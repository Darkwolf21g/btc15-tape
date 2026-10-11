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
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Cache-Control": "no-store"};
const WINDOW = 900;

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
    if (request.method === "OPTIONS") return new Response(null, {headers: {...CORS, "Access-Control-Allow-Headers": "Content-Type"}});
    if (path === "/feed" || path === "/feed/status" || path === "/record" || path === "/record.csv" || path === "/collector/status" || path === "/trade/status" || path === "/trade/config") {
      if (env.FEED_TOKEN && url.searchParams.get("token") !== env.FEED_TOKEN) return new Response("token", {status: 403, headers: CORS});
      if (!env.FEED) return new Response("feed not configured", {status: 503, headers: CORS});
      return env.FEED.get(env.FEED.idFromName("brti")).fetch(request);
    }
    // Self-test: sign a cheap authenticated REST call and report what Kalshi says (status codes only).
    if (path === "/feed/selftest") {
      if (env.FEED_TOKEN && url.searchParams.get("token") !== env.FEED_TOKEN) return new Response("token", {status: 403, headers: CORS});
      const out = {keyIdLength: (env.KALSHI_KEY_ID || "").length, keyIdTrimmedLength: (env.KALSHI_KEY_ID || "").trim().length,
                   keyIdShape: /^[0-9a-f-]{36}$/.test((env.KALSHI_KEY_ID || "").trim()) ? "uuid" : "not a uuid",
                   pemLines: (env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim().split("\n").length,
                   pemHeader: ((env.KALSHI_PRIVATE_KEY || "").match(/-----BEGIN [A-Z ]*-----/) || ["none"])[0]};
      try {
        const der = pemToDer((env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n"));
        out.derBytes = der.length;                     // an Ed25519 PKCS#8 key is 48 bytes
        for (const apiPath of ["/trade-api/v2/portfolio/balance", "/trade-api/v2/cfbenchmarks/values"]) {
          const stamp = String(Date.now());
          const sig = await signHandshake(env.KALSHI_PRIVATE_KEY, stamp + "GET" + apiPath);
          const up = await fetch("https://external-api.kalshi.com" + apiPath + (apiPath.endsWith("values") ? "?id=BRTI" : ""),
                                 {headers: {"Accept": "application/json", "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID.trim(), "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": stamp}});
          const body = await up.text();
          out[apiPath] = {status: up.status, reply: up.ok ? "ok (" + body.length + " bytes)" : body.slice(0, 160)};
        }
      } catch (e) { out.error = String(e.message || e).slice(0, 200); }
      return new Response(JSON.stringify(out), {headers: {...CORS, "Content-Type": "application/json"}});
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
                               {headers: {"Accept": "application/json", "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID.trim(), "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": stamp},
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

// ---------------------------------------------------------------- the collector's model (the page's maths, on REST data)
const SETTLE = 60, VOL_TAU = 180, CHECKS = [600, 300, 120, 60];
const tailCdf = z => 0.5 + z * (z * z + 6) / (2 * Math.pow(z * z + 4, 1.5));
function feeCents(p) { return 100 * (Math.min(0.01, 0.10 * p * (1 - p)) + 0.01); }
// ticks: [[ms, value]] sorted; volatility from 5-s changes over the last 2 and 15 minutes
function volsFrom(ticks, nowMs) {
  const perSec = new Map();
  for (const [ms, v] of ticks) perSec.set(Math.floor(ms / 1000), v);
  const est = span => { let sum = 0, n = 0; const from = Math.floor(nowMs / 1000) - span;
    for (let t = from; t <= Math.floor(nowMs / 1000); t++) { const a = perSec.get(t), b = perSec.get(t - 5); if (a != null && b != null) { sum += (a - b) ** 2 / 5; n++; } }
    return n >= 12 ? Math.max(0.5, Math.sqrt(sum / n)) : null; };
  const s = est(120), l = est(900);
  return s && l ? {s, l} : null;
}
function projectFrom(ticks, nowMs, closeS, x, vols) {
  const now = nowMs / 1000;
  const perSec = new Map(); for (const [ms, v] of ticks) perSec.set(Math.floor(ms / 1000), v);
  let known = 0, observed = 0; const ahead = [];
  for (let sec = closeS - SETTLE + 1; sec <= closeS; sec++) {
    if (sec <= now) { const v = perSec.get(sec); if (v != null) { known += v; observed++; } else { known += x; observed++; } }   // a missing elapsed second is carried at spot
    else ahead.push(sec - now);
  }
  const m = ahead.length, vs = vols.s * vols.s, vl = vols.l * vols.l;
  let variance = 0, previous = 0;
  for (let j = 0; j < m; j++) { const u = ahead[j], c = m - j; variance += (vl * (u - previous) + (vs - vl) * VOL_TAU * (Math.exp(-previous / VOL_TAU) - Math.exp(-u / VOL_TAU))) * c * c; previous = u; }
  const mean = (known + m * x) / (observed + m), sd = Math.sqrt(variance / ((observed + m) ** 2) + 0.3 * 0.3);
  return {mean, sd, observed, m};
}
async function signedGet(env, apiPath, query) {
  const stamp = String(Date.now()), sig = await signHandshake(env.KALSHI_PRIVATE_KEY, stamp + "GET" + apiPath);
  const r = await fetch("https://external-api.kalshi.com" + apiPath + (query || ""), {headers: {"Accept": "application/json", "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID.trim(), "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": stamp}});
  if (!r.ok) throw new Error(apiPath + " " + r.status + " " + (await r.text()).slice(0, 100));
  return r.json();
}
const HOSTS = {live: "https://external-api.kalshi.com", demo: "https://demo-api.kalshi.co"};
function keysFor(env, mode) {
  return mode === "demo" ? {id: env.KALSHI_DEMO_KEY_ID, pem: env.KALSHI_DEMO_PRIVATE_KEY} : {id: env.KALSHI_KEY_ID, pem: env.KALSHI_PRIVATE_KEY};
}
async function signedCall(env, mode, method, apiPath, body) {
  const k = keysFor(env, mode);
  if (!k.id || !k.pem) throw new Error("no " + mode + " key");
  const stamp = String(Date.now()), sig = await signHandshake(k.pem, stamp + method + apiPath);
  const r = await fetch(HOSTS[mode === "demo" ? "demo" : "live"] + apiPath, {method, body: body ? JSON.stringify(body) : undefined,
    headers: {"Accept": "application/json", "Content-Type": "application/json", "KALSHI-ACCESS-KEY": k.id.trim(), "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": stamp}});
  const text = await r.text();
  if (!r.ok) throw new Error(method + " " + apiPath + " " + r.status + " " + text.slice(0, 160));
  return text ? JSON.parse(text) : {};
}
const etDay = ms => new Intl.DateTimeFormat("en-CA", {timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(ms));
const tailFromBand = (mean, sd, tgt) => tailCdf((mean - (tgt - 0.005)) / sd);
function parseTicks(d) {                        // the CF Benchmarks history payload, tolerant of its shape
  const pl = d && d.data ? d.data.payload : d && d.payload;
  const rows = Array.isArray(pl) ? pl : pl && (pl.values || pl.data || pl.items);
  const out = [];
  for (const t of rows || []) {
    const when = t.time != null ? t.time : t.timestamp != null ? t.timestamp : t.t, v = +(t.value != null ? t.value : t.v);
    const ms = typeof when === "number" ? (when > 1e11 ? when : when * 1000) : Date.parse(when);
    if (v > 0 && ms > 0) out.push([ms, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------- the Durable Object
export class KalshiFeed {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.clients = new Set();
    this.up = null; this.upState = "off"; this.upSince = 0; this.upMsgAt = 0; this.lastErr = null; this.backoff = 2000;
    this.last = {};                               // last frame of each type, replayed to a phone that just connected
    this.tickerSid = null; this.bookSid = null; this.tickerSet = ""; this.subId = 1;
    this.books = {};                              // ticker -> {yes: Map(price -> qty), no: Map(price -> qty)}
    this.idleTimer = null; this.retryTimer = null; this.windowTimer = null;
    this.counts = {};
    this.ticks = [];                              // [[ms, value]] from the stream, last 20 minutes, for the agent
    this.settleAvg = null;                        // Kalshi's accumulating final-minute average, when streamed
    this.lastTicker = {};                         // ticker -> {bid, ask, at}
    this.agentBusy = false;
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
    if (url.pathname === "/feed/status") { await this.ensureAlarm(); return new Response(JSON.stringify(this.status().msg), {headers: {...CORS, "Content-Type": "application/json"}}); }
    if (url.pathname === "/trade/status") {
      const cfg = await this.tradeConfig(), log = await this.tradeLog(), day = (await this.state.storage.get("trade.day")) || null;
      const all = await this.state.storage.list({prefix: "t:"}), windows = [...all.values()].sort((a, b) => a.close - b.close).slice(-60);
      return new Response(JSON.stringify({config: cfg, today: day, hasDemoKey: !!(this.env.KALSHI_DEMO_KEY_ID && this.env.KALSHI_DEMO_PRIVATE_KEY), tokenSet: !!this.env.FEED_TOKEN,
        stream: this.upState, ticks: this.ticks.length, windows, decisions: log.decisions.slice(-30), errors: log.errors.slice(-10)}), {headers: {...CORS, "Content-Type": "application/json"}});
    }
    if (url.pathname === "/trade/config") {
      if (request.method !== "POST") return new Response("POST", {status: 405, headers: CORS});
      if (!this.env.FEED_TOKEN) return new Response("set FEED_TOKEN on the Worker before controlling the agent", {status: 403, headers: CORS});
      let body; try { body = await request.json(); } catch (e) { return new Response("json", {status: 400, headers: CORS}); }
      const cfg = await this.tradeConfig();
      if (body.mode != null) {
        if (!["off", "paper", "demo", "live"].includes(body.mode)) return new Response("mode", {status: 400, headers: CORS});
        if (body.mode === "live" && body.confirm !== "LIVE") return new Response("live needs confirm: LIVE", {status: 400, headers: CORS});
        if (body.mode === "demo" && !(this.env.KALSHI_DEMO_KEY_ID && this.env.KALSHI_DEMO_PRIVATE_KEY)) return new Response("demo needs KALSHI_DEMO_KEY_ID and KALSHI_DEMO_PRIVATE_KEY", {status: 400, headers: CORS});
        cfg.mode = body.mode;
      }
      for (const k of ["perWindowCents", "dailyLossStopCents", "maxTradesPerDay", "minEdge", "bankrollCents", "firstSeconds", "lastSeconds"]) if (body[k] != null && Number.isFinite(+body[k])) cfg[k] = +body[k];
      cfg.perWindowCents = Math.min(cfg.perWindowCents, 5000);                 // a hard ceiling of $50 a window, whatever is asked
      await this.state.storage.put("trade.cfg", cfg);
      await this.state.storage.setAlarm(this.nextEvent(Date.now(), cfg.mode !== "off", cfg));
      if (cfg.mode !== "off") this.ensureUpstream();
      return new Response(JSON.stringify(cfg), {headers: {...CORS, "Content-Type": "application/json"}});
    }
    if (url.pathname === "/collector/status") { await this.ensureAlarm(); const c = (await this.state.storage.get("collector")) || {}; c.nextAlarm = await this.state.storage.getAlarm(); return new Response(JSON.stringify(c), {headers: {...CORS, "Content-Type": "application/json"}}); }
    if (url.pathname === "/record" || url.pathname === "/record.csv") {
      await this.ensureAlarm();
      const all = await this.state.storage.list({prefix: "w:"});
      const rows = [...all.values()].sort((a, b) => a.close - b.close).slice(-400);
      if (url.pathname === "/record") return new Response(JSON.stringify(rows), {headers: {...CORS, "Content-Type": "application/json"}});
      const lines = ["ticker,close_utc,target,result,official_close_avg,check_s,model_p,model_p_matched,ask,bid,spot,sd"];
      for (const w of rows) for (const [c, k] of Object.entries(w.checks || {})) lines.push([w.mk, new Date(w.close * 1000).toISOString(), w.tgt, w.result || "", w.officialCloseAvg || "", c, k.p, k.p2, k.ask, k.bid, k.x, k.sd].join(","));
      return new Response(lines.join("\n"), {headers: {...CORS, "Content-Type": "text/csv"}});
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", {status: 426, headers: CORS});
    await this.ensureAlarm();
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.accept();
    this.clients.add(server);
    const drop = () => { this.clients.delete(server); this.maybeIdle(); };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    server.addEventListener("message", ev => { if (ev.data === "ping") { try { server.send("pong"); } catch (e) {} } });
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      server.send(JSON.stringify(this.status()));
      for (const f of Object.values(this.last)) server.send(f);
      for (const [tk, b] of Object.entries(this.books)) server.send(JSON.stringify(this.snapshotOf(tk, b)));   // the books as they stand now
    } catch (e) {}
    this.ensureUpstream();
    return new Response(null, {status: 101, webSocket: client});
  }
  broadcast(text) {
    for (const c of this.clients) { try { c.send(text); } catch (e) { this.clients.delete(c); } }
  }
  maybeIdle() {
    if (this.clients.size || this.idleTimer) return;
    this.idleTimer = setTimeout(async () => { this.idleTimer = null; const cfg = await this.tradeConfig(); if (!this.clients.size && cfg.mode === "off") this.closeUpstream("idle"); }, 60000);
  }
  closeUpstream(why) {
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.windowTimer = null; }
    const ws = this.up; this.up = null; this.upState = "off"; this.tickerSid = null; this.bookSid = null; this.tickerSet = ""; this.books = {};
    if (ws) { try { ws.close(1000, why); } catch (e) {} }
  }
  async ensureUpstream() {
    if (this.up || this.upState === "connecting") return;
    if (!this.env.KALSHI_KEY_ID || !this.env.KALSHI_PRIVATE_KEY) { this.upState = "no key"; this.broadcast(JSON.stringify(this.status())); return; }
    this.upState = "connecting"; this.broadcast(JSON.stringify(this.status()));
    try {
      const ts = String(Date.now());
      const sig = await signHandshake(this.env.KALSHI_PRIVATE_KEY, ts + "GET" + "/trade-api/ws/v2");
      const resp = await fetch(WS_UPSTREAM, {headers: {"Upgrade": "websocket", "KALSHI-ACCESS-KEY": this.env.KALSHI_KEY_ID.trim(),
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
      const old = [this.tickerSid, this.bookSid].filter(x => x != null);
      if (old.length) this.send({cmd: "unsubscribe", params: {sids: old}});
      this.tickerSid = null; this.bookSid = null; this.tickerSet = set;
      for (const t of Object.keys(this.books)) if (!tk.includes(t)) delete this.books[t];
      this.send({cmd: "subscribe", params: {channels: ["ticker"], market_tickers: tk, send_initial_snapshot: true}});
      this.send({cmd: "subscribe", params: {channels: ["orderbook_delta"], market_tickers: tk}});
    }
    if (this.windowTimer) clearTimeout(this.windowTimer);
    const msToBoundary = WINDOW * 1000 - (Date.now() % (WINDOW * 1000));
    this.windowTimer = setTimeout(() => { this.windowTimer = null; if (this.up) this.subscribeTickers(); }, msToBoundary + 1500);
  }
  // ---- the collector: scores every window whether or not a page is open
  async ensureAlarm() {
    if (!(this.env.KALSHI_KEY_ID && this.env.KALSHI_PRIVATE_KEY)) return;
    if ((await this.state.storage.getAlarm()) == null) { const cfg = await this.tradeConfig(); await this.state.storage.setAlarm(this.nextEvent(Date.now(), cfg.mode !== "off", cfg)); }
  }
  nextEvent(nowMs, agentOn, cfg) {             // the next checkpoint, settlement or agent moment after now, in ms
    const now = nowMs / 1000, close = (Math.floor(now / WINDOW) + 1) * WINDOW, times = [];
    for (const c of [close - WINDOW, close, close + WINDOW]) { for (const k of CHECKS) times.push(c - k); times.push(c + 90, c + 400); }
    if (agentOn) {
      const first = cfg ? cfg.firstSeconds : 300, lastS = cfg ? cfg.lastSeconds : 15;
      const zoneStart = close - WINDOW + first, zoneEnd = close - lastS;
      if (now < zoneStart - 1) times.push(zoneStart); else if (now < zoneEnd - 1) times.push(now + 5); else times.push(close + first);
    }
    return Math.min(...times.filter(t => t > now + 0.5)) * 1000;
  }
  async alarm() {
    const nowMs = Date.now(), now = nowMs / 1000, log = (await this.state.storage.get("collector")) || {runs: 0, errors: []};
    log.runs++; log.lastRun = nowMs;
    try {
      const close = (Math.floor(now / WINDOW) + 1) * WINDOW, left = close - now;
      const check = CHECKS.find(k => Math.abs(left - k) < 20);
      if (check) await this.checkpoint(marketTicker(close), close, check, nowMs);
      const prevClose = close - WINDOW, since = now - prevClose;
      if (since > 60 && since < 450) { await this.settle(marketTicker(prevClose), prevClose); await this.settleTrades(marketTicker(prevClose), prevClose); }
      log.lastOk = nowMs;
    } catch (e) { log.errors = (log.errors || []).concat([{at: nowMs, error: String(e.message || e).slice(0, 200)}]).slice(-10); }
    await this.state.storage.put("collector", log);
    const cfg = await this.tradeConfig(), on = cfg.mode !== "off";
    if (on) await this.agentTick(nowMs);
    else if (!this.clients.size && this.up) this.closeUpstream("agent off");
    await this.state.storage.setAlarm(this.nextEvent(Date.now(), on, cfg));
  }
  async checkpoint(mk, close, check, nowMs) {
    const key = "w:" + mk, w = (await this.state.storage.get(key)) || {mk, close, tgt: null, checks: {}, result: null, src: null, relay: true};
    if (w.checks[check]) return;
    const hour = Math.floor(nowMs / 3600000) * 3600000;
    const [hist, prev, mkt] = await Promise.all([
      signedGet(this.env, "/trade-api/v2/cfbenchmarks/history/values", "?id=BRTI&timespan=HOUR&timestamp=" + new Date(hour).toISOString()),
      nowMs - hour < 1000 * 1000 ? signedGet(this.env, "/trade-api/v2/cfbenchmarks/history/values", "?id=BRTI&timespan=HOUR&timestamp=" + new Date(hour - 3600000).toISOString()) : null,
      signedGet(this.env, "/trade-api/v2/markets/" + mk)]);
    const ticks = parseTicks(prev).concat(parseTicks(hist)).filter(t => t[0] <= nowMs);
    const m = mkt && mkt.market;
    if (m && +m.floor_strike > 0) w.tgt = +m.floor_strike;
    const ask = m && +m.yes_ask_dollars > 0 ? +m.yes_ask_dollars : null, bid = m && +m.yes_bid_dollars > 0 ? +m.yes_bid_dollars : null;
    const vols = volsFrom(ticks, nowMs), x = ticks.length ? ticks[ticks.length - 1][1] : null;
    const entry = {ask, bid, x, at: nowMs, ticks: ticks.length};
    if (vols && x != null && w.tgt != null) {
      const pr = projectFrom(ticks, nowMs, close, x, vols);
      entry.p = +tailCdf((pr.mean - (w.tgt - 0.005)) / pr.sd).toFixed(3);
      entry.p2 = +tailCdf((pr.mean - (w.tgt - 0.005)) / (pr.sd / Math.SQRT2)).toFixed(3);
      entry.sd = +pr.sd.toFixed(2); entry.mean = +pr.mean.toFixed(2);
    }
    w.checks[check] = entry;
    await this.state.storage.put(key, w);
  }
  async settle(mk, close) {
    const key = "w:" + mk, w = await this.state.storage.get(key);
    if (!w || w.src === "kalshi") return;
    const d = await signedGet(this.env, "/trade-api/v2/markets/" + mk), m = d && d.market;
    if (m && (m.result === "yes" || m.result === "no")) {
      w.result = m.result; w.src = "kalshi";
      if (+m.floor_strike > 0) w.tgt = +m.floor_strike;
      if (m.expiration_value != null && Number.isFinite(+m.expiration_value)) w.officialCloseAvg = +m.expiration_value;
      await this.state.storage.put(key, w);
    }
  }
  pushTick(ms, v) {
    const last = this.ticks[this.ticks.length - 1];
    if (last && Math.abs(v - last[1]) > 0.005 * last[1] && ms - last[0] < 10000) { this.oddTick = (this.oddTick || 0) + 1; if (this.oddTick < 2) return; }
    this.oddTick = 0;
    if (!last || ms >= last[0]) this.ticks.push([ms, v]);
    const cut = ms - 1200000; while (this.ticks.length && this.ticks[0][0] < cut) this.ticks.shift();
  }

  // ---- the execution agent
  // Runs from 10 minutes before each close to 15 seconds before it, every 5 seconds, on the stream.
  // Modes: off (default), paper (decides, logs, scores; no orders), demo (Kalshi's demo exchange,
  // its own key pair), live. Every order is a limit at the ask, immediate-or-cancel, so nothing rests.
  async tradeConfig() {
    const c = (await this.state.storage.get("trade.cfg")) || {};
    return Object.assign({mode: "off", perWindowCents: 1000, dailyLossStopCents: 3000, maxTradesPerDay: 12, minEdge: 3, bankrollCents: 50000, firstSeconds: 300, lastSeconds: 15}, c);
  }
  async tradeLog() { return (await this.state.storage.get("trade.log")) || {decisions: [], errors: []}; }
  async agentTick(nowMs) {
    const cfg = await this.tradeConfig();
    if (cfg.mode === "off" || this.agentBusy) return;
    this.agentBusy = true;
    const log = await this.tradeLog();
    try {
      const now = nowMs / 1000, close = (Math.floor(now / WINDOW) + 1) * WINDOW, left = close - now, mk = marketTicker(close);
      if (left > WINDOW - cfg.firstSeconds || left < cfg.lastSeconds) return;
      if (!this.up) { await this.ensureUpstream(); return; }                    // the stream feeds the model; try again next tick
      const key = "t:" + mk, w = (await this.state.storage.get(key)) || {mk, close, trades: [], decided: 0};
      if (w.trades.length) return;                                              // one trade per window
      const day = etDay(nowMs), today = (await this.state.storage.get("trade.day")) || {day, trades: 0, pnlCents: 0};
      if (today.day !== day) { today.day = day; today.trades = 0; today.pnlCents = 0; }
      if (today.trades >= cfg.maxTradesPerDay || today.pnlCents <= -cfg.dailyLossStopCents) return;
      const last = this.ticks[this.ticks.length - 1];
      if (!last || nowMs - last[0] > 3000 || this.ticks.length < 200) return;
      let tgt = w.tgt;
      if (!tgt) { const d = await signedGet(this.env, "/trade-api/v2/markets/" + mk); tgt = d && d.market && +d.market.floor_strike > 0 ? +d.market.floor_strike : null; if (!tgt) return; w.tgt = tgt; }
      const vols = volsFrom(this.ticks, nowMs); if (!vols) return;
      const x = last[1];
      const projectWith = (xx, vv) => {
        const pr = projectFrom(this.ticks, nowMs, close, xx, vv);
        const sa = this.settleAvg;
        if (sa && nowMs - sa.at < 3000 && Math.abs(sa.end - close * 1000) < 90000 && sa.n >= 1) {    // Kalshi's own count of the settlement minute
          const m = Math.min(pr.m, SETTLE - sa.n); pr.mean = (sa.v * sa.n + m * xx) / (sa.n + m); pr.official = true;
        }
        return pr;
      };
      const base = projectWith(x, vols), p = tailFromBand(base.mean, base.sd, tgt);
      let lo = 1, hi = 0; const adverse = vols.s * Math.sqrt(10);
      for (const k of [0.7, 1, 1.5]) for (const shift of [-adverse, 0, adverse]) { const pr = projectWith(x + shift, {s: vols.s * k, l: vols.l * k}); const q = tailFromBand(pr.mean, pr.sd, tgt); if (q < lo) lo = q; if (q > hi) hi = q; }
      const b = this.books[mk], best = m => { let pp = null, q = 0; for (const [px, qty] of m) if (pp == null || px > pp) { pp = px; q = qty; } return pp == null ? null : {price: Math.round((1 - pp) * 100), size: Math.floor(q)}; };
      const offer = {Up: b ? best(b.no) : null, Down: b ? best(b.yes) : null};
      const tk = this.lastTicker[mk];
      if (!offer.Up && tk && tk.ask) offer.Up = {price: Math.round(tk.ask * 100), size: 1};
      if (!offer.Down && tk && tk.bid) offer.Down = {price: Math.round((1 - tk.bid) * 100), size: 1};
      const decide = (side, worst, off) => {
        if (!off || !(off.price > 0 && off.price < 100)) return null;
        const fee = feeCents(off.price / 100), edge = worst * 100 - off.price - fee;
        if (edge < cfg.minEdge) return {side, price: off.price, edge: +edge.toFixed(1), call: edge <= 0 ? "no" : "thin"};
        const c = (off.price + fee) / 100, f = (worst - c) / (1 - c), stake = Math.min(cfg.perWindowCents / 100, 0.02 * cfg.bankrollCents / 100, 0.25 * f * cfg.bankrollCents / 100);
        const n = Math.min(Math.floor(stake / c), off.size);
        return {side, price: off.price, edge: +edge.toFixed(1), call: n >= 1 ? "buy" : "thin", n: Math.max(0, n), offered: off.size};
      };
      const dUp = decide("Up", lo, offer.Up), dDown = decide("Down", 1 - hi, offer.Down);
      w.decided++;
      const pick = dUp && dUp.call === "buy" ? dUp : dDown && dDown.call === "buy" ? dDown : null;
      if (!pick) {
        w.holding = null;
        if (w.decided % 12 === 1) { log.decisions = log.decisions.concat([{at: nowMs, mk, left: Math.round(left), p: +p.toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), up: dUp, down: dDown, note: "no trade"}]).slice(-200); await this.state.storage.put("trade.log", log); }
        await this.state.storage.put(key, w); return;
      }
      // a call must hold across two ticks (about 5 s) before anything is sent: a blip must not trade
      if (!w.holding || w.holding.side !== pick.side) { w.holding = {side: pick.side, since: nowMs}; await this.state.storage.put(key, w); return; }
      if (nowMs - w.holding.since < 4000) { await this.state.storage.put(key, w); return; }
      const trade = {at: nowMs, mk, left: Math.round(left), side: pick.side, price: pick.price, n: pick.n, offered: pick.offered, edge: pick.edge, p: +p.toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), x: +x.toFixed(2), sd: +base.sd.toFixed(2), official: !!base.official, mode: cfg.mode, filled: 0, cost: 0};
      if (cfg.mode === "paper") { trade.filled = pick.n; trade.cost = pick.n * pick.price; trade.status = "paper"; }
      else {
        const body = {ticker: mk, action: "buy", side: pick.side === "Up" ? "yes" : "no", count: pick.n, type: "limit", time_in_force: "immediate_or_cancel",
                      client_order_id: crypto.randomUUID(), cancel_order_on_pause: true};
        if (pick.side === "Up") body.yes_price = pick.price; else body.no_price = pick.price;
        const r = await signedCall(this.env, cfg.mode, "POST", "/trade-api/v2/portfolio/orders", body);
        const o = (r && r.order) || {};
        trade.orderId = o.order_id || null; trade.status = o.status || "sent"; trade.filled = +o.fill_count || 0; trade.cost = +o.taker_fill_cost || 0;
        trade.feesCents = Math.round((+o.taker_fees || 0) + (+o.maker_fees || 0));
      }
      w.trades.push(trade); today.trades++;
      await this.state.storage.put(key, w); await this.state.storage.put("trade.day", today);
      log.decisions = log.decisions.concat([Object.assign({note: "TRADE"}, trade)]).slice(-200);
      await this.state.storage.put("trade.log", log);
    } catch (e) {
      log.errors = (log.errors || []).concat([{at: nowMs, error: String(e.message || e).slice(0, 200)}]).slice(-20);
      await this.state.storage.put("trade.log", log);
    } finally { this.agentBusy = false; }
  }
  async settleTrades(mk, close) {               // after the close: score the window's trade against the official result
    const key = "t:" + mk, w = await this.state.storage.get(key);
    if (!w || !w.trades.length || w.settled) return;
    const d = await signedGet(this.env, "/trade-api/v2/markets/" + mk), m = d && d.market;
    if (!(m && (m.result === "yes" || m.result === "no"))) return;
    const yes = m.result === "yes";
    let pnl = 0;
    for (const t of w.trades) {
      if (!t.filled) { t.pnlCents = 0; continue; }
      const won = t.side === "Up" ? yes : !yes, fee = t.feesCents != null ? t.feesCents : Math.round(t.filled * feeCents(t.price / 100));
      t.pnlCents = Math.round(t.filled * (won ? 100 - t.price : -t.price)) - fee; pnl += t.pnlCents;
    }
    w.result = m.result; w.settled = true;
    const today = (await this.state.storage.get("trade.day")) || {day: etDay(Date.now()), trades: 0, pnlCents: 0};
    if (today.day === etDay(close * 1000)) today.pnlCents += pnl;
    await this.state.storage.put(key, w); await this.state.storage.put("trade.day", today);
  }
  snapshotOf(tk, b) {
    return {type: "orderbook_snapshot", msg: {market_ticker: tk, yes_dollars_fp: [...b.yes].map(([p, q]) => [p.toFixed(4), q.toFixed(2)]), no_dollars_fp: [...b.no].map(([p, q]) => [p.toFixed(4), q.toFixed(2)])}};
  }
  onUpstream(data) {
    if (typeof data !== "string") return;
    this.upMsgAt = Date.now();
    let d; try { d = JSON.parse(data); } catch (e) { return; }
    if (!d || !d.type) return;
    this.counts[d.type] = (this.counts[d.type] || 0) + 1;
    if (d.type === "subscribed" && d.msg) { if (d.msg.channel === "ticker") this.tickerSid = d.msg.sid; if (d.msg.channel === "orderbook_delta") this.bookSid = d.msg.sid; }
    if (d.type === "orderbook_snapshot" && d.msg && d.msg.market_ticker) {
      const b = {yes: new Map(), no: new Map()};
      for (const [px, q] of d.msg.yes_dollars_fp || []) if (+q > 0) b.yes.set(+px, +q);
      for (const [px, q] of d.msg.no_dollars_fp || []) if (+q > 0) b.no.set(+px, +q);
      this.books[d.msg.market_ticker] = b;
    }
    if (d.type === "orderbook_delta" && d.msg && d.msg.market_ticker && this.books[d.msg.market_ticker]) {
      const m = this.books[d.msg.market_ticker][d.msg.side === "no" ? "no" : "yes"], px = +d.msg.price_dollars, q = (m.get(px) || 0) + +d.msg.delta_fp;
      if (q > 0) m.set(px, q); else m.delete(px);
    }
    if (d.type === "cfbenchmarks_value_5hz" && d.msg && +d.msg.value_usd > 0) this.pushTick(+d.msg.source_ts_ms || Date.now(), +d.msg.value_usd);
    if (d.type === "cfbenchmarks_value" && d.msg) {
      try { const v = +JSON.parse(d.msg.data).value; if (v > 0) this.pushTick(Date.now(), v); } catch (e) {}
      const f = d.msg.last_60s_windowed_average_15min;
      this.settleAvg = f && +f.value > 0 ? {v: +f.value, n: +f.window_size, end: +f.window_end_ts_exclusive, at: Date.now()} : null;
    }
    if (d.type === "ticker" && d.msg && d.msg.market_ticker) this.lastTicker[d.msg.market_ticker] = {bid: +d.msg.yes_bid_dollars || null, ask: +d.msg.yes_ask_dollars || null, at: Date.now()};
    if (d.type === "error") { this.lastErr = "kalshi error " + JSON.stringify(d.msg).slice(0, 150); this.broadcast(JSON.stringify(this.status())); return; }
    if (d.type === "cfbenchmarks_value" || d.type === "cfbenchmarks_value_5hz" || d.type === "ticker" || d.type === "orderbook_snapshot" || d.type === "orderbook_delta") {
      if (d.type.startsWith("orderbook")) { this.broadcast(data); return; }     // books are rebuilt for newcomers from this.books
      this.last[d.type] = data;
      this.broadcast(data);
    }
  }
}
