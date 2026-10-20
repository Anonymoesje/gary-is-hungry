// Gary Is Hungry leaderboard. GET /scores?v=2&seed=d20261020 (or seed=all), POST /scores.
//
// Security model:
// - Scores can't be faked: every submitted run is replayed with the game's own physics and must
//   reproduce the claimed distance exactly.
// - Nobody can overwrite someone else's row: rows are keyed by a SHA-256 of the player's private id,
//   which never leaves their browser except in their own submissions.
// - Abuse is bounded: per-IP rate limits, a body size cap, a frame cap on replays, strict input
//   patterns, a cap on rows per course, and parameterized SQL only.
// - Responses are plain JSON with locked-down headers, and only the game's own origin gets CORS.
import { SIM, Course, simulateGhost, decodeFlips, encodeFlips, cleanName } from './sim.js';
export { Room } from './room.js';
export { Limiter } from './limiter.js';
import { visitorKey } from './limiter.js';

// Party codes: 5 characters without look-alikes (no 0/O, 1/I).
const ROOM_PATH = /^\/room\/([A-HJ-NP-Z2-9]{5})$/;

const ALLOWED = ['https://anonymoesje.github.io'];
const GAME_URL = 'https://anonymoesje.github.io/gary-is-hungry/';
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const DAILY = /^d(\d{4})(\d{2})(\d{2})$/;
const FRAME_CAP = 120 * 60 * 15;   // a quarter of an hour of play is far beyond any real run
const MAX_BODY = 16000;
const MAX_ROWS_PER_COURSE = 5000;

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

function cors(origin, env) {
  const ok = ALLOWED.includes(origin) || (env.ALLOW_LOCAL === '1' && LOCAL.test(origin));
  if (!ok) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (body, status, extra) => new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
// Daily courses follow each player's local date, so allow a day either side of UTC today.
function recentDaily(seed) {
  const m = DAILY.exec(seed);
  if (!m) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.abs(t - Date.now()) < 2 * 86400000;
}
// Rate limit bindings are optional, so a missing binding never takes the board down.
async function allowed(limiter, key) {
  if (!limiter) return true;
  try { return (await limiter.limit({ key })).success; } catch (e) { console.warn('rate limiter failed', String(e)); return true; }
}
// Exact count per visitor and action, on top of the approximate built-in limiter.
async function allowedExact(env, action, ip, limit, windowMs) {
  if (!env.LIMITS) return true;
  try { return await env.LIMITS.get(env.LIMITS.idFromName(action + '|' + visitorKey(ip))).hit(limit, windowMs); }
  catch (e) { console.warn('exact limiter failed', String(e)); return true; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = cors(req.headers.get('origin') || '', env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...h } });
    // people who open the server's own address land on the game instead of a bare error
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      return new Response(null, { status: 302, headers: { Location: GAME_URL, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const room = ROOM_PATH.exec(url.pathname);
    if (room) {
      // Browsers always send Origin on a WebSocket upgrade, so only the game's own page gets in.
      if (!(await allowed(env.CONNECTS, ip)) || !(await allowedExact(env, 'connect', ip, 20, 60000))) return json({ error: 'slow down' }, 429, {});
      const origin = req.headers.get('origin') || '';
      if (!(ALLOWED.includes(origin) || (env.ALLOW_LOCAL === '1' && LOCAL.test(origin)))) return json({ error: 'forbidden' }, 403, {});
      if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'websocket only' }, 426, {});
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(req);
    }
    if (url.pathname !== '/scores') return json({ error: 'not found' }, 404, h);
    try {
      if (req.method === 'GET') {
        if (!(await allowed(env.READS, ip))) return json({ error: 'slow down' }, 429, h);
        return await list(url, env, h);
      }
      if (req.method === 'POST') {
        if (!(await allowed(env.WRITES, ip)) || !(await allowedExact(env, 'write', ip, 6, 60000))) return json({ error: 'slow down' }, 429, h);
        return await submit(req, env, h);
      }
      return json({ error: 'method not allowed' }, 405, { ...h, Allow: 'GET, POST, OPTIONS' });
    } catch (e) {
      return json({ error: 'server error' }, 500, h);
    }
  },
};

async function list(url, env, h) {
  if (Number(url.searchParams.get('v')) !== SIM) return json({ entries: [], total: 0, old: true }, 200, h);
  const seed = url.searchParams.get('seed') || '';
  if (seed === 'all') {
    // SQLite returns the other columns from the row that holds MAX(d), so this is each player's best run.
    const { results } = await env.DB.prepare(
      'SELECT ph AS h, name, col, seed, MAX(d) AS d, f, at FROM scores WHERE v = ?1 GROUP BY ph ORDER BY d DESC, at ASC LIMIT 25'
    ).bind(SIM).all();
    return json({ entries: results }, 200, h);
  }
  if (!DAILY.test(seed)) return json({ error: 'bad seed' }, 400, h);
  const { results } = await env.DB.prepare(
    'SELECT ph AS h, name, col, seed, d, f, at FROM scores WHERE v = ?1 AND seed = ?2 ORDER BY d DESC, at ASC LIMIT 25'
  ).bind(SIM, seed).all();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE v = ?1 AND seed = ?2').bind(SIM, seed).first();
  return json({ entries: results, total: row ? row.n : 0 }, 200, h);
}

async function readBody(req) {
  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return null;
  const len = Number(req.headers.get('content-length'));
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function submit(req, env, h) {
  const b = await readBody(req);
  if (!b || typeof b !== 'object') return json({ error: 'bad request' }, 400, h);
  if (b.v !== SIM) return json({ error: 'old version' }, 409, h);
  const pid = typeof b.pid === 'string' && /^[0-9a-f]{24}$/.test(b.pid) ? b.pid : null;
  const seed = typeof b.seed === 'string' && recentDaily(b.seed) ? b.seed : null;
  const f = typeof b.f === 'string' && /^[0-9a-zA-Z_~-]{1,9000}$/.test(b.f) ? b.f : null;
  const claimed = Number.isInteger(b.d) ? b.d : -1;
  if (!pid || !seed || !f || claimed < 1 || claimed > 100000) return json({ error: 'bad entry' }, 400, h);
  const flips = decodeFlips(f);
  if (!flips) return json({ error: 'bad ghost' }, 400, h);

  const run = simulateGhost(new Course(seed), flips, FRAME_CAP);
  if (run.alive || run.d !== claimed) return json({ error: 'replay does not match' }, 422, h);
  // Flips after the runner died change nothing, so they are dropped. That makes every run's ghost
  // canonical, and a ghost copied from the board (padded or not) is recognised as a copy.
  const ghost = encodeFlips(flips.filter(fr => fr < run.frames));

  const name = cleanName(b.name) || 'Someone';
  const col = Number.isInteger(b.col) && b.col >= 0 && b.col <= 3 ? b.col : 0;
  const ph = await sha(pid);
  const copy = await env.DB.prepare('SELECT 1 AS x FROM scores WHERE seed = ?1 AND f = ?2 AND ph <> ?3 LIMIT 1').bind(seed, ghost, ph).first();
  if (copy) return json({ error: 'that run is already on the board' }, 409, h);
  const existing = await env.DB.prepare('SELECT d FROM scores WHERE ph = ?1 AND seed = ?2').bind(ph, seed).first();
  if (!existing) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE seed = ?1').bind(seed).first();
    if (count && count.n >= MAX_ROWS_PER_COURSE) return json({ error: 'board full' }, 503, h);
  }
  await env.DB.prepare(
    `INSERT INTO scores (ph, seed, name, col, d, f, v, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (ph, seed) DO UPDATE SET name = excluded.name, col = excluded.col, d = excluded.d, f = excluded.f, v = excluded.v, at = excluded.at
     WHERE excluded.d > scores.d OR scores.v <> excluded.v`
  ).bind(ph, seed, name, col, claimed, ghost, SIM, Date.now()).run();
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE v = ?1 AND seed = ?2 AND d > ?3').bind(SIM, seed, claimed).first();
  return json({ ok: true, rank: (r ? r.n : 0) + 1 }, 200, h);
}
