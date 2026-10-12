// Canonical model. scripts/sync-model.cjs embeds this exact source in Worker and page.
// Frozen baseline: no fitted flow lean; all parameters recorded under VERSION.
(() => {
const VERSION = "brti-driftless-v3";
const EXECUTION_VERSION = "paper-delayed-depth-v2";
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
  .map(([p,n])=>({price:Math.round((1-p)*10000)/100,size:Math.round(n*100)/100})).filter(level=>level.size>0).sort((a,b)=>a.price-b.price);
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
