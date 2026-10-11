// Kalshi relay for the BTC 15 Tape page. Runs as a Cloudflare Worker with one Durable Object.
//
// Two jobs:
//  1. Forward two public, read-only REST requests (the BTC 15-minute market record and its
//     60-second-average feed) with the header browsers need. No account or key involved.
//  2. Hold ONE authenticated WebSocket to Kalshi (the owner's API key, stored as Worker secrets,
//     never in the page) and fan its frames out to every phone connected at /feed: the official
//     BRTI index (1/s with the trailing 60-s average and, in the final minute, the settlement
//     average as it accumulates; and up to 5/s raw), and the market's bid/ask as they change.
//     The upstream connection is opened when the first phone connects and closed a minute after
//     the last one leaves, so the Durable Object sleeps when nobody is watching.
//
// Secrets (Worker → Settings → Variables and Secrets): KALSHI_KEY_ID, KALSHI_PRIVATE_KEY (the PEM,
// Ed25519 or RSA), and optionally FEED_TOKEN (then phones must open /feed?token=...).

const UPSTREAMS = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2"];
const WS_UPSTREAM = "https://external-api-ws.kalshi.com/trade-api/ws/v2";   // https + Upgrade header: Workers do not take wss:// in fetch
const ALLOWED = [/^\/markets\/KXBTC15M-[A-Z0-9-]+$/, /^\/live_data\/events\/KXBTC15M-[A-Z0-9]+$/, /^\/exchange\/status$/];
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Cache-Control": "no-store"};
const WINDOW = 900;

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
    if (request.method === "OPTIONS") return new Response(null, {headers: CORS});
    if (path === "/feed" || path === "/feed/status") {
      if (env.FEED_TOKEN && url.searchParams.get("token") !== env.FEED_TOKEN) return new Response("token", {status: 403, headers: CORS});
      if (!env.FEED) return new Response("feed not configured", {status: 503, headers: CORS});
      return env.FEED.get(env.FEED.idFromName("brti")).fetch(request);
    }
    // Official BRTI history (CF Benchmarks, passed through Kalshi with the key): one hour of ticks.
    // Costs 50 of the 200 read tokens a second, so the page asks for it a few times a window at most.
    if (path === "/brti/history") {
      if (env.FEED_TOKEN && url.searchParams.get("token") !== env.FEED_TOKEN) return new Response("token", {status: 403, headers: CORS});
      if (!env.KALSHI_KEY_ID || !env.KALSHI_PRIVATE_KEY) return new Response("no key", {status: 503, headers: CORS});
      const ts = url.searchParams.get("timestamp"), span = url.searchParams.get("timespan") || "HOUR";
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(ts || "") || !/^(HOUR|DAY|MINUTE)$/.test(span)) return new Response("bad timestamp", {status: 400, headers: CORS});
      const apiPath = "/trade-api/v2/cfbenchmarks/history/values", stamp = String(Date.now());
      try {
        const sig = await signHandshake(env.KALSHI_PRIVATE_KEY, stamp + "GET" + apiPath);
        const up = await fetch("https://external-api.kalshi.com" + apiPath + "?id=BRTI&timespan=" + span + "&timestamp=" + encodeURIComponent(ts),
                               {headers: {"Accept": "application/json", "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": stamp},
                                cf: {cacheTtl: 0, cacheEverything: false}});
        const body = await up.text();
        return new Response(body, {status: up.status, headers: {...CORS, "Content-Type": "application/json"}});
      } catch (e) { return new Response("upstream unreachable: " + e.message, {status: 502, headers: CORS}); }
    }
    if (request.method !== "GET" || !ALLOWED.some(re => re.test(path))) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);     // the page and its files
      return new Response("not found", {status: 404, headers: CORS});
    }
    let last = null;
    for (const base of UPSTREAMS) {
      for (let attempt = 0; attempt < 2; attempt++) {           // one quick retry per upstream
        try {
          const up = await fetch(base + path, {headers: {"Accept": "application/json",
                                                         "User-Agent": "Mozilla/5.0 (compatible; btc15-tape relay)"},
                                               cf: {cacheTtl: 0, cacheEverything: false}});
          const body = await up.text();
          if (up.ok) return new Response(body, {status: 200, headers: {...CORS, "Content-Type": "application/json"}});
          last = new Response(body.slice(0, 300), {status: up.status, headers: {...CORS, "X-Upstream": base}});
          if (up.status !== 429 && up.status < 500) break;        // a firm answer; do not hammer
        } catch (e) {
          last = new Response("upstream unreachable: " + e.message, {status: 502, headers: {...CORS, "X-Upstream": base}});
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
    return last;
  },
};

// ---------------------------------------------------------------- the market tickers, as the page works them out
const ET = new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", year: "2-digit", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
function marketTicker(closeTs) {
  const p = {}; for (const x of ET.formatToParts(new Date(closeTs * 1000))) p[x.type] = x.value;
  return `KXBTC15M-${p.year}${p.month.toUpperCase()}${p.day}${p.hour === "24" ? "00" : p.hour}${p.minute}-${p.minute}`;
}
function currentTickers() {                     // this window's market and the next one's
  const close = (Math.floor(Date.now() / 1000 / WINDOW) + 1) * WINDOW;
  return [marketTicker(close), marketTicker(close + WINDOW)];
}

// ---------------------------------------------------------------- signing the handshake
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), c => c.charCodeAt(0));
}
function pkcs1ToPkcs8(pkcs1) {                 // wrap an "RSA PRIVATE KEY" in the PrivateKeyInfo envelope WebCrypto wants
  const len = n => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  const octet = [0x04, ...len(pkcs1.length), ...pkcs1];
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [0x02, 0x01, 0x00, ...algo, ...octet];
  return new Uint8Array([0x30, ...len(body.length), ...body]);
}
async function signHandshake(pem, message) {
  pem = pem.replace(/\\n/g, "\n").trim();
  const data = new TextEncoder().encode(message);
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    const key = await crypto.subtle.importKey("pkcs8", pkcs1ToPkcs8(pemToDer(pem)), {name: "RSA-PSS", hash: "SHA-256"}, false, ["sign"]);
    return b64(await crypto.subtle.sign({name: "RSA-PSS", saltLength: 32}, key, data));
  }
  const der = pemToDer(pem);
  try {
    const key = await crypto.subtle.importKey("pkcs8", der, {name: "Ed25519"}, false, ["sign"]);
    return b64(await crypto.subtle.sign("Ed25519", key, data));
  } catch (e) {
    const key = await crypto.subtle.importKey("pkcs8", der, {name: "RSA-PSS", hash: "SHA-256"}, false, ["sign"]);
    return b64(await crypto.subtle.sign({name: "RSA-PSS", saltLength: 32}, key, data));
  }
}

// ---------------------------------------------------------------- the Durable Object
export class KalshiFeed {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.clients = new Set();
    this.up = null; this.upState = "off"; this.upSince = 0; this.upMsgAt = 0; this.lastErr = null; this.backoff = 2000;
    this.last = {};                               // last frame of each type, replayed to a phone that just connected
    this.tickerSid = null; this.tickerSet = ""; this.subId = 1;
    this.idleTimer = null; this.retryTimer = null; this.windowTimer = null;
    this.counts = {};
  }
  status() {
    return {type: "relay", msg: {state: this.upState, since: this.upSince, lastMessage: this.upMsgAt, error: this.lastErr,
                                 clients: this.clients.size, tickers: this.tickerSet, counts: this.counts, hasKey: !!(this.env.KALSHI_KEY_ID && this.env.KALSHI_PRIVATE_KEY),
                                 // names only, never values: what the relay can see of its settings
                                 settings: Object.keys(this.env).filter(k => typeof this.env[k] === "string").map(k => k + (this.env[k] ? "" : " (empty)")),
                                 keyLooksLikePem: typeof this.env.KALSHI_PRIVATE_KEY === "string" && /BEGIN .*PRIVATE KEY/.test(this.env.KALSHI_PRIVATE_KEY)}};
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/feed/status") return new Response(JSON.stringify(this.status().msg), {headers: {...CORS, "Content-Type": "application/json"}});
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", {status: 426, headers: CORS});
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.accept();
    this.clients.add(server);
    const drop = () => { this.clients.delete(server); this.maybeIdle(); };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    server.addEventListener("message", ev => { if (ev.data === "ping") { try { server.send("pong"); } catch (e) {} } });
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try { server.send(JSON.stringify(this.status())); for (const f of Object.values(this.last)) server.send(f); } catch (e) {}
    this.ensureUpstream();
    return new Response(null, {status: 101, webSocket: client});
  }
  broadcast(text) {
    for (const c of this.clients) { try { c.send(text); } catch (e) { this.clients.delete(c); } }
  }
  maybeIdle() {
    if (this.clients.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.clients.size) this.closeUpstream("idle"); }, 60000);
  }
  closeUpstream(why) {
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.windowTimer = null; }
    const ws = this.up; this.up = null; this.upState = "off"; this.tickerSid = null; this.tickerSet = "";
    if (ws) { try { ws.close(1000, why); } catch (e) {} }
  }
  async ensureUpstream() {
    if (this.up || this.upState === "connecting") return;
    if (!this.env.KALSHI_KEY_ID || !this.env.KALSHI_PRIVATE_KEY) { this.upState = "no key"; this.broadcast(JSON.stringify(this.status())); return; }
    this.upState = "connecting"; this.broadcast(JSON.stringify(this.status()));
    try {
      const ts = String(Date.now());
      const sig = await signHandshake(this.env.KALSHI_PRIVATE_KEY, ts + "GET" + "/trade-api/ws/v2");
      const resp = await fetch(WS_UPSTREAM, {headers: {"Upgrade": "websocket", "KALSHI-ACCESS-KEY": this.env.KALSHI_KEY_ID,
                                                       "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts}});
      const ws = resp.webSocket;
      if (!ws) throw new Error("Kalshi refused the handshake: " + resp.status + " " + (await resp.text().catch(() => "")).slice(0, 120));
      ws.accept();
      this.up = ws; this.upState = "open"; this.upSince = Date.now(); this.lastErr = null; this.backoff = 2000; this.counts = {};
      ws.addEventListener("message", ev => this.onUpstream(ev.data));
      ws.addEventListener("close", ev => { if (this.up === ws) { this.up = null; this.upState = "off"; this.lastErr = "closed " + ev.code + " " + (ev.reason || ""); this.retry(); } });
      ws.addEventListener("error", () => { if (this.up === ws) { this.up = null; this.upState = "off"; this.lastErr = "socket error"; this.retry(); } });
      this.send({cmd: "subscribe", params: {channels: ["cfbenchmarks_value"], index_ids: ["BRTI"]}});
      this.send({cmd: "subscribe", params: {channels: ["cfbenchmarks_value_5hz"], index_ids: ["BRTI"]}});
      this.subscribeTickers();
      this.broadcast(JSON.stringify(this.status()));
    } catch (e) {
      this.upState = "off"; this.lastErr = String(e.message || e).slice(0, 200);
      this.broadcast(JSON.stringify(this.status()));
      this.retry();
    }
  }
  retry() {
    if (!this.clients.size || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.clients.size) this.ensureUpstream(); }, this.backoff);
    this.backoff = Math.min(60000, this.backoff * 2);
  }
  send(obj) { if (this.up) { obj.id = this.subId++; try { this.up.send(JSON.stringify(obj)); } catch (e) {} } }
  subscribeTickers() {                           // this window's market and the next; renewed at each boundary
    const tk = currentTickers(), set = tk.join(",");
    if (set !== this.tickerSet) {
      if (this.tickerSid != null) this.send({cmd: "unsubscribe", params: {sids: [this.tickerSid]}});
      this.tickerSid = null; this.tickerSet = set; this.pendingTicker = this.subId;
      this.send({cmd: "subscribe", params: {channels: ["ticker"], market_tickers: tk, send_initial_snapshot: true}});
    }
    if (this.windowTimer) clearTimeout(this.windowTimer);
    const msToBoundary = WINDOW * 1000 - (Date.now() % (WINDOW * 1000));
    this.windowTimer = setTimeout(() => { this.windowTimer = null; if (this.up) this.subscribeTickers(); }, msToBoundary + 1500);
  }
  onUpstream(data) {
    if (typeof data !== "string") return;
    this.upMsgAt = Date.now();
    let d; try { d = JSON.parse(data); } catch (e) { return; }
    if (!d || !d.type) return;
    this.counts[d.type] = (this.counts[d.type] || 0) + 1;
    if (d.type === "subscribed" && d.msg && d.msg.channel === "ticker") this.tickerSid = d.msg.sid;
    if (d.type === "error") { this.lastErr = "kalshi error " + JSON.stringify(d.msg).slice(0, 150); this.broadcast(JSON.stringify(this.status())); return; }
    if (d.type === "cfbenchmarks_value" || d.type === "cfbenchmarks_value_5hz" || d.type === "ticker") {
      this.last[d.type] = data;
      this.broadcast(data);
    }
  }
}
