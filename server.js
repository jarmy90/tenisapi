'use strict';

const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// CORS (si vas a llamar desde navegador / web)
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const SCRAPE_URL = process.env.SCRAPE_URL || 'https://www.flashscore.es/tennis/';

// Cache para no lanzar Chromium en cada petición (muy importante en Render Free)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000); // 15s por defecto
let _cache = { ts: 0, data: null };
let _inFlight = null; // evita 10 chromium simultáneos

function nowMs() { return Date.now(); }

// ─────────────────────────────────────────────────────────────
// SCRAPER
// ─────────────────────────────────────────────────────────────
async function scrapeFlashscoreTennis() {
  console.log('[+] Iniciando Chromium Headless...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  let matches = [];

  try {
    console.log(`[+] Navegando a: ${SCRAPE_URL}`);
    await page.goto(SCRAPE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('[+] Esperando renderizado JS (.event__match)...');
    await page.waitForSelector('.event__match', { timeout: 15000 })
      .catch(() => console.log('[!] Timeout esperando .event__match (puede no haber partidos o haber bloqueo)'));

    matches = await page.evaluate(() => {
      const results = [];
      const matchNodes = document.querySelectorAll('.event__match');

      matchNodes.forEach(node => {
        // Jugadores
        const homeNode = node.querySelector('.event__participant--home');
        const awayNode = node.querySelector('.event__participant--away');
        const home = homeNode ? homeNode.textContent.trim() : 'Jugador 1';
        const away = awayNode ? awayNode.textContent.trim() : 'Jugador 2';

        // Torneo asociado (subiendo hasta el header anterior)
        let tournament = 'Desconocido';
        let prev = node.previousElementSibling;
        while (prev) {
          if (prev.classList && prev.classList.contains('event__header')) {
            const tNode = prev.querySelector('.event__title--name');
            tournament = tNode ? tNode.textContent.trim() : 'Desconocido';
            break;
          }
          prev = prev.previousElementSibling;
        }

        // Estado (Set 1, Finalizado, etc.)
        const stageNode = node.querySelector('.event__stage');
        const status = stageNode ? stageNode.textContent.trim() : '';

        // Puntuaciones por sets (si están visibles)
        const scoresDiv = node.querySelector('.event__scores');
        const setsHome = [];
        const setsAway = [];

        if (scoresDiv) {
          const spans = Array.from(scoresDiv.querySelectorAll('span'));
          for (let i = 0; i < spans.length; i += 2) {
            setsHome.push((spans[i]?.textContent || '').trim());
            setsAway.push((spans[i + 1]?.textContent || '').trim());
          }
        }

        results.push({
          tournament,
          home,
          away,
          status,
          score: { home: setsHome, away: setsAway }
        });
      });

      return results;
    });

    console.log(`[+] Recuperados ${matches.length} partidos.`);
    return matches;

  } catch (e) {
    console.error('[-] Error durante el scraping:', e.message || e);
    throw e;
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────

// Healthcheck real (Render lo agradece)
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    cache_age_ms: _cache.data ? (nowMs() - _cache.ts) : null
  });
});

// Info simple
app.get('/', (req, res) => {
  res.send('Bolita Tennis API (Node.js + Playwright) funcionando 🎾. Llama a /api/tennis/live');
});

// Endpoint principal
app.get('/api/tennis/live', async (req, res) => {
  try {
    const forceFresh = String(req.query.fresh || '') === '1';

    // Cache TTL
    const age = nowMs() - _cache.ts;
    if (!forceFresh && _cache.data && age < CACHE_TTL_MS) {
      return res.status(200).json({
        success: true,
        cached: true,
        cacheAgeMs: age,
        timestamp: new Date(_cache.ts).toISOString(),
        count: _cache.data.length,
        events: _cache.data
      });
    }

    // Evita varios chromium simultáneos si llegan varias requests a la vez
    if (_inFlight && !forceFresh) {
      const data = await _inFlight;
      return res.status(200).json({
        success: true,
        cached: true,
        cacheAgeMs: nowMs() - _cache.ts,
        timestamp: new Date(_cache.ts).toISOString(),
        count: data.length,
        events: data
      });
    }

    console.log(`[GET] /api/tennis/live desde ${req.ip} (fresh=${forceFresh ? '1' : '0'})`);

    _inFlight = (async () => {
      const data = await scrapeFlashscoreTennis();
      _cache = { ts: nowMs(), data };
      return data;
    })();

    const data = await _inFlight;
    _inFlight = null;

    res.status(200).json({
      success: true,
      cached: false,
      timestamp: new Date().toISOString(),
      count: data.length,
      events: data
    });

  } catch (error) {
    _inFlight = null;
    res.status(500).json({
      success: false,
      message: 'Error interno al scrapear los marcadores',
      error: error?.message || String(error)
    });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 API de Tenis iniciada en el puerto ${PORT}`);
  console.log(`Prueba local: http://localhost:${PORT}/api/tennis/live`);
});