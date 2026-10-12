// Canonical research calculations; embedded in worker.js and imported by the offline evaluator.
(() => {
const VERSION = 'settlement-research-v1';
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
  return {at, leftSeconds:close-at/1000, target, targetAt, marketStatus, exchange,
    index:{source:'cfbenchmarks_value',sourceAt:last?.[0]??null,receivedAt:last?.[2]??null,value:last?.[1]??null,ageMs,samples:input.length},
    vols, projection, p, p2, status:reason||'forecast', depth:depthSnapshot(book,at)};
}
function simulate(check, variant, close) {
  const p=check[variant], book=check.depth, arrival=check.arrival;
  const no=reason=>({attempted:false,filled:0,pnlCents:null,reason});
  if(!finite(p)||p<0||p>1||!book?.valid||check.marketStatus!=='active'||
    check.exchange?.exchange_active!==true||check.exchange?.trading_active!==true)return no('decision data unavailable');
  const candidates=[['Up',p,book.yes[0]],['Down',1-p,book.no[0]]].filter(x=>x[2]).map(([side,prob,level])=>({side,price:level.price,
    edge:100*prob-level.price-globalThis.BTC15Model.feesCents(level.price,SETTINGS.quantity,SETTINGS.feeVenue)})).sort((a,b)=>b.edge-a.edge);
  const c=candidates[0]; if(!c||c.edge<SETTINGS.minEdgeCents)return no('below frozen net-edge threshold');
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
    evaluatedWindows:evaluated.size,folds,scores,readyForLive:false,
    expectedWindows:recorded.length?Math.round((recorded.at(-1).close-recorded[0].close)/900)+1:0,
    unrecordedWindows:recorded.length?Math.max(0,Math.round((recorded.at(-1).close-recorded[0].close)/900)+1-recorded.length):0,
    status:evaluated.size?'chronological research results; fills are simulated':'collecting; insufficient prior resolved windows',
    limitations:['Each checkpoint is a separate one-contract experiment; do not add their P&L.',
      'Variant selection uses earlier resolved windows only; no live model changes.',
      'Displayed depth does not guarantee an executable fill; latency and fees are fixed scenarios.',
      'Arrival simulation reuses checkpoint exchange status for at most four seconds; intervening halts are unknown.',
      'Missing/stale data is excluded and reported; coverage can bias results. No statistical significance claim.']};
}
globalThis.BTC15Research=Object.freeze({VERSION,CHECKS,SETTINGS,depthWanted,depthSnapshot,snapshot,simulate,report});
})();
