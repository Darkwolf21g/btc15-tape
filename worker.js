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
const MODEL_VERSION = "brti-driftless-v3";
// Bound network waits so a slow upstream cannot strand the alarm chain.
const timedFetch = (url, options = {}) => fetch(url, {...options, signal: AbortSignal.timeout(12000)});

export default {
  async scheduled(event, env, ctx) {
    if (env.FEED && env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY) {
      ctx.waitUntil(env.FEED.get(env.FEED.idFromName("brti")).fetch(new Request("https://internal/watchdog")));
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
    if (request.method === "OPTIONS") return new Response(null, {headers: {...CORS, "Access-Control-Allow-Headers": "Content-Type"}});
    if (path === "/feed" || path === "/feed/status" || path === "/record" || path === "/record.csv" || path === "/collector/status" || path === "/trade/status" || path === "/trade/config") {
      if (env.FEED_TOKEN && url.searchParams.get("token") !== env.FEED_TOKEN) return new Response("token", {status: 403, headers: CORS});
      if (!env.FEED) return new Response("feed not configured", {status: 503, headers: CORS});
      try { return await env.FEED.get(env.FEED.idFromName("brti")).fetch(request); }
      catch (e) {
        const message=String(e?.message || e), trace=crypto.randomUUID();
        const code=/quota|daily|limit exceeded|exceeded.*limit/i.test(message)?"platform_limit":/overload/i.test(message)?"collector_overloaded":/storage|sqlite|database/i.test(message)?"collector_storage":/timeout|timed out/i.test(message)?"collector_timeout":/reset|restart/i.test(message)?"collector_restarting":"collector_exception";
        // Full exception stays in private Worker logs. Never expose keys or raw upstream errors.
        console.error("btc15 collector failure",{trace,code,path,error:e});
        return new Response(JSON.stringify({healthy:false,error:code,trace,release:"collector-diagnostics-v1"}),{status:503,headers:{...CORS,"Content-Type":"application/json","Retry-After":"30"}});
      }
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
          const up = await timedFetch("https://external-api.kalshi.com" + apiPath + (apiPath.endsWith("values") ? "?id=BRTI" : ""),
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
        const up = await timedFetch("https://external-api.kalshi.com" + apiPath + "?id=BRTI&timespan=" + span + "&timestamp=" + encodeURIComponent(ts),
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
          const up = await timedFetch(base + path, {headers: {"Accept": "application/json",
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
// BEGIN SHARED BTC15 MODEL
// Canonical model. scripts/sync-model.cjs embeds this exact source in Worker and page.
// Frozen baseline: no fitted flow lean; all parameters recorded under VERSION.
(() => {
const VERSION = "brti-driftless-v3";
const EXECUTION_VERSION = "paper-delayed-depth-v1";
const SETTLE = 60, VOL_TAU = 180;
const tailCdf = z => 0.5 + z * (z*z+6) / (2*Math.pow(z*z+4,1.5));
const chance = (mean, sd, target) => tailCdf((mean - (target - .005)) / sd);
function volsFrom(ticks, nowMs) {
  const perSec = new Map();
  for (const [ms, v] of ticks) perSec.set(Math.floor(ms / 1000), v);
  const est = span => { let sum = 0, n = 0; const from = Math.floor(nowMs / 1000) - span;
    for (let t = from; t <= Math.floor(nowMs / 1000); t++) { const a = perSec.get(t), b = perSec.get(t - 5); if (a != null && b != null) { sum += (a - b) ** 2 / 5; n++; } }
    return n >= 12 ? Math.max(0.5, Math.sqrt(sum / n)) : null; };
  const s = est(120), l = est(900);
  return s && l ? {s, l} : null;
}
function projectFrom(ticks, nowMs, closeS, x, vols, aggregate = null) {
  const now = nowMs / 1000, perSec = new Map(ticks.map(([ms, v]) => [Math.floor(ms / 1000), v]));
  let known = 0, observed = 0, missing = 0; const ahead = [];
  for (let sec = closeS - SETTLE + 1; sec <= closeS; sec++) {
    if (sec <= now) { const v = perSec.get(sec); if (Number.isFinite(v)) { known += v; observed++; } else missing++; }
    else ahead.push(sec - now);
  }
  // A delayed aggregate must never turn a 60-reading contract into a 59-reading contract.
  const elapsed = SETTLE - ahead.length;
  if (aggregate && aggregate.n === elapsed && aggregate.n >= 1 && aggregate.n <= 60 &&
      aggregate.end > (closeS - 60) * 1000 && aggregate.end <= closeS * 1000 &&
      nowMs - aggregate.end >= -1000 && nowMs - aggregate.end < 3000 && Number.isFinite(aggregate.v)) {
    known = aggregate.v * aggregate.n; observed = aggregate.n; missing = 0;
  }
  if (missing) return {mean: null, sd: null, observed, missing, m: ahead.length};
  const m = ahead.length, vs = vols.s ** 2, vl = vols.l ** 2;
  let variance = 0, previous = 0;
  for (let j = 0; j < m; j++) { const u = ahead[j], c = m - j; variance += (vl * (u - previous) + (vs - vl) * VOL_TAU * (Math.exp(-previous / VOL_TAU) - Math.exp(-u / VOL_TAU))) * c * c; previous = u; }
  return {sum: known, reconstructed: 0, mean: (known + m * x) / SETTLE, sd: Math.sqrt(variance / SETTLE ** 2 + 0.09), observed, missing: 0, m, official: observed > 0};
}

function band(ticks, nowMs, close, x, vols, target, aggregate=null) {
 let lo=1, hi=0; const adverse=vols.s*Math.sqrt(10);
 for(const k of [.7,1,1.5]) for(const shift of [-adverse,0,adverse]) {
  const pr=projectFrom(ticks,nowMs,close,x+shift,{s:vols.s*k,l:vols.l*k},aggregate);
  if(pr.mean==null)return null;
  const p=chance(pr.mean,pr.sd,target);lo=Math.min(lo,p);hi=Math.max(hi,p);
 }
 return {lo,hi};
}
// Conservative whole-cent rounding for simulation. Actual fees reconcile from fills later.
// Robinhood exchange fee is an explicit assumption, not a fetched executable fee quote.
function feesCents(priceCents,n=1,venue="kalshi",exchangeFeeCents=1) {
 if(!(priceCents>0&&priceCents<100&&n>0))return 0;
 const p=priceCents/100;
 const commission=venue==="kalshi" ? .07*n*p*(1-p)*100 : Math.min(n,(venue==="robinhood-gold"?.05:.10)*n*p*(1-p)*100);
 return Math.ceil(commission-1e-9)+(venue==="kalshi"?0:Math.ceil(n*exchangeFeeCents-1e-9));
}
function asks(book,side) {
 const levels=side==="Up"?book?.no:book?.yes;
 if(!levels)return [];
 return [...levels].filter(([p,n])=>Number.isFinite(p)&&p>0&&p<1&&Number.isFinite(n)&&n>0)
  .map(([p,n])=>({price:Math.round((1-p)*10000)/100,size:Math.floor(n)})).sort((a,b)=>a.price-b.price);
}
function paperFill(intent,book,nowMs,cfg) {
 const empty=reason=>({filled:0,cost:0,feesCents:0,status:"paper-no-fill",reason,levels:[],filledAt:nowMs,latencyMs:nowMs-intent.at});
 if(nowMs<intent.readyAt)return null;
 if(nowMs>=intent.close*1000)return empty("contract closed before simulated arrival");
 if(nowMs-intent.readyAt>10000)return empty("execution checkpoint missed");
 if(!book||nowMs-book.at>cfg.paperBookMaxAgeMs||book.at>nowMs)return empty("no fresh depth at simulated arrival");
 let remaining=intent.n, cost=0, fees=0;const levels=[];
 for(const level of asks(book,intent.side)) {
  if(level.price>intent.price+1e-8)break;
  const n=Math.min(remaining,Math.floor(level.size*cfg.paperDepthFraction));
  if(n<=0)continue;
  levels.push({price:level.price,n});cost+=n*level.price;
  fees+=feesCents(level.price,n,cfg.paperVenue,cfg.paperExchangeFeeCents);remaining-=n;if(!remaining)break;
 }
 const filled=intent.n-remaining;
 if(!filled)return empty("no quantity at limit after depth haircut");
 return {filled,cost:Math.round(cost*100)/100,feesCents:fees,levels,status:remaining?"paper-partial":"paper-filled",reason:remaining?"available depth below requested size":"filled at arrival book",filledAt:nowMs,latencyMs:nowMs-intent.at};
}
globalThis.BTC15Model=Object.freeze({VERSION,EXECUTION_VERSION,tailCdf,chance,volsFrom,projectFrom,band,feesCents,asks,paperFill});
})();
// END SHARED BTC15 MODEL
const {tailCdf,volsFrom,projectFrom} = globalThis.BTC15Model;
function feeCents(p) { return globalThis.BTC15Model.feesCents(p*100); }
async function signedGet(env, apiPath, query) {
  const stamp = String(Date.now()), sig = await signHandshake(env.KALSHI_PRIVATE_KEY, stamp + "GET" + apiPath);
  const r = await timedFetch("https://external-api.kalshi.com" + apiPath + (query || ""), {headers: {"Accept": "application/json", "KALSHI-ACCESS-KEY": env.KALSHI_KEY_ID.trim(), "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": stamp}});
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
  const r = await timedFetch(HOSTS[mode === "demo" ? "demo" : "live"] + apiPath, {method, body: body ? JSON.stringify(body) : undefined,
    headers: {"Accept": "application/json", "Content-Type": "application/json", "KALSHI-ACCESS-KEY": k.id.trim(), "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": stamp}});
  const text = await r.text();
  if (!r.ok) throw new Error(method + " " + apiPath + " " + r.status + " " + text.slice(0, 160));
  return text ? JSON.parse(text) : {};
}
async function notify(env, title, text) {           // a push to the ntfy app, if NTFY_TOPIC is set
  if (!env.NTFY_TOPIC) return;
  try { await timedFetch("https://ntfy.sh/" + encodeURIComponent(env.NTFY_TOPIC.trim()), {method: "POST", body: text, headers: {"Title": title, "Tags": "chart_with_upwards_trend"}}); } catch (e) {}
}
const etDay = ms => new Intl.DateTimeFormat("en-CA", {timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(ms));
const tailFromBand = globalThis.BTC15Model.chance;
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

function calibrationReport(rows) {
  const windows = rows.filter(w => w.src === "kalshi" && ["yes", "no"].includes(w.result) && Object.values(w.checks || {}).some(k => k.model === MODEL_VERSION && Number.isFinite(k.p))).sort((a, b) => a.close - b.close);
  const holdout = windows.slice(Math.floor(windows.length * 2 / 3));
  const scores = {};
  for (const c of CHECKS) {
    let n = 0, wider = 0, matched = 0, market = 0;
    for (const w of holdout) {
      const k = w.checks[c];
      if (!k || k.model !== MODEL_VERSION || ![k.p, k.p2, k.bid, k.ask].every(Number.isFinite) || k.at >= w.close * 1000) continue;
      const y = w.result === "yes" ? 1 : 0; n++;
      wider += (k.p - y) ** 2; matched += (k.p2 - y) ** 2; market += ((k.bid + k.ask) / 2 - y) ** 2;
    }
    scores[c] = n ? {n, wider: wider / n, matched: matched / n, market: market / n} : null;
  }
  return {model: MODEL_VERSION, settledWindows: windows.length, holdoutWindows: holdout.length, split: "newest third by window; descriptive only", scores, autoPromotion: false};
}

function paperReport(windows) {
 const trades=windows.flatMap(w=>(w.trades||[]).filter(t=>t.mode==="paper"&&t.model===MODEL_VERSION&&t.executionModel===globalThis.BTC15Model.EXECUTION_VERSION).map(t=>({...t,close:w.close,settled:!!w.settled}))).sort((a,b)=>a.close-b.close);
 const filled=trades.filter(t=>t.filled>0), settled=filled.filter(t=>t.settled&&Number.isFinite(t.pnlCents));
 let equity=0,peak=0,drawdown=0;
 for(const t of settled){equity+=t.pnlCents;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);}
 const groups={};
 for(const t of trades){const cfg=t.paperSettings||{};const key=JSON.stringify({venue:cfg.paperVenue,delay:cfg.paperDelayMs,depth:cfg.paperDepthFraction,edge:cfg.minEdge,cap:cfg.perWindowCents,bankroll:cfg.bankrollCents,first:cfg.firstSeconds,last:cfg.lastSeconds,bookAge:cfg.paperBookMaxAgeMs,exchangeFee:cfg.paperExchangeFeeCents});
  const g=groups[key]||(groups[key]={settings:JSON.parse(key),attempts:0,settled:0,pnlCents:0});g.attempts++;if(t.settled&&t.filled>0&&Number.isFinite(t.pnlCents)){g.settled++;g.pnlCents+=t.pnlCents;}}
 return {scenarios:Object.values(groups),model:MODEL_VERSION,executionModel:globalThis.BTC15Model.EXECUTION_VERSION,attempts:trades.length,filled:filled.length,noFill:trades.length-filled.length,settled:settled.length,winRate:settled.length?settled.filter(t=>t.pnlCents>0).length/settled.length:null,pnlCents:equity,feesCents:filled.reduce((a,t)=>a+(t.feesCents||0),0),maxDrawdownCents:drawdown,meanLatencyMs:trades.length?trades.reduce((a,t)=>a+(t.latencyMs||0),0)/trades.length:null,readyForLive:false,reason:"Research only: forward results must be reviewed; no automatic promotion"};
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
    this.indexSeconds = new Map(); // Only the 1 Hz BRTI channel can supply settlement readings.
    this.alarmBusy = false;
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
    if (url.pathname === "/watchdog") { await this.ensureAlarm(); return new Response("ok"); }
    if (url.pathname === "/feed/status") { await this.ensureAlarm(); return new Response(JSON.stringify(this.status().msg), {headers: {...CORS, "Content-Type": "application/json"}}); }
    if (url.pathname === "/trade/status") {
      const cfg = await this.tradeConfig(), log = await this.tradeLog(), day = (await this.state.storage.get("trade.day")) || null;
      const all = await this.state.storage.list({prefix: "t:"}), windows = [...all.values()].sort((a, b) => a.close - b.close).slice(-60);
      return new Response(JSON.stringify({config: cfg, today: day, hasDemoKey: !!(this.env.KALSHI_DEMO_KEY_ID && this.env.KALSHI_DEMO_PRIVATE_KEY), tokenSet: !!this.env.FEED_TOKEN,
        stream: this.upState, ticks: this.ticks.length, windows, decisions: log.decisions.slice(-30), errors: log.errors.slice(-10), researchOnly:true, paperReport:paperReport([...all.values()])}), {headers: {...CORS, "Content-Type": "application/json"}});
    }
    if (url.pathname === "/trade/config") {
      if (request.method !== "POST") return new Response("POST", {status: 405, headers: CORS});
      if (!this.env.FEED_TOKEN) return new Response("set FEED_TOKEN on the Worker before controlling the agent", {status: 403, headers: CORS});
      let body; try { body = await request.json(); } catch (e) { return new Response("json", {status: 400, headers: CORS}); }
      const cfg = await this.tradeConfig();
      if (body.mode != null) {
        if (!["off", "paper"].includes(body.mode)) return new Response("This research release supports off and paper only; exchange execution is not enabled", {status: 400, headers: CORS});
        cfg.mode = body.mode;
      }
      for (const k of ["paperDelayMs", "paperBookMaxAgeMs", "paperDepthFraction", "paperExchangeFeeCents", "perWindowCents", "dailyLossStopCents", "maxTradesPerDay", "minEdge", "bankrollCents", "firstSeconds", "lastSeconds"]) if (body[k] != null) { if (typeof body[k] !== "number" || !Number.isFinite(body[k])) return new Response("invalid " + k, {status:400,headers:CORS}); cfg[k] = body[k]; }
      if(body.paperVenue!=null) { if(!["kalshi","robinhood","robinhood-gold"].includes(body.paperVenue))return new Response("invalid paperVenue",{status:400,headers:CORS});cfg.paperVenue=body.paperVenue; }
      const ranges = {paperDelayMs:[250,5000],paperBookMaxAgeMs:[250,3000],paperDepthFraction:[0.1,1],paperExchangeFeeCents:[0,5],perWindowCents: [100, 5000], dailyLossStopCents: [100, 100000], maxTradesPerDay: [1, 96], minEdge: [3, 99], bankrollCents: [1000, 100000000], firstSeconds: [60, 840], lastSeconds: [15, 60]};
      for (const [k, [lo, hi]] of Object.entries(ranges)) if (!Number.isFinite(cfg[k]) || cfg[k] < lo || cfg[k] > hi || (!["minEdge","paperDepthFraction","paperExchangeFeeCents"].includes(k) && !Number.isInteger(cfg[k]))) return new Response("invalid " + k, {status: 400, headers: CORS});
      cfg.perWindowCents = Math.min(cfg.perWindowCents, 5000);                 // a hard ceiling of $50 a window, whatever is asked
      await this.state.storage.put("trade.cfg", cfg);
      const pending=await this.state.storage.list({prefix:"t:"});
        const due=[...pending.values()].filter(v=>v.pendingPaper).map(v=>Math.max(Date.now()+100,v.pendingPaper.readyAt));
        await this.state.storage.setAlarm(Math.min(this.nextEvent(Date.now(), cfg.mode === "paper", cfg),...due));
      if (cfg.mode !== "off") this.ensureUpstream();
      return new Response(JSON.stringify(cfg), {headers: {...CORS, "Content-Type": "application/json"}});
    }
    if (url.pathname === "/collector/status") { await this.ensureAlarm(); const c = (await this.state.storage.get("collector")) || {}; c.nextAlarm = await this.state.storage.getAlarm(); c.now = Date.now(); c.model = MODEL_VERSION;
      c.healthy = !!c.lastOk && c.now - c.lastOk < 120000; c.stream = this.upState;
      c.indexAgeMs = this.ticks.length ? c.now - this.ticks[this.ticks.length - 1][0] : null;
      const rows = [...(await this.state.storage.list({prefix: "w:"})).values()];
      c.forecasts = rows.reduce((n, w) => n + Object.values(w.checks || {}).filter(k => k.model === MODEL_VERSION && Number.isFinite(k.p)).length, 0);
      c.settledWindows = rows.filter(w => w.src === "kalshi").length;
      c.calibration = calibrationReport(rows);
      return new Response(JSON.stringify(c), {headers: {...CORS, "Content-Type": "application/json"}}); }
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
      if (this.upState === "open" && Date.now() - this.upMsgAt < 3000)
        for (const [type, f] of Object.entries(this.last)) if (type !== "ticker") server.send(f);
      for (const [tk, b] of Object.entries(this.books)) if (Date.now() - b.at < 15000) server.send(JSON.stringify(this.snapshotOf(tk, b)));   // the books as they stand now
    } catch (e) {}
    this.ensureUpstream();
    return new Response(null, {status: 101, webSocket: client});
  }
  broadcast(text) {
    for (const c of this.clients) { try { c.send(text); } catch (e) { this.clients.delete(c); } }
  }
  maybeIdle() {
    if (this.clients.size || this.idleTimer) return;
    this.idleTimer = setTimeout(async () => { this.idleTimer = null; const cfg = await this.tradeConfig(); if (!this.env.KALSHI_KEY_ID && !this.clients.size && cfg.mode === "off") this.closeUpstream("idle"); }, 60000);
  }
  closeUpstream(why) {
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.windowTimer = null; }
    const ws = this.up; this.up = null; this.upState = "off"; this.tickerSid = null; this.bookSid = null; this.tickerSet = ""; this.books = {}; this.lastTicker = {}; this.last = {}; this.settleAvg = null;
    if (ws) { try { ws.close(1000, why); } catch (e) {} }
  }
  async ensureUpstream() {
    if (this.up || this.upState === "connecting") return;
    if (!this.env.KALSHI_KEY_ID || !this.env.KALSHI_PRIVATE_KEY) { this.upState = "no key"; this.broadcast(JSON.stringify(this.status())); return; }
    if (!this.indexSeconds.size) {
      const saved = (await this.state.storage.get("index.seconds")) || [];
      for (const [ms, v] of saved) if (Date.now() - ms < 1200000) this.indexSeconds.set(ms, v);
      if (!this.ticks.length) this.ticks = [...this.indexSeconds];
    }
    this.upState = "connecting"; this.broadcast(JSON.stringify(this.status()));
    try {
      const ts = String(Date.now());
      const sig = await signHandshake(this.env.KALSHI_PRIVATE_KEY, ts + "GET" + "/trade-api/ws/v2");
      const resp = await timedFetch(WS_UPSTREAM, {headers: {"Upgrade": "websocket", "KALSHI-ACCESS-KEY": this.env.KALSHI_KEY_ID.trim(),
                                                       "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts}});
      const ws = resp.webSocket;
      if (!ws) throw new Error("Kalshi refused the handshake: " + resp.status + " " + (await resp.text().catch(() => "")).slice(0, 120));
      ws.accept();
      this.tickerSet = ""; this.tickerSid = null; this.bookSid = null; this.books = {}; this.lastTicker = {}; this.last = {}; this.bookSequence = null;
      this.up = ws; this.upState = "open"; this.upSince = Date.now(); this.lastErr = null; this.backoff = 2000; this.counts = {};
      ws.addEventListener("message", ev => this.onUpstream(ev.data));
      ws.addEventListener("close", ev => { if (this.up === ws) { this.closeUpstream("disconnected"); this.lastErr = "closed " + ev.code + " " + (ev.reason || ""); this.retry(); } });
      ws.addEventListener("error", () => { if (this.up === ws) { this.closeUpstream("socket error"); this.lastErr = "socket error"; this.retry(); } });
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
    if ((!this.clients.size && !this.env.KALSHI_KEY_ID) || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.clients.size || this.env.KALSHI_KEY_ID) this.ensureUpstream(); }, this.backoff);
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
    const alarm = await this.state.storage.getAlarm(), now = Date.now();
    if (!this.alarmBusy && (alarm == null || alarm < now - 60000 || alarm > now + 60000))
      await this.state.storage.setAlarm(now + 1000);
    if (this.up && now - Math.max(this.upMsgAt, this.upSince) > 20000) this.closeUpstream("stale stream");
    await this.ensureUpstream();
  }
  nextEvent(nowMs, agentOn, cfg) {             // the next checkpoint, settlement or agent moment after now, in ms
    const now = nowMs / 1000, close = (Math.floor(now / WINDOW) + 1) * WINDOW, times = [];
    for (const c of [close - WINDOW, close, close + WINDOW]) { for (const k of CHECKS) times.push(c - k); times.push(c + 90, c + 400); }
    if (agentOn) {
      const first = cfg ? cfg.firstSeconds : 300, lastS = cfg ? cfg.lastSeconds : 15;
      const zoneStart = close - WINDOW + first, zoneEnd = close - lastS;
      if (now < zoneStart - 1) times.push(zoneStart); else if (now < zoneEnd - 1) times.push(now + 5); else times.push(close + first);
    }
    return Math.min(now + 30, ...times.filter(t => t > now + 0.5)) * 1000;
  }
  async alarm() {
    if (this.alarmBusy) return;
    this.alarmBusy = true;
    const nowMs = Date.now(), now = nowMs / 1000;
    const log = (await this.state.storage.get("collector")) || {runs: 0, errors: []};
    log.runs++; log.lastRun = nowMs;
    // Schedule before network work and again in finally: errors must not stop collection.
    await this.state.storage.setAlarm(nowMs + 30000);
    try {
      await this.state.storage.put("index.seconds", [...this.indexSeconds].slice(-1200));
      await this.ensureAlarm();
      const close = (Math.floor(now / WINDOW) + 1) * WINDOW, left = close - now;
      const check = CHECKS.find(k => left <= k && k - left < 20);
      if (check) await this.checkpoint(marketTicker(close), close, check, nowMs);
      // Retry old unresolved windows as well as the most recent close.
      const rows = await this.state.storage.list({prefix: "w:"});
      const pending = [...rows.values()].filter(w => w.close < now - 60 && w.src !== "kalshi").slice(-4);
      for (const w of pending) await this.settle(w.mk, w.close);
      const prevClose = close - WINDOW;
      const trades=await this.state.storage.list({prefix:"t:"});
      for(const tradeWindow of [...trades.values()].filter(v=>v.close<now-60&&!v.settled&&v.trades?.length).slice(-8)) await this.settleTrades(tradeWindow.mk,tradeWindow.close);
      log.lastOk = nowMs;
      log.indexAgeMs = this.ticks.length ? nowMs - this.ticks[this.ticks.length - 1][0] : null;
      const cfg = await this.tradeConfig();
      await this.processPaper(Date.now(),cfg);
      if (cfg.mode === "paper") await this.agentTick(Date.now());
      // Persist bounded read-only history so a cold object can warm up without a phone.

      if (rows.size > 5000) for (const [key] of [...rows].slice(0, rows.size - 5000)) await this.state.storage.delete(key);
    } catch (e) {
      log.errors = (log.errors || []).concat([{at: Date.now(), error: String(e.message || e).slice(0, 200)}]).slice(-10);
    } finally {
      try {
        await this.state.storage.put("collector", log);
      } finally {
        const cfg = await this.tradeConfig().catch(() => ({mode: "off"}));
        const pending=await this.state.storage.list({prefix:"t:"});
        const due=[...pending.values()].filter(v=>v.pendingPaper).map(v=>Math.max(Date.now()+100,v.pendingPaper.readyAt));
        await this.state.storage.setAlarm(Math.min(this.nextEvent(Date.now(), cfg.mode === "paper", cfg),...due));
        this.alarmBusy = false;
      }
    }
  }
  async checkpoint(mk, close, check, nowMs) {
    const key = "w:" + mk, w = (await this.state.storage.get(key)) || {mk, close, tgt: null, checks: {}, result: null, src: null, relay: true};
    if (w.checks[check]) return;
    // Snapshot the live stream at the checkpoint before awaiting REST. Later ticks must
    // not leak into a forecast recorded for an earlier time.
    const liveTicks = this.ticks.filter(t => t[0] <= nowMs), seconds = [...this.indexSeconds].filter(t => t[0] <= nowMs);
    const aggregate = this.settleAvg && {...this.settleAvg};
    const book=this.books[mk],tick=this.lastTicker[mk];
    const offers=book&&nowMs-book.at<1500?{ask:globalThis.BTC15Model.asks(book,"Up")[0]?.price/100,bid:1-globalThis.BTC15Model.asks(book,"Down")[0]?.price/100,at:book.at}:tick&&nowMs-tick.at<5000?{...tick}:null;
    let ticks = liveTicks;
    ticks = seconds; // Immutable one-Hz input snapshot; no retrospective forecast reconstruction.
    const mkt = await signedGet(this.env, "/trade-api/v2/markets/" + mk);
    const m = mkt && mkt.market;
    if (m && +m.floor_strike > 0) w.tgt = +m.floor_strike;
    const ask=offers&&Number.isFinite(offers.ask)?offers.ask:null,bid=offers&&Number.isFinite(offers.bid)?offers.bid:null;
    const vols = volsFrom(ticks, nowMs), x = liveTicks.length ? liveTicks[liveTicks.length - 1][1] : null;
    const ageMs = liveTicks.length ? nowMs - liveTicks[liveTicks.length - 1][0] : null;
    const entry = {ask, bid, marketAt:offers?.at??null, x, at: nowMs, ticks: ticks.length, ageMs, model: MODEL_VERSION};
    const pr = vols && x != null ? projectFrom(seconds, nowMs, close, x, vols, aggregate) : null;
    if (vols && x != null && w.tgt != null && ageMs >= 0 && ageMs < 3000 && pr.mean != null) {
      entry.p = +tailCdf((pr.mean - (w.tgt - 0.005)) / pr.sd).toFixed(3);
      entry.p2 = +tailCdf((pr.mean - (w.tgt - 0.005)) / (pr.sd / Math.SQRT2)).toFixed(3);
      entry.sd = +pr.sd.toFixed(2); entry.mean = +pr.mean.toFixed(2);
    }
    entry.status = entry.p != null ? "forecast" : ageMs == null || ageMs >= 3000 ? "stale index" : !vols ? "warming up volatility" : !w.tgt ? "missing target" : "missing settlement readings";
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
    if (!Number.isFinite(v) || !(v > 0) || !Number.isFinite(ms) || Date.now() - ms > 5000 || ms > Date.now() + 1000) return;
    const last = this.ticks[this.ticks.length - 1];
    if (last && ms <= last[0]) return;
    if (last && Math.abs(v - last[1]) > 0.005 * last[1] && ms - last[0] < 10000) { this.oddTick = (this.oddTick || 0) + 1; if (this.oddTick < 2) return; }
    this.oddTick = 0;
    if (!last || ms >= last[0]) this.ticks.push([ms, v]);
    const cut = ms - 1200000; while (this.ticks.length && this.ticks[0][0] < cut) this.ticks.shift();
  }

  // ---- the execution agent
  // Runs from 10 minutes before each close to 15 seconds before it, every 5 seconds, on the stream.
  // Research release: off or paper. No exchange order submission path is enabled.
  async tradeConfig() {
    const c = (await this.state.storage.get("trade.cfg")) || {};
    const cfg=Object.assign({paperDelayMs:1000,paperBookMaxAgeMs:1500,paperDepthFraction:0.5,paperVenue:"kalshi",paperExchangeFeeCents:1,mode: "off", perWindowCents: 1000, dailyLossStopCents: 3000, maxTradesPerDay: 12, minEdge: 3, bankrollCents: 50000, firstSeconds: 300, lastSeconds: 15}, c);
    if(!["off","paper"].includes(cfg.mode))cfg.mode="off";
    return cfg;
  }
  async tradeLog() { return (await this.state.storage.get("trade.log")) || {decisions: [], errors: []}; }
  async agentTick(nowMs) {
    const cfg = await this.tradeConfig();
    if (cfg.mode !== "paper" || this.agentBusy) return; // Exchange execution is deferred until a separately reviewed release.
    this.agentBusy = true;
    let log={decisions:[],errors:[]};
    try {
      log = await this.tradeLog();
      if(await this.processPaper(nowMs,cfg))return;
      const now = nowMs / 1000, close = (Math.floor(now / WINDOW) + 1) * WINDOW, left = close - now, mk = marketTicker(close);
      if (left > WINDOW - cfg.firstSeconds || left < cfg.lastSeconds) return;
      if (!this.up) { await this.ensureUpstream(); return; }                    // the stream feeds the model; try again next tick
      const key = "t:" + mk, w = (await this.state.storage.get(key)) || {mk, close, trades: [], decided: 0};
      if (w.trades.length || w.pendingOrder || w.pendingPaper) return;                                              // one trade per window
      const attempts = await this.state.storage.list({prefix: "t:"});
      if ([...attempts.values()].some(v => v.pendingOrder || v.pendingPaper)) return; // unresolved execution pauses all further orders
      const day = etDay(nowMs), today = (await this.state.storage.get("trade.day")) || {day, trades: 0, pnlCents: 0};
      if (today.day !== day) { today.day = day; today.trades = 0; today.pnlCents = 0; }
      if (today.trades >= cfg.maxTradesPerDay || today.pnlCents <= -cfg.dailyLossStopCents) return;
      const last = this.ticks[this.ticks.length - 1];
      if (!last || nowMs - last[0] > 3000 || this.ticks.length < 200) return;
      let tgt = w.tgt;
      if (!tgt) { const d = await signedGet(this.env, "/trade-api/v2/markets/" + mk); tgt = d && d.market && +d.market.floor_strike > 0 ? +d.market.floor_strike : null; if (!tgt) return; w.tgt = tgt; }
      const vols = volsFrom([...this.indexSeconds], nowMs); if (!vols) return;
      const x = last[1];
      const projectWith = (xx, vv) => projectFrom([...this.indexSeconds], nowMs, close, xx, vv, this.settleAvg);
      const base = projectWith(x, vols);
      if (base.mean == null) return;
      const p = tailFromBand(base.mean, base.sd, tgt);
      const {lo,hi}=globalThis.BTC15Model.band([...this.indexSeconds],nowMs,close,x,vols,tgt,this.settleAvg);
      const b0=this.books[mk], b=b0 && nowMs-b0.at < cfg.paperBookMaxAgeMs ? b0:null;
      const first=side=>globalThis.BTC15Model.asks(b,side)[0]||null;
      const offer={Up:first("Up"),Down:first("Down")}; // Real depth required; ticker size is not liquidity.
      const decide = (side, worst, off) => {
        if (!off || !(off.price > 0 && off.price < 100)) return null;
        const fee = globalThis.BTC15Model.feesCents(off.price,1,cfg.paperVenue,cfg.paperExchangeFeeCents), edge = worst * 100 - off.price - fee;
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
      const exchange = await signedGet(this.env, "/trade-api/v2/exchange/status");
      const market = await signedGet(this.env, "/trade-api/v2/markets/" + mk);
      if (exchange.trading_active !== true || exchange.exchange_active !== true || market.market?.status !== "active" || Date.now() - nowMs > 3000) return;
      const trade = {at: nowMs, mk, left: Math.round(left), side: pick.side, price: pick.price, n: pick.n, offered: pick.offered, edge: pick.edge, p: +p.toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), x: +x.toFixed(2), sd: +base.sd.toFixed(2), official: !!base.official, mode: cfg.mode, filled: 0, cost: 0};
      trade.model=MODEL_VERSION;trade.executionModel=globalThis.BTC15Model.EXECUTION_VERSION;
      trade.feeVenue=cfg.paperVenue;trade.feeAssumption=cfg.paperVenue==="kalshi"?"general taker, whole-cent conservative rounding":"Robinhood cost scenario on Kalshi depth";
      w.pendingPaper={...trade,close,readyAt:nowMs+cfg.paperDelayMs,bookAt:b.at,cfg:{...cfg}};
      await this.state.storage.put(key,w);
      await this.state.storage.setAlarm(Math.min(w.pendingPaper.readyAt,Date.now()+1000));
      return;
    } catch (e) {
      log.errors = (log.errors || []).concat([{at: nowMs, error: String(e.message || e).slice(0, 200)}]).slice(-20);
      await this.state.storage.put("trade.log", log);
    } finally { this.agentBusy = false; }
  }
  async processPaper(nowMs,cfg) {
    const rows=await this.state.storage.list({prefix:"t:"});let processed=false;
    for(const [key,w] of rows) {
      const intent=w.pendingPaper;if(!intent)continue;
      let fill;
      if(cfg.mode!=="paper") fill={filled:0,cost:0,feesCents:0,status:"paper-canceled",reason:"paper mode stopped",filledAt:nowMs,latencyMs:nowMs-intent.at,levels:[]};
      else {
        if(nowMs<intent.readyAt)continue;
        let active=false;
        try { const exchange=await signedGet(this.env,"/trade-api/v2/exchange/status");const market=await signedGet(this.env,"/trade-api/v2/markets/"+w.mk);active=exchange.exchange_active===true&&exchange.trading_active===true&&market.market?.status==="active"; }catch(e){}
        nowMs=Date.now();
        fill=globalThis.BTC15Model.paperFill(intent,active&&this.up?this.books[w.mk]:null,nowMs,intent.cfg);
        if(fill&&!active)fill.reason="exchange or market not confirmed active at simulated arrival";
      }
      if(!fill)continue;
      const {cfg:settings,readyAt,...trade}=intent;
      Object.assign(trade,fill,{paperSettings:settings,fillIndex:this.ticks.length&&nowMs-this.ticks.at(-1)[0]<3000?this.ticks.at(-1)[1]:null});
      w.pendingPaper=null;w.trades.push(trade);
      // Paper never calls the portfolio API. Every attempt has a durable audit record.
      await this.state.storage.put(key,w);
      const day=etDay(nowMs);let today=await this.state.storage.get("trade.day");
      if(!today||today.day!==day)today={day,trades:0,pnlCents:0};
      today.trades++;await this.state.storage.put("trade.day",today);
      const log=await this.tradeLog();log.decisions=log.decisions.concat([{...trade,note:"TRADE"}]).slice(-200);await this.state.storage.put("trade.log",log);
      processed=true;
    }
    return processed;
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
      t.pnlCents = Math.round((t.filled * (won ? 100 : 0) - (Number.isFinite(t.cost) ? t.cost : t.filled * t.price) - fee)*100)/100; pnl += t.pnlCents;
    }
    w.result = m.result; w.settled = true;
    const today = (await this.state.storage.get("trade.day")) || {day: etDay(Date.now()), trades: 0, pnlCents: 0};
    if (today.day === etDay(close * 1000)) today.pnlCents += pnl;
    await this.state.storage.put(key, w); await this.state.storage.put("trade.day", today);
    await notify(this.env, `BTC 15 settled: ${pnl >= 0 ? "+" : "−"}$${(Math.abs(pnl) / 100).toFixed(2)}`, `${mk} resolved ${m.result === "yes" ? "Up" : "Down"} · today ${today.pnlCents >= 0 ? "+" : "−"}$${(Math.abs(today.pnlCents) / 100).toFixed(2)} over ${today.trades} trade${today.trades === 1 ? "" : "s"}`);
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
    if (d.type === "orderbook_snapshot" || d.type === "orderbook_delta") {
      if (d.type === "orderbook_delta" && Number.isFinite(d.seq) && this.bookSequence != null && d.seq !== this.bookSequence + 1) {
        this.closeUpstream("order book sequence gap"); this.retry(); return;
      }
      if (Number.isFinite(d.seq)) this.bookSequence = d.seq;
    }
    if (d.type === "orderbook_snapshot" && d.msg && d.msg.market_ticker) {
      const b = {yes: new Map(), no: new Map(), at: Date.now()};
      for (const [px, q] of d.msg.yes_dollars_fp || []) if (+q > 0) b.yes.set(+px, +q);
      for (const [px, q] of d.msg.no_dollars_fp || []) if (+q > 0) b.no.set(+px, +q);
      this.books[d.msg.market_ticker] = b;
    }
    if (d.type === "orderbook_delta" && d.msg && d.msg.market_ticker && this.books[d.msg.market_ticker]) {
      const m = this.books[d.msg.market_ticker][d.msg.side === "no" ? "no" : "yes"], px = +d.msg.price_dollars, q = (m.get(px) || 0) + +d.msg.delta_fp;
      if (q > 0) m.set(px, q); else m.delete(px);
      this.books[d.msg.market_ticker].at = Date.now();
    }
    if (d.type === "cfbenchmarks_value_5hz" && d.msg && d.msg.index_id === "BRTI" && +d.msg.value_usd > 0) this.pushTick(+d.msg.source_ts_ms, +d.msg.value_usd);
    if (d.type === "cfbenchmarks_value" && d.msg) {
      try {
        const raw = JSON.parse(d.msg.data), v = +raw.value, ms = typeof raw.time === "number" ? raw.time : Date.parse(raw.time);
        if (d.msg.index_id === "BRTI" && v > 0 && Number.isFinite(v) && ms > 0 && Date.now() - ms < 5000 && ms <= Date.now() + 1000) {
          this.pushTick(ms, v); this.indexSeconds.set(ms, v);
          for (const t of this.indexSeconds.keys()) if (t < ms - 1200000) this.indexSeconds.delete(t);
        }
      } catch (e) {}
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
