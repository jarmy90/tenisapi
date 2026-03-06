'use strict';

/**
 * Bolita Tennis API (Node + Express + Playwright) — Render-ready
 *
 * IMPORTANTE PARA RENDER:
 * Build Command:
 *   npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
 * Start Command:
 *   npm start
 *
 * Env var recomendada en Render:
 *   PLAYWRIGHT_BROWSERS_PATH=0
 *
 * Opcional:
 *   SCRAPE_URL=https://www.flashscore.es/tenis/
 *   CACHE_TTL_MS=15000
 */

'use strict';

const express = require('express');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// URL primaria + fallback (mobi suele ser más scrapeable)
const SCRAPE_URLS = [
  (process.env.SCRAPE_URL || 'https://www.flashscore.es/tenis/'),
  'https://www.flashscore.mobi/tennis/'
];

// Cache para evitar abrir Chromium en cada request (muy importante en Render Free)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000);
let _cache = { ts: 0, data: null };
let _inFlight = null;

const now = () => Date.now();
const iso = (t) => new Date(t).toISOString();

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────────────────────
// Helpers Playwright
// ─────────────────────────────────────────────────────────────
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
  const candidates = [
    'button:has-text("Aceptar")',
    'button:has-text("Acepto")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Aceptar todas")',
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
  for (let i = 0; i < 4; i++) {
    try {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(650);
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────
// Debug endpoints
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
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    localBrowsersPath: localBrowsers,
    localBrowsersExists: fs.existsSync(localBrowsers),
    localBrowsersEntries: fs.existsSync(localBrowsers) ? fs.readdirSync(localBrowsers).slice(0, 30) : [],
    scrapeUrls: SCRAPE_URLS
  });
});

// Screenshot base64 + URL final + contadores (para ver qué está renderizando)
app.get('/debug/snap', async (req, res) => {
  let browser = null;
  try {
    const { browser: b, page } = await launchPage();
    browser = b;

    const url = req.query.url ? String(req.query.url) : SCRAPE_URLS[0];
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await bestEffortHandleCookies(page);
    await bestEffortScroll(page);

    const finalUrl = page.url();
    const counts = await page.evaluate(() => {
      const q = (sel) => document.querySelectorAll(sel).length;
      return {
        eventMatchExact: q('.event__match'),
        eventMatchAny: q('[class*="event__match"]'),
        homeAny: q('[class*="participant--home"]'),
        awayAny: q('[class*="participant--away"]'),
        anyMatch: q('[class*="match"]'),
        anyEvent: q('[class*="event"]'),
        bodyTextLen: (document.body?.innerText || '').length
      };
    });

    const buf = await page.screenshot({ fullPage: true });
    await browser.close();
    browser = null;

    res.json({ ok: true, finalUrl, counts, screenshotBase64: buf.toString('base64') });
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// HTML parcial + URL final
app.get('/debug/html', async (req, res) => {
  let browser = null;
  try {
    const { browser: b, page } = await launchPage();
    browser = b;

    const url = req.query.url ? String(req.query.url) : SCRAPE_URLS[0];
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
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

// Root
app.get('/', (req, res) => {
  res.send('Bolita Tennis API (Node.js + Playwright) funcionando 🎾. Llama a /api/tennis/live');
});

// ─────────────────────────────────────────────────────────────
// Scraper (intenta URL primaria y fallback)
// ─────────────────────────────────────────────────────────────
async function scrapeFromUrl(url) {
  const { browser, page } = await launchPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await bestEffortHandleCookies(page);
    await bestEffortScroll(page);

    // Espera a algo parecido a “match”
    await page.waitForSelector('[class*="match"]', { timeout: 12000 }).catch(() => {});

    const data = await page.evaluate(() => {
      // Selecciona matches de forma flexible
      const nodes = Array.from(document.querySelectorAll('.event__match, [class*="event__match"]'));
      const out = [];

      for (const node of nodes) {
        const home =
          node.querySelector('.event__participant--home, [class*="participant--home"]')?.textContent?.trim() || '';
        const away =
          node.querySelector('.event__participant--away, [class*="participant--away"]')?.textContent?.trim() || '';
        if (!home || !away) continue;

        // torneo: subir hasta header anterior si existe
        let tournament = '';
        let prev = node.previousElementSibling;
        while (prev) {
          const cls = prev.className || '';
          if (String(cls).includes('event__header')) {
            tournament = prev.querySelector('.event__title--name')?.textContent?.trim() || '';
            break;
          }
          prev = prev.previousElementSibling;
        }

        const status = node.querySelector('.event__stage')?.textContent?.trim() || '';

        // scores por sets (si están)
        const setsHome = [];
        const setsAway = [];
        const scoresDiv = node.querySelector('.event__scores');
        if (scoresDiv) {
          const spans = Array.from(scoresDiv.querySelectorAll('span'));
          for (let i = 0; i < spans.length; i += 2) {
            setsHome.push((spans[i]?.textContent || '').trim());
            setsAway.push((spans[i + 1]?.textContent || '').trim());
          }
        }

        out.push({
          tournament: tournament || 'Desconocido',
          home,
          away,
          status,
          score: { home: setsHome, away: setsAway }
        });
      }

      return out;
    });

    return data;
  } finally {
    await browser.close();
  }
}

async function scrapeFlashscoreTennis() {
  for (const url of SCRAPE_URLS) {
    const data = await scrapeFromUrl(url);
    if (data && data.length) return data;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Endpoint principal
// ─────────────────────────────────────────────────────────────
app.get('/api/tennis/live', async (req, res) => {
  try {
    const forceFresh = String(req.query.fresh || '') === '1';

    const age = now() - _cache.ts;
    if (!forceFresh && _cache.data && age < CACHE_TTL_MS) {
      return res.json({
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
      return res.json({
        success: true,
        cached: true,
        cacheAgeMs: now() - _cache.ts,
        timestamp: iso(_cache.ts),
        count: data.length,
        events: data
      });
    }

    _inFlight = (async () => {
      const data = await scrapeFlashscoreTennis();
      _cache = { ts: now(), data };
      return data;
    })();

    const data = await _inFlight;
    _inFlight = null;

    return res.json({
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

// Start
app.listen(PORT, () => {
  console.log(`🚀 API de Tenis iniciada en el puerto ${PORT}`);
  console.log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
  console.log(`SCRAPE_URLS=${JSON.stringify(SCRAPE_URLS)}`);
});

