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
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
    if (request.method === "OPTIONS") return new Response(null, {headers: {...CORS, "Access-Control-Allow-Headers": "Content-Type"}});
    if (path === "/feed" || path === "/feed/status" || path === "/record" || path === "/record.csv" || path === "/collector/status" || path === "/trade/status" || path === "/trade/config" || path.startsWith("/demo/") || path.startsWith("/research/")) {
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
// BEGIN SHARED BTC15 RESEARCH
// Canonical research calculations; embedded in worker.js and imported by the offline evaluator.
(() => {
const VERSION = 'settlement-research-v1';
const BIAS_VERSION = 'btc15-bias-v1';
const PRICE_BANDS = [0,10,30,50,70,90,100];
const CHECKS = [600, 300, 120, 60, 30, 15, 5];
const SETTINGS = Object.freeze({delayMs:1000, maxArrivalLateMs:3000, bookMaxAgeMs:1500,
  indexMaxAgeMs:3000, depthFraction:0.5, quantity:1, minEdgeCents:3,
  feeVenue:'kalshi', feeAssumption:'general taker multiplier 1; whole-cent rounding per fill level',
  checkpointToleranceMs:5000, minTrainWindows:60, testWindows:20});
const finite = v => typeof v === 'number' && Number.isFinite(v);
const depthWanted = now => {
  const left = (Math.floor(now / 900000) + 1) * 900 - now / 1000;
  return CHECKS.some(c => left <= c + 5 && left > c - 10);
};
function depthSnapshot(book, at) {
  if (!book) return null;
  const sourceAt = finite(book.sourceAt) ? book.sourceAt : null;
  const age = at - book.at, sourceAge = sourceAt == null ? null : at - sourceAt;
  const yes = globalThis.BTC15Model.asks(book,'Up').slice(0,10);
  const no = globalThis.BTC15Model.asks(book,'Down').slice(0,10);
  const bid = no.length ? 100-no[0].price : null, ask = yes[0]?.price ?? null;
  const fresh = age >= 0 && age <= SETTINGS.bookMaxAgeMs && sourceAge != null &&
    sourceAge >= 0 && sourceAge <= SETTINGS.bookMaxAgeMs;
  const valid = fresh && finite(bid) && finite(ask) && bid <= ask;
  return {receivedAt:book.at, sourceAt, sourceKind:book.sourceKind || null,
    ageMs:age, sourceAgeMs:sourceAge, valid, bidCents:bid, askCents:ask, yes, no,
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
  return {bias, at, leftSeconds:close-at/1000, target, targetAt, marketStatus, exchange,
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
  const valid=all.filter(w=>w.schema===VERSION&&w.model===globalThis.BTC15Model.VERSION);
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
  return {schema:VERSION,model:globalThis.BTC15Model.VERSION,settings:SETTINGS,recordedWindows:recorded.length,settledWindows:windows.length,
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
  const coverage={pending:0,invalid:0,legacy:0,missingMove:0,missingArrival:0};
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
    if(seen.has(w.mk)||w.schema!==VERSION||w.model!==globalThis.BTC15Model.VERSION)continue;seen.add(w.mk);
    for(const c of CHECKS){
      const k=w.checks?.[c];if(!k)continue;
      if(k.bias?.version!==BIAS_VERSION){coverage.legacy++;continue;}
      captured++;firstAt=firstAt==null?k.at:Math.min(firstAt,k.at);lastAt=lastAt==null?k.at:Math.max(lastAt,k.at);
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
globalThis.BTC15Research=Object.freeze({VERSION,BIAS_VERSION,CHECKS,SETTINGS,depthWanted,depthSnapshot,snapshot,simulate,report,biasReport});
})();
// END SHARED BTC15 RESEARCH
const research = globalThis.BTC15Research;
const {tailCdf,volsFrom,projectFrom} = globalThis.BTC15Model;
function feeCents(p) { return globalThis.BTC15Model.feesCents(p*100); }
async function signedGet(env, apiPath, query) { return signedCall(env,"live","GET",apiPath+(query||"")); }
const HOSTS = {live:"https://external-api.kalshi.com",demo:"https://external-api.demo.kalshi.co"};
function keysFor(env, mode) {
  if(!["live","demo"].includes(mode))throw Error("Unknown API environment");
  return mode === "demo" ? {id:env.KALSHI_DEMO_KEY_ID,pem:env.KALSHI_DEMO_PRIVATE_KEY} : {id:env.KALSHI_KEY_ID,pem:env.KALSHI_PRIVATE_KEY};
}
async function signedCall(env, mode, method, apiPath, body) {
  // Production credentials are read-only in this application, regardless of caller.
  if(mode!=="demo" && method!=="GET")throw Error("Production execution disabled");
  if(!/^\/trade-api\/v2\//.test(apiPath)||apiPath.includes("..")||apiPath.includes("#"))throw Error("Invalid API path");
  const k=keysFor(env,mode);if(!k.id||!k.pem)throw Error("no "+mode+" key");
  const budget=apiBudget(env,mode);let sig;const stamp=String(Date.now());
  try{debitBudget(budget,method,apiPath);sig=await signHandshake(k.pem,stamp+method+apiPath.split("?")[0]);}
  catch(e){e.notSubmitted=true;throw e;}
  const r=await timedFetch(HOSTS[mode]+apiPath,{method,body:body?JSON.stringify(body):undefined,
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
    this.settleAvg = null;                        // Kalshi's accumulating final-minute average, when streamed
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
                                 // names only, never values: what the relay can see of its settings
                                 settings: Object.keys(this.env).filter(k => typeof this.env[k] === "string").map(k => k + (this.env[k] ? "" : " (empty)")),
                                 keyLooksLikePem: typeof this.env.KALSHI_PRIVATE_KEY === "string" && /BEGIN .*PRIVATE KEY/.test(this.env.KALSHI_PRIVATE_KEY)}};
  }
  async fetch(request) {
    const url = new URL(request.url);
    if(url.pathname.startsWith('/research/'))return this.researchRequest(request,url);
    if(url.pathname==="/market-data")return this.marketData(url.searchParams.get("path")||"");
    if(url.pathname.startsWith("/demo/"))return this.demoRequest(request,url);
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
    const row=(await this.state.storage.get(key))||{schema:research.VERSION,model:MODEL_VERSION,mk,close,settings:research.SETTINGS,checks:{},src:null,result:null};
    let changed=false;
    for(const c of research.CHECKS)if(!row.checks[c]&&started-(close-c)*1000>research.SETTINGS.checkpointToleranceMs){
      row.checks[c]={at:started,status:'checkpoint missed',p:null,p2:null};changed=true;
    }
    const c=research.CHECKS.find(c=>!row.checks[c]&&started>=(close-c)*1000);
    if(c!=null){
      let market=null,exchange=null,error=null;
      try{
        market=(await signedGet(this.env,'/trade-api/v2/markets/'+mk))?.market;
        exchange=await signedGet(this.env,'/trade-api/v2/exchange/status');
      }catch(e){error='market or exchange read unavailable';}
      // Receipt precedes capture. Never label data fetched later with an earlier decision time.
      const at=Date.now(),target=market?.floor_strike!=null?Number(market.floor_strike):null;
      const input=[...this.researchTicks.values()].filter(t=>t[0]<=at&&t[2]<=at&&t[0]>=at-1200000).sort((a,b)=>a[0]-b[0]);
      const k=research.snapshot({at,close,target,targetAt:at,ticks:input,book:this.books[mk],exchange,marketStatus:market?.status??null});
      if(error||at-(close-c)*1000>research.SETTINGS.checkpointToleranceMs){k.status=error||'checkpoint missed during market read';k.p=null;k.p2=null;}
      row.checks[c]=k;row.target=target;row.rules={primary:market?.rules_primary??null,secondary:market?.rules_secondary??null,closeTime:market?.close_time??null};
      await this.state.storage.put(`ri:${close}:${c}`,{schema:research.VERSION,model:MODEL_VERSION,mk,close,check:c,at,
        columns:['source_ms','value_usd','first_received_ms'],source:'cfbenchmarks_value',ticks:input,target,targetAt:at});
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
      if(!k||k.arrival)continue;
      const at=Date.now(),depth=research.depthSnapshot(this.books[row.mk],at);
      k.arrival={at,depth,exchange:k.exchange,exchangeObservedAt:k.at,exchangeAgeMs:at-k.at};
      // Reuses checkpoint status only for this bounded 1–4s simulation. No exchange order.
      await this.state.storage.put(item.key,row);
    }
    if(pending.length)await this.state.storage.put('research.pending',keep);
  }
  async researchSettle() {
    const now=Date.now(),rows=[...(await this.state.storage.list({prefix:'r:'})).values()].sort((a,b)=>a.close-b.close);
    for(const row of rows.filter(w=>w.close*1000<now-60000&&w.src!=='kalshi').slice(-4)){
      if(!row.closingCapture){
        const ticks=[...this.researchTicks.values()].filter(t=>Math.floor(t[0]/1000)>row.close-60&&Math.floor(t[0]/1000)<=row.close).sort((a,b)=>a[0]-b[0]);
        const seconds=new Map(ticks.map(t=>[Math.floor(t[0]/1000),t[1]]));
        row.closingCapture={at:now,samples:seconds.size,complete:seconds.size===60,localAverage:seconds.size===60?[...seconds.values()].reduce((a,b)=>a+b,0)/60:null};
        await this.state.storage.put(`ri:${row.close}:0`,{schema:research.VERSION,mk:row.mk,close:row.close,check:0,at:now,source:'cfbenchmarks_value',columns:['source_ms','value_usd','first_received_ms'],ticks});
        await this.state.storage.put('r:'+row.close,row);
      }
      let m;
      const existing=await this.state.storage.get('w:'+row.mk);
      if(existing?.src==='kalshi')m={result:existing.result,expiration_value:existing.officialCloseAvg};
      else m=(await signedGet(this.env,'/trade-api/v2/markets/'+row.mk))?.market;
      if(m&&['yes','no'].includes(m.result)){
        row.result=m.result;row.src='kalshi';row.resultObservedAt=Date.now();
        row.officialCloseAvg=m.expiration_value!=null&&Number.isFinite(Number(m.expiration_value))?Number(m.expiration_value):null;
        await this.state.storage.put('r:'+row.close,row);
      }
    }
    if(now-(this.researchPrunedAt||0)>3600000){
      for(const row of rows)if(row.close*1000<now-10*86400000)await this.state.storage.delete('r:'+row.close);
      const inputs=await this.state.storage.list({prefix:'ri:'});
      for(const [key] of inputs)if(Number(key.split(':')[1])*1000<now-86400000)await this.state.storage.delete(key);
      this.researchPrunedAt=now;
    }
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
    if (!this.indexSeconds.size) {
      const saved = (await this.state.storage.get("index.seconds")) || [];
      for (const [ms, v] of saved) if (Date.now() - ms < 1200000) this.indexSeconds.set(ms, v);
      if (!this.ticks.length) this.ticks = [...this.indexSeconds];
    }
    this.upState = "connecting"; this.broadcast(JSON.stringify(this.status()));
    try {
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
    const alarm = await this.state.storage.getAlarm(), now = Date.now();
    if (!this.alarmBusy && (alarm == null || alarm < now - 60000 || alarm > now + 60000))
      await this.state.storage.setAlarm(now + 1000);
    if (this.up && now - Math.max(this.upMsgAt, this.upSince) > 20000) this.closeUpstream("stale stream");
    this.agentActive = (await this.tradeConfig()).mode !== "off";
    await this.ensureUpstream();
    if(this.up) this.subscribeTickers();
  }
  nextEvent(nowMs, agentOn, cfg) {             // the next checkpoint, settlement or agent moment after now, in ms
    const now = nowMs / 1000, close = (Math.floor(now / WINDOW) + 1) * WINDOW, times = [];
    for (const c of [close - WINDOW, close, close + WINDOW]) { for (const k of CHECKS) times.push(c - k); times.push(c + 90, c + 400); }
    for (const c of [close,close+WINDOW]) for(const k of research.CHECKS)times.push(c-k-5,c-k,c-k+10);
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
      await this.researchArrivals();
      const close = (Math.floor(now / WINDOW) + 1) * WINDOW, left = close - now;
      const check = CHECKS.find(k => left <= k && k - left < 20);
      if (check) await this.checkpoint(marketTicker(close), close, check, nowMs);
      await this.researchCapture();
      // Retry old unresolved windows as well as the most recent close.
      const rows = await this.state.storage.list({prefix: "w:"});
      const pending = [...rows.values()].filter(w => w.close < now - 60 && w.src !== "kalshi").slice(-4);
      for (const w of pending) await this.settle(w.mk, w.close);
      await this.researchSettle();
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
        const researchDue=((await this.state.storage.get('research.pending'))||[]).map(p=>Math.max(Date.now()+100,p.readyAt));
        await this.state.storage.setAlarm(Math.min(this.nextEvent(Date.now(), cfg.mode === "paper", cfg),...due,...researchDue));
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
      if(d.sid!=null && this.bookSid!=null && d.sid!==this.bookSid)return;
      const sid=d.sid??"legacy", previous=this.bookSequences.get(sid)??(d.sid==null?this.bookSequence:null);
      if (d.type === "orderbook_delta" && Number.isFinite(d.seq) && previous != null && d.seq !== previous + 1) {
        this.closeUpstream("order book sequence gap"); this.retry(); return;
      }
      if (Number.isFinite(d.seq)){this.bookSequences.set(sid,d.seq);this.bookSequence=d.seq;}
    }
    if (d.type === "orderbook_snapshot" && d.msg && d.msg.market_ticker) {
      const b = {yes: new Map(), no: new Map(), at: Date.now(), sourceAt:Number(d.sending_ts_ms)||null, sourceKind:'sending_ts_ms'};
      for (const [px, q] of d.msg.yes_dollars_fp || []) if (+q > 0) b.yes.set(+px, +q);
      for (const [px, q] of d.msg.no_dollars_fp || []) if (+q > 0) b.no.set(+px, +q);
      this.books[d.msg.market_ticker] = b;
    }
    if (d.type === "orderbook_delta" && d.msg && d.msg.market_ticker && this.books[d.msg.market_ticker]) {
      const m = this.books[d.msg.market_ticker][d.msg.side === "no" ? "no" : "yes"], px = +d.msg.price_dollars, q = (m.get(px) || 0) + +d.msg.delta_fp;
      if (q > 0) m.set(px, q); else m.delete(px);
      this.books[d.msg.market_ticker].at = Date.now();
      this.books[d.msg.market_ticker].sourceAt = Number(d.msg.ts_ms??d.sending_ts_ms)||null;
      this.books[d.msg.market_ticker].sourceKind = d.msg.ts_ms!=null?'ts_ms':'sending_ts_ms';
    }
    if (d.type === "cfbenchmarks_value_5hz" && d.msg && d.msg.index_id === "BRTI" && +d.msg.value_usd > 0) this.pushTick(+d.msg.source_ts_ms, +d.msg.value_usd);
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
    if (d.type === "ticker" && d.msg && d.msg.market_ticker) this.lastTicker[d.msg.market_ticker] = {bid: +d.msg.yes_bid_dollars || null, ask: +d.msg.yes_ask_dollars || null, at: Date.now()};
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
