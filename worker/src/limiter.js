// Exact per-visitor limits. Cloudflare's built-in rate limiter counts per server and lets floods spread
// over many connections slip through, so each visitor (and action) gets one tiny counter object here.
// One object per key means every request for that key is counted in one place.
import { DurableObject } from 'cloudflare:workers';

export class Limiter extends DurableObject {
  // fixed window: at most `limit` hits per `windowMs`
  hit(limit, windowMs) {
    const now = Date.now();
    if (!this.win || now - this.win.start >= windowMs) this.win = { start: now, n: 0 };
    this.win.n += 1;
    return this.win.n <= limit;
  }
}

// IPv6 visitors usually own a whole /64, so they are counted per /64 rather than per address.
export function visitorKey(ip) {
  if (!ip.includes(':')) return ip;
  const parts = ip.split(':');
  return parts.slice(0, 4).join(':') + '::/64';
}
