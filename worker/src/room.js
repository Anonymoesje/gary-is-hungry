// One party room per code. Every player keeps a small presence object (name, colour, lobby hops,
// race and run position) and the room relays changes to everyone else in it.
//
// The room trusts nothing it receives: each field is checked against a fixed shape, unknown fields
// are dropped, messages are size and rate capped, and a room holds at most MAX_PEERS players.
// Nothing is stored. When the last player leaves, the room forgets everything.
import { DurableObject } from 'cloudflare:workers';
import { cleanName } from './sim.js';

const MAX_PEERS = 8;
const MAX_MSG = 1024;        // bytes per message
const MAX_PRESENCE = 1200;   // bytes per player, well under the 2 KB socket attachment limit
const RATE = 25, BURST = 50; // messages per second per player

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const RACE_ID = /^[a-z0-9]{4,10}$/;
const FIELDS = {
  live: v => (v ? 1 : undefined),
  nick: v => (typeof v === 'string' ? cleanName(v) || undefined : undefined),
  col: v => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined),
  hop: v => (Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : undefined),
  race: v => {
    if (!v || typeof v !== 'object') return undefined;
    const id = typeof v.id === 'string' && RACE_ID.test(v.id) ? v.id : null;
    const seed = typeof v.seed === 'string' && /^[a-z0-9]{1,16}$/.test(v.seed) ? v.seed : null;
    const cd = num(v.cd, 0, 8000);
    return id && seed && cd !== undefined ? { id, seed, cd } : undefined;
  },
  run: v => {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !RACE_ID.test(v.id)) return undefined;
    const x = num(v.x, -50, 1e6), y = num(v.y, -5, 17), d = num(v.d, 0, 1e6);
    if (x === undefined || y === undefined || d === undefined) return undefined;
    // the frame they are on and their latest flip frames, strictly increasing and never in the future
    const f = Number.isInteger(v.f) && v.f >= 0 && v.f <= 1e7 ? v.f : 0;
    const fl = [];
    if (Array.isArray(v.fl)) {
      for (const k of v.fl.slice(0, 32)) {
        if (!Number.isInteger(k) || k < 0 || k > f || (fl.length && k <= fl[fl.length - 1])) return undefined;
        fl.push(k);
      }
    }
    return { id: v.id, f, fl, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, g: v.g < 0 ? -1 : 1, a: v.a ? 1 : 0, d: Math.floor(d) };
  },
};
function applyPatch(prev, patch) {
  const p = { ...prev };
  for (const k of Object.keys(patch).slice(0, 12)) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, k)) continue;
    const v = patch[k];
    if (v === null) { delete p[k]; continue; }
    const clean = FIELDS[k](v);
    if (clean !== undefined) p[k] = clean;
  }
  return p;
}
function peerId() {
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.buckets = new Map();
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if (this.ctx.getWebSockets().length > MAX_PEERS) {
      // say why before closing, the close frame alone doesn't always reach a socket that just opened
      server.serializeAttachment({ full: true });
      server.send(JSON.stringify({ t: 'full' }));
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const peer = peerId();
    server.serializeAttachment({ peer, p: {} });
    server.send(JSON.stringify({ t: 'hello', you: peer, peers: this.everyoneBut(server) }));
    this.broadcast(server, { t: 'u', peer, p: {} });
    return new Response(null, { status: 101, webSocket: client });
  }

  everyoneBut(except) {
    const out = [];
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      const a = w.deserializeAttachment();
      if (a && a.peer) out.push({ peer: a.peer, p: a.p || {} });
    }
    return out;
  }

  broadcast(from, msg) {
    const s = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === from) continue;
      const a = w.deserializeAttachment();
      if (!a || !a.peer) continue;   // turned-away sockets hear nothing
      try { w.send(s); } catch (e) { /* a closing socket is fine to skip */ }
    }
  }

  take(ws) {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b) { b = { tokens: BURST, at: now }; this.buckets.set(ws, b); }
    b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MSG) { ws.close(4009, 'message too big'); return; }
    if (!this.take(ws)) { ws.close(4008, 'too many messages'); return; }
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || m.t !== 'p' || !m.patch || typeof m.patch !== 'object' || Array.isArray(m.patch)) return;
    const a = ws.deserializeAttachment();
    if (!a || !a.peer) { ws.close(4001, 'room full'); return; }
    const p = applyPatch(a.p || {}, m.patch);
    if (JSON.stringify(p).length > MAX_PRESENCE) return;
    a.p = p;
    ws.serializeAttachment(a);
    this.broadcast(ws, { t: 'u', peer: a.peer, p });
  }

  async webSocketClose(ws) { this.left(ws); try { ws.close(1000, 'bye'); } catch (e) {} }
  async webSocketError(ws) { this.left(ws); }

  left(ws) {
    this.buckets.delete(ws);
    const a = ws.deserializeAttachment();
    if (a && a.peer) this.broadcast(ws, { t: 'l', peer: a.peer });
  }
}
