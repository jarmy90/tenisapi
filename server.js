'use strict';

/**
 * Bolita Tennis API (Node.js + Express + Playwright)
 *
 * OBJETIVO:
 * - Scrape en vivo de tenis desde Flashscore (página renderizada JS).
 * - Render-friendly: browsers herméticos dentro de node_modules para evitar /opt/render/.cache/ms-playwright
 *
 * Render settings recomendados:
 * - Node: 20.x
 * - Build Command: npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
 * - Start Command: npm start
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// 🔥 CLAVE: fuerza modo "hermético" antes de cargar Playwright.
// Esto hace que browsers se usen desde node_modules/playwright-core/.local-browsers en vez de ~/.cache/ms-playwright. [1](https://www.api-football.com/documentation-v3)[2](https://rapidapi.com/Creativesdev/api/free-api-live-football-data)
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// URL a scrapear (puedes cambiarla en Render env var SCRAPE_URL si quieres)
const SCRAPE_URL = process.env.SCRAPE_URL || 'https://www.flashscore.es/tennis/';

// Cache para no lanzar Chromium continuamente (Render Free lo agradece)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000); // 15s
let _cache = { ts: 0, data: null };
let _inFlight = null;

// ─────────────────────────────────────────────────────────────
// CORS (por si llamas desde browser/web/app directamente)
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const now = () => Date.now();
const iso = (t) => new Date(t).toISOString();

async function launchPage() {
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
  return { browser, context, page };
}

async function bestEffortHandleCookies(page) {
  // Best-effort: puede variar por región/idioma.
  const candidates = [
    'button:has-text("Aceptar")',
    'button:has-text("Acepto")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Aceptarlo todo")',
    'button:has-text("I agree")',
    'button:has-text("Accept")',
    'button:has-text("Accept all")'
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(800);
        break;
      }
    } catch (_) {}
  }
}

async function bestEffortScroll(page) {
  // A veces hay lazy-load
  for (let i = 0; i < 4; i++) {
    try {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(650);
    } catch (_) {}
  }
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// Debug endpoints (para saber exactamente qué ve Playwright)
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || null
  });
});

app.get('/debug/pw', (req, res) => {
  const cwd = process.cwd();
  const localBrowsers = path.join(cwd, 'node_modules', 'playwright-core', '.local-browsers');
  res.json({
    ok: true,
    cwd,
    SCRAPE_URL,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    localBrowsersPath: localBrowsers,
    localBrowsersExists: fs.existsSync(localBrowsers),
    localBrowsersEntries: fs.existsSync(localBrowsers) ? fs.readdirSync(localBrowsers).slice(0, 30) : []
  });
});

// Devuelve screenshot base64 + URL final + contadores de selectores
app.get('/debug/snap', async (req, res) => {
  let browser = null;
  try {
    const x = await launchPage();
    browser = x.browser;
    const page = x.page;

    await page.goto(SCRAPE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await bestEffortHandleCookies(page);
    await bestEffortScroll(page);

    const finalUrl = page.url();

    const counts = await page.evaluate(() => {
      const q = (sel) => document.querySelectorAll(sel).length;
      return {
        eventMatch: q('.event__match'),
        participantHome: q('.event__participant--home'),
        participantAway: q('.event__participant--away'),
        anyEvent: q('[class*="event"]'),
        anyMatch: q('[class*="match"]'),
        bodyTextLen: (document.body?.innerText || '').length
      };
    });

    const buf = await page.screenshot({ fullPage: true });

    await browser.close();
    browser = null;

    res.json({
      ok: true,
      finalUrl,
      counts,
      screenshotBase64: buf.toString('base64')
    });
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Devuelve HTML (parcial) + URL final
app.get('/debug/html', async (req, res) => {
  let browser = null;
  try {
    const x = await launchPage();
    browser = x.browser;
    const page = x.page;

    await page.goto(SCRAPE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await bestEffortHandleCookies(page);
    await bestEffortScroll(page);

    const finalUrl = page.url();
    const html = await page.content();

    await browser.close();
    browser = null;

    res.type('text/plain').send(`FINAL_URL=${finalUrl}\n\n` + html.slice(0, 140000));
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    res.status(500).type('text/plain').send(e?.message || String(e));
  }
});

// ─────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  // Este mensaje ya lo estabas usando y confirma que Express está vivo. [3](https://playwright.dev/docs/browsers)
  res.send('Bolita Tennis API (Node.js + Playwright) funcionando 🎾. Llama a /api/tennis/live');
});

// ─────────────────────────────────────────────────────────────
// Scraper principal (devuelve events[])
// ─────────────────────────────────────────────────────────────
async function scrapeFlashscoreTennis() {
  const { browser, page } = await launchPage();
  let results = [];

  try {
    console.log(`[+] goto: ${SCRAPE_URL}`);
    await page.goto(SCRAPE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    await bestEffortHandleCookies(page);
    await bestEffortScroll(page);

    // Espera a que aparezcan partidos si existen
    await page.waitForSelector('.event__match', { timeout: 12000 }).catch(() => {});

    // Evalúa DOM con tu lógica base (event__match, participant--home/away, header título)
    results = await page.evaluate(() => {
      const out = [];
      const matchNodes = document.querySelectorAll('.event__match');

      matchNodes.forEach(node => {
        const homeNode = node.querySelector('.event__participant--home');
        const awayNode = node.querySelector('.event__participant--away');
        const home = homeNode ? homeNode.textContent.trim() : 'Jugador 1';
        const away = awayNode ? awayNode.textContent.trim() : 'Jugador 2';

        // Torneo (subiendo al header anterior)
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

        // Scores por sets
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

        out.push({
          tournament,
          home,
          away,
          status,
          score: { home: setsHome, away: setsAway }
        });
      });

      return out;
    });

    return results;
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────
// Endpoint principal
// ─────────────────────────────────────────────────────────────
app.get('/api/tennis/live', async (req, res) => {
  try {
    const forceFresh = String(req.query.fresh || '') === '1';

    const age = now() - _cache.ts;
    if (!forceFresh && _cache.data && age < CACHE_TTL_MS) {
      return res.status(200).json({
        success: true,
        cached: true,
        cacheAgeMs: age,
        timestamp: iso(_cache.ts),
        count: _cache.data.length,
        events: _cache.data
      });
    }

    if (_inFlight && !forceFresh) {
      const data = await _inFlight;
      return res.status(200).json({
        success: true,
        cached: true,
        cacheAgeMs: now() - _cache.ts,
        timestamp: iso(_cache.ts),
        count: data.length,
        events: data
      });
    }

    console.log(`[GET] /api/tennis/live from ${req.ip} fresh=${forceFresh ? '1' : '0'}`);

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
  } catch (e) {
    _inFlight = null;
    return res.status(500).json({
      success: false,
      message: 'Error interno al scrapear los marcadores',
      error: e?.message || String(e)
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 API de Tenis iniciada en el puerto ${PORT}`);
  console.log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
  console.log(`SCRAPE_URL=${SCRAPE_URL}`);
});'use strict';

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

