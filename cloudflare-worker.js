export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS preflight (lo manda el navegador)
        if (request.method === "OPTIONS") {
            return withCors(new Response(null, { status: 204 }));
        }

        // ✅ DEBUG: revisa si llegan las variables (no expone la key)
        if (url.pathname === "/__envcheck") {
            return withCors(json({
                has_RAPIDAPI_KEY: !!env.RAPIDAPI_KEY,
                has_RAPIDAPI_HOST: !!env.RAPIDAPI_HOST,
                has_UPSTREAM_BASE: !!env.UPSTREAM_BASE,
                RAPIDAPI_HOST_value: env.RAPIDAPI_HOST || null,
                UPSTREAM_BASE_value: env.UPSTREAM_BASE || null
            }, 200));
        }

        // ─────────────────────────────────────────────────────────────
        // ✅ TENNIS RANK (NO depende de RapidAPI)
        // Importante: esto VA ANTES del env-check de RapidAPI.
        // ─────────────────────────────────────────────────────────────

        if (url.pathname === "/tennis/rank") {
            const name = (url.searchParams.get("name") || "").trim();
            const tour = (url.searchParams.get("tour") || "atp").toLowerCase(); // atp|wta
            if (!name) return withCors(json({ ok: false, error: "missing name" }, 400));

            try {
                const map = await getRankMap(tour, ctx);
                const rank = findRank(map, name);
                return withCors(json({ ok: true, name, tour, rank: rank ?? null }, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e) }, 500));
            }
        }

        // Bulk: /tennis/ranks?tour=atp&names=Alcaraz|Nadal
        if (url.pathname === "/tennis/ranks") {
            const namesRaw = (url.searchParams.get("names") || "").trim();
            const tour = (url.searchParams.get("tour") || "atp").toLowerCase();
            if (!namesRaw) return withCors(json({ ok: false, error: "missing names" }, 400));

            const names = namesRaw.split("|").map(s => s.trim()).filter(Boolean).slice(0, 6);
            if (!names.length) return withCors(json({ ok: false, error: "empty names" }, 400));

            try {
                const map = await getRankMap(tour, ctx);
                const out = {};
                for (const nm of names) out[nm] = findRank(map, nm) ?? null;
                return withCors(json({ ok: true, tour, ranks: out }, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e) }, 500));
            }
        }

        // ─────────────────────────────────────────────────────────────
        // A PARTIR DE AQUÍ: RapidAPI Livescore
        // ─────────────────────────────────────────────────────────────

        const RAPIDAPI_KEY = env.RAPIDAPI_KEY || "";
        const RAPIDAPI_HOST = env.RAPIDAPI_HOST || "";
        const UPSTREAM_BASE = (env.UPSTREAM_BASE || "").replace(/\/$/, "");

        if (!RAPIDAPI_KEY || !RAPIDAPI_HOST || !UPSTREAM_BASE) {
            return withCors(json({
                ok: false,
                error: "Missing env vars. Set RAPIDAPI_KEY (secret), RAPIDAPI_HOST, UPSTREAM_BASE."
            }, 500));
        }

        // 1) RAW passthrough list-by-date (para comprobar)
        if (url.pathname === "/livescore/matches/list-by-date") {
            const date = url.searchParams.get("date") || "";
            const category = url.searchParams.get("category") || "tennis";
            const timezone = url.searchParams.get("timezone") || "1";

            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return withCors(json({
                    status: false, message: "Errors",
                    errors: { date: "Incorrect date format, should be YYYY-MM-DD" }, data: null
                }, 400));
            }

            try {
                const upstream = new URL(UPSTREAM_BASE + "/matches/list-by-date");
                upstream.searchParams.set("date", date);
                upstream.searchParams.set("category", category);
                upstream.searchParams.set("timezone", timezone);
                const raw = await fetchRapidJSON(upstream.toString(), RAPIDAPI_KEY, RAPIDAPI_HOST);
                return withCors(json(raw, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e) }, 502));
            }
        }

        // 2) FILTRADO: ATP/WTA Singles (previas OK), sin Challenger/ITF ni dobles
        if (url.pathname === "/livescore/tennis/atp-wta-singles") {
            const timezone = url.searchParams.get("timezone") || "1";
            let date = url.searchParams.get("date");
            const days = parseInt(url.searchParams.get("days") || "0", 10) || 0;

            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                date = dateFromOffset(days);
            }

            try {
                const upstream = new URL(UPSTREAM_BASE + "/matches/list-by-date");
                upstream.searchParams.set("date", date);
                upstream.searchParams.set("category", "tennis");
                upstream.searchParams.set("timezone", timezone);

                const raw = await fetchRapidJSON(upstream.toString(), RAPIDAPI_KEY, RAPIDAPI_HOST);
                const filtered = filterAtpWtaSingles(raw);
                return withCors(json(filtered, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e), Stages: [] }, 502));
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 3) FÚTBOL LIVE HOY: EPL + LaLiga en tiempo real
        //    GET /livescore/football/live-today?timezone=1
        //    Respuesta: { ok:true, matches:[{eid,home,away,score1,score2,elapsed,status,comp},...] }
        // ─────────────────────────────────────────────────────────────
        if (url.pathname === "/livescore/football/live-today") {
            const timezone = url.searchParams.get("timezone") || "1";
            const date = dateFromOffset(0); // hoy

            try {
                const upstream = new URL(UPSTREAM_BASE + "/matches/list-by-date");
                upstream.searchParams.set("date", date);
                upstream.searchParams.set("category", "soccer");
                upstream.searchParams.set("timezone", timezone);

                const raw = await fetchRapidJSON(upstream.toString(), RAPIDAPI_KEY, RAPIDAPI_HOST);
                const matches = filterTopLeagueFootball(raw);
                return withCors(json({ ok: true, date, matches }, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e), matches: [] }, 502));
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 4) PARTIDO INDIVIDUAL LIVE: detalles de un partido específico
        //    GET /livescore/match/live?eid=XXX&category=soccer&timezone=1
        // ─────────────────────────────────────────────────────────────
        if (url.pathname === "/livescore/match/live") {
            const eid = url.searchParams.get("eid") || "";
            const category = url.searchParams.get("category") || "soccer";
            const timezone = url.searchParams.get("timezone") || "1";
            if (!eid) return withCors(json({ ok: false, error: "missing eid" }, 400));

            // La LiveScore API no tiene endpoint por eid directamente en el plan básico,
            // así que pedimos el día del partido y buscamos por eid
            const date = url.searchParams.get("date") || dateFromOffset(0);
            try {
                const upstream = new URL(UPSTREAM_BASE + "/matches/list-by-date");
                upstream.searchParams.set("date", date);
                upstream.searchParams.set("category", category);
                upstream.searchParams.set("timezone", timezone);

                const raw = await fetchRapidJSON(upstream.toString(), RAPIDAPI_KEY, RAPIDAPI_HOST);
                // busca el evento por Eid en los Stages
                const ev = findEventByEid(raw, eid);
                if (!ev) return withCors(json({ ok: false, error: "event not found", eid }, 404));
                return withCors(json({ ok: true, event: ev }, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e) }, 502));
            }
        }

        // 5) TENNIS LIVE HOY: ATP/WTA en tiempo real
        //    GET /livescore/tennis/live-today?timezone=1
        if (url.pathname === "/livescore/tennis/live-today") {
            const timezone = url.searchParams.get("timezone") || "1";
            const date = dateFromOffset(0);
            try {
                const upstream = new URL(UPSTREAM_BASE + "/matches/list-by-date");
                upstream.searchParams.set("date", date);
                upstream.searchParams.set("category", "tennis");
                upstream.searchParams.set("timezone", timezone);
                const raw = await fetchRapidJSON(upstream.toString(), RAPIDAPI_KEY, RAPIDAPI_HOST);
                const filtered = filterAtpWtaSinglesLive(raw);
                return withCors(json({ ok: true, date, matches: filtered }, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e), matches: [] }, 502));
            }
        }
        // ─────────────────────────────────────────────────────────────
        // 6) TENIS SOFASCORE FALLBACK (PROXY LIBRE DE CORS)
        //    GET /livescore/tennis/sofascore-live
        // ─────────────────────────────────────────────────────────────
        if (url.pathname === "/livescore/tennis/sofascore-live") {
            try {
                // Hacemos fetch a SofaScore y devolvemos la respuesta inyectando CORS
                const sofaRes = await fetch("https://api.sofascore.com/api/v1/sport/tennis/events/live", {
                    headers: {
                        "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    }
                });

                if (!sofaRes.ok) {
                    return withCors(json({ ok: false, error: "SofaScore upstream error: " + sofaRes.status }, 502));
                }

                const data = await sofaRes.json();

                // Limpiamos los datos para enviar solo ATP/WTA
                const evs = (data.events || []).filter(e =>
                    e.tournament?.category?.name === 'ATP' ||
                    e.tournament?.category?.name === 'WTA'
                );

                // Lo cacheamos 20 segundos preventivamente para no saturar SofaScore si hay muchas llamadas
                const finalRes = json({ ok: true, events: evs }, 200);
                const h = new Headers(finalRes.headers);
                h.set("Access-Control-Allow-Origin", "*");
                h.set("Cache-Control", "public, s-maxage=20, max-age=20");
                return new Response(finalRes.body, { status: 200, headers: h });

            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e) }, 502));
            }
        }

        // 3) PROXY genérico: /livescore/lo-que-sea -> upstream /lo-que-sea
        if (url.pathname.startsWith("/livescore/")) {
            try {
                const tail = url.pathname.replace(/^\/livescore/, "");
                const upstreamUrl = new URL(UPSTREAM_BASE + tail);
                upstreamUrl.search = url.search;
                const raw = await fetchRapidJSON(upstreamUrl.toString(), RAPIDAPI_KEY, RAPIDAPI_HOST);
                return withCors(json(raw, 200));
            } catch (e) {
                return withCors(json({ ok: false, error: String(e?.message || e) }, 502));
            }
        }

        return withCors(json({ ok: false, error: "Not found" }, 404));
    }
};

// ─────────────────────────────────────────────────────────────
// CORS helpers
// ─────────────────────────────────────────────────────────────
function withCors(res) {
    const h = new Headers(res.headers);
    h.set("Access-Control-Allow-Origin", "*");
    h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    h.set("Access-Control-Max-Age", "86400");
    return new Response(res.body, { status: res.status, headers: h });
}
function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" }
    });
}
async function fetchRapidJSON(url, key, host) {
    const res = await fetch(url, {
        headers: {
            "x-rapidapi-key": key,
            "x-rapidapi-host": host
        }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`UPSTREAM_${res.status}: ${text.slice(0, 220)}`);
    try { return JSON.parse(text); }
    catch { throw new Error("UPSTREAM_JSON_PARSE: " + text.slice(0, 220)); }
}

function dateFromOffset(days = 0) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function filterAtpWtaSingles(payload) {
    // ✅ FIX: defensa total ante payload inesperado
    if (!payload || typeof payload !== 'object') return { Stages: [] };
    const stages = Array.isArray(payload.Stages) ? payload.Stages : [];
    const outStages = [];

    for (const st of stages) {
        try {
            const cnm = String(st?.Cnm || st?.Nm || "").toUpperCase();
            // Acepta ATP o WTA en el nombre del torneo/categoría
            const isAtpWta = cnm.includes("ATP") || cnm.includes("WTA");
            if (!isAtpWta) continue;
            if (cnm.includes("CHALLENGER") || cnm.includes("ITF")) continue;
            // También descartamos "DOUBLES", "MIXED" etc.
            if (cnm.includes("DOUBLES") || cnm.includes("DOUBLE") || cnm.includes("MIXED")) continue;

            const evs = Array.isArray(st?.Events) ? st.Events : [];
            const singles = evs.filter(ev => {
                try {
                    const t1 = Array.isArray(ev?.T1) ? ev.T1 : [];
                    const t2 = Array.isArray(ev?.T2) ? ev.T2 : [];
                    // Singles: exactamente 1 jugador por equipo
                    if (t1.length !== 1 || t2.length !== 1) return false;
                    // Descarta dobles por nombre (p.ej. "Alcaraz / Nadal")
                    const n1 = String(t1[0]?.Nm || "");
                    const n2 = String(t2[0]?.Nm || "");
                    if (/\s\/\s|\s&\s/.test(n1) || /\s\/\s|\s&\s/.test(n2)) return false;
                    return true;
                } catch (_) { return false; }
            });

            if (!singles.length) continue;
            outStages.push({ ...st, Events: singles });
        } catch (_) { continue; }
    }

    return { ...payload, Stages: outStages };
}

// Convierte el estado Eps de Livescore a un estado legible
function epsToStatus(eps) {
    const e = String(eps || "").toUpperCase().trim();
    if (!e || e === "NS" || e === "0") return "upcoming";
    if (e === "HT" || e === "HALF TIME") return "halftime";
    if (e === "FT" || e === "AET" || e === "PEN" || e === "AP" || e === "ABD") return "finished";
    if (e === "TBA" || e === "POSTP" || e === "CANC" || e === "SUSP") return "postponed";
    // Si es numérico → en juego (1st/2nd set en tenis, 1st/2nd half en football)
    if (/^\d+$/.test(e) || e === "1" || e === "2") return "live";
    if (e.startsWith("S")) return "live"; // Sets tenis: S1, S2, S3
    return "live"; // fallback: cualquier otro valor → live
}

// Filtra fútbol de TOP ligas (EPL, La Liga, + Champions, Europa League)
function filterTopLeagueFootball(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const stages = Array.isArray(payload.Stages) ? payload.Stages : [];
    const out = [];
    const TOP_KEYWORDS = ["PREMIER LEAGUE", "LA LIGA", "BUNDESLIGA", "SERIE A", "LIGUE 1",
        "CHAMPIONS", "EUROPA LEAGUE", "CONFERENCE"];

    for (const st of stages) {
        try {
            const cnm = String(st?.Cnm || st?.Nm || "").toUpperCase();
            const isTop = TOP_KEYWORDS.some(k => cnm.includes(k));
            if (!isTop) continue;
            const evs = Array.isArray(st?.Events) ? st.Events : [];
            for (const ev of evs) {
                try {
                    const t1 = Array.isArray(ev?.T1) ? ev.T1[0] : {};
                    const t2 = Array.isArray(ev?.T2) ? ev.T2[0] : {};
                    const eps = String(ev?.Eps || "");
                    const status = epsToStatus(eps);
                    // elapsed: campo Eact (minutos), o estimado por Eps
                    let elapsed = parseInt(ev?.Eact || ev?.Ela || "0", 10) || 0;
                    if (isNaN(elapsed)) elapsed = 0;
                    out.push({
                        eid: String(ev?.Eid || ""),
                        home: String(t1?.Nm || t1?.Abr || ""),
                        away: String(t2?.Nm || t2?.Abr || ""),
                        score1: parseInt(ev?.Tr1 || "0", 10) || 0,
                        score2: parseInt(ev?.Tr2 || "0", 10) || 0,
                        elapsed,
                        status,
                        eps,
                        comp: String(st?.Cnm || ""),
                        esd: String(ev?.Esd || ""), // formato: YYYYMMDDHHMMSS
                    });
                } catch (_) { }
            }
        } catch (_) { }
    }

    // Ordena: live primero, luego por kickoff
    out.sort((a, b) => {
        const aLive = (a.status === "live" || a.status === "halftime") ? 0 : 1;
        const bLive = (b.status === "live" || b.status === "halftime") ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        return String(a.esd).localeCompare(String(b.esd));
    });

    return out;
}

// Filtra tenis ATP/WTA en vivo (versión plana para endpoint live-today)
function filterAtpWtaSinglesLive(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const stages = Array.isArray(payload.Stages) ? payload.Stages : [];
    const out = [];

    for (const st of stages) {
        try {
            const cnm = String(st?.Cnm || "").toUpperCase();
            if (!(cnm.includes("ATP") || cnm.includes("WTA"))) continue;
            if (cnm.includes("CHALLENGER") || cnm.includes("ITF") || cnm.includes("DOUBLES") || cnm.includes("MIXED")) continue;
            const evs = Array.isArray(st?.Events) ? st.Events : [];
            for (const ev of evs) {
                try {
                    const t1 = Array.isArray(ev?.T1) ? ev.T1 : [];
                    const t2 = Array.isArray(ev?.T2) ? ev.T2 : [];
                    if (t1.length !== 1 || t2.length !== 1) continue;
                    const n1 = String(t1[0]?.Nm || "");
                    const n2 = String(t2[0]?.Nm || "");
                    if (/\s\/\s|\s&\s/.test(n1) || /\s\/\s|\s&\s/.test(n2)) continue;
                    const eps = String(ev?.Eps || "");
                    const status = epsToStatus(eps);
                    // Para tenis: Tr1/Tr2 = sets ganados, Sc = sets score (ej "6-4")
                    out.push({
                        eid: String(ev?.Eid || ""),
                        home: n1,
                        away: n2,
                        sets1: parseInt(ev?.Tr1 || "0", 10) || 0,
                        sets2: parseInt(ev?.Tr2 || "0", 10) || 0,
                        // Detalle de set actual (si disponible en sub-score)
                        score: ev?.Sc || null,
                        status,
                        eps,
                        comp: String(st?.Cnm || ""),
                        esd: String(ev?.Esd || ""),
                    });
                } catch (_) { }
            }
        } catch (_) { }
    }

    out.sort((a, b) => {
        const aLive = (a.status === "live") ? 0 : 1;
        const bLive = (b.status === "live") ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        return String(a.esd).localeCompare(String(b.esd));
    });

    return out;
}

// Busca un evento por Eid en el payload de list-by-date
function findEventByEid(payload, eid) {
    if (!payload || typeof payload !== 'object') return null;
    const stages = Array.isArray(payload.Stages) ? payload.Stages : [];
    for (const st of stages) {
        const evs = Array.isArray(st?.Events) ? st.Events : [];
        for (const ev of evs) {
            if (String(ev?.Eid || "") === String(eid)) return ev;
        }
    }
    return null;
}

const ATP_RANK_URL = "https://live-tennis.eu/en/official-atp-ranking";
const WTA_RANK_URL = "https://live-tennis.eu/en/official-wta-ranking";
const WIKI_PARSE_URL =
    "https://en.wikipedia.org/w/api.php?action=parse&page=Current_tennis_rankings&prop=text&format=json&redirects=1&origin=*";

const RANK_TTL_SECONDS = 12 * 60 * 60;
const RANK_LIMIT = 300;

async function getRankMap(tour, ctx) {
    const t = (tour === "wta") ? "wta" : "atp";
    const cache = caches.default;
    const cacheKey = new Request(`https://rank-cache.local/${t}/top${RANK_LIMIT}`, { method: "GET" });

    const cached = await cache.match(cacheKey);
    if (cached) return await cached.json();

    let map = null;
    try {
        const src = (t === "wta") ? WTA_RANK_URL : ATP_RANK_URL;
        const html = await fetchText(src);
        map = parseLiveTennisRanking(html, RANK_LIMIT);
    } catch (_) { map = null; }

    if (!map || Object.keys(map).length < 30) {
        try {
            const html = await fetchWikiParsedHTML();
            const wikiMap = parseWikiCurrentRankings(html, t, RANK_LIMIT);
            if (wikiMap && Object.keys(wikiMap).length) map = wikiMap;
        } catch (_) { }
    }

    if (!map || !Object.keys(map).length) {
        throw new Error("RANK_MAP_EMPTY");
    }

    const res = new Response(JSON.stringify(map), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${RANK_TTL_SECONDS}`
        }
    });

    const putPromise = cache.put(cacheKey, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(putPromise);
    else await putPromise;

    return map;
}

async function fetchText(url) {
    const r = await fetch(url, {
        headers: { "user-agent": "bolita-worker/1.0", "accept": "text/html" }
    });
    if (!r.ok) throw new Error(`RANK_SRC_${r.status}`);
    return await r.text();
}

async function fetchWikiParsedHTML() {
    const r = await fetch(WIKI_PARSE_URL, {
        headers: { "user-agent": "bolita-worker/1.0", "accept": "application/json" }
    });
    if (!r.ok) throw new Error(`WIKI_${r.status}`);
    const j = await r.json();
    return j?.parse?.text?.["*"] || "";
}

function parseLiveTennisRanking(html, limit) {
    const out = Object.create(null);
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

    for (const row of rows) {
        const rm = row.match(/<t[dh][^>]*>\s*([0-9]{1,3})\s*<\/t[dh]>/i);
        if (!rm) continue;
        const rank = parseInt(rm[1], 10);
        if (!(rank >= 1 && rank <= limit)) continue;

        const am = row.match(/<a[^>]*>([^<]{2,80})<\/a>/i);
        if (!am) continue;

        const name = normalizeName(am[1]);
        if (name.length < 3) continue;
        if (!out[name] || rank < out[name]) out[name] = rank;
    }

    return out;
}

function parseWikiCurrentRankings(html, tour, limit) {
    const marker = (tour === "wta") ? "WTA singles" : "ATP singles";
    const idx = html.toLowerCase().indexOf(marker.toLowerCase());
    if (idx < 0) return Object.create(null);
    const slice = html.slice(idx, idx + 250000);

    const out = Object.create(null);
    const rows = slice.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
        const rm = row.match(/<t[dh][^>]*>\s*([0-9]{1,3})\s*<\/t[dh]>/i);
        if (!rm) continue;
        const rank = parseInt(rm[1], 10);
        if (!(rank >= 1 && rank <= limit)) continue;

        const am = row.match(/<a[^>]*>([^<]{2,80})<\/a>/i);
        if (!am) continue;

        const name = normalizeName(am[1]);
        if (!out[name] || rank < out[name]) out[name] = rank;
    }
    return out;
}

function normalizeName(s) {
    return String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s'.-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokens(s) {
    return normalizeName(s)
        .split(" ")
        .map(x => x.trim())
        .filter(Boolean)
        .filter(x => x.length > 1 && x !== "jr" && x !== "sr");
}

function findRank(map, inputName) {
    const key = normalizeName(inputName);
    if (map[key]) return map[key];

    const inToks = tokens(inputName);
    if (!inToks.length) return null;

    const last = inToks[inToks.length - 1];

    let bestRank = null;
    let bestScore = -1;

    for (const k in map) {
        const candRank = map[k];
        const candToks = tokens(k);

        let score = 0;
        if (candToks.includes(last)) score += 5;

        let hits = 0;
        for (const t of inToks) if (candToks.includes(t)) hits++;
        score += hits * 2;

        if (k.includes(last)) score += 2;
        if (hits === inToks.length) score += 3;

        if (score > bestScore) {
            bestScore = score;
            bestRank = candRank;
        } else if (score === bestScore && bestRank != null && candRank < bestRank) {
            bestRank = candRank;
        }
    }

    if (bestScore < 5) return null;
    return bestRank;
}
