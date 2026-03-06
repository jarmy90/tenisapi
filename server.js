'use strict';

/**
 * BOLITA TENNIS API — Render-ready (Node + Express + Playwright)
 * - Fuerza Playwright a usar browsers "herméticos" dentro de node_modules
 * - Evita que busque en /opt/render/.cache/ms-playwright (que en Render runtime suele no persistir)
 *
 * Requisitos:
 *  - Build command: npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
 *  - Node 20.x recomendado
 */

// 1) Express primero
const express = require('express');

// 2) 🔥 CLAVE: fuerza el modo hermético ANTES de cargar Playwright
// Esto evita que Playwright busque ejecutables en ~/.cache/ms-playwright en runtime.
// Si Render ya tiene la env var, esto la respeta; si no, la fija a "0".
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

// 3) Ahora sí: Playwright
const { chromium } = require('playwright');

const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// CORS (para que tu web/Android llame directo si quieres)
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

// Cache para evitar levantar Chromium en cada request (Render Free = más estable)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000); // 15s por defecto
let _cache = { ts: 0, data: null };
let _inFlight = null;

// Helper
const now = () => Date.now();

// ─────────────────────────────────────────────────────────────
// DEBUG endpoints (diagnóstico rápido)
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || null
  });
});

// Verifica si existen los browsers herméticos (esto te dice si Render está bien)
app.get('/debug/pw', (req, res) => {
  const cwd = process.cwd();
  const localBrowsers = path.join(cwd, 'node_modules', 'playwright-core', '.local-browsers');
  res.json({
    ok: true,
    cwd,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    localBrowsersPath: localBrowsers,
    localBrowsersExists: fs.existsSync(localBrowsers),
    localBrowsersEntries: fs.existsSync(localBrowsers)
      ? fs.readdirSync(localBrowsers).slice(0, 20)
      : []
  });
});

// Mensaje root (como tu original)
app.get('/', (req, res) => {
  res.send('Bolita Tennis API (Node.js + Playwright) funcionando 🎾. Llama a /api/tennis/live');
});

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
    await page.waitForSelector('.event__match', { timeout: 15000 }).catch(() => {
      console.log('[!] Timeout esperando .event__match (puede no haber partidos o haber bloqueo)');
    });

    matches = await page.evaluate(() => {
      const results = [];
      const matchNodes = document.querySelectorAll('.event__match');

      matchNodes.forEach(node => {
        const homeNode = node.querySelector('.event__participant--home');
        const awayNode = node.querySelector('.event__participant--away');
        const home = homeNode ? homeNode.textContent.trim() : 'Jugador 1';
        const away = awayNode ? awayNode.textContent.trim() : 'Jugador 2';

        // Torneo asociado: subir hasta el header anterior
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

        const stageNode = node.querySelector('.event__stage');
        const status = stageNode ? stageNode.textContent.trim() : '';

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
    console.error('[-] Error durante el scraping:', e?.message || e);
    throw e;
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────
// ENDPOINT PRINCIPAL
// ─────────────────────────────────────────────────────────────
app.get('/api/tennis/live', async (req, res) => {
  try {
    const forceFresh = String(req.query.fresh || '') === '1';

    // Cache TTL
    const age = now() - _cache.ts;
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

    // Evita multiples Chromiums simultáneos
    if (_inFlight && !forceFresh) {
      const data = await _inFlight;
      return res.status(200).json({
        success: true,
        cached: true,
        cacheAgeMs: now() - _cache.ts,
        timestamp: new Date(_cache.ts).toISOString(),
        count: data.length,
        events: data
      });
    }

    console.log(`[GET] /api/tennis/live desde ${req.ip} (fresh=${forceFresh ? '1' : '0'})`);

    _inFlight = (async () => {
      const data = await scrapeFlashscoreTennis();
      _cache = { ts: now(), data };
      return data;
    })();

    const data = await _inFlight;
    _inFlight = null;

    return res.status(200).json({
      success: true,
      cached: false,
      timestamp: new Date().toISOString(),
      count: data.length,
      events: data
    });

  } catch (error) {
    _inFlight = null;
    return res.status(500).json({
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
  console.log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
});
