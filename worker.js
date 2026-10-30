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
const REPLICA_MS = 200, REPLICA_KEEP_MS = 10 * 60 * 1000;                    // Worker-side BRTI replica cadence and scoring window
const ALLOWED = [/^\/markets\/KXBTC15M-[A-Z0-9-]+$/, /^\/live_data\/events\/KXBTC15M-[A-Z0-9]+$/, /^\/exchange\/status$/];
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Cache-Control": "no-store"};
const WINDOW = 900;
const MODEL_VERSION = "brti-driftless-v4";
// Bound network waits so a slow upstream cannot strand the alarm chain.
const timedFetch = (url, options = {}) => fetch(url, {...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)});
const SESSION_READ_BUDGET_MS = 2000;
// The timeout applies only to the HTTP upgrade. An AbortSignal.timeout left on
// the upgraded response also aborts the long-lived WebSocket after 12 seconds.
async function upgradeFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try { return await fetch(url, {...options, signal:controller.signal}); }
  finally { clearTimeout(timer); }
}

// Short shared caches collapse concurrent page polls. Never retry 429 through another hostname.
let publicPauseUntil=0;
const publicCache=new Map(), publicPending=new Map();
function retryDelay(value, now=Date.now()) {
  const n=Number(value);
  return Math.max(1000, value && Number.isFinite(n) ? n*1000 : value && Number.isFinite(Date.parse(value)) ? Date.parse(value)-now : 30000);
}
async function publicKalshi(path) {
  const now=Date.now(), cached=publicCache.get(path);
  if(cached && cached.until>now)return cached.result;
  if(now<publicPauseUntil)return {status:429,body:JSON.stringify({error:"rate_limited",retry_at:publicPauseUntil}),retry:Math.ceil((publicPauseUntil-now)/1000)};
  if(publicPending.has(path))return publicPending.get(path);
  const job=(async()=>{
    try {
      const up=await timedFetch(UPSTREAMS[0]+path,{headers:{Accept:"application/json"}});
      const result={status:up.status,body:await up.text()};
      if(up.status===429){const delay=retryDelay(up.headers.get("Retry-After"));publicPauseUntil=Date.now()+delay;result.retry=Math.ceil(delay/1000);}
      if(up.ok){for(const [key,v] of publicCache)if(v.until<=Date.now())publicCache.delete(key);publicCache.set(path,{until:Date.now()+(path==="/exchange/status"?10000:2000),result});}
      return result;
    }catch{return {status:502,body:JSON.stringify({error:"upstream_unreachable"})};}
    finally{publicPending.delete(path);}
  })();
  publicPending.set(path,job);return job;
}
const apiBudgets=new WeakMap();
function apiBudget(env, mode) {
  let modes=apiBudgets.get(env);if(!modes){modes={};apiBudgets.set(env,modes);}
  return modes[mode]||(modes[mode]={pauseUntil:0,limits:null,limitsAt:0,buckets:{}});
}
function debitBudget(state, method, path) {
  if(Date.now()<state.pauseUntil)throw Error("Kalshi rate limited; retry after "+Math.ceil((state.pauseUntil-Date.now())/1000)+"s");
  const kind=method==="GET"?"read":"write", limit=state.limits?.[kind];
  if(!limit || !(limit.refill_rate>0) || !(limit.bucket_capacity>0))return;
  const cost=path.includes("/cfbenchmarks/")?50:10, now=Date.now();
  const b=state.buckets[kind]||(state.buckets[kind]={tokens:limit.bucket_capacity,at:now});
  b.tokens=Math.min(limit.bucket_capacity,b.tokens+(now-b.at)*limit.refill_rate/1000);b.at=now;
  if(b.tokens<cost)throw Error("Local API budget exhausted; retry later");
  b.tokens-=cost;
}

export default {
  async scheduled(event, env, ctx) {
    if (env.FEED && env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY) {
      ctx.waitUntil(env.FEED.get(env.FEED.idFromName("brti")).fetch(new Request("https://internal/watchdog")));
    }
  },
  async fetch(request, env) {
    let url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (request.method === "OPTIONS") return new Response(null, {headers: {...CORS, "Access-Control-Allow-Headers": "Content-Type"}});
    // Setup link: /setup?token=... verifies the token, keeps it as a secure same-site cookie for this
    // site, and sends the browser on to the tape with the token in the fragment so the page saves it
    // too. Another phone is then set up by opening one link. The cookie is HttpOnly: page scripts
    // never see it, and SameSite=Lax keeps cross-site requests from carrying it.
    if (path === "/setup") {
      if (!env.FEED_TOKEN) return Response.redirect(url.origin + "/", 302);
      const t = url.searchParams.get("token") || "";
      if (t !== env.FEED_TOKEN) return new Response("token", {status: 403, headers: CORS});
      return new Response(null, {status: 302, headers: {Location: url.origin + "/#token=" + encodeURIComponent(t), "Cache-Control": "no-store",
        "Set-Cookie": "btc15_token=" + encodeURIComponent(t) + "; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax"}});
    }
    // A browser that holds the cookie is treated exactly like one that sent ?token=.
    if (env.FEED_TOKEN && url.searchParams.get("token") == null) {
      const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)btc15_token=([^;]+)/);
      let c = null; try { c = m ? decodeURIComponent(m[1]) : null; } catch (e) {}
      if (c === env.FEED_TOKEN) { url.searchParams.set("token", c); request = new Request(url.toString(), request); }
    }
    // Public, read-only: the Worker replica's research summary. No key material, no account data,
    // no Kalshi REST calls and nothing is woken by reading it.
    if (path === "/replica/public") {
      if (!env.FEED) return new Response("feed not configured", {status: 503, headers: CORS});
      try { return await env.FEED.get(env.FEED.idFromName("brti")).fetch(request); }
      catch (e) { return new Response(JSON.stringify({error: "unavailable"}), {status: 503, headers: {...CORS, "Content-Type": "application/json"}}); }
    }
    if (path === "/feed" || path === "/feed/status" || path === "/record" || path === "/record.csv" || path === "/collector/status" || path === "/trade/status" || path === "/trade/config" || path === "/replica/status" || path.startsWith("/demo/") || path.startsWith("/research/") || path.startsWith("/paper-session/")) {
      if (env.FEED_TOKEN && url.searchParams.get("token") !== env.FEED_TOKEN) return new Response("token", {status: 403, headers: CORS});
      if (!env.FEED) return new Response("feed not configured", {status: 503, headers: CORS});
      try { return await env.FEED.get(env.FEED.idFromName("brti")).fetch(request); }
      catch (e) {
        const message=String(e?.message || e), trace=crypto.randomUUID();
        const code=/quota|daily|limit exceeded|exceeded.*limit|exceeded allowed volume/i.test(message)?"platform_limit":/overload/i.test(message)?"collector_overloaded":/storage|sqlite|database/i.test(message)?"collector_storage":/timeout|timed out/i.test(message)?"collector_timeout":/reset|restart/i.test(message)?"collector_restarting":"collector_exception";
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
      try {
        const d=await signedGet(env,"/trade-api/v2/cfbenchmarks/history/values","?id=BRTI&timespan="+span+"&timestamp="+encodeURIComponent(ts));
        return new Response(JSON.stringify(d),{headers:{...CORS,"Content-Type":"application/json"}});
      }catch(e){return new Response(JSON.stringify({error:e.message}),{status:e.status===429?429:502,headers:{...CORS,"Content-Type":"application/json","Retry-After":"30"}});}
    }
    if (request.method !== "GET" || !ALLOWED.some(re => re.test(path))) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);     // the page and its files
      return new Response("not found", {status: 404, headers: CORS});
    }
    if(env.FEED&&env.KALSHI_KEY_ID&&env.KALSHI_PRIVATE_KEY){
      try{
        const r=await env.FEED.get(env.FEED.idFromName("brti")).fetch(new Request("https://internal/market-data?path="+encodeURIComponent(path)));
        if(r.status!==426)return r;
        // During rollout, the singleton can briefly run code from before this route existed.
        // Keep the same authenticated read; never fall back on rate limits or arbitrary errors.
        const d=await signedGet(env,"/trade-api/v2"+path);
        return new Response(JSON.stringify(d),{headers:{...CORS,"Content-Type":"application/json"}});
      }
      catch{return new Response(JSON.stringify({error:"collector_unavailable"}),{status:503,headers:{...CORS,"Content-Type":"application/json","Retry-After":"30"}});}
    }
    const result = await publicKalshi(path);
    return new Response(result.body, {status:result.status, headers:{...CORS,"Content-Type":"application/json",...(result.retry?{"Retry-After":String(result.retry)}:{})}});
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
const VERSION = "brti-driftless-v4";
// KXBTC15M contract: sixty one-second readings strictly before its reference/close time.
// The WebSocket final-minute aggregate is a different, close-inclusive statistic.
const SETTLEMENT_CONVENTION = "[close-60s,close)";
const EXECUTION_VERSION = "paper-delayed-depth-v3";
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
function projectFrom(ticks, nowMs, closeS, x, vols) {
  const now = nowMs / 1000, perSec = new Map(ticks.map(([ms, v]) => [Math.floor(ms / 1000), v]));
  let known = 0, observed = 0, missing = 0; const ahead = [];
  for (let sec = closeS - SETTLE; sec < closeS; sec++) {
    if (sec <= now) { const v = perSec.get(sec); if (Number.isFinite(v)) { known += v; observed++; } else missing++; }
    else ahead.push(sec - now);
  }
  // Do not substitute last_60s_windowed_average_15min: its start/close membership differs.
  if (missing) return {mean: null, sd: null, observed, missing, m: ahead.length};
  const m = ahead.length, vs = vols.s ** 2, vl = vols.l ** 2;
  let variance = 0, previous = 0;
  for (let j = 0; j < m; j++) { const u = ahead[j], c = m - j; variance += (vl * (u - previous) + (vs - vl) * VOL_TAU * (Math.exp(-previous / VOL_TAU) - Math.exp(-u / VOL_TAU))) * c * c; previous = u; }
  return {sum: known, reconstructed: 0, mean: (known + m * x) / SETTLE, sd: Math.sqrt(variance / SETTLE ** 2 + 0.09), observed, missing: 0, m, official: observed > 0};
}

function band(ticks, nowMs, close, x, vols, target) {
 let lo=1, hi=0; const adverse=vols.s*Math.sqrt(10);
 for(const k of [.7,1,1.5]) for(const shift of [-adverse,0,adverse]) {
  const pr=projectFrom(ticks,nowMs,close,x+shift,{s:vols.s*k,l:vols.l*k});
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
  .map(([p,n])=>({price:Math.round((1-p)*10000)/100,size:Math.round(n*100)/100})).filter(level=>level.size>0).sort((a,b)=>a.price-b.price);
}
function paperFill(intent,book,nowMs,cfg) {
 const empty=reason=>({filled:0,cost:0,feesCents:0,status:"paper-no-fill",reason,levels:[],filledAt:nowMs,latencyMs:nowMs-intent.at});
 if(nowMs<intent.readyAt)return null;
 if(!Number.isInteger(intent.n)||intent.n<1)return empty('invalid whole-contract quantity');
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
globalThis.BTC15Model=Object.freeze({VERSION,SETTLEMENT_CONVENTION,EXECUTION_VERSION,tailCdf,chance,volsFrom,projectFrom,band,feesCents,asks,paperFill});
})();
// END SHARED BTC15 MODEL
// BEGIN SHARED BTC15 RESEARCH
// Canonical research calculations; embedded in worker.js and imported by the offline evaluator.
(() => {
const VERSION = 'settlement-research-v2';
const BIAS_VERSION = 'btc15-bias-v3';
const LEGACY_SETTLEMENT_CONVENTION = '(close-60s,close]';
const PRICE_BANDS = [0,10,30,50,70,90,100];
const CHECKS = [600, 300, 120, 60, 30, 15, 5];
const DEPTH_POLICY = 'depth-clock-v2';
const SETTINGS = Object.freeze({delayMs:1000, maxArrivalLateMs:3000, bookMaxAgeMs:1500,
  indexMaxAgeMs:3000, sourceClockSkewMs:250, clockOffsetMinSamples:8, clockOffsetSamples:64, depthFraction:0.5, quantity:1, minEdgeCents:3,
  feeVenue:'kalshi', feeAssumption:'general taker multiplier 1; whole-cent rounding per fill level',
  checkpointToleranceMs:5000, minTrainWindows:60, testWindows:20});
const finite = v => typeof v === 'number' && Number.isFinite(v);
const currentCohort = w => w.schema===VERSION&&w.model===globalThis.BTC15Model.VERSION;
const depthWanted = now => {
  const left = (Math.floor(now / 900000) + 1) * 900 - now / 1000;
  return CHECKS.some(c => left <= c + 5 && left > c - 10);
};
// Upstream clock offset: the median of (source timestamp - local receipt) over recent book frames,
// estimated before the frame being judged. Kalshi's clock has run up to ~370 ms ahead of the
// Worker's; without this correction fresh books were rejected as "future". Network latency makes
// the estimate conservative (it is offset minus typical latency), so a replayed old frame still
// shows a large corrected age and is still rejected.
function clockOffsetEstimate(samples) {
  if (!Array.isArray(samples) || samples.length < SETTINGS.clockOffsetMinSamples) return null;
  const s = samples.filter(finite).sort((a, b) => a - b);
  if (s.length < SETTINGS.clockOffsetMinSamples) return null;
  return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2;
}
function depthSnapshot(book, at) {
  if (!book) return null;
  const sourceAt = finite(book.sourceAt) ? book.sourceAt : null;
  const age = at - book.at, sourceAge = sourceAt == null ? null : at - sourceAt;
  const offset = finite(book.clockOffsetMs) ? book.clockOffsetMs : null;
  const correctedSourceAge = sourceAge == null ? null : sourceAge + (offset ?? 0);
  const yes = globalThis.BTC15Model.asks(book,'Up').slice(0,10);
  const no = globalThis.BTC15Model.asks(book,'Down').slice(0,10);
  const bid = no.length ? 100-no[0].price : null, ask = yes[0]?.price ?? null;
  const fresh = age >= 0 && age <= SETTINGS.bookMaxAgeMs && correctedSourceAge != null &&
    correctedSourceAge >= -SETTINGS.sourceClockSkewMs && correctedSourceAge <= SETTINGS.bookMaxAgeMs;
  const valid = fresh && finite(bid) && finite(ask) && bid <= ask;
  return {depthPolicy:DEPTH_POLICY, receivedAt:book.at, sourceAt, sourceKind:book.sourceKind || null,
    ageMs:age, sourceAgeMs:sourceAge, clockOffsetMs:offset, correctedSourceAgeMs:correctedSourceAge,
    clockAheadMs:sourceAge==null?null:Math.max(0,-sourceAge), valid, bidCents:bid, askCents:ask, yes, no,
    reason:!fresh?'missing, stale or future depth timestamp':!valid?'empty or crossed book':null};
}
function snapshot({at, close, target, targetAt, ticks, book, exchange, marketStatus}) {
  // ticks are [source milliseconds, value, first received milliseconds]. No historical reconstruction.
  const input=ticks.filter(([ms,v,received])=>finite(ms)&&finite(v)&&v>0&&finite(received)&&ms<=at&&received<=at&&ms>=at-1200000).sort((a,b)=>a[0]-b[0]);
  const last=input.at(-1), ageMs=last ? at-last[0] : null;
  const vols=globalThis.BTC15Model.volsFrom(input,at);
  const projection=last&&vols ? globalThis.BTC15Model.projectFrom(input,at,close,last[1],vols) : null;
  const reason=!(finite(target)&&target>0&&finite(targetAt)&&targetAt<=at)?'missing target known at capture':
    !last||ageMs>SETTINGS.indexMaxAgeMs?'stale official index':!vols?'warming up volatility':
    projection?.mean==null?'missing settlement readings':at>=close*1000?'market closed':null;
  const p=reason?null:globalThis.BTC15Model.chance(projection.mean,projection.sd,target);
  const p2=reason?null:globalThis.BTC15Model.chance(projection.mean,projection.sd/Math.SQRT2,target);
  const previous=last&&input.find(t=>Math.floor(t[0]/1000)===Math.floor(last[0]/1000)-5);
  const move5=previous&&vols ? (last[1]-previous[1])/(vols.s*Math.sqrt(5)) : null;
  const boundary=finite(target)?target-.005:null;
  const required=projection?.m>0&&projection.m<60&&projection.missing===0&&boundary!=null ? (60*boundary-projection.sum)/projection.m : null;
  // Stored now, never reconstructed from an eventual outcome or later backfill.
  const bias={version:BIAS_VERSION,move5Z:move5,move5Usd:previous?last[1]-previous[1]:null,
    previousIndexSourceAt:previous?.[0]??null,requiredRemainingMean:required,
    spotAbove:boundary!=null&&last?last[1]>=boundary:null,
    projectedAbove:boundary!=null&&finite(projection?.mean)?projection.mean>=boundary:null};
  return {model:globalThis.BTC15Model.VERSION,settlementConvention:globalThis.BTC15Model.SETTLEMENT_CONVENTION,
    bias, at, leftSeconds:close-at/1000, target, targetAt, marketStatus, exchange,
    index:{source:'cfbenchmarks_value',sourceAt:last?.[0]??null,receivedAt:last?.[2]??null,value:last?.[1]??null,ageMs,samples:input.length},
    vols, projection, p, p2, status:reason||'forecast', depth:depthSnapshot(book,at)};
}
function simulate(check, variant, close, forcedSide=null) {
  const p=check[variant], book=check.depth, arrival=check.arrival;
  const no=reason=>({attempted:false,filled:0,pnlCents:null,reason});
  if(!finite(p)||p<0||p>1||!book?.valid||check.marketStatus!=='active'||
    check.exchange?.exchange_active!==true||check.exchange?.trading_active!==true)return no('decision data unavailable');
  const candidates=[['Up',p,book.yes[0]],['Down',1-p,book.no[0]]].filter(x=>x[2]).map(([side,prob,level])=>({side,price:level.price,
    edge:100*prob-level.price-globalThis.BTC15Model.feesCents(level.price,SETTINGS.quantity,SETTINGS.feeVenue)})).sort((a,b)=>b.edge-a.edge);
  const c=forcedSide?candidates.find(c=>c.side===forcedSide):candidates[0]; if(!c||(!forcedSide&&c.edge<SETTINGS.minEdgeCents))return no('below frozen net-edge threshold');
  const empty=reason=>({...c,attempted:true,filled:0,costCents:0,feesCents:0,reason});
  if(!arrival)return empty('arrival not recorded');
  const ready=check.at+SETTINGS.delayMs;
  if(arrival.at<ready||arrival.at-ready>SETTINGS.maxArrivalLateMs||arrival.at>=close*1000)return empty('arrival outside allowed time');
  if(!arrival.depth?.valid||arrival.exchange?.exchange_active!==true||arrival.exchange?.trading_active!==true)return empty('arrival depth or exchange unavailable');
  const levels=c.side==='Up'?arrival.depth.yes:arrival.depth.no;
  let remaining=SETTINGS.quantity,cost=0,fees=0;
  for(const level of levels){
    if(level.price>c.price+1e-8)break;
    const n=Math.min(remaining,Math.floor(level.size*SETTINGS.depthFraction));
    if(n<=0)continue;
    cost+=n*level.price; fees+=globalThis.BTC15Model.feesCents(level.price,n,SETTINGS.feeVenue);remaining-=n;
    if(!remaining)break;
  }
  return {...c,attempted:true,filled:SETTINGS.quantity-remaining,costCents:cost,feesCents:fees,
    delayMs:arrival.at-check.at,reason:remaining?'insufficient depth at original limit':'simulated fill'};
}
function report(all) {
  // Each chronological fold chooses ONLY the probability variant on earlier, already resolved windows.
  // Checkpoints are separate experiments. Never sum them as one strategy or pick their winner here.
  const valid=all.filter(currentCohort);
  const recorded=[...new Map(valid.map(w=>[w.mk,w])).values()].sort((a,b)=>a.close-b.close);
  const resolved=w=>w.src==='kalshi'&&['yes','no'].includes(w.result)&&finite(w.resultObservedAt)&&w.resultObservedAt>=w.close*1000;
  const windows=recorded.filter(resolved);
  const scores={},folds=[];
  for(const c of CHECKS)scores[c]={n:0,brier:0,marketBrier:0,logLoss:0,attempts:0,filled:0,wins:0,pnlCents:0,feesCents:0,maxDrawdownCents:0,
    bins:Array.from({length:10},(_,i)=>({from:i/10,to:(i+1)/10,n:0,p:0,y:0})),skips:{},equity:0,peak:0};
  const eligible=(w,c)=>{const k=w.checks?.[c];return k&&k.status==='forecast'&&k.at<w.close*1000&&k.at>=(w.close-Number(c))*1000&&
    k.at-(w.close-Number(c))*1000<=SETTINGS.checkpointToleranceMs&&k.depth?.valid&&[k.p,k.p2].every(v=>finite(v)&&v>=0&&v<=1)?k:null;};
  const evaluated=new Set();
  // UTC time blocks keep fold membership fixed when a late result arrives or a window is missing.
  const blockSeconds=900*SETTINGS.testWindows;
  const blockIds=[...new Set(recorded.map(w=>Math.floor((w.close-900)/blockSeconds)))];
  for(const block of blockIds){
    const cutoff=block*blockSeconds*1000;
    const test=recorded.filter(w=>Math.floor((w.close-900)/blockSeconds)===block&&resolved(w));
    const train=windows.filter(w=>w.close*1000<=cutoff&&w.resultObservedAt<cutoff);
    if(train.length<SETTINGS.minTrainWindows||!test.length)continue;
    const choices={};
    for(const c of CHECKS){
      const pairs=train.map(w=>({w,k:eligible(w,c)})).filter(x=>x.k);
      if(pairs.length<SETTINGS.minTrainWindows){choices[c]={variant:null,trainN:pairs.length};continue;}
      const loss=variant=>pairs.reduce((s,{w,k})=>s+(k[variant]-(w.result==='yes'?1:0))**2,0)/pairs.length;
      const wide=loss('p'),matched=loss('p2'),variant=matched<wide?'p2':'p';
      choices[c]={variant,trainN:pairs.length,wideBrier:wide,matchedBrier:matched};
      const s=scores[c];
      for(const w of test){
        const k=eligible(w,c);if(!k){s.skips['invalid forecast or book']=(s.skips['invalid forecast or book']||0)+1;continue;}
        const p=k[variant],y=w.result==='yes'?1:0,mid=(k.depth.bidCents+k.depth.askCents)/200;
        evaluated.add(w.mk);s.n++;s.brier+=(p-y)**2;s.marketBrier+=(mid-y)**2;
        const bounded=Math.min(1-1e-12,Math.max(1e-12,p));s.logLoss-=y*Math.log(bounded)+(1-y)*Math.log(1-bounded);
        const bin=s.bins[Math.min(9,Math.floor(p*10))];bin.n++;bin.p+=p;bin.y+=y;
        const fill=simulate(k,variant,w.close);
        if(fill.attempted)s.attempts++;
        if(fill.filled){const won=(fill.side==='Up')===(y===1),pnl=fill.filled*(won?100:0)-fill.costCents-fill.feesCents;
          s.filled++;if(won)s.wins++;s.pnlCents+=pnl;s.feesCents+=fill.feesCents;s.equity+=pnl;s.peak=Math.max(s.peak,s.equity);s.maxDrawdownCents=Math.max(s.maxDrawdownCents,s.peak-s.equity);
        }else{s.skips[fill.reason]=(s.skips[fill.reason]||0)+1;}
      }
    }
    folds.push({trainWindows:train.length,trainResultsBefore:cutoff,testFirstClose:test[0].close,testLastClose:test.at(-1).close,testWindows:test.length,choices});
  }
  for(const s of Object.values(scores)){
    for(const name of ['brier','marketBrier','logLoss'])s[name]=s.n?s[name]/s.n:null;
    s.brierImprovement=s.n?s.marketBrier-s.brier:null;s.winRate=s.filled?s.wins/s.filled:null;
    s.bins=s.bins.map(b=>({from:b.from,to:b.to,n:b.n,meanProbability:b.n?b.p/b.n:null,observedRate:b.n?b.y/b.n:null}));
    delete s.equity;delete s.peak;
  }
  return {schema:VERSION,model:globalThis.BTC15Model.VERSION,settlementConvention:globalThis.BTC15Model.SETTLEMENT_CONVENTION,
    settings:SETTINGS,recordedWindows:recorded.length,settledWindows:windows.length,
    evaluatedWindows:evaluated.size,folds,scores,bias:biasReport(recorded),readyForLive:false,
    expectedWindows:recorded.length?Math.round((recorded.at(-1).close-recorded[0].close)/900)+1:0,
    unrecordedWindows:recorded.length?Math.max(0,Math.round((recorded.at(-1).close-recorded[0].close)/900)+1-recorded.length):0,
    status:evaluated.size?'chronological research results; fills are simulated':'collecting; insufficient prior resolved windows',
    limitations:['Each checkpoint is a separate one-contract experiment; do not add their P&L.',
      'Variant selection uses earlier resolved windows only; no live model changes.',
      'Displayed depth does not guarantee an executable fill; latency and fees are fixed scenarios.',
      'Arrival simulation reuses checkpoint exchange status for at most four seconds; intervening halts are unknown.',
      'Missing/stale data is excluded and reported; coverage can bias results. No statistical significance claim.']};
}
// Fixed forward experiments. Every group has at most one observation per market.
// Price bands, checkpoint and side are never pooled to manufacture an independent sample.
function biasReport(recorded) {
  const groups=new Map(), seen=new Set();let captured=0,settled=0,firstAt=null,lastAt=null;
  const coverage={pending:0,unlisted:0,invalid:0,legacy:0,missingMove:0,missingArrival:0};
  const add=(hypothesis,checkpoint,side,band,w,k)=>{
    const key=[hypothesis,checkpoint,side,band??'all'].join(':');
    if(!groups.has(key))groups.set(key,{hypothesis,checkpoint,side,band,n:0,wins:0,askSum:0,costSum:0,
      attempts:0,filled:0,fillWins:0,pnlCents:0,feesCents:0,spentCents:0,equity:0,peak:0,maxDrawdownCents:0,
      markoutN:0,markoutSum:0,delaySum:0,days:new Set(),skips:{}});
    const g=groups.get(key),level=(side==='Up'?k.depth.yes:k.depth.no)[0];
    if(!level||!finite(level.price))return;
    const won=(side==='Up')===(w.result==='yes');
    g.n++;g.wins+=Number(won);g.askSum+=level.price;
    g.costSum+=level.price+globalThis.BTC15Model.feesCents(level.price,1,SETTINGS.feeVenue);
    g.days.add(new Date(w.close*1000).toISOString().slice(0,10));
    const fill=simulate(k,'p',w.close,side);g.attempts+=Number(fill.attempted);
    if(fill.filled){
      const pnl=100*Number(won)*fill.filled-fill.costCents-fill.feesCents;
      g.filled++;g.fillWins+=Number(won);g.pnlCents+=pnl;g.feesCents+=fill.feesCents;
      g.spentCents+=fill.costCents+fill.feesCents;g.equity+=pnl;g.peak=Math.max(g.peak,g.equity);
      g.maxDrawdownCents=Math.max(g.maxDrawdownCents,g.peak-g.equity);
    }else g.skips[fill.reason]=(g.skips[fill.reason]||0)+1;
    const a=k.arrival,delay=a?.at-k.at;
    if(a?.depth?.valid&&a.exchange?.trading_active===true&&a.exchange?.exchange_active===true&&
      delay>=SETTINGS.delayMs&&delay<=SETTINGS.delayMs+SETTINGS.maxArrivalLateMs&&a.at<w.close*1000){
      const start=(k.depth.bidCents+k.depth.askCents)/2,end=(a.depth.bidCents+a.depth.askCents)/2;
      if(finite(start)&&finite(end)){g.markoutN++;g.markoutSum+=(end-start)*(side==='Up'?1:-1);g.delaySum+=delay;}
    }
  };
  for(const w of [...recorded].sort((a,b)=>a.close-b.close)){
    if(seen.has(w.mk)||!currentCohort(w))continue;seen.add(w.mk);
    for(const c of CHECKS){
      const k=w.checks?.[c];if(!k)continue;
      if(k.bias?.version!==BIAS_VERSION){coverage.legacy++;continue;}
      captured++;firstAt=firstAt==null?k.at:Math.min(firstAt,k.at);lastAt=lastAt==null?k.at:Math.max(lastAt,k.at);
      if(w.src==='unlisted'){coverage.unlisted++;continue;}
      if(w.src!=='kalshi'||!['yes','no'].includes(w.result)||!finite(w.resultObservedAt)||w.resultObservedAt<w.close*1000){coverage.pending++;continue;}
      if(k.status!=='forecast'||!finite(k.p)||k.p<0||k.p>1||!k.depth?.valid||k.marketStatus!=='active'||
        k.exchange?.exchange_active!==true||k.exchange?.trading_active!==true||
        !finite(k.at)||k.at<(w.close-c)*1000||k.at-(w.close-c)*1000>SETTINGS.checkpointToleranceMs||k.at>=w.close*1000){coverage.invalid++;continue;}
      settled++;if(!k.arrival)coverage.missingArrival++;
      for(const side of ['Up','Down']){
        const price=(side==='Up'?k.depth.yes:k.depth.no)[0]?.price;
        const i=PRICE_BANDS.findIndex((lo,i)=>price>=lo&&price<PRICE_BANDS[i+1]);
        if(i>=0)add('price-bands',c,side,`${PRICE_BANDS[i]}–${PRICE_BANDS[i+1]}¢`,w,k);
      }
      if(c<=60&&k.projection?.observed>0&&k.projection.m>0&&k.projection.missing===0&&
        typeof k.bias.spotAbove==='boolean'&&typeof k.bias.projectedAbove==='boolean'&&k.bias.spotAbove!==k.bias.projectedAbove)
        add('settlement-disagreement',c,k.bias.projectedAbove?'Up':'Down',null,w,k);
      if(!finite(k.bias.move5Z))coverage.missingMove++;
      else if(Math.abs(k.bias.move5Z)>=1)add('index-follow-through',c,k.bias.move5Z>0?'Up':'Down',null,w,k);
    }
  }
  const rows=[...groups.values()].map(g=>{
    const out={...g,days:g.days.size,winRate:g.n?g.wins/g.n:null,meanAskCents:g.n?g.askSum/g.n:null,
      meanAllInCents:g.n?g.costSum/g.n:null,fillRate:g.attempts?g.filled/g.attempts:null,
      meanNetCents:g.filled?g.pnlCents/g.filled:null,returnOnCost:g.spentCents?g.pnlCents/g.spentCents:null,
      meanMarkoutCents:g.markoutN?g.markoutSum/g.markoutN:null,meanDelayMs:g.markoutN?g.delaySum/g.markoutN:null,
      evidence:'descriptive forward sample; no validated edge'};
    for(const key of ['askSum','costSum','equity','peak','markoutSum','delaySum'])delete out[key];return out;
  });
  return {version:BIAS_VERSION,captured,eligibleSettledCheckpoints:settled,firstAt,lastAt,coverage,rows,readyForLive:false,
    status:captured?'Collecting forward evidence · no validated edge':'Waiting for new captures · no historical reconstruction',
    definitions:{'price-bands':'Each side in fixed ask-price bands, bought independently at the original limit.',
      'settlement-disagreement':'Final-minute spot and projected average disagree; buy the projected-average side.',
      'index-follow-through':'Five-second BRTI move of at least one short-volatility scale; buy that direction.'},
    limitations:['Fixed hypotheses start only with version-tagged captures; no fitted thresholds or historical backfill.',
      'Each checkpoint, price band and side is separate. Rows overlap; do not sum P&L or sample sizes.',
      'Win rate covers all eligible quotes; net P&L covers simulated fills only. Fill selection can change outcomes.',
      'Signed midpoint movement over actual 1–4s delay is diagnostic, not executable profit or causal latency evidence.',
      'Repeated windows may be dependent. No confidence, significance or automatic promotion claim.',
      'Fee multiplier 1 and depth haircut are assumptions; missing data and rolling retention may bias results.']};
}
globalThis.BTC15Research=Object.freeze({DEPTH_POLICY, clockOffsetEstimate, VERSION,BIAS_VERSION,LEGACY_SETTLEMENT_CONVENTION,CHECKS,SETTINGS,currentCohort,depthWanted,depthSnapshot,snapshot,simulate,report,biasReport});
})();
// END SHARED BTC15 RESEARCH
const research = globalThis.BTC15Research;
// BEGIN SHARED BTC15 SESSION
// Forward-only timed paper experiment. No exchange order calls.
(() => {
const VERSION='paper-session-v2';
const SETTINGS=Object.freeze({durationMs:3600000,cadenceMs:5000,delayMs:1000,maxDelayMs:4000,depthFraction:.5,quantity:1,minEdgeCents:3,exitEdgeCents:3,maxEntriesPerWindow:3,cooldownMs:30000,lossStopCents:300,model:'brti-driftless-v4',settlementConvention:'[close-60s,close)',feeAssumption:'general Kalshi taker fee, rounded up per one-contract fill'});
const M=()=>globalThis.BTC15Model,finite=Number.isFinite;
// Strategies. 'model-edge' is the original: buy the side whose model probability beats the ask by
// the edge threshold, one contract. 'distance-v1' is a price-following rule that ignores the model:
// enter when the official index is enterUsd or more from the target, on that side, spending
// budgetCents at the ask; hold while the distance stays at least holdUsd; sell at the bid when it
// shrinks below holdUsd or the index crosses the target; after a sell, buy the same side again only
// once the index is reentryUsd further from the target than where it sold; a cross restarts the
// entry rule on the other side. No trading in the last stopBeforeCloseMs of a window.
const STRATEGIES=Object.freeze({
 'model-edge':Object.freeze({name:'model-edge'}),
 'distance-v1':Object.freeze({name:'distance-v1',enterUsd:15,holdUsd:10,reentryUsd:25,budgetCents:10000,maxEntriesPerWindow:6,cooldownMs:10000,lossStopCents:20000,stopBeforeCloseMs:60000,indexMaxAgeMs:3000}),
});
function create(now,id,strategy='model-edge'){if(!STRATEGIES[strategy])throw Error('unknown strategy '+strategy);const startAt=(Math.floor(now/900000)+1)*900000+750;return {version:VERSION,id,settings:{...SETTINGS,strategy,strategyParams:{...STRATEGIES[strategy]}},createdAt:now,startAt,endAt:startAt+SETTINGS.durationMs-750,status:'scheduled',looks:[],attempts:[],trades:[],pending:null,nextLookAt:startAt,entries:{},lastEntryAt:null,stoppedAt:null,lastSell:null};}
const strategyOf=s=>s?.settings?.strategy||'model-edge';
const paramsOf=s=>({...STRATEGIES[strategyOf(s)],...(s?.settings?.strategyParams||{})});
// A saved experiment keeps its original cohort forever. Deployment may stop it,
// but must never upgrade its settings or relabel observations with today's model.
function compatibilityReason(s){
 if(!s)return 'missing session';
 if(s.version!==VERSION||s.settings?.model!==SETTINGS.model||s.settings?.settlementConvention!==SETTINGS.settlementConvention)
  return 'incompatible session cohort: expected '+[VERSION,SETTINGS.model,SETTINGS.settlementConvention].join(' / ')+'; recorded '+[s.version??'unspecified',s.settings?.model??'unspecified',s.settings?.settlementConvention??'unspecified'].join(' / ');
 if(M()?.VERSION!==SETTINGS.model||M()?.SETTLEMENT_CONVENTION!==SETTINGS.settlementConvention)return 'incompatible runtime model or settlement interval';
 return null;
}
function compatible(s){return compatibilityReason(s)===null;}
function attribution(s,q){return {sessionVersion:q?.sessionVersion??s.version??null,model:q?.model??q?.decision?.model??s.settings?.model??null,settlementConvention:q?.settlementConvention??q?.decision?.settlementConvention??s.settings?.settlementConvention??null};}
function snapshotReason(k){return k?.model===SETTINGS.model&&k?.settlementConvention===SETTINGS.settlementConvention?null:'snapshot model or settlement interval mismatch';}
function active(s,at){return !!s&&compatible(s)&&s.stoppedAt==null&&at<s.endAt&&['scheduled','running'].includes(s.status);}
function position(s){return s.trades.find(t=>t.pnlCents==null);}
function stop(s,at,reason='time limit',pendingReason='session stopped'){
 if(s.stoppedAt==null){s.stoppedAt=at;s.stopReason=reason;}
 s.status=position(s)?'settling':'complete';
 if(s.pending){s.attempts.push({...s.pending,...attribution(s,s.pending),filled:0,arrivalAt:at,reason:pendingReason});s.pending=null;}
}
// Returns whether persistence is needed. Repeated loads and already-completed
// historical reports do not append attempts, rewrite provenance or move timestamps.
function reconcile(s,at){
 const reason=compatibilityReason(s);
 if(!s||!reason||(!s.pending&&(s.stoppedAt!=null||s.status==='complete')))return false;
 stop(s,at,reason,reason);return true;
}
function clock(s,at){reconcile(s,at);if(s.stoppedAt==null&&at>=s.endAt)stop(s,at);if(s.stoppedAt!=null&&!position(s))s.status='complete';if(active(s,at)&&at>=s.startAt)s.status='running';}
function valid(k){return k?.status==='forecast'&&finite(k.p)&&k.p>=0&&k.p<=1&&k.depth?.valid&&k.marketStatus==='active'&&k.exchange?.exchange_active===true&&k.exchange?.trading_active===true;}
function bid(depth,side){return side==='Up'?depth.bidCents:100-depth.askCents;}
function decide(s,k,mk,close){const at=k.at;clock(s,at);if(!active(s,at)||at<s.startAt||at<s.nextLookAt||s.pending)return;
 s.nextLookAt=at+SETTINGS.cadenceMs;
 const record={sessionVersion:s.version,model:k.model??null,settlementConvention:k.settlementConvention??null,at,mk,close,p:k.p,p2:k.p2,target:k.target,targetAt:k.targetAt,vols:k.vols,status:k.status,reads:k.reads,index:k.index,projection:k.projection,depth:k.depth,marketStatus:k.marketStatus,exchange:k.exchange,reason:null};
 const finish=reason=>{record.reason=reason;s.looks.push(record);};
 const mismatch=snapshotReason(k);if(mismatch)return finish(mismatch);
 if(strategyOf(s)==='distance-v1')return decideDistance(s,k,mk,close,record,finish);
 if(!valid(k))return finish(k.status!=='forecast'?k.status:k.depth?.reason||'market or exchange unavailable');
 if(at+SETTINGS.maxDelayMs>=Math.min(close*1000,s.endAt))return finish('too close to deadline');
 const held=position(s);record.action=held?'sell':'buy';let intent;
 if(held){if(held.mk!==mk)return finish('awaiting official settlement');const price=bid(k.depth,held.side),prob=held.side==='Up'?k.p:1-k.p,edge=price-M().feesCents(price,1,'kalshi')-100*prob;
  record.edgeCents=edge;if(edge<SETTINGS.exitEdgeCents)return finish('hold: exit advantage below 3c');
  intent={action:'sell',side:held.side,limit:price,edgeCents:edge,tradeId:held.id};
 }else{
  const candidates=[['Up',k.p,k.depth.yes[0]],['Down',1-k.p,k.depth.no[0]]].filter(x=>x[2]).map(([side,p,l])=>({side,limit:l.price,edgeCents:100*p-l.price-M().feesCents(l.price,1,'kalshi')})).sort((a,b)=>b.edgeCents-a.edgeCents);
  intent=candidates[0];record.edgeCents=intent?.edgeCents??null;
  if(!intent||intent.edgeCents<SETTINGS.minEdgeCents)return finish('entry edge below 3c');
  if(s.trades.reduce((n,t)=>n+(t.pnlCents||0),0)<=-SETTINGS.lossStopCents)return finish('session loss stop');
  if((s.entries[mk]||0)>=SETTINGS.maxEntriesPerWindow)return finish('window entry-attempt cap');
  if(s.lastEntryAt!=null&&at-s.lastEntryAt<SETTINGS.cooldownMs)return finish('entry cooldown');
  intent.action='buy';s.entries[mk]=(s.entries[mk]||0)+1;s.lastEntryAt=at;
 }
 s.pending={...intent,sessionVersion:s.version,model:k.model,settlementConvention:k.settlementConvention,at,readyAt:at+SETTINGS.delayMs,mk,close,p:k.p,decision:record};finish(intent.action+' intent');
}
// Price-following rule. Uses the latest official one-second index reading and the market's target;
// the model probability is recorded but plays no part.
function decideDistance(s,k,mk,close,record,finish){
 const at=k.at,P=paramsOf(s),index=k.index,S0=index?.value,K=k.target;
 const live=k.depth?.valid&&k.marketStatus==='active'&&k.exchange?.exchange_active===true&&k.exchange?.trading_active===true;
 if(!live)return finish(k.depth?.reason||'market or exchange unavailable');
 if(!finite(S0)||!finite(index?.ageMs)||index.ageMs>P.indexMaxAgeMs)return finish('stale official index');
 if(!finite(K))return finish('missing target known at capture');
 const d=S0-K;record.distanceUsd=d;
 const deadline=Math.min(close*1000-P.stopBeforeCloseMs,s.endAt);
 if(at+SETTINGS.maxDelayMs>=deadline)return finish('inside the final minute');
 const held=position(s);record.action=held?'sell':'buy';
 if(held){
  if(held.mk!==mk)return finish('awaiting official settlement');
  const onSide=held.side==='Up'?d:-d;record.heldDistanceUsd=onSide;
  if(onSide>=P.holdUsd)return finish('hold: distance '+onSide.toFixed(2)+' holds above '+P.holdUsd);
  const price=bid(k.depth,held.side);if(!finite(price))return finish('no bid to sell into');
  s.pending={action:'sell',side:held.side,limit:price,n:held.n||1,tradeId:held.id,distanceUsd:d,sessionVersion:s.version,model:k.model,settlementConvention:k.settlementConvention,at,readyAt:at+SETTINGS.delayMs,mk,close,p:k.p,decision:record};
  return finish('sell intent: distance '+onSide.toFixed(2)+(onSide<0?' crossed':' below '+P.holdUsd));
 }
 const side=d>=P.enterUsd?'Up':d<=-P.enterUsd?'Down':null;
 if(!side)return finish('inside entry band: '+d.toFixed(2)+' vs ±'+P.enterUsd);
 const last=s.lastSell;
 if(last&&last.mk===mk&&last.side===side){const further=Math.abs(d)-Math.abs(last.distanceUsd);record.sinceSellUsd=further;if(further<P.reentryUsd)return finish('awaiting re-entry: '+further.toFixed(2)+' further than the sell, need '+P.reentryUsd);}
 if(s.trades.reduce((n,t)=>n+(t.pnlCents||0),0)<=-P.lossStopCents)return finish('session loss stop');
 if((s.entries[mk]||0)>=P.maxEntriesPerWindow)return finish('window entry-attempt cap');
 if(s.lastEntryAt!=null&&at-s.lastEntryAt<P.cooldownMs)return finish('entry cooldown');
 const level=(side==='Up'?k.depth.yes:k.depth.no)[0];if(!level)return finish('no ask to buy from');
 const n=Math.floor(P.budgetCents/level.price);if(n<1)return finish('budget below one contract');
 s.entries[mk]=(s.entries[mk]||0)+1;s.lastEntryAt=at;
 s.pending={action:'buy',side,limit:level.price,n,distanceUsd:d,sessionVersion:s.version,model:k.model,settlementConvention:k.settlementConvention,at,readyAt:at+SETTINGS.delayMs,mk,close,p:k.p,decision:record};
 return finish('buy intent: '+n+' contracts at ≤'+level.price+'¢, distance '+d.toFixed(2));
}
function arrive(s,k){const at=k.at;clock(s,at);const q=s.pending;if(!q||at<q.readyAt)return;
 s.pending=null;const result={...q,...attribution(s,q),arrivalModel:k.model??null,arrivalSettlementConvention:k.settlementConvention??null,arrivalAt:at,arrivalDepth:k.depth,arrivalExchange:k.exchange,arrivalMarketStatus:k.marketStatus,arrivalReads:k.reads,filled:0,reason:null};s.attempts.push(result);
 if(q.sessionVersion!==s.version||q.model!==s.settings.model||q.settlementConvention!==s.settings.settlementConvention){result.reason='intent model or settlement interval mismatch';return;}
 const mismatch=snapshotReason(k);if(mismatch){result.reason=mismatch;return;}
 if(!active(s,at)||at>=q.close*1000||at-q.at>SETTINGS.maxDelayMs){result.reason='arrival outside allowed time';return;}
 // Arrival requires a live market and book; never requires a new favourable prediction.
 if(!k.depth?.valid||k.marketStatus!=='active'||k.exchange?.exchange_active!==true||k.exchange?.trading_active!==true){result.reason=k.depth?.reason||'arrival market or exchange unavailable';return;}
 const levels=q.action==='buy'?(q.side==='Up'?k.depth.yes:k.depth.no):(q.side==='Up'?k.depth.no:k.depth.yes).map(l=>({...l,price:100-l.price}));
 const want=q.n||1;
 if(want===1){
  const level=levels.find(l=>Math.floor(l.size*SETTINGS.depthFraction)>=1&&(q.action==='buy'?l.price<=q.limit+1e-9:l.price>=q.limit-1e-9));
  if(!level){result.reason='no depth at original limit after haircut';return;}
  const fee=M().feesCents(level.price,1,'kalshi');result.filled=1;result.priceCents=level.price;result.feesCents=fee;result.reason='simulated fill';
  if(q.action==='buy')s.trades.push({...attribution(s,q),id:s.id+':'+s.trades.length,mk:q.mk,close:q.close,side:q.side,entryAt:at,entryCents:level.price,entryFeeCents:fee,pnlCents:null});
  else{const t=s.trades.find(t=>t.id===q.tradeId&&t.pnlCents==null);if(!t)throw Error('paper position missing');Object.assign(t,{exitAt:at,exitCents:level.price,exitFeeCents:fee,pnlCents:level.price-fee-t.entryCents-t.entryFeeCents,resolution:'early exit'});}
  return;
 }
 // Several contracts: walk the levels at or better than the original limit, half the displayed
 // size at each, until the quantity is met. Partial fills are real fills; the rest stays unfilled.
 let remaining=want,cost=0,fees=0;const fills=[];
 for(const l of levels){
  if(q.action==='buy'?l.price>q.limit+1e-9:l.price<q.limit-1e-9)break;
  const take=Math.min(remaining,Math.floor(l.size*SETTINGS.depthFraction));if(take<1)continue;
  fills.push({price:l.price,n:take});cost+=take*l.price;fees+=M().feesCents(l.price,take,'kalshi');remaining-=take;if(!remaining)break;
 }
 const filled=want-remaining;
 if(!filled){result.reason='no depth at original limit after haircut';return;}
 const avg=Math.round(cost/filled*100)/100;
 Object.assign(result,{filled,requested:want,priceCents:avg,feesCents:fees,levels:fills,reason:remaining?'simulated partial fill':'simulated fill'});
 if(q.action==='buy')s.trades.push({...attribution(s,q),id:s.id+':'+s.trades.length,mk:q.mk,close:q.close,side:q.side,n:filled,entryAt:at,entryCents:avg,entryFeeCents:fees,entryDistanceUsd:q.distanceUsd??null,pnlCents:null});
 else{
  const t=s.trades.find(t=>t.id===q.tradeId&&t.pnlCents==null);if(!t)throw Error('paper position missing');
  const held=t.n||1,closedN=Math.min(filled,held);
  if(closedN<held){ // the unsold remainder stays open as its own position, carrying its share of the entry fee
   const rest=held-closedN,restFee=Math.round(t.entryFeeCents*rest/held*100)/100;
   s.trades.push({...t,id:t.id+':r',n:rest,entryFeeCents:restFee,pnlCents:null});t.n=closedN;t.entryFeeCents=Math.round((t.entryFeeCents-restFee)*100)/100;
  }
  Object.assign(t,{exitAt:at,exitCents:avg,exitFeeCents:fees,pnlCents:Math.round((closedN*(avg-t.entryCents)-fees-t.entryFeeCents)*100)/100,resolution:'early exit'});
  s.lastSell={mk:q.mk,side:q.side,distanceUsd:q.distanceUsd??null,at,price:avg};
 }
}
function settle(s,mk,result,at){if(!['yes','no'].includes(result))return;for(const t of s.trades.filter(t=>t.mk===mk&&t.pnlCents==null&&at>=t.close*1000)){const won=(t.side==='Up')===(result==='yes'),n=t.n||1;Object.assign(t,{exitAt:at,exitCents:won?100:0,exitFeeCents:0,pnlCents:Math.round((n*((won?100:0)-t.entryCents)-t.entryFeeCents)*100)/100,resolution:'official settlement',officialResult:result});}clock(s,at);}
// Observed coverage, not backfilled decisions. Count only finished five-second
// bins; an in-progress bin is not a missed look. A stop closes its partial bin.
function coverage(s,now){
 const cadence=s.settings?.cadenceMs,start=s.startAt,end=s.endAt;
 if(!finite(cadence)||cadence<=0||!finite(start)||!finite(end)||end<=start)return null;
 const cutoff=Math.max(start,Math.min(now,end,s.stoppedAt??Infinity));
 const finished=cutoff>=end||s.stoppedAt!=null&&s.stoppedAt<=now;
 const planned=Math.ceil((end-start)/cadence),elapsed=Math.min(planned,Math.max(0,(finished?Math.ceil:Math.floor)((cutoff-start)/cadence)));
 const bins=new Map(),times=[];
 for(const l of s.looks){if(!finite(l.at)||l.at<start||l.at>=end||l.at>cutoff)continue;
  const slot=Math.floor((l.at-start)/cadence);bins.set(slot,(bins.get(slot)||0)+1);times.push(l.at);
 }
 const quarter=Math.floor(start/900000)*900000;
 const windows=Array.from({length:Math.ceil((end-quarter)/900000)},(_,i)=>({startAt:quarter+i*900000,close:quarter/1000+(i+1)*900,plannedSlots:0,elapsedSlots:0,observedSlots:0,missedSlots:0}));
 let observed=0;
 for(let slot=0;slot<planned;slot++){
  const w=windows[Math.floor((start+slot*cadence-quarter)/900000)];w.plannedSlots++;
  if(slot<elapsed){w.elapsedSlots++;if(bins.has(slot)){w.observedSlots++;observed++;}else w.missedSlots++;}
 }
 times.sort((a,b)=>a-b);let maxGap=0;
 for(let i=1;i<times.length;i++)maxGap=Math.max(maxGap,times[i]-times[i-1]);
 return {version:'observed-five-second-bins-v1',throughAt:cutoff,plannedSlots:planned,elapsedSlots:elapsed,observedSlots:observed,missedSlots:elapsed-observed,
  fraction:elapsed?observed/elapsed:null,extraLooksInSameSlot:[...bins.values()].reduce((n,c)=>n+Math.max(0,c-1),0),maxEvaluationGapMs:times.length>1?maxGap:null,windows};
}
function report(s,now=Date.now()){const closed=s.trades.filter(t=>t.pnlCents!=null).sort((a,b)=>a.exitAt-b.exitAt);let pnl=0,peak=0,drawdown=0;for(const t of closed){pnl+=t.pnlCents;peak=Math.max(peak,pnl);drawdown=Math.max(drawdown,peak-pnl);}const reasons={};for(const r of [...s.looks,...s.attempts.filter(a=>!a.filled)])reasons[r.reason]=(reasons[r.reason]||0)+1;
 const delays=s.attempts.filter(a=>a.filled&&finite(a.arrivalAt)&&finite(a.at)).map(a=>a.arrivalAt-a.at);
 return {version:s.version,strategy:strategyOf(s),strategyParams:paramsOf(s),model:s.settings?.model??null,settlementConvention:s.settings?.settlementConvention??null,compatible:compatible(s),contractsFilled:s.trades.reduce((n,t)=>n+(t.n||1),0),spentCents:Math.round(s.trades.reduce((n,t)=>n+(t.n||1)*t.entryCents,0)),compatibilityReason:compatibilityReason(s),looks:s.looks.length,eligible:s.looks.filter(l=>finite(l.edgeCents)).length,skippedDecisions:s.looks.filter(l=>!/^(buy|sell) intent/.test(l.reason||'')).length,coverage:coverage(s,now),fillDelayMs:delays.length?{min:Math.min(...delays),mean:delays.reduce((n,d)=>n+d,0)/delays.length,max:Math.max(...delays)}:null,attempts:s.attempts.length+(s.pending?1:0),entryFills:s.trades.length,exitFills:closed.filter(t=>t.resolution==='early exit').length,wins:closed.filter(t=>t.pnlCents>0).length,losses:closed.filter(t=>t.pnlCents<0).length,open:s.trades.length-closed.length,feesCents:s.attempts.reduce((n,a)=>n+(a.feesCents||0),0),pnlCents:pnl,drawdownCents:drawdown,edgeAvailable:s.looks.some(l=>l.action==='buy'&&l.edgeCents>=SETTINGS.minEdgeCents),reasons,unrealizedExcluded:true};}
function due(s,now){if(!s)return Infinity;if(!active(s,now))return s.stoppedAt==null?now+100:Infinity;return Math.max(now+100,Math.min(s.endAt,s.pending?.readyAt??Infinity,s.nextLookAt));}
globalThis.BTC15Session={VERSION,SETTINGS,STRATEGIES,create,compatible,reconcile,active,clock,stop,decide,arrive,settle,report,due};
})();
// END SHARED BTC15 SESSION
// BEGIN SHARED BTC15 REPLICA
// Canonical BRTI replica. scripts/sync-model.cjs embeds this exact source in the tape page.
// Re-implements the published CME CF Real Time Indices calculation (methodology v17.0,
// 21 Sep 2026) from the constituent order books the page can see. It is research context:
// it never replaces the official index, never settles anything and is not used by the
// frozen probability model. Deviations from the official calculation are listed in REPLICA.md.
// v2 corrects D from 5% to the published 0.5%; v1 integrated hundreds of BTC deep and ran $30-40 off.
(() => {
const VERSION = "brti-replica-v2";
const METHODOLOGY = "CME CF RTI methodology v17.0";
// BTC-USD parameters (methodology sections 6.1-6.2).
const PARAMS = Object.freeze({
  deviation: 0.005,     // D: utilized depth stops where the ask curve is more than 0.5% above the mid curve
  erroneous: 0.05,      // a book whose mid is >5% from the median mid is excluded
  reinstate: 0.025,     // ...and readmitted only once back within half that
  lagMs: 10000,         // a book retrieved more than 10 s before the calculation is excluded
  tau: 100,             // level-based spacing: smaller side's liquidity / 100
  lambdaFrac: 0.3,      // lambda = 1 / (0.3 * utilized depth)
  capSd: 5,             // order size cap = trimmed mean + 5 winsorized standard deviations
  capLevels: 50, capBand: 0.05, winsor: 0.01,
  effectiveMs: 200,
});

// Aggregate one side by price, dropping non-numeric or non-positive entries.
function side(raw, bids) {
  const byPrice = new Map();
  for (const level of raw || []) {
    const p = +level[0], s = +level[1];
    if (!(Number.isFinite(p) && p > 0 && Number.isFinite(s) && s > 0)) continue;
    byPrice.set(p, (byPrice.get(p) || 0) + s);
  }
  return [...byPrice].sort(bids ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
}
// One exchange's relevant order book, or the reason it is excluded (methodology section 5).
function cleanBook(book) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return {error: "unparseable"};
  const bids = side(book.bids, true), asks = side(book.asks, false);
  if (!bids.length || !asks.length) return {error: "one-sided"};
  if (bids[0][0] >= asks[0][0]) return {error: "crossed"};
  return {bids, asks, mid: (bids[0][0] + asks[0][0]) / 2};
}
function merge(books, bids) {
  const byPrice = new Map();
  for (const b of books) for (const [p, s] of bids ? b.bids : b.asks) byPrice.set(p, (byPrice.get(p) || 0) + s);
  return [...byPrice].sort(bids ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
}
function winsorized(sorted) {          // sorted ascending; k = floor(1% of n) each tail
  const n = sorted.length, k = Math.floor(PARAMS.winsor * n);
  const lo = sorted[k], hi = sorted[n - 1 - k];
  return {k, values: sorted.map(x => Math.min(hi, Math.max(lo, x)))};
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
// Dynamic order size cap from the uncapped consolidated book (section 4.1.3).
function sizeCap(bids, asks) {
  const take = (levels, inBand) => levels.slice(0, Math.max(levels.filter(inBand).length, Math.min(levels.length, PARAMS.capLevels)));
  const a = take(asks, ([p]) => p <= asks[0][0] * (1 + PARAMS.capBand));
  const b = take(bids, ([p]) => p >= bids[0][0] * (1 - PARAMS.capBand));
  const sizes = a.concat(b).map(([, s]) => s).sort((x, y) => x - y);
  const {k, values} = winsorized(sizes);
  const trimmed = sizes.slice(k, sizes.length - k);
  return mean(trimmed) + PARAMS.capSd * sd(values);
}
// Remove the lesser top size from both sides while the consolidated book is crossed (v16.8+).
function uncross(bids, asks) {
  bids = bids.map(l => l.slice()); asks = asks.map(l => l.slice());
  let i = 0, j = 0;
  while (i < bids.length && j < asks.length && bids[i][0] >= asks[j][0]) {
    const m = Math.min(bids[i][1], asks[j][1]);
    bids[i][1] -= m; asks[j][1] -= m;
    if (bids[i][1] <= 1e-12) i++;
    if (asks[j][1] <= 1e-12) j++;
  }
  return {bids: bids.slice(i), asks: asks.slice(j)};
}
// Mode of a Gaussian kernel density over winsorized sizes, evaluated at the sample values.
// The methodology does not state the search grid; evaluating at the samples is this replica's choice.
// Books with tens of thousands of levels are subsampled (every k-th size after sorting) to keep
// a 200 ms tick cheap; up to KDE_MAX_SAMPLES every size is used. A replica choice, not CF's.
const KDE_MAX_SAMPLES = 4000;
function kdeMode(sizes) {
  let sorted = sizes.slice().sort((x, y) => x - y);
  if (sorted.length > KDE_MAX_SAMPLES) { const k = Math.ceil(sorted.length / KDE_MAX_SAMPLES); sorted = sorted.filter((_, i) => i % k === 0); }
  const n = sorted.length;
  if (n < 4) return sorted[0];
  const {values} = winsorized(sorted), sigma = sd(values);
  if (!(sigma > 0)) return values[0];
  const h = 1.06 * sigma * Math.pow(n, -0.2), reach = 6 * h;
  let best = values[0], bestD = -1, lo = 0, hi = 0, prev = NaN;
  for (const x of values) {
    if (x === prev) continue; prev = x;
    while (values[lo] < x - reach) lo++;
    while (hi < n && values[hi] <= x + reach) hi++;
    let d = 0;
    for (let i = lo; i < hi; i++) d += Math.exp(-0.5 * ((x - values[i]) / h) ** 2);
    if (d > bestD) { bestD = d; best = x; }
  }
  return best;
}
const total = levels => levels.reduce((a, [, s]) => a + s, 0);
function spacing(bids, asks) {
  const tb = total(bids), ta = total(asks);
  const lev = Math.min(ta, tb) / PARAMS.tau;
  const kde = kdeMode((tb < ta ? bids : asks).map(([, s]) => s));
  return Math.min(lev, kde);
}
// Marginal price at cumulative volume v for each grid point s, 2s, ... while both sides last.
function curve(levels, s, maxN) {
  const out = []; let cum = 0, j = 0;
  for (let i = 1; i <= maxN; i++) {
    const v = i * s;
    while (j < levels.length && cum + levels[j][1] < v - 1e-9 * v) { cum += levels[j][1]; j++; }
    if (j >= levels.length) break;
    out.push(levels[j][0]);
  }
  return out;
}

// state: {excluded: {exchange: true}} carried between calls for the erroneous-data hysteresis.
function calculate(books, nowMs, state = {excluded: {}}) {
  const used = [], excluded = {}, valid = [];
  for (const [name, book] of Object.entries(books || {})) {
    if (!book || !Number.isFinite(book.at)) { excluded[name] = "no book"; continue; }
    if (nowMs - book.at > PARAMS.lagMs) { excluded[name] = "delayed"; continue; }
    const c = cleanBook(book);
    if (c.error) { excluded[name] = c.error; continue; }
    valid.push([name, c]);
  }
  const mids = valid.map(([, c]) => c.mid).sort((a, b) => a - b);
  const median = mids.length ? (mids[(mids.length - 1) >> 1] + mids[mids.length >> 1]) / 2 : null;
  const nextState = {excluded: {}};
  const kept = [];
  for (const [name, c] of valid) {
    const dev = Math.abs(c.mid / median - 1);
    const limit = state.excluded && state.excluded[name] ? PARAMS.reinstate : PARAMS.erroneous;
    if (dev > limit) { excluded[name] = "potentially erroneous"; nextState.excluded[name] = true; continue; }
    kept.push(c); used.push(name);
  }
  const fail = reason => ({value: null, reason, used, excluded, state: nextState, version: VERSION});
  if (!kept.length) return fail("no usable books");
  let bids = merge(kept, true), asks = merge(kept, false);
  const cap = sizeCap(bids, asks);
  bids = bids.map(([p, s]) => [p, Math.min(s, cap)]);
  asks = asks.map(([p, s]) => [p, Math.min(s, cap)]);
  ({bids, asks} = uncross(bids, asks));
  if (!bids.length || !asks.length) return fail("book exhausted by uncrossing");
  const s = spacing(bids, asks);
  if (!(s > 0)) return fail("no spacing");
  const maxN = Math.floor(Math.min(total(bids), total(asks)) / s + 1e-9);
  const ask = curve(asks, s, maxN), bid = curve(bids, s, maxN), n = Math.min(ask.length, bid.length);
  if (!n) return fail("no curve");
  let last = 0;                                   // index of the last grid point within D
  for (let i = 0; i < n; i++) {
    const mid = (ask[i] + bid[i]) / 2;
    if (ask[i] / mid - 1 <= PARAMS.deviation) last = i; else break;
  }
  const depthLimited = last === n - 1;            // the visible books ran out before the 0.5% band did
  const vT = (last + 1) * s, lambda = 1 / (PARAMS.lambdaFrac * vT);
  let sum = 0, wsum = 0;
  for (let i = 0; i <= last; i++) {
    const w = Math.exp(-lambda * (i + 1) * s);
    sum += w * (ask[i] + bid[i]) / 2; wsum += w;
  }
  const value = sum / wsum;
  return {value, rounded: Math.round(value * 100) / 100, vT, spacing: s, cap, lambda, points: last + 1,
          depthLimited, used, excluded, state: nextState, version: VERSION};
}

// Tracking against the official index. Replica values are stamped with local compute time;
// official ticks carry both their source timestamp and local receipt time.
function track(replica, official, opts = {}) {
  const lags = opts.lags || Array.from({length: 31}, (_, i) => (i - 10) * 200);   // -2 s .. +4 s
  const maxGap = opts.maxGapMs || 1500;
  // Official value in force at a moment on the chosen clock (last tick at or before it).
  const at = (series, key, t) => {
    let lo = 0, hi = series.length - 1, hit = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m][key] <= t) { hit = m; lo = m + 1; } else hi = m - 1; }
    return hit >= 0 && t - series[hit][key] <= maxGap ? series[hit].v : null;
  };
  const score = key => {
    const series = official.filter(o => Number.isFinite(o[key]) && Number.isFinite(o.v)).sort((a, b) => a[key] - b[key]);
    let best = null; const curveOut = [];
    for (const lag of lags) {
      let errs = [];
      for (const r of replica) { const o = at(series, key, r.t + lag); if (o != null && Number.isFinite(r.v)) errs.push(r.v - o); }
      if (errs.length < (opts.minPairs || 20)) { curveOut.push({lag, n: errs.length, mae: null}); continue; }
      if (opts.demean) {            // a series with a level offset (a perpetual's basis): score around its median difference
        const sorted = errs.slice().sort((a, b) => a - b), med = sorted[(sorted.length - 1) >> 1];
        errs = errs.map(e => e - med);
      }
      errs = errs.map(Math.abs).sort((a, b) => a - b);
      const mae = mean(errs), med = errs[(errs.length - 1) >> 1];
      curveOut.push({lag, n: errs.length, mae, median: med});
      if (!best || mae < best.mae) best = {lag, n: errs.length, mae, median: med};
    }
    return {best, curve: curveOut};
  };
  // Same-instant error against the source timestamp (accuracy), and the shift against
  // receipt time that best aligns the two (positive = the replica moves first).
  const source = score("t"), receipt = score("at");
  const zero = source.curve.find(c => c.lag === 0);
  return {accuracy: zero && zero.mae != null ? zero : null, sourceBest: source.best, headStartMs: receipt.best ? receipt.best.lag : null,
          receiptBest: receipt.best, receiptCurve: receipt.curve};
}

// Does the Kalshi book move after the replica, or before it? Event-based: a replica event is a
// one-second index move of at least `moveUsd` (default: three robust standard deviations of
// one-second moves in the window); a book event is a mid change of at least `midCents` while the
// mid is between `minMid` and `maxMid` (far from the strike the book has no reason to move).
// For each replica event the nearest book event within `windowMs` is found and dt = book - replica.
function leadLag(replica, mids, opts = {}) {
  const windowMs = opts.windowMs || 5000, dead = opts.deadbandMs || 150, midCents = opts.midCents || 1;
  const minMid = opts.minMid ?? 10, maxMid = opts.maxMid ?? 90, debounce = opts.debounceMs || 2000;
  const r = replica.filter(x => Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  const m = mids.filter(x => Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  // One-second moves of the replica.
  const moves = []; let j = 0;
  for (let i = 0; i < r.length; i++) {
    while (j < i && r[i].t - r[j + 1].t >= 1000) j++;
    if (r[i].t - r[j].t >= 800 && r[i].t - r[j].t <= 1500) moves.push({t: r[i].t, d: r[i].v - r[j].v});
  }
  if (moves.length < 20) return {events: 0, reason: "too few replica moves", moveUsd: null};
  let moveUsd = opts.moveUsd;
  if (!(moveUsd > 0)) {
    const abs = moves.map(x => Math.abs(x.d)).sort((a, b) => a - b), med = abs[(abs.length - 1) >> 1];
    moveUsd = Math.max(1, 3 * 1.4826 * med);
  }
  // The book mid in force at a moment (last change at or before it); an index move while the
  // mid sits outside [minMid, maxMid] is not an event, since the book has no reason to react.
  const midAt = t => { let lo = 0, hi = m.length - 1, hit = -1; while (lo <= hi) { const k = (lo + hi) >> 1; if (m[k].t <= t) { hit = k; lo = k + 1; } else hi = k - 1; } return hit >= 0 ? m[hit].v : null; };
  const rEvents = []; let lastAt = -Infinity, pinned = 0;
  for (const x of moves) {
    if (!(Math.abs(x.d) >= moveUsd && x.t - lastAt >= debounce)) continue;
    lastAt = x.t;
    const mid = midAt(x.t);
    if (mid == null || mid < minMid || mid > maxMid) { pinned++; continue; }
    rEvents.push({t: x.t, dir: Math.sign(x.d)});
  }
  const mEvents = []; let prev = null; lastAt = -Infinity;
  for (const x of m) {
    if (prev && Math.abs(x.v - prev.v) >= midCents && x.v >= minMid && x.v <= maxMid && prev.v >= minMid && prev.v <= maxMid && x.t - lastAt >= 1000) { mEvents.push({t: x.t, dir: Math.sign(x.v - prev.v)}); lastAt = x.t; }
    prev = x;
  }
  let after = 0, before = 0, same = 0, none = 0, agree = 0; const dts = [];
  for (const e of rEvents) {
    let best = null;
    for (const k of mEvents) { const dt = k.t - e.t; if (Math.abs(dt) <= windowMs && (!best || Math.abs(dt) < Math.abs(best.dt))) best = {dt, dir: k.dir}; }
    if (!best) { none++; continue; }
    dts.push(best.dt);
    if (best.dt > dead) after++; else if (best.dt < -dead) before++; else same++;
    if (best.dir === e.dir) agree++;
  }
  dts.sort((a, b) => a - b);
  return {events: rEvents.length, bookEvents: mEvents.length, after, before, same, none, agree, moveUsd, pinned,
          medianDtMs: dts.length ? dts[(dts.length - 1) >> 1] : null, reacted: rEvents.length - none};
}

globalThis.BTC15Replica = Object.freeze({VERSION, METHODOLOGY, PARAMS, cleanBook, sizeCap, uncross, kdeMode, spacing, curve, calculate, track, leadLag});
})();
// END SHARED BTC15 REPLICA
// BEGIN SHARED BTC15 DEPTH
// Canonical order-book adapters for the BRTI replica. scripts/sync-model.cjs embeds this exact
// source in the tape page and in the Worker. Each adapter keeps one constituent exchange's book
// current through a book object with snapshot/set/touch/reset; the host owns the socket.
(() => {
const REPLICA_BAND = 0.15;   // levels further than this from an exchange's own touch are ignored
const CONSTITUENTS = ["Bitstamp", "Coinbase", "Kraken", "Gemini", "Bullish", "Crypto.com", "LMAX Digital"];
const DEPTH_VENUES = {
  // Coinbase Exchange: level2_batch is the full book without authentication (50 ms batches).
  // No sequence numbers on this channel; the heartbeat channel proves the connection is current.
  coinbase: {name: "Coinbase", url: "wss://ws-feed.exchange.coinbase.com",
    open: ws => ws.send(JSON.stringify({type: "subscribe", product_ids: ["BTC-USD"], channels: ["level2_batch", "heartbeat"]})),
    msg: (d, book) => {
      if (d.type === "snapshot" && d.product_id === "BTC-USD") book.snapshot(d.bids || [], d.asks || []);
      else if (d.type === "l2update" && d.product_id === "BTC-USD") for (const [side, p, sz] of d.changes || []) book.set(side === "buy", p, sz);
      else if (d.type === "heartbeat") book.touch();
    }},
  // Kraken v2 book, 1000 levels. Sizes are absolute; apply in order; levels pushed past the
  // subscribed depth are not deleted by Kraken, so the book is truncated after each message.
  // A CRC32 of the top ten levels guards the book; a mismatch forces a fresh snapshot.
  kraken: {name: "Kraken", url: "wss://ws.kraken.com/v2", depth: 1000,
    open: ws => ws.send(JSON.stringify({method: "subscribe", params: {channel: "book", symbol: ["BTC/USD"], depth: 1000}})),
    msg: (d, book, ws, st, b) => {
      if (d.channel === "heartbeat") return book.touch();
      if (d.channel !== "book" || !Array.isArray(d.data)) return;
      for (const x of d.data) {
        if (x.symbol !== "BTC/USD") continue;
        const lv = a => (a || []).map(l => [l.price, l.qty]);
        if (d.type === "snapshot") book.snapshot(lv(x.bids), lv(x.asks));
        else if (d.type === "update") { for (const [p, q] of lv(x.bids)) book.set(true, p, q); for (const [p, q] of lv(x.asks)) book.set(false, p, q); }
        else continue;
        truncateBook(b, 1000);
        if (Number.isFinite(x.checksum) && b.ready) {
          if (krakenChecksum(b) === x.checksum >>> 0) st.checked = true;
          else if (st.checked) return book.reset("checksum mismatch, resyncing");
          else b.note = "checksum format unconfirmed";
        }
      }
    }},
  // Bitstamp: every message is the full top 100 bids and asks. The page reads the book from its
  // existing Bitstamp quote socket instead (it marks this entry shared); the Worker opens this one.
  bitstamp: {name: "Bitstamp", url: "wss://ws.bitstamp.net", depth: 100,
    open: ws => ws.send(JSON.stringify({event: "bts:subscribe", data: {channel: "order_book_btcusd"}})),
    ping: ws => ws.send(JSON.stringify({event: "bts:heartbeat"})),
    msg: (d, book) => {
      if (d.event === "bts:request_reconnect") book.reset("exchange asked to reconnect");
      else if (d.event === "data" && d.channel === "order_book_btcusd" && d.data && Array.isArray(d.data.bids)) book.snapshot(d.data.bids, d.data.asks || []);
      else if (d.event === "bts:heartbeat") book.touch();
    }},
  // Gemini v1 market data, full book: the first update carries every level ("initial");
  // later changes give the absolute remaining size. socket_sequence must rise by one.
  gemini: {name: "Gemini", url: "wss://api.gemini.com/v1/marketdata/BTCUSD?bids=true&offers=true&trades=false&auctions=false&heartbeat=true",
    open: () => {},
    msg: (d, book, ws, st) => {
      if (Number.isFinite(d.socket_sequence)) {
        if (st.seq != null && d.socket_sequence !== st.seq + 1) return book.reset("sequence gap, resyncing");
        st.seq = d.socket_sequence;
      }
      if (d.type === "heartbeat") return book.touch();
      if (d.type !== "update" || !Array.isArray(d.events)) return;
      const changes = d.events.filter(e => e.type === "change");
      if (changes.length && changes.every(e => e.reason === "initial")) {
        book.snapshot(changes.filter(e => e.side === "bid").map(e => [e.price, e.remaining]), changes.filter(e => e.side === "ask").map(e => [e.price, e.remaining]));
      } else for (const e of changes) book.set(e.side === "bid", e.price, e.remaining);
      book.touch();
    }},
  // Crypto.com: SNAPSHOT mode sends the full top 50 every 500 ms; heartbeats must be answered.
  cryptocom: {name: "Crypto.com", url: "wss://stream.crypto.com/exchange/v1/market", depth: 50,
    open: ws => setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({id: 1, method: "subscribe", params: {channels: ["book.BTC_USD.50"], book_subscription_type: "SNAPSHOT"}, nonce: Date.now()})); }, 1000),
    msg: (d, book, ws) => {
      if (d.method === "public/heartbeat") { ws.send(JSON.stringify({id: d.id, method: "public/respond-heartbeat"})); return book.touch(); }
      const r = d.result;
      if (!r || r.channel !== "book" || r.instrument_name !== "BTC_USD" || !Array.isArray(r.data)) return;
      for (const x of r.data) if (Array.isArray(x.bids) && Array.isArray(x.asks)) book.snapshot(x.bids, x.asks);
    }},
  // Bullish: documented snapshots of 100 levels as flat [price, qty, price, qty, ...] arrays.
  // The incremental format is undocumented, so only snapshots are applied; a book that stops
  // receiving them ages out after 10 s like any delayed book.
  bullish: {name: "Bullish", url: "wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook", depth: 100,
    open: ws => ws.send(JSON.stringify({jsonrpc: "2.0", type: "command", method: "subscribe", id: "1", params: {topic: "l2Orderbook", symbol: "BTCUSD"}})),
    msg: (d, book, ws, st, b) => {
      const x = d.data;
      if (!x || !Array.isArray(x.bids) || !Array.isArray(x.asks) || x.symbol !== "BTCUSD") return;
      const pairs = a => { const out = []; for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };
      if (d.type === "snapshot") book.snapshot(pairs(x.bids), pairs(x.asks));
      else b.note = "ignoring undocumented " + String(d.type).slice(0, 20) + " messages";
    }},
};
function truncateBook(b, n) {            // keep only the n best levels a side, as the exchange does
  for (const [m, isBid] of [[b.bids, true], [b.asks, false]]) {
    if (m.size <= n) continue;
    const keep = [...m.keys()].sort(isBid ? (x, y) => y - x : (x, y) => x - y).slice(0, n);
    const set = new Set(keep);
    for (const p of [...m.keys()]) if (!set.has(p)) m.delete(p);
  }
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(str) { let c = 0xFFFFFFFF; for (let i = 0; i < str.length; i++) c = CRC_TABLE[(c ^ str.charCodeAt(i)) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
// Kraken's book checksum: top ten asks then bids; price (1 dp) and quantity (8 dp) with the
// decimal point and leading zeros removed, concatenated. BTC/USD precisions are assumed here.
function krakenChecksum(b) {
  const part = (p, q) => p.toFixed(1).replace(".", "").replace(/^0+/, "") + q.toFixed(8).replace(".", "").replace(/^0+/, "");
  const asks = [...b.asks].sort((x, y) => x[0] - y[0]).slice(0, 10), bids = [...b.bids].sort((x, y) => y[0] - x[0]).slice(0, 10);
  let str = "";
  for (const [p, q] of asks) str += part(p, q);
  for (const [p, q] of bids) str += part(p, q);
  return crc32(str);
}
function depthOps(b, ws) {
  const put = (m, p, sz) => { p = +p; sz = +sz; if (!(Number.isFinite(p) && p > 0)) return; if (Number.isFinite(sz) && sz > 0) m.set(p, sz); else m.delete(p); };
  return {
    snapshot(bids, asks) { b.bids.clear(); b.asks.clear(); for (const [p, sz] of bids) put(b.bids, p, sz); for (const [p, sz] of asks) put(b.asks, p, sz); b.ready = true; b.at = Date.now(); b.state = "live"; b.backoff = 1000; b.note = ""; },
    set(isBid, p, sz) { if (!b.ready) return; put(isBid ? b.bids : b.asks, p, sz); b.at = Date.now(); },
    touch() { if (b.ready) b.at = Date.now(); },               // heartbeat: the book we hold is still current
    reset(reason) { b.ready = false; b.bids.clear(); b.asks.clear(); b.note = reason; b.state = "resync"; try { ws.close(); } catch (e) {} },
  };
}
function depthSide(m, isBid, limit, ref) {
  const out = [];
  for (const [p, sz] of m) if (isBid ? p >= ref * (1 - REPLICA_BAND) : p <= ref * (1 + REPLICA_BAND)) out.push([p, sz]);
  out.sort(isBid ? (a, c) => c[0] - a[0] : (a, c) => a[0] - c[0]);
  return limit && out.length > limit ? out.slice(0, limit) : out;
}
// The books in the shape BTC15Replica.calculate takes, keyed by exchange name.
function replicaBooksFrom(depthBooks) {
  const books = {};
  for (const [key, spec] of Object.entries(DEPTH_VENUES)) {
    const b = depthBooks[key];
    if (!b || !b.ready || !b.bids.size || !b.asks.size) continue;
    let bestBid = 0, bestAsk = Infinity;
    for (const p of b.bids.keys()) if (p > bestBid) bestBid = p;
    for (const p of b.asks.keys()) if (p < bestAsk) bestAsk = p;
    const ref = (bestBid + bestAsk) / 2;
    books[spec.name] = {bids: depthSide(b.bids, true, spec.depth, ref), asks: depthSide(b.asks, false, spec.depth, ref), at: b.at};
  }
  return books;
}
const newDepthBook = () => ({bids: new Map(), asks: new Map(), at: 0, ready: false, state: "off", ws: null, backoff: 1000, timer: null, fails: 0, note: "", seq: null, openedAt: 0});
globalThis.BTC15Depth = Object.freeze({DEPTH_VENUES, CONSTITUENTS, REPLICA_BAND, depthOps, depthSide, replicaBooksFrom, newDepthBook, truncateBook, crc32, krakenChecksum});
})();
// END SHARED BTC15 DEPTH
const paperSession = globalThis.BTC15Session;
const {tailCdf,volsFrom,projectFrom} = globalThis.BTC15Model;
function feeCents(p) { return globalThis.BTC15Model.feesCents(p*100); }
async function signedGet(env, apiPath, query, options) { return signedCall(env,"live","GET",apiPath+(query||""),undefined,options); }
// Kalshi lists no market for some windows (for example its weekly Thursday-morning maintenance).
// A 404 for a market whose window closed more than ten minutes ago is permanent: settlement
// records the window as unlisted once instead of retrying it every cycle.
const UNLISTED_AFTER_S = 600;
const unlistedMarket = (e, close) => !!e && e.status === 404 && Date.now() / 1000 - close > UNLISTED_AFTER_S;
const HOSTS = {live:"https://external-api.kalshi.com",demo:"https://external-api.demo.kalshi.co"};
function keysFor(env, mode) {
  if(!["live","demo"].includes(mode))throw Error("Unknown API environment");
  return mode === "demo" ? {id:env.KALSHI_DEMO_KEY_ID,pem:env.KALSHI_DEMO_PRIVATE_KEY} : {id:env.KALSHI_KEY_ID,pem:env.KALSHI_PRIVATE_KEY};
}
async function signedCall(env, mode, method, apiPath, body, options = {}) {
  // Production credentials are read-only in this application, regardless of caller.
  if(mode!=="demo" && method!=="GET")throw Error("Production execution disabled");
  if(!/^\/trade-api\/v2\//.test(apiPath)||apiPath.includes("..")||apiPath.includes("#"))throw Error("Invalid API path");
  const k=keysFor(env,mode);if(!k.id||!k.pem)throw Error("no "+mode+" key");
  const budget=apiBudget(env,mode);let sig;const stamp=String(Date.now());
  try{debitBudget(budget,method,apiPath);sig=await signHandshake(k.pem,stamp+method+apiPath.split("?")[0]);}
  catch(e){e.notSubmitted=true;throw e;}
  options.signal?.throwIfAborted();
  const r=await timedFetch(HOSTS[mode]+apiPath,{method,signal:options.signal,body:body?JSON.stringify(body):undefined,
    headers:{Accept:"application/json","Content-Type":"application/json","KALSHI-ACCESS-KEY":k.id.trim(),"KALSHI-ACCESS-SIGNATURE":sig,"KALSHI-ACCESS-TIMESTAMP":stamp}});
  if(r.status===429)budget.pauseUntil=Date.now()+retryDelay(r.headers.get("Retry-After"));
  const text=await r.text();
  if(!r.ok){const e=Error(method+" "+apiPath.split("?")[0]+" HTTP "+r.status);e.status=r.status;throw e;}
  const d=text?JSON.parse(text):{};
  if(apiPath==="/trade-api/v2/account/limits"){budget.limits={usage_tier:d.usage_tier,read:d.read,write:d.write};budget.limitsAt=Date.now();budget.buckets={};}
  return d;
}
async function accountLimits(env,mode="live") {
  const b=apiBudget(env,mode);
  if(Date.now()-(b.checkedAt||0)>300000){b.checkedAt=Date.now();try{await signedCall(env,mode,"GET","/trade-api/v2/account/limits");b.error=null;}catch(e){b.error=e.message;}}
  return {limits:b.limits,at:b.limitsAt,error:b.error||null,retryAt:b.pauseUntil};
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
    this.bookSequences=new Map(); this.demoBusy=false; this.marketCache=new Map(); this.marketPending=new Map();
    this.up = null; this.upState = "off"; this.upSince = 0; this.upMsgAt = 0; this.lastErr = null; this.backoff = 2000;
    this.last = {};                               // last frame of each type, replayed to a phone that just connected
    this.tickerSid = null; this.bookSid = null; this.tickerSet = ""; this.subId = 1;
    this.books = {};                              // ticker -> {yes: Map(price -> qty), no: Map(price -> qty)}
    this.idleTimer = null; this.retryTimer = null; this.windowTimer = null;
    this.counts = {};
    this.ticks = [];                              // [[ms, value]] from the stream, last 20 minutes, for the agent
    this.settleAvg = null;                        // Stream final-minute aggregate only; not contract settlement
    this.lastTicker = {};                         // ticker -> {bid, ask, at}
    this.agentBusy = false;
    this.indexSeconds = new Map(); // Only the 1 Hz BRTI channel can supply settlement readings.
    this.researchTicks = new Map(); // First-observed source/value/receipt triples; never backfilled.
    this.alarmBusy = false;
    this.agentActive = false; this.depthSubscribed = null;
  }
  status() {
    return {type: "relay", msg: {state: this.upState, since: this.upSince, lastMessage: this.upMsgAt, error: this.lastErr,
                                 clients: this.clients.size, tickers: this.tickerSet, counts: this.counts, hasKey: !!(this.env.KALSHI_KEY_ID && this.env.KALSHI_PRIVATE_KEY),
                                 bookClockOffsetMs: this.bookClockOffset ? this.bookClockOffset.estimate : null, bookClockSamples: this.bookClockOffset ? this.bookClockOffset.samples.length : 0,
                                 // names only, never values: what the relay can see of its settings
                                 settings: Object.keys(this.env).filter(k => typeof this.env[k] === "string").map(k => k + (this.env[k] ? "" : " (empty)")),
                                 keyLooksLikePem: typeof this.env.KALSHI_PRIVATE_KEY === "string" && /BEGIN .*PRIVATE KEY/.test(this.env.KALSHI_PRIVATE_KEY)}};
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    // The two paper experiments share one control lock. Separate locks allow
    // both starts to pass their exclusion checks across awaited storage reads.
    if(request.method==='POST'&&(path==='/trade/config'||path.startsWith('/paper-session/'))){
      if(this.paperControlBusy)return new Response(JSON.stringify({error:'Paper control busy; refresh status before retrying.'}),{status:409,headers:{...CORS,'Content-Type':'application/json'}});
      this.paperControlBusy=true;
      try{return await this.handleRequest(request);}finally{this.paperControlBusy=false;}
    }
    return this.handleRequest(request);
  }
  async handleRequest(request) {
    const url = new URL(request.url);
    if(url.pathname.startsWith('/paper-session/'))return this.sessionRequest(request,url);
    if(url.pathname.startsWith('/research/'))return this.researchRequest(request,url);
    if(url.pathname==="/market-data")return this.marketData(url.searchParams.get("path")||"");
    if(url.pathname.startsWith("/demo/"))return this.demoRequest(request,url);
    if (url.pathname === "/watchdog") { await this.ensureAlarm(); return new Response("ok"); }
    if (url.pathname === "/feed/status") { await this.ensureAlarm(); return new Response(JSON.stringify(this.status().msg), {headers: {...CORS, "Content-Type": "application/json"}}); }
    if (url.pathname === "/replica/status") { await this.ensureAlarm(); this.ensureReplica(); return new Response(JSON.stringify(this.replicaStatus()), {headers: {...CORS, "Content-Type": "application/json"}}); }
    if (url.pathname === "/replica/public") {
      const live = this.replica ? this.replicaStatus() : (await this.state.storage.get("replica.summary")) || {enabled: false, reason: "not running"};
      const history = (await this.state.storage.get("replica.history")) || [];
      return new Response(JSON.stringify({live, history, note: "Research summary of the Worker-side BRTI replica. Nothing here trades."}), {headers: {...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=5"}});
    }
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
      if(!body||typeof body!=='object'||Array.isArray(body))return new Response('JSON object required',{status:400,headers:CORS});
      const cfg = await this.tradeConfig();
      if (body.mode != null) {
        if (!["off", "paper"].includes(body.mode)) return new Response("This research release supports off and paper only; exchange execution is not enabled", {status: 400, headers: CORS});
        if(body.mode==='paper'){
          const session=await this.state.storage.get('session.current');
          if(session&&(paperSession.active(session,Date.now())||session.trades.some(t=>t.pnlCents==null)))return new Response('Stop and settle the timed session first',{status:409,headers:CORS});
        }
        cfg.mode = body.mode;
      }
      for (const k of ["paperDelayMs", "paperBookMaxAgeMs", "paperDepthFraction", "paperExchangeFeeCents", "perWindowCents", "dailyLossStopCents", "maxTradesPerDay", "minEdge", "bankrollCents", "firstSeconds", "lastSeconds"]) if (body[k] != null) { if (typeof body[k] !== "number" || !Number.isFinite(body[k])) return new Response("invalid " + k, {status:400,headers:CORS}); cfg[k] = body[k]; }
      if(body.paperVenue!=null) { if(!["kalshi","robinhood","robinhood-gold"].includes(body.paperVenue))return new Response("invalid paperVenue",{status:400,headers:CORS});cfg.paperVenue=body.paperVenue; }
      const ranges = {paperDelayMs:[250,5000],paperBookMaxAgeMs:[250,3000],paperDepthFraction:[0.1,1],paperExchangeFeeCents:[0,5],perWindowCents: [100, 5000], dailyLossStopCents: [100, 100000], maxTradesPerDay: [1, 96], minEdge: [3, 99], bankrollCents: [1000, 100000000], firstSeconds: [60, 840], lastSeconds: [15, 60]};
      for (const [k, [lo, hi]] of Object.entries(ranges)) if (!Number.isFinite(cfg[k]) || cfg[k] < lo || cfg[k] > hi || (!["minEdge","paperDepthFraction","paperExchangeFeeCents"].includes(k) && !Number.isInteger(cfg[k]))) return new Response("invalid " + k, {status: 400, headers: CORS});
      cfg.perWindowCents = Math.min(cfg.perWindowCents, 5000);                 // a hard ceiling of $50 a window, whatever is asked
      await this.state.storage.put("trade.cfg", cfg);
      await this.scheduleAlarm();
      if (cfg.mode !== "off") this.ensureUpstream();
      return new Response(JSON.stringify(cfg), {headers: {...CORS, "Content-Type": "application/json"}});
    }
    if (url.pathname === "/collector/status") { await this.ensureAlarm(); const c = (await this.state.storage.get("collector")) || {}; c.nextAlarm = await this.state.storage.getAlarm(); c.now = Date.now(); c.model = MODEL_VERSION;
      c.healthy = !!c.lastOk && c.now - c.lastOk < 120000 && !(c.cycleFailures>0);
      c.maintenanceRunning=!!this.collectorTask; c.stage=this.collectorStage||null; c.stream = this.upState;
      if(c.maintenanceRunning&&c.now-c.maintenanceStartedAt>=15000)c.healthy=false;
      c.indexAgeMs = this.ticks.length ? c.now - this.ticks[this.ticks.length - 1][0] : null;
      const rows = [...(await this.state.storage.list({prefix: "w:"})).values()];
      c.forecasts = rows.reduce((n, w) => n + Object.values(w.checks || {}).filter(k => k.model === MODEL_VERSION && Number.isFinite(k.p)).length, 0);
      c.settledWindows = rows.filter(w => w.src === "kalshi").length;
      c.calibration = calibrationReport(rows);
      c.api=await accountLimits(this.env);
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
    if(this.up) this.subscribeTickers();
    const drop = () => { this.clients.delete(server); this.maybeIdle(); };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    server.addEventListener("message", ev => { if (ev.data === "ping") { try { server.send("pong"); server.send(JSON.stringify(this.indexSnapshot(90))); } catch (e) {} } });
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      server.send(JSON.stringify(this.status()));
      server.send(JSON.stringify(this.indexSnapshot()));
      if (this.upState === "open" && Date.now() - this.upMsgAt < 3000)
        for (const [type, f] of Object.entries(this.last)) if (type !== "ticker") server.send(f);
      for (const [tk, b] of Object.entries(this.books)) if (Date.now() - b.at < 15000) server.send(JSON.stringify(this.snapshotOf(tk, b)));   // the books as they stand now
    } catch (e) {}
    this.ensureUpstream();
    return new Response(null, {status: 101, webSocket: client});
  }
  async loadSession() {
    const s=await this.state.storage.get('session.current');if(!s)return null;
    for(const field of ['looks','attempts']){
      const count=s[field+'Count'];if(count==null)continue;
      s[field]=[];
      for(let i=0;i<Math.ceil(count/20);i++)s[field].push(...((await this.state.storage.get(`se:${s.id}:${field}:${i}`))||[]));
      if(s[field].length!==count)throw Error('Paper session history incomplete');
    }
    return s;
  }
  async saveSession(s) {
    const meta={...s},chunks=[];
    for(const field of ['looks','attempts']){
      const from=Math.floor((s[field+'Count']||0)/20);
      for(let i=from;i<Math.ceil(s[field].length/20);i++)chunks.push([`se:${s.id}:${field}:${i}`,s[field].slice(i*20,i*20+20)]);
      meta[field+'Count']=s[field].length;meta[field]=[];
    }
    meta.revision=(s.revision||0)+1;
    const saved=await this.state.storage.transaction(async tx=>{
      const current=await tx.get('session.current');
      if(current&&current.id!==s.id&&s.revision!=null)return false;
      if(current?.id===s.id&&(current.revision||0)!==(s.revision||0))return false;
      for(const [key,value]of chunks)await tx.put(key,value);
      await tx.put('session.current',meta);return true;
    });
    if(saved){s.revision=meta.revision;s.looksCount=meta.looksCount;s.attemptsCount=meta.attemptsCount;}
    return saved;
  }
  async sessionRequest(request,url) {
    const reply=(d,status=200)=>new Response(JSON.stringify(d),{status,headers:{...CORS,'Content-Type':'application/json','Cache-Control':'no-store'}});
    if(!this.env.FEED_TOKEN||url.searchParams.get('token')!==this.env.FEED_TOKEN)return reply({error:'Save the configured stream token to use timed paper sessions.'},403);
    let s=await this.loadSession();
    if(url.pathname==='/paper-session/status'&&request.method==='GET')return reply({session:s?{...s,looks:undefined,attempts:undefined}:null,report:s?paperSession.report(s):null,error:this.sessionError??null,now:Date.now()});
    if(url.pathname==='/paper-session/export'&&request.method==='GET')return reply({session:s||null,report:s?paperSession.report(s):null,now:Date.now()});
    if(request.method!=='POST')return reply({error:'POST required'},405);
    if(url.pathname==='/paper-session/stop'){
      if(s){paperSession.stop(s,Date.now(),'manual stop');if(!await this.saveSession(s))return reply({error:'Session changed while stopping; refresh status and retry.'},409);}
      return reply({session:s});
    }
    if(url.pathname!=='/paper-session/start')return reply({error:'not found'},404);
    if(!this.env.KALSHI_KEY_ID||!this.env.KALSHI_PRIVATE_KEY)return reply({error:'Official feed credentials are not configured.'},409);
    const cfg=await this.tradeConfig(),old=[...(await this.state.storage.list({prefix:'t:'})).values()];
    // Re-read after awaited storage: simultaneous start requests must not overwrite a session.
    s=await this.loadSession();
    if(s&&paperSession.reconcile(s,Date.now())&&!await this.saveSession(s))return reply({error:'Session changed during version transition; refresh status and retry.'},409);
    if(cfg.mode!=='off'||old.some(w=>w.pendingPaper||(!w.settled&&w.trades?.some(t=>t.filled>0))))return reply({error:'Turn the legacy agent off and let its open paper positions settle first.'},409);
    if(s&&(paperSession.active(s,Date.now())||s.trades.some(t=>t.pnlCents==null)))return reply({error:'A session is already scheduled, running or awaiting settlement.'},409);
    if(s)await this.state.storage.put('session.previous',await this.state.storage.get('session.current'));
    const strategy=url.searchParams.get('strategy')||'model-edge';
    if(!paperSession.STRATEGIES[strategy])return reply({error:'unknown strategy'},400);
    s=paperSession.create(Date.now(),crypto.randomUUID(),strategy);
    if(!await this.saveSession(s))return reply({error:'Session changed while starting; refresh status and retry.'},409);
    this.agentActive=true;this.ensureUpstream();if(this.up)this.subscribeTickers();
    await this.scheduleAlarm(Date.now()+1000);
    return reply({session:s});
  }
  startSessionTask() {
    // waitUntil keeps I/O alive without holding the alarm-handler lock. Single flight
    // plus saveSession's revision check protects stops/restarts across awaited reads.
    if(this.sessionTask)return;
    const task=this.sessionTick().catch(e=>{
      this.sessionError={at:Date.now(),error:String(e.message||e).slice(0,200)};
    }).finally(async()=>{
      this.sessionTask=null;
      try { await this.scheduleAlarm(); }
      catch(e) { this.sessionError={at:Date.now(),error:String(e.message||e).slice(0,200)}; }
    });
    this.sessionTask=task;
    this.state.waitUntil(task);
  }
  async sessionTick() {
    let s=await this.loadSession();if(!s)return;
    const id=s.id;paperSession.clock(s,Date.now());
    // Persist a version stop/cancellation before any slow outcome reads.
    if(!await this.saveSession(s))return;
    // Outcomes and decision metadata share a bounded batch. Neither a slow
    // settlement read nor sequential 12s REST waits may consume the next look.
    const startedAt=Date.now(),signal=AbortSignal.timeout(SESSION_READ_BUDGET_MS);
    const due=paperSession.active(s,startedAt)&&startedAt>=s.startAt&&(s.pending||startedAt>=s.nextLookAt);
    const close=s.pending?.close??(Math.floor(startedAt/900000)+1)*900,mk=s.pending?.mk??marketTicker(close);
    const read=async path=>({data:await signedGet(this.env,path,undefined,{signal}),at:Date.now()});
    const open=s.trades.filter(t=>t.pnlCents==null&&startedAt>=t.close*1000);
    const reads=await Promise.allSettled([
      ...(due?[read('/trade-api/v2/markets/'+mk),read('/trade-api/v2/exchange/status')]:[]),
      ...open.map(t=>read('/trade-api/v2/markets/'+t.mk)),
    ]);
    s=await this.loadSession();if(!s||s.id!==id)return;
    for(const [i,t]of open.entries()){
      const outcome=reads[(due?2:0)+i];
      if(outcome.status==='fulfilled')paperSession.settle(s,t.mk,outcome.value.data?.market?.result,Date.now());
    }
    paperSession.clock(s,Date.now());
    if(!await this.saveSession(s)||!due||!paperSession.active(s,Date.now()))return;
    const marketRead=reads[0],exchangeRead=reads[1];
    const market=marketRead.status==='fulfilled'?marketRead.value.data?.market:null;
    const exchange=exchangeRead.status==='fulfilled'?exchangeRead.value.data:null;
    const error=reads.slice(0,2).some(r=>r.status==='rejected')?'market or exchange read unavailable':null;
    // Reload after the save too: a stop can interleave with any awaited storage.
    s=await this.loadSession();if(!s||s.id!==id)return;
    const at=Date.now();paperSession.clock(s,at);
    const target=market?.floor_strike!=null?Number(market.floor_strike):null;
    const k=research.snapshot({at,close,target,targetAt:marketRead.status==='fulfilled'?marketRead.value.at:null,ticks:[...this.researchTicks.values()],book:this.books[mk],exchange,marketStatus:market?.status});
    k.reads={version:'session-reads-v1',startedAt,finishedAt:at,budgetMs:SESSION_READ_BUDGET_MS,marketAt:marketRead.status==='fulfilled'?marketRead.value.at:null,exchangeAt:exchangeRead.status==='fulfilled'?exchangeRead.value.at:null};
    if(error){k.status=error;k.p=null;}
    if(k.depth&&!k.depth.valid&&k.depth.reason==='empty or crossed book')k.depth.reason=k.depth.yes.length&&k.depth.no.length?'crossed order book':'one-sided or empty order book';
    s.lastObservedAt=at;
    if(s.pending)paperSession.arrive(s,k);else paperSession.decide(s,k,mk,close);
    await this.saveSession(s);
  }
  async researchRequest(request,url) {
    const reply=(d,status=200)=>new Response(JSON.stringify(d),{status,headers:{...CORS,'Content-Type':'application/json'}});
    if(request.method!=='GET')return reply({error:'read only'},405);
    if(this.env.FEED_TOKEN&&url.searchParams.get('token')!==this.env.FEED_TOKEN)return reply({error:'token'},403);
    if(!['/research/status','/research/report','/research/export','/research/inputs'].includes(url.pathname))return reply({error:'not found'},404);
    if(url.pathname==='/research/inputs'){
      const close=Number(url.searchParams.get('close')),check=Number(url.searchParams.get('check'));
      if(!Number.isInteger(close)||close<=0||![0,...research.CHECKS].includes(check))return reply({error:'invalid close/check'},400);
      const input=await this.state.storage.get(`ri:${close}:${check}`);
      return input?reply(input):reply({error:'inputs unavailable or expired (24h retention)'},404);
    }
    const rows=[...(await this.state.storage.list({prefix:'r:'})).values()].sort((a,b)=>a.close-b.close);
    if(url.pathname==='/research/report')return reply(research.report(rows));
    if(url.pathname==='/research/export'){
      const after=Number(url.searchParams.get('after')||0),through=Number(url.searchParams.get('through')||Math.floor(Date.now()/1000)),limit=Number(url.searchParams.get('limit')||25);
      if(![after,through,limit].every(Number.isInteger)||after<0||through<after||limit<1||limit>100)return reply({error:'invalid pagination'},400);
      const filtered=rows.filter(w=>w.close>after&&w.close<=through),page=filtered.slice(0,limit);
      return reply({schema:research.VERSION,model:MODEL_VERSION,settings:research.SETTINGS,through,rows:page,nextAfter:filtered.length>limit?page.at(-1).close:null});
    }
    const checks=rows.flatMap(w=>Object.values(w.checks||{})),last=rows.at(-1);
    return reply({schema:research.VERSION,model:MODEL_VERSION,recordedWindows:rows.length,settledWindows:rows.filter(w=>w.src==='kalshi').length,
      forecasts:checks.filter(c=>c.status==='forecast').length,arrivals:checks.filter(c=>c.arrival).length,
      usableDepth:checks.filter(c=>c.depth?.valid).length,missed:checks.filter(c=>c.status!=='forecast').length,
      lastCaptureAt:Math.max(0,...checks.map(c=>c.at||0))||null,lastClose:last?.close??null,
      retention:{summaryDays:10,rawInputHours:24},settings:research.SETTINGS,tradingChanged:false});
  }
  async researchCapture() {
    if(!this.env.KALSHI_KEY_ID||!this.env.KALSHI_PRIVATE_KEY)return;
    const started=Date.now(),close=(Math.floor(started/900000)+1)*900,mk=marketTicker(close),key='r:'+close;
    const row=(await this.state.storage.get(key))||{schema:research.VERSION,model:MODEL_VERSION,
      settlementConvention:globalThis.BTC15Model.SETTLEMENT_CONVENTION,mk,close,settings:research.SETTINGS,checks:{},src:null,result:null};
    // An upgrade mid-window must not mix new forecasts into an older cohort or replace its raw inputs.
    if(!research.currentCohort(row))return;
    let changed=false;
    for(const c of research.CHECKS)if(!row.checks[c]&&started-(close-c)*1000>research.SETTINGS.checkpointToleranceMs){
      row.checks[c]={at:started,status:'checkpoint missed',p:null,p2:null};changed=true;
    }
    const c=research.CHECKS.find(c=>!row.checks[c]&&started>=(close-c)*1000+750);
    if(c!=null){
      const inputKey=`ri:${close}:${c}`;
      if(await this.state.storage.get(inputKey)){
        // A previous capture may have saved raw input before an interrupted summary write.
        // Keep that original buffer; a later book/target cannot reconstruct the lost forecast.
        row.checks[c]={at:started,status:'checkpoint skipped: original raw input already exists',p:null,p2:null};
        await this.state.storage.put(key,row);
        return;
      }
      const readStartedAt=Date.now(),signal=AbortSignal.timeout(SESSION_READ_BUDGET_MS);
      const read=async path=>({data:await signedGet(this.env,path,undefined,{signal}),at:Date.now()});
      const [marketRead,exchangeRead]=await Promise.allSettled([read('/trade-api/v2/markets/'+mk),read('/trade-api/v2/exchange/status')]);
      const market=marketRead.status==='fulfilled'?marketRead.value.data?.market:null;
      const exchange=exchangeRead.status==='fulfilled'?exchangeRead.value.data:null;
      const targetAt=marketRead.status==='fulfilled'?marketRead.value.at:null;
      const error=[marketRead,exchangeRead].some(r=>r.status==='rejected')?'market or exchange read unavailable':null;
      // Receipt precedes capture. Never label data fetched later with an earlier decision time.
      const at=Date.now(),target=market?.floor_strike!=null?Number(market.floor_strike):null;
      const input=[...this.researchTicks.values()].filter(t=>t[0]<=at&&t[2]<=at&&t[0]>=at-1200000).sort((a,b)=>a[0]-b[0]);
      const k=research.snapshot({at,close,target,targetAt,ticks:input,book:this.books[mk],exchange,marketStatus:market?.status??null});
      k.reads={version:'research-reads-v1',startedAt:readStartedAt,finishedAt:at,budgetMs:SESSION_READ_BUDGET_MS,marketAt:targetAt,exchangeAt:exchangeRead.status==='fulfilled'?exchangeRead.value.at:null};
      if(error||at-(close-c)*1000>research.SETTINGS.checkpointToleranceMs){k.status=error||'checkpoint missed during market read';k.p=null;k.p2=null;}
      row.checks[c]=k;row.target=target;row.rules={primary:market?.rules_primary??null,secondary:market?.rules_secondary??null,closeTime:market?.close_time??null};
      await this.state.storage.put(inputKey,{schema:research.VERSION,model:MODEL_VERSION,
        settlementConvention:globalThis.BTC15Model.SETTLEMENT_CONVENTION,mk,close,check:c,at,
        columns:['source_ms','value_usd','first_received_ms'],source:'cfbenchmarks_value',ticks:input,target,targetAt});
      const pending=(await this.state.storage.get('research.pending'))||[];
      if(k.status==='forecast')pending.push({key,check:c,readyAt:at+research.SETTINGS.delayMs});
      await this.state.storage.put('research.pending',pending);
      changed=true;
    }
    if(changed)await this.state.storage.put(key,row);
  }
  async researchArrivals() {
    const pending=(await this.state.storage.get('research.pending'))||[],keep=[];
    for(const item of pending){
      if(Date.now()<item.readyAt){keep.push(item);continue;}
      const row=await this.state.storage.get(item.key),k=row?.checks?.[item.check];
      // Leave legacy checkpoints untouched; rollout can lose a pending arrival, never relabel it.
      if(!k||k.arrival||!research.currentCohort(row))continue;
      const at=Date.now(),depth=research.depthSnapshot(this.books[row.mk],at);
      k.arrival={at,depth,exchange:k.exchange,exchangeObservedAt:k.at,exchangeAgeMs:at-k.at};
      // Reuses checkpoint status only for this bounded 1–4s simulation. No exchange order.
      await this.state.storage.put(item.key,row);
    }
    if(pending.length)await this.state.storage.put('research.pending',keep);
  }
  async researchSettle(options = {}) {
    const now=Date.now(),rows=[...(await this.state.storage.list({prefix:'r:'})).values()].sort((a,b)=>a.close-b.close);
    let firstError=null;   // one failing window must not block the others in this pass
    for(const row of rows.filter(w=>w.close*1000<now-60000&&w.src!=='kalshi'&&w.src!=='unlisted').slice(-4)){
      if(!row.closingCapture){
        const inputKey=`ri:${row.close}:0`,saved=await this.state.storage.get(inputKey);
        // Existing raw buffers may outlive an interrupted summary write. Reuse, never overwrite them.
        const settlementConvention=saved?.settlementConvention??(research.currentCohort(saved||row)?
          globalThis.BTC15Model.SETTLEMENT_CONVENTION:research.LEGACY_SETTLEMENT_CONVENTION);
        const ticks=(saved?.ticks||[...this.researchTicks.values()]).filter(t=>{
          const sec=Math.floor(t[0]/1000);
          return settlementConvention===globalThis.BTC15Model.SETTLEMENT_CONVENTION?
            sec>=row.close-60&&sec<row.close:sec>row.close-60&&sec<=row.close;
        }).sort((a,b)=>a[0]-b[0]);
        const seconds=new Map(ticks.map(t=>[Math.floor(t[0]/1000),t[1]]));
        row.closingCapture={at:saved?.at??now,settlementConvention,samples:seconds.size,complete:seconds.size===60,localAverage:seconds.size===60?[...seconds.values()].reduce((a,b)=>a+b,0)/60:null};
        if(!saved)await this.state.storage.put(inputKey,{schema:row.schema,model:row.model,settlementConvention,
          mk:row.mk,close:row.close,check:0,at:now,source:'cfbenchmarks_value',columns:['source_ms','value_usd','first_received_ms'],ticks});
        await this.state.storage.put('r:'+row.close,row);
      }
      let m;
      const existing=await this.state.storage.get('w:'+row.mk);
      if(existing?.src==='kalshi')m={result:existing.result,expiration_value:existing.officialCloseAvg};
      else try{m=(await signedGet(this.env, '/trade-api/v2/markets/'+row.mk, undefined, options))?.market;}
      catch(e){
        if(!unlistedMarket(e,row.close)){firstError??=e;continue;}
        await this.state.storage.transaction(async tx=>{
          const latest=await tx.get('r:'+row.close);if(!latest||latest.src==='kalshi')return;
          latest.src='unlisted';latest.unlistedObservedAt=Date.now();await tx.put('r:'+row.close,latest);
        });
        continue;
      }
      if(m&&['yes','no'].includes(m.result)){
        // A delayed arrival may have landed while the official outcome was fetched.
        // Attach labels to the latest record without replacing that observation.
        await this.state.storage.transaction(async tx=>{
          const latest=await tx.get('r:'+row.close);if(!latest||latest.src==='kalshi')return;
          latest.result=m.result;latest.src='kalshi';latest.resultObservedAt=Date.now();
          latest.officialCloseAvg=m.expiration_value!=null&&Number.isFinite(Number(m.expiration_value))?Number(m.expiration_value):null;
          await tx.put('r:'+row.close,latest);
        });
      }
    }
    if(now-(this.researchPrunedAt||0)>3600000){
      for(const row of rows)if(row.close*1000<now-10*86400000)await this.state.storage.delete('r:'+row.close);
      const inputs=await this.state.storage.list({prefix:'ri:'});
      for(const [key] of inputs)if(Number(key.split(':')[1])*1000<now-86400000)await this.state.storage.delete(key);
      this.researchPrunedAt=now;
    }
    if(firstError)throw firstError;
  }
  async marketData(path) {
    const reply=(d)=>new Response(d.body,{status:d.status,headers:{...CORS,"Content-Type":"application/json",...(d.retry?{"Retry-After":String(d.retry)}:{})}});
    if(!ALLOWED.some(re=>re.test(path)))return reply({status:404,body:'{"error":"not found"}'});
    const cached=this.marketCache.get(path);if(cached?.until>Date.now())return reply(cached.result);
    if(this.marketPending.has(path))return reply(await this.marketPending.get(path));
    const job=(async()=>{
      try{
        const d=await signedGet(this.env,"/trade-api/v2"+path);
        const result={body:JSON.stringify(d),status:200};
        for(const [key,v] of this.marketCache)if(v.until<=Date.now())this.marketCache.delete(key);
        this.marketCache.set(path,{until:Date.now()+(path==="/exchange/status"?10000:2000),result});return result;
      }catch(e){const budget=apiBudget(this.env,"live"),limited=e.status===429||Date.now()<budget.pauseUntil||/budget exhausted/.test(e.message);
        return {status:limited?429:503,body:JSON.stringify({error:limited?"rate_limited":"market_data_unavailable"}),retry:limited?Math.max(1,Math.ceil((budget.pauseUntil-Date.now())/1000)):30};}
      finally{this.marketPending.delete(path);}
    })();this.marketPending.set(path,job);return reply(await job);
  }
  // Demo is an isolated execution test, never driven by production prices or the model.
  async demoRequest(request,url) {
    const reply=(d,status=200)=>new Response(JSON.stringify(d),{status,headers:{...CORS,"Content-Type":"application/json"}});
    if(!this.env.FEED_TOKEN)return reply({error:"Set FEED_TOKEN before using demo controls"},403);
    if(url.searchParams.get("token")!==this.env.FEED_TOKEN)return reply({error:"token required"},403);
    if(!this.env.KALSHI_DEMO_KEY_ID||!this.env.KALSHI_DEMO_PRIVATE_KEY)return reply({error:"Demo credentials not configured",configured:false},409);
    if(this.demoBusy)return reply({error:"Demo operation in progress; retry later"},409);
    const allowed={"/demo/status":"GET","/demo/order":"POST","/demo/reconcile":"POST","/demo/cancel":"POST"};
    if(!allowed[url.pathname])return reply({error:"not found"},404);
    if(request.method!==allowed[url.pathname])return reply({error:"method not allowed"},405);
    this.demoBusy=true;
    const call=(method,path,body)=>signedCall(this.env,"demo",method,"/trade-api/v2"+path,body);
    try {
      const ledger=(await this.state.storage.get("demo.ledger"))||[];
      if(url.pathname==="/demo/status"){
        const api=await accountLimits(this.env,"demo");
        if(!this.demoOverview || Date.now()-this.demoOverview.at>30000){
          const exchange=await call("GET","/exchange/status");
          const markets=await call("GET","/markets?series_ticker=KXBTC15M&status=open&limit=20");
          this.demoOverview={at:Date.now(),exchange,markets:(markets.markets||[]).map(m=>({ticker:m.ticker,status:m.status,close_time:m.close_time,yes_ask:m.yes_ask_dollars,no_ask:m.no_ask_dollars}))};
        }
        return reply({configured:true,environment:"demo",...this.demoOverview,api,ledger,limits:{contractsPerOrder:1,ordersPerDay:10},automaticTrading:false});
      }
      let body;try{body=await request.json();}catch{return reply({error:"Invalid JSON"},400);}
      if(!body||typeof body!=='object'||Array.isArray(body))return reply({error:'JSON object required'},400);
      if(url.pathname==="/demo/order"){
        if(!/^btc15-demo-[a-f0-9-]{36}$/.test(body.clientId||""))return reply({error:"Invalid client order ID"},400);
        const previous=ledger.find(x=>x.clientId===body.clientId);
        if(previous)return reply({order:previous,reused:true});
        if(ledger.some(x=>!x.reconciled))return reply({error:"Reconcile the previous demo order before submitting another"},409);
        const price=Number(body.priceCents);
        if(!/^KXBTC15M-[A-Z0-9-]+$/.test(body.ticker||"")||!["yes","no"].includes(body.side)||!Number.isFinite(price)||price<1||price>99||Math.abs(price*100-Math.round(price*100))>1e-7)
          return reply({error:"Choose a demo BTC15 market, YES/NO, and a limit from 1 to 99 cents (up to two decimals)"},400);
        if(ledger.filter(x=>etDay(x.at)===etDay(Date.now())).length>=10)return reply({error:"Demo daily limit: 10 test orders"},409);
        const exchange=await call("GET","/exchange/status");
        const market=(await call("GET","/markets/"+body.ticker)).market;
        if(exchange.exchange_active!==true||exchange.trading_active!==true||market?.status!=="active"||!(Date.parse(market.close_time)>Date.now()+15000))return reply({error:"Demo market is paused, unavailable, or closing"},409);
        const yesUnits=body.side==="yes"?Math.round(price*100):10000-Math.round(price*100);
        const payload={ticker:body.ticker,client_order_id:body.clientId,side:body.side==="yes"?"bid":"ask",count:"1.00",price:(yesUnits/10000).toFixed(4),time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",cancel_order_on_pause:true};
        const entry={clientId:body.clientId,ticker:body.ticker,side:body.side,priceCents:price,at:Date.now(),environment:"demo",request:payload,state:"submitting",reconciled:false};
        ledger.push(entry);await this.state.storage.put("demo.ledger",ledger);
        try{const result=await call("POST","/portfolio/events/orders",payload);entry.orderId=result.order_id;entry.placement=result;entry.state=result.order_id?"accepted":"unknown";}
        catch(e){const rejected=e.notSubmitted||[400,401,403,404,422,429].includes(e.status);entry.state=rejected?"rejected":"unknown";entry.reconciled=!!rejected;entry.error=e.message;}
        // An uncertain response is never blindly retried. Reconcile by client ID first.
        await this.state.storage.put("demo.ledger",ledger);
        return reply({order:entry});
      }
      const entry=ledger.find(x=>x.clientId===body.clientId);
      if(!entry)return reply({error:"Unknown demo order"},404);
      if(url.pathname==="/demo/cancel"){
        if(!entry.orderId)return reply({error:"Reconcile to locate the exchange order first"},409);
        try{entry.cancellation=await call("DELETE","/portfolio/events/orders/"+encodeURIComponent(entry.orderId));entry.reconciled=false;entry.state="cancel requested";}
        catch(e){entry.error=e.message;entry.reconciled=false;entry.state="cancel unknown";}
      }else{
        let order;
        if(entry.orderId)order=(await call("GET","/portfolio/orders/"+encodeURIComponent(entry.orderId))).order;
        else{
          let cursor="";
          for(let page=0;page<5;page++){
            const d=await call("GET","/portfolio/orders?ticker="+encodeURIComponent(entry.ticker)+"&limit=100"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
            order=(d.orders||[]).find(o=>o.client_order_id===entry.clientId);cursor=d.cursor;
            if(order||!cursor)break;
          }
        }
        if(!order){entry.state="unknown";entry.error="No matching exchange order found; submission remains blocked";entry.reconciled=false;}
        else{
          if(order.client_order_id!==entry.clientId||order.ticker!==entry.ticker)throw Error("Demo reconciliation identity mismatch");
          entry.orderId=order.order_id;
          const fills=[];let cursor="",complete=false;
          for(let page=0;page<5;page++){
            const d=await call("GET","/portfolio/fills?order_id="+encodeURIComponent(entry.orderId)+"&limit=100"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
            fills.push(...(d.fills||[]));cursor=d.cursor;if(!cursor){complete=true;break;}
          }
          const unique=[...new Map(fills.map(f=>[f.fill_id||f.trade_id,f])).values()];
          const valid=unique.every(f=>(f.fill_id||f.trade_id)&&f.order_id===entry.orderId&&f.ticker===entry.ticker&&Number.isFinite(Number(f.count_fp??f.count)));
          const quantity=unique.reduce((n,f)=>n+Number(f.count_fp??f.count),0), expected=Number(order.fill_count_fp??order.fill_count);
          const positions=await call("GET","/portfolio/positions?ticker="+encodeURIComponent(entry.ticker)+"&limit=100");
          entry.order=order;entry.fills=unique;entry.positions=positions.market_positions||[];entry.checkedAt=Date.now();
          entry.reconciled=complete&&valid&&Number.isFinite(expected)&&Math.abs(quantity-expected)<1e-8&&["executed","canceled"].includes(order.status)&&!positions.cursor;
          entry.state=entry.reconciled?"reconciled":"pending reconciliation";
          entry.error=entry.reconciled?null:"Order is open, fills differ, or reconciliation is incomplete";
        }
      }
      await this.state.storage.put("demo.ledger",ledger);
      return reply({order:entry});
    }catch(e){return reply({error:e.message,environment:"demo"},502);}
    finally{this.demoBusy=false;}
  }
  indexSnapshot(limit = 1200) {
    const now = Date.now();
    const ticks = [...this.indexSeconds].filter(([ms,v]) => Number.isFinite(ms) && ms > 0 && ms >= now-1200000 && ms <= now+1000 && Number.isFinite(v) && v > 0)
      .sort((a,b)=>a[0]-b[0]).slice(-limit);
    return {type:"brti_snapshot", msg:{index_id:"BRTI", source:"cfbenchmarks_value", ticks}};
  }
  broadcast(text) {
    for (const c of this.clients) { try { c.send(text); } catch (e) { this.clients.delete(c); } }
  }
  maybeIdle() {
    if (this.clients.size || this.idleTimer) return;
    this.idleTimer = setTimeout(async () => { this.idleTimer = null; const cfg = await this.tradeConfig(); if (!this.env.KALSHI_KEY_ID && !this.clients.size && cfg.mode === "off") this.closeUpstream("idle"); else await this.ensureAlarm(); }, 60000);
  }
  closeUpstream(why) {
    if (this.windowTimer) { clearTimeout(this.windowTimer); this.windowTimer = null; }
    const ws = this.up; this.up = null; this.upState = "off"; this.tickerSid = null; this.bookSid = null; this.tickerSet = ""; this.books = {}; this.bookSequences.clear(); this.bookSequence=null; this.lastTicker = {}; this.last = {}; this.settleAvg = null;
    if (ws) { try { ws.close(1000, why); } catch (e) {} }
  }
  async ensureUpstream() {
    if (this.up || this.upState === "connecting" || this.retryTimer) return;
    if (!this.env.KALSHI_KEY_ID || !this.env.KALSHI_PRIVATE_KEY) { this.upState = "no key"; this.broadcast(JSON.stringify(this.status())); return; }
    // Reserve before the first await, including cold-start history loading.
    this.upState = "connecting"; this.broadcast(JSON.stringify(this.status()));
    try {
      if (!this.indexSeconds.size) {
        const saved = (await this.state.storage.get("index.seconds")) || [];
        for (const [ms, v] of saved) if (Date.now() - ms < 1200000) this.indexSeconds.set(ms, v);
        if (!this.ticks.length) this.ticks = [...this.indexSeconds];
      }
      const ts = String(Date.now());
      const sig = await signHandshake(this.env.KALSHI_PRIVATE_KEY, ts + "GET" + "/trade-api/ws/v2");
      const resp = await upgradeFetch(WS_UPSTREAM, {headers: {"Upgrade": "websocket", "KALSHI-ACCESS-KEY": this.env.KALSHI_KEY_ID.trim(),
                                                       "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts}});
      const ws = resp.webSocket;
      if (!ws) throw new Error("Kalshi refused the handshake: " + resp.status + " " + (await resp.text().catch(() => "")).slice(0, 120));
      ws.accept();
      this.tickerSet = ""; this.tickerSid = null; this.bookSid = null; this.books = {}; this.lastTicker = {}; this.last = {}; this.bookSequence = null; this.bookSequences.clear();
      this.up = ws; this.upState = "open"; this.upSince = Date.now(); this.lastErr = null; this.backoff = 2000; this.counts = {};
      ws.addEventListener("message", ev => { if (this.up === ws) this.onUpstream(ev.data); });
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
    const tk = currentTickers().slice(0,1), set = tk.join(","), wantDepth = this.clients.size > 0 || this.agentActive || research.depthWanted(Date.now());
    if (set !== this.tickerSet || wantDepth !== this.depthSubscribed) {
      const old = [this.tickerSid, this.bookSid].filter(x => x != null);
      if (old.length) this.send({cmd: "unsubscribe", params: {sids: old}});
      this.tickerSid = null; this.bookSid = null; this.tickerSet = set;
      this.depthSubscribed = wantDepth; this.bookSequence = null; this.bookSequences.clear(); this.books = {};
      for (const t of Object.keys(this.books)) if (!tk.includes(t)) delete this.books[t];
      this.send({cmd: "subscribe", params: {channels: ["ticker"], market_tickers: tk, send_initial_snapshot: true}});
      if(wantDepth) this.send({cmd: "subscribe", params: {channels: ["orderbook_delta"], market_tickers: tk}});
    }
    if (this.windowTimer) clearTimeout(this.windowTimer);
    const msToBoundary = WINDOW * 1000 - (Date.now() % (WINDOW * 1000));
    this.windowTimer = setTimeout(() => { this.windowTimer = null; if (this.up) this.subscribeTickers(); }, msToBoundary + 1500);
  }
  // ---- the collector: scores every window whether or not a page is open
  async ensureAlarm() {
    if (!(this.env.KALSHI_KEY_ID && this.env.KALSHI_PRIVATE_KEY)) return;
    this.ensureReplica();
    const alarm = await this.state.storage.getAlarm(), now = Date.now();
    if (!this.alarmBusy && (alarm == null || alarm < now - 60000 || alarm > now + 60000))
      await this.scheduleAlarm(now + 1000);
    if (this.up && now - Math.max(this.upMsgAt, this.upSince) > 20000) this.closeUpstream("stale stream");
    const session=await this.state.storage.get('session.current');
    this.agentActive = (await this.tradeConfig()).mode !== "off" || paperSession.active(session,now);
    await this.ensureUpstream();
    if(this.up) this.subscribeTickers();
  }
  nextEvent(nowMs, agentOn, cfg) {             // the next checkpoint, settlement or agent moment after now, in ms
    const now = nowMs / 1000, close = (Math.floor(now / WINDOW) + 1) * WINDOW, times = [];
    for (const c of [close - WINDOW, close, close + WINDOW]) { for (const k of CHECKS) times.push(c - k); times.push(c + 90, c + 400); }
    for (const c of [close,close+WINDOW]) for(const k of research.CHECKS)times.push(c-k-5,c-k+.75,c-k+10);
    if (agentOn) {
      const first = cfg ? cfg.firstSeconds : 300, lastS = cfg ? cfg.lastSeconds : 15;
      const zoneStart = close - WINDOW + first, zoneEnd = close - lastS;
      if (now < zoneStart - 1) times.push(zoneStart); else if (now < zoneEnd - 1) times.push(now + 5); else times.push(close + first);
    }
    return Math.min(now + 30, ...times.filter(t => t > now + 0.5)) * 1000;
  }
  async updateCollector(update) {
    await this.state.storage.transaction(async tx=>{
      const log=(await tx.get('collector'))||{runs:0,errors:[]};
      update(log);await tx.put('collector',log);
    });
  }
  async collectorError(e,stage=null) {
    const entry={at:Date.now(),stage,error:String(e.message||e).slice(0,200)};
    await this.updateCollector(log=>{
      log.errors=(log.errors||[]).concat([entry]).slice(-10);
    });
    return entry;
  }
  async scheduleAlarm(earlier=Infinity) {
    // Background session/maintenance completions can race the fast alarm. Compute
    // and shorten atomically; never push an earlier research or arrival wake back.
    await this.state.storage.transaction(async tx=>{
      const now=Date.now(),cfg=Object.assign({mode:'off',firstSeconds:300,lastSeconds:15},await tx.get('trade.cfg'));
      const pending=await tx.list({prefix:'t:'});
      const due=this.collectorTask?[]:[...pending.values()].filter(v=>v.pendingPaper).map(v=>Math.max(now+100,v.pendingPaper.readyAt));
      const researchDue=((await tx.get('research.pending'))||[]).map(p=>Math.max(now+100,p.readyAt));
      const session=await tx.get('session.current');
      const sessionDue=this.sessionTask?Infinity:paperSession.due(session,now);
      const next=Math.min(earlier,this.nextEvent(now,cfg.mode==='paper',cfg),...due,...researchDue,sessionDue);
      const existing=await tx.getAlarm();
      // An overdue wake may be queued for delivery. Re-arm promptly rather than
      // postponing it to a distant event when a background request completes.
      const wake=existing!=null&&existing<=now?Math.min(next,now+100):next;
      if(existing==null||existing<=now||wake<existing)await tx.setAlarm(wake);
    });
  }
  startCollectorTask() {
    if(this.collectorTask)return;
    const task=this.collectorMaintenance().catch(e=>this.collectorError(e)).finally(async()=>{
      this.collectorTask=null;this.collectorStage=null;
      try { await this.scheduleAlarm(); } catch(e) { await this.collectorError(e); }
    });
    this.collectorTask=task;
    this.state.waitUntil(task);
  }
  async collectorMaintenance() {
    // One deadline for maintenance market reads, rather than 12s per old row.
    const startedAt=Date.now(),options={signal:AbortSignal.timeout(8000)};
    const cycleErrors=[];
    const run=async(stage,job)=>{
      this.collectorStage=stage;
      try { options.signal.throwIfAborted(); await job(); }
      catch(e) { cycleErrors.push(await this.collectorError(e,stage)); }
    };
    await this.updateCollector(log=>{log.maintenanceStartedAt=startedAt;});
    await run('upstream',()=>this.ensureAlarm());
    const cfg=await this.tradeConfig();
    await run('paper arrivals',()=>this.processPaper(Date.now(),cfg,options));
    const at=Date.now(),now=at/1000,close=(Math.floor(now/WINDOW)+1)*WINDOW,left=close-now;
    const check=CHECKS.find(k=>left<=k&&k-left<20);
    if(check)await run('checkpoint',()=>this.checkpoint(marketTicker(close),close,check,at,options));
    // Decisions precede historical settlement retries, which may exhaust the budget.
    if(cfg.mode==='paper')await run('paper decision',()=>this.agentTick(Date.now(),options));
    const rows=await this.state.storage.list({prefix:'w:'});
    for(const w of [...rows.values()].filter(w=>w.close<now-60&&w.src!=='kalshi'&&w.src!=='unlisted').slice(-4))
      await run('forecast settlement',()=>this.settle(w.mk,w.close,options));
    await run('research settlement',()=>this.researchSettle(options));
    const trades=await this.state.storage.list({prefix:'t:'});
    for(const w of [...trades.values()].filter(w=>w.close<now-60&&!w.settled&&w.trades?.length).slice(-8))
      await run('paper settlement',()=>this.settleTrades(w.mk,w.close,options));
    if(rows.size>5000)for(const [key]of [...rows].slice(0,rows.size-5000))await this.state.storage.delete(key);
    await this.updateCollector(log=>{
      log.lastCycleAt=Date.now();log.cycleDurationMs=Date.now()-startedAt;
      log.cycleFailures=cycleErrors.length;log.cycleErrors=cycleErrors;log.stage=null;
      if(!cycleErrors.length)log.lastOk=Date.now(); // A live heartbeat must not hide failed work.
      log.indexAgeMs=this.ticks.length?Date.now()-this.ticks[this.ticks.length-1][0]:null;
    });
  }
  async alarm() {
    if(this.alarmBusy)return;
    this.alarmBusy=true;
    try {
      await this.updateCollector(log=>{log.runs++;log.lastRun=Date.now();});
      // Repair wake before network work. Expensive unrelated I/O runs in separate
      // single-flight tasks so a newly queued +1s research arrival can fire on time.
      await this.scheduleAlarm();
      await this.state.storage.put('index.seconds',[...this.indexSeconds].slice(-1200));
      await this.researchArrivals();
      await this.researchCapture();
      this.startSessionTask();
      this.startCollectorTask();
    } catch(e) { await this.collectorError(e); }
    finally {
      try { await this.scheduleAlarm(); }
      finally { this.alarmBusy=false; }
    }
  }
  async checkpoint(mk, close, check, nowMs, options = {}) {
    const key = "w:" + mk, w = (await this.state.storage.get(key)) || {mk, close, tgt: null, checks: {}, result: null, src: null, relay: true};
    if (w.checks[check]) return;
    // Snapshot the live stream at the checkpoint before awaiting REST. Later ticks must
    // not leak into a forecast recorded for an earlier time.
    const liveTicks = this.ticks.filter(t => t[0] <= nowMs), seconds = [...this.indexSeconds].filter(t => t[0] <= nowMs);
    const book=this.books[mk],tick=this.lastTicker[mk];
    const offers=book&&nowMs-book.at>=0&&nowMs-book.at<1500?{ask:globalThis.BTC15Model.asks(book,"Up")[0]?.price/100,bid:1-globalThis.BTC15Model.asks(book,"Down")[0]?.price/100,at:book.at}:tick&&nowMs-tick.at>=0&&nowMs-tick.at<5000?{...tick}:null;
    let ticks = liveTicks;
    ticks = seconds; // Immutable one-Hz input snapshot; no retrospective forecast reconstruction.
    const mkt = await signedGet(this.env, "/trade-api/v2/markets/" + mk, undefined, options);
    const m = mkt && mkt.market;
    if (m && +m.floor_strike > 0) w.tgt = +m.floor_strike;
    const ask=offers&&Number.isFinite(offers.ask)?offers.ask:null,bid=offers&&Number.isFinite(offers.bid)?offers.bid:null;
    const vols = volsFrom(ticks, nowMs), x = liveTicks.length ? liveTicks[liveTicks.length - 1][1] : null;
    const ageMs = liveTicks.length ? nowMs - liveTicks[liveTicks.length - 1][0] : null;
    const entry = {ask, bid, marketAt:offers?.at??null, x, at: nowMs, ticks: ticks.length, ageMs, model: MODEL_VERSION};
    const pr = vols && x != null ? projectFrom(seconds, nowMs, close, x, vols) : null;
    if (vols && x != null && w.tgt != null && ageMs >= 0 && ageMs < 3000 && pr.mean != null) {
      entry.p = +tailCdf((pr.mean - (w.tgt - 0.005)) / pr.sd).toFixed(3);
      entry.p2 = +tailCdf((pr.mean - (w.tgt - 0.005)) / (pr.sd / Math.SQRT2)).toFixed(3);
      entry.sd = +pr.sd.toFixed(2); entry.mean = +pr.mean.toFixed(2);
    }
    entry.status = entry.p != null ? "forecast" : ageMs == null || ageMs >= 3000 ? "stale index" : !vols ? "warming up volatility" : !w.tgt ? "missing target" : "missing settlement readings";
    w.checks[check] = entry;
    await this.state.storage.put(key, w);
  }
  async settle(mk, close, options = {}) {
    const key = "w:" + mk, w = await this.state.storage.get(key);
    if (!w || w.src === "kalshi" || w.src === "unlisted") return;
    let d;
    try { d = await signedGet(this.env, "/trade-api/v2/markets/" + mk, undefined, options); }
    catch (e) { if (!unlistedMarket(e, close)) throw e; w.src = "unlisted"; w.unlistedObservedAt = Date.now(); await this.state.storage.put(key, w); return; }
    const m = d && d.market;
    if (m && (m.result === "yes" || m.result === "no")) {
      w.result = m.result; w.src = "kalshi";
      if (+m.floor_strike > 0) w.tgt = +m.floor_strike;
      if (m.expiration_value != null && Number.isFinite(+m.expiration_value)) w.officialCloseAvg = +m.expiration_value;
      await this.state.storage.put(key, w);
    }
  }
  // ---- the Worker-side BRTI replica: the constituent books held next to the Kalshi socket.
  // Every 200 ms the canonical calculation runs over the fresh books; the value is scored against
  // the official 5 Hz tick (accuracy and head start) and, by events, against the Kalshi book's mid
  // (does the book move after the replica or before it). Research only; nothing trades on it.
  ensureReplica() {
    // Opt-in (REPLICA=on). Running it saturated the Durable Object (240 ms ticks against a 200 ms
    // target) and the collector's requests timed out behind it; see HANDOFF.md for the result it gave.
    if (this.env.REPLICA !== "on" || !(this.env.KALSHI_KEY_ID && this.env.KALSHI_PRIVATE_KEY)) return;
    if (!this.replica) this.replica = {books: {}, hist: [], official: [], mids: [], last: null, state: {excluded: {}}, tracking: null, lead: null, scoredAt: 0, startedAt: Date.now(), ticks: 0, gapMs: 0, gapN: 0, gapMax: 0, lastTickAt: 0, errors: 0, lastError: null};
    for (const key of Object.keys(globalThis.BTC15Depth.DEPTH_VENUES)) this.connectDepth(key);
    if (!this.replicaTimer) this.replicaTimer = setTimeout(() => this.replicaLoop(), REPLICA_MS);
  }
  async connectDepth(key) {
    const D = globalThis.BTC15Depth, spec = D.DEPTH_VENUES[key];
    const b = this.replica.books[key] || (this.replica.books[key] = D.newDepthBook());
    if (b.ws || b.connecting || b.timer) return;
    b.connecting = true; b.state = "connecting";
    try {
      const resp = await upgradeFetch(spec.url.replace(/^wss:/, "https:"), {headers: {"Upgrade": "websocket"}});
      const ws = resp.webSocket;
      if (!ws) throw new Error("refused " + resp.status);
      ws.accept();
      b.ws = ws; b.connecting = false; b.state = "waiting"; b.openedAt = Date.now(); b.ready = false; b.bids.clear(); b.asks.clear();
      const st = {}, ops = D.depthOps(b, ws);
      try { spec.open(ws); } catch (e) {}
      ws.addEventListener("message", ev => {
        if (b.ws !== ws || typeof ev.data !== "string") return;
        b.messages = (b.messages || 0) + 1;                                  // every incoming frame counts toward Durable Object request volume
        let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d || typeof d !== "object") return;
        b.fails = 0;
        try { spec.msg(d, ops, ws, st, b); } catch (e) { ops.reset("parser error: " + e.message); }
      });
      const gone = why => { if (b.ws !== ws) return; b.ws = null; b.ready = false; if (b.state !== "resync") { b.state = "off"; b.note = why; } b.fails++; this.retryDepth(key); };
      ws.addEventListener("close", ev => gone("closed " + ev.code));
      ws.addEventListener("error", () => gone("socket error"));
    } catch (e) {
      b.connecting = false; b.ws = null; b.state = "off"; b.fails++; b.note = String(e.message || e).slice(0, 80);
      this.retryDepth(key);
    }
  }
  retryDepth(key) {
    const b = this.replica.books[key];
    if (b.timer) return;
    b.timer = setTimeout(() => { b.timer = null; if (this.replica) this.connectDepth(key); }, b.backoff);
    b.backoff = Math.min(b.fails >= 5 ? 60000 : 15000, b.backoff * 2);
  }
  noteKalshiMid(tk) {
    if (!this.replica || tk !== currentTickers()[0]) return;
    const q = this.lastTicker[tk]; if (!q || !(q.bid > 0 && q.ask > 0)) return;
    const mid = Math.round((q.bid + q.ask) / 2 * 10000) / 100;             // cents
    const s = this.replica.mids, last = s[s.length - 1];
    if (last && last.v === mid) return;
    s.push({t: Date.now(), v: mid});
  }
  replicaLoop() {
    this.replicaTimer = null;
    if (!this.replica) return;
    const R = globalThis.BTC15Replica, D = globalThis.BTC15Depth, r = this.replica, now = Date.now();
    try {
      // Workers freeze the clock inside one execution, so the calculation cannot be timed directly.
      // The gap between ticks can: 200 ms means the loop keeps up; longer means it is overloaded.
      if (r.lastTickAt) { r.gapMs += now - r.lastTickAt; r.gapN++; if (now - r.lastTickAt > r.gapMax) r.gapMax = now - r.lastTickAt; }
      r.lastTickAt = now;
      const out = R.calculate(D.replicaBooksFrom(r.books), now, r.state);
      r.state = out.state; r.last = {...out, t: now}; r.ticks++;
      if (Number.isFinite(out.value)) r.hist.push({t: now, v: out.value});
      const cut = now - REPLICA_KEEP_MS;
      while (r.hist.length && r.hist[0].t < cut) r.hist.shift();
      while (r.official.length && r.official[0].at < cut) r.official.shift();
      while (r.mids.length > 1 && r.mids[1].t < cut) r.mids.shift();
      if (r.ticks % 25 === 0) for (const [key, spec] of Object.entries(D.DEPTH_VENUES)) {       // pings every 5 s; silent sockets reconnect
        const b = r.books[key]; if (!b || !b.ws) continue;
        if ((b.at || b.openedAt) && now - Math.max(b.at, b.openedAt) > 30000) { b.note = "silent for 30 s"; try { b.ws.close(); } catch (e) {} }
        else if (spec.ping) { try { spec.ping(b.ws); } catch (e) {} }
      }
      if (now - r.scoredAt >= 10000) {
        r.scoredAt = now;
        r.tracking = R.track(r.hist, r.official);
        r.lead = R.leadLag(r.hist, r.mids);
        r.gapMax = 0;                                                       // the maximum is per scoring period
        this.broadcast(JSON.stringify({type: "replica", msg: this.replicaStatus()}));
        // Every ten minutes: one history row, kept for 48 hours, so days accumulate without anyone watching.
        if (now - (r.historyAt || 0) >= 600000) { r.historyAt = now; this.state.waitUntil(this.appendReplicaHistory().catch(() => {})); }
      }
    } catch (e) { r.errors++; r.lastError = String(e.message || e).slice(0, 120); }
    this.replicaTimer = setTimeout(() => this.replicaLoop(), REPLICA_MS);
  }
  async appendReplicaHistory() {
    const s = this.replicaStatus(), t = s.tracking, l = s.lead;
    const row = {at: s.now, value: s.value, diff: s.diff, usedBooks: s.usedBooks, tickGapMs: s.tickGapMs, tickGapMaxMs: s.tickGapMaxMs,
                 errMean: t && t.accuracy ? t.accuracy.mae : null, errMedian: t && t.accuracy ? t.accuracy.median : null, pairs: t && t.accuracy ? t.accuracy.n : 0, headStartMs: t ? t.headStartMs : null,
                 events: l ? l.events || 0 : 0, after: l ? l.after || 0 : 0, before: l ? l.before || 0 : 0, same: l ? l.same || 0 : 0, none: l ? l.none || 0 : 0, agree: l ? l.agree || 0 : 0, pinned: l ? l.pinned || 0 : 0, moveUsd: l ? l.moveUsd || null : null, medianDtMs: l ? l.medianDtMs : null,
                 books: Object.fromEntries(Object.entries(s.books).map(([k, b]) => [k, b.used ? "used" : b.excluded || b.state]))};
    const history = ((await this.state.storage.get("replica.history")) || []).filter(h => s.now - h.at < 48 * 3600000);
    history.push(row);
    await this.state.storage.put("replica.history", history);
    await this.state.storage.put("replica.summary", s);
  }
  replicaStatus() {
    const r = this.replica, D = globalThis.BTC15Depth;
    if (!r) return {enabled: false, reason: this.env.REPLICA !== "on" ? "off (set REPLICA=on to run it)" : "no key"};
    const books = {};
    for (const [key, spec] of Object.entries(D.DEPTH_VENUES)) {
      const b = r.books[key];
      books[spec.name] = b ? {state: b.ready ? "live" : b.state, bids: b.bids.size, asks: b.asks.size, ageMs: b.at ? Date.now() - b.at : null, note: b.note || null, used: !!(r.last && r.last.used.includes(spec.name)), excluded: r.last && r.last.excluded[spec.name] || null,
                              messages: b.messages || 0, messagesPerSec: b.messages && b.openedAt ? b.messages / Math.max(1, (Date.now() - b.openedAt) / 1000) : null} : {state: "off"};
    }
    const o = r.official[r.official.length - 1];
    return {enabled: true, version: globalThis.BTC15Replica.VERSION, at: r.last ? r.last.t : null, value: r.last ? r.last.value : null, reason: r.last ? r.last.reason || null : null,
            official: o ? {v: o.v, t: o.t, at: o.at} : null, diff: r.last && o && Number.isFinite(r.last.value) ? r.last.value - o.v : null,
            usedBooks: r.last ? r.last.used.length : 0, constituents: D.CONSTITUENTS.length, books, depthLimited: r.last ? !!r.last.depthLimited : null,
            tracking: r.tracking, lead: r.lead, ticks: r.ticks, tickGapMs: r.gapN ? r.gapMs / r.gapN : null, tickGapMaxMs: r.gapMax || null, since: r.startedAt,
            officialKept: r.official.length, midsKept: r.mids.length, errors: r.errors, lastError: r.lastError, now: Date.now(),
            upstreamCounts: this.counts || {}, upstreamSince: this.upSince || null};
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
  async agentTick(nowMs, options = {}) {
    const cfg = await this.tradeConfig();
    if (cfg.mode !== "paper" || this.agentBusy) return; // Exchange execution is deferred until a separately reviewed release.
    this.agentBusy = true;
    let log={decisions:[],errors:[]};
    try {
      log = await this.tradeLog();
      if(await this.processPaper(nowMs,cfg,options))return;
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
      if (!tgt) { const d = await signedGet(this.env, "/trade-api/v2/markets/" + mk, undefined, options); tgt = d && d.market && +d.market.floor_strike > 0 ? +d.market.floor_strike : null; if (!tgt) return; w.tgt = tgt; }
      const vols = volsFrom([...this.indexSeconds], nowMs); if (!vols) return;
      const x = last[1];
      const projectWith = (xx, vv) => projectFrom([...this.indexSeconds], nowMs, close, xx, vv);
      const base = projectWith(x, vols);
      if (base.mean == null) return;
      const p = tailFromBand(base.mean, base.sd, tgt);
      const {lo,hi}=globalThis.BTC15Model.band([...this.indexSeconds],nowMs,close,x,vols,tgt);
      const b0=this.books[mk], b=b0 && nowMs-b0.at < cfg.paperBookMaxAgeMs ? b0:null;
      const first=side=>globalThis.BTC15Model.asks(b,side)[0]||null;
      const offer={Up:first("Up"),Down:first("Down")}; // Real depth required; ticker size is not liquidity.
      const decide = (side, worst, off) => {
        if (!off || !(off.price > 0 && off.price < 100)) return null;
        const fee = globalThis.BTC15Model.feesCents(off.price,1,cfg.paperVenue,cfg.paperExchangeFeeCents), edge = worst * 100 - off.price - fee;
        if (edge < cfg.minEdge) return {side, price: off.price, edge: +edge.toFixed(1), call: edge <= 0 ? "no" : "thin"};
        const c = (off.price + fee) / 100, f = (worst - c) / (1 - c), stake = Math.min(cfg.perWindowCents / 100, 0.02 * cfg.bankrollCents / 100, 0.25 * f * cfg.bankrollCents / 100);
        const n = Math.min(Math.floor(stake / c), Math.floor(off.size));
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
      const exchange = await signedGet(this.env, "/trade-api/v2/exchange/status", undefined, options);
      const market = await signedGet(this.env, "/trade-api/v2/markets/" + mk, undefined, options);
      if (exchange.trading_active !== true || exchange.exchange_active !== true || market.market?.status !== "active" || Date.now() - nowMs > 3000) return;
      if((await this.tradeConfig()).mode!=='paper')return; // Off may arrive during network reads.
      const trade = {at: nowMs, mk, left: Math.round(left), side: pick.side, price: pick.price, n: pick.n, offered: pick.offered, edge: pick.edge, p: +p.toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), x: +x.toFixed(2), sd: +base.sd.toFixed(2), official: !!base.official, mode: cfg.mode, filled: 0, cost: 0};
      trade.model=MODEL_VERSION;trade.executionModel=globalThis.BTC15Model.EXECUTION_VERSION;
      trade.feeVenue=cfg.paperVenue;trade.feeAssumption=cfg.paperVenue==="kalshi"?"general taker, whole-cent conservative rounding":"Robinhood cost scenario on Kalshi depth";
      w.pendingPaper={...trade,close,readyAt:nowMs+cfg.paperDelayMs,bookAt:b.at,cfg:{...cfg}};
      await this.state.storage.put(key,w);
      await this.scheduleAlarm(Math.min(w.pendingPaper.readyAt,Date.now()+1000));
      return;
    } catch (e) {
      log.errors = (log.errors || []).concat([{at: nowMs, error: String(e.message || e).slice(0, 200)}]).slice(-20);
      await this.state.storage.put("trade.log", log);
      if(options.signal)throw e;
    } finally { this.agentBusy = false; }
  }
  async processPaper(nowMs,cfg, options = {}) {
    const rows=await this.state.storage.list({prefix:"t:"});let processed=false;
    for(const [key,w] of rows) {
      const intent=w.pendingPaper;if(!intent)continue;
      let fill;
      if(cfg.mode!=="paper") fill={filled:0,cost:0,feesCents:0,status:"paper-canceled",reason:"paper mode stopped",filledAt:nowMs,latencyMs:nowMs-intent.at,levels:[]};
      else {
        if(nowMs<intent.readyAt)continue;
        let active=false;
        try { const exchange=await signedGet(this.env, "/trade-api/v2/exchange/status", undefined, options);const market=await signedGet(this.env, "/trade-api/v2/markets/"+w.mk, undefined, options);active=exchange.exchange_active===true&&exchange.trading_active===true&&market.market?.status==="active"; }catch(e){}
        const latest=await this.tradeConfig();
        nowMs=Date.now();
        if(latest.mode!=='paper')fill={filled:0,cost:0,feesCents:0,status:'paper-canceled',reason:'paper mode stopped',filledAt:nowMs,latencyMs:nowMs-intent.at,levels:[]};
        else {
          fill=globalThis.BTC15Model.paperFill(intent,active&&this.up?this.books[w.mk]:null,nowMs,intent.cfg);
          if(fill&&!active)fill.reason="exchange or market not confirmed active at simulated arrival";
        }
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
  async settleTrades(mk, close, options = {}) {               // after the close: score the window's trade against the official result
    const key = "t:" + mk, w = await this.state.storage.get(key);
    if (!w || !w.trades.length || w.settled) return;
    let d;
    try { d = await signedGet(this.env, "/trade-api/v2/markets/" + mk, undefined, options); }
    catch (e) {
      // No market means nothing could have filled. A recorded fill against it needs a person, not a guess.
      if (!unlistedMarket(e, close) || w.trades.some(t => t.filled)) throw e;
      for (const t of w.trades) t.pnlCents = 0;
      w.settled = true; w.unlisted = true; w.result = null; await this.state.storage.put(key, w); return;
    }
    const m = d && d.market;
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
    this.state.waitUntil(notify(this.env, `BTC 15 settled: ${pnl >= 0 ? "+" : "−"}$${(Math.abs(pnl) / 100).toFixed(2)}`, `${mk} resolved ${m.result === "yes" ? "Up" : "Down"} · today ${today.pnlCents >= 0 ? "+" : "−"}$${(Math.abs(today.pnlCents) / 100).toFixed(2)} over ${today.trades} trade${today.trades === 1 ? "" : "s"}`));
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
      if(d.sid!=null && this.bookSid!=null && d.sid!==this.bookSid)return;
      const sid=d.sid??"legacy", previous=this.bookSequences.get(sid)??(d.sid==null?this.bookSequence:null);
      if (d.type === "orderbook_delta" && Number.isFinite(d.seq) && previous != null && d.seq !== previous + 1) {
        this.closeUpstream("order book sequence gap"); this.retry(); return;
      }
      if (Number.isFinite(d.seq)){this.bookSequences.set(sid,d.seq);this.bookSequence=d.seq;}
    }
    if ((d.type === "orderbook_snapshot" || d.type === "orderbook_delta") && d.msg) {
      // Offset of Kalshi's clock from this Worker's, from frames before the one being judged.
      const src = Number(d.msg.ts_ms ?? d.sending_ts_ms);
      this.bookClockOffset = this.bookClockOffset || {samples: [], estimate: null};
      const estimate = this.bookClockOffset.estimate;
      if (Number.isFinite(src) && src > 0) {
        this.bookClockOffset.samples.push(src - Date.now());
        if (this.bookClockOffset.samples.length > research.SETTINGS.clockOffsetSamples) this.bookClockOffset.samples.shift();
        this.bookClockOffset.estimate = research.clockOffsetEstimate(this.bookClockOffset.samples);
      }
      this.bookClockOffsetBefore = estimate;
    }
    if (d.type === "orderbook_snapshot" && d.msg && d.msg.market_ticker) {
      const b = {yes: new Map(), no: new Map(), at: Date.now(), sourceAt:Number(d.sending_ts_ms)||null, sourceKind:'sending_ts_ms', clockOffsetMs:this.bookClockOffsetBefore ?? null};
      for (const [px, q] of d.msg.yes_dollars_fp || []) if (+q > 0) b.yes.set(+px, +q);
      for (const [px, q] of d.msg.no_dollars_fp || []) if (+q > 0) b.no.set(+px, +q);
      this.books[d.msg.market_ticker] = b;
    }
    if (d.type === "orderbook_delta" && d.msg && d.msg.market_ticker && this.books[d.msg.market_ticker]) {
      const m = this.books[d.msg.market_ticker][d.msg.side === "no" ? "no" : "yes"], px = +d.msg.price_dollars, q = (Math.round((m.get(px) || 0)*100) + Math.round(Number(d.msg.delta_fp)*100))/100;
      if (q > 0) m.set(px, q); else m.delete(px);
      this.books[d.msg.market_ticker].at = Date.now();
      this.books[d.msg.market_ticker].sourceAt = Number(d.msg.ts_ms??d.sending_ts_ms)||null;
      this.books[d.msg.market_ticker].sourceKind = d.msg.ts_ms!=null?'ts_ms':'sending_ts_ms';
      this.books[d.msg.market_ticker].clockOffsetMs = this.bookClockOffsetBefore ?? null;
    }
    if (d.type === "cfbenchmarks_value_5hz" && d.msg && d.msg.index_id === "BRTI" && +d.msg.value_usd > 0) {
      this.pushTick(+d.msg.source_ts_ms, +d.msg.value_usd);
      if (this.replica) { const o = this.replica.official, t = +d.msg.source_ts_ms, last = o[o.length - 1]; if (Number.isFinite(t) && (!last || t > last.t)) o.push({t, at: Date.now(), v: +d.msg.value_usd}); }
    }
    if (d.type === "cfbenchmarks_value" && d.msg) {
      try {
        const raw = JSON.parse(d.msg.data), v = +raw.value, ms = typeof raw.time === "number" || /^\d{13}$/.test(raw.time) ? +raw.time : Date.parse(raw.time);
        if (d.msg.index_id === "BRTI" && v > 0 && Number.isFinite(v) && ms > 0 && Date.now() - ms < 1200000 && ms <= Date.now() + 1000) {
          this.pushTick(ms, v); this.indexSeconds.set(ms, v);
          if(!this.researchTicks.has(ms))this.researchTicks.set(ms,[ms,v,Date.now()]);
          for(const t of this.researchTicks.keys())if(t<Date.now()-1200000)this.researchTicks.delete(t);
          for (const t of this.indexSeconds.keys()) if (t < Date.now() - 1200000) this.indexSeconds.delete(t);
        }
      } catch (e) {}
      const f = d.msg.last_60s_windowed_average_15min;
      this.settleAvg = f && +f.value > 0 ? {v: +f.value, n: +f.window_size, end: +f.window_end_ts_exclusive, at: Date.now()} : null;
    }
    if (d.type === "ticker" && d.msg && d.msg.market_ticker) {
      this.lastTicker[d.msg.market_ticker] = {bid: +d.msg.yes_bid_dollars || null, ask: +d.msg.yes_ask_dollars || null, at: Date.now()};
      this.noteKalshiMid(d.msg.market_ticker);        // the ticker changes only when the price does: cheap, and enough for lead/lag
    }
    if (d.type === "error" && [10,25,27].includes(Number(d.msg?.code))) {
      this.lastErr="Kalshi subscription error "+d.msg.code;
      if(Number(d.msg.code)===27)this.backoff=Math.max(this.backoff,30000);
      this.closeUpstream(this.lastErr);this.retry();this.broadcast(JSON.stringify(this.status()));return;
    }
    if (d.type === "error") { this.lastErr = "kalshi error " + JSON.stringify(d.msg).slice(0, 150); this.broadcast(JSON.stringify(this.status())); return; }
    if (d.type === "cfbenchmarks_value" || d.type === "cfbenchmarks_value_5hz" || d.type === "ticker" || d.type === "orderbook_snapshot" || d.type === "orderbook_delta") {
      if (d.type.startsWith("orderbook")) { this.broadcast(data); return; }     // books are rebuilt for newcomers from this.books
      this.last[d.type] = data;
      this.broadcast(data);
    }
  }
}
