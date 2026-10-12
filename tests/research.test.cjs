const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function harness(){
 let now=1800000000000;
 class Clock extends Date{static now(){return now;}}
 const context=vm.createContext({Date:Clock,Intl,URL,Request,Response,AbortSignal,AbortController,console,setTimeout:()=>1,clearTimeout(){},TextEncoder,crypto:require('node:crypto').webcrypto});
 const source=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8').replace('export default {','const entry = {').replace('export class KalshiFeed','class KalshiFeed');
 vm.runInContext(source+'\nglobalThis.api={KalshiFeed,entry,research,marketTicker};',context);
 const data=new Map();let alarm=null;
 const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),list:async({prefix})=>new Map([...data].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)])),delete:async k=>data.delete(k),getAlarm:async()=>alarm,setAlarm:async a=>{alarm=a;}};
 const obj=new context.api.KalshiFeed({storage},{KALSHI_KEY_ID:'fixture',KALSHI_PRIVATE_KEY:'fixture'});
 return {context,obj,data,api:context.api,r:context.api.research,now:()=>now,setTime:v=>now=v,alarm:()=>alarm};
}
const book=at=>({at,sourceAt:at-20,sourceKind:'ts_ms',yes:new Map([[.4,10]]),no:new Map([[.5,10]])});
const ticks=(from,to)=>Array.from({length:to-from+1},(_,i)=>[(from+i)*1000,100+Math.sin(i), (from+i)*1000+10]);
test('research uses only one-Hz observations available at capture and pauses on an elapsed gap',()=>{
 const h=harness(),close=1800000900,at=(close-30)*1000+20,input=ticks(close-1000,close-30);
 const base={at,close,target:100,targetAt:at-10,ticks:input,book:book(at),marketStatus:'active',exchange:{exchange_active:true,trading_active:true}};
 const good=h.r.snapshot(base);assert.equal(good.status,'forecast');assert.equal(good.projection.observed,30);assert.ok(good.depth.valid);
 const gap=h.r.snapshot({...base,ticks:input.filter(t=>t[0]!==((close-40)*1000))});assert.equal(gap.p,null);assert.match(gap.status,/missing settlement/);
 const late=input.map(t=>t[0]===(close-40)*1000?[t[0],t[1],at+1000]:t);
 assert.equal(h.r.snapshot({...base,ticks:late}).p,null);
 assert.equal(h.r.snapshot({...base,targetAt:at+1}).p,null);
});
test('research rejects replayed/future/unknown depth sources and crossed books',()=>{
 const h=harness(),at=h.now();
 for(const sourceAt of [null,at-5000,at+251])assert.equal(h.r.depthSnapshot({...book(at),sourceAt},at).valid,false);
 assert.equal(h.r.depthSnapshot({...book(at),yes:new Map([[.9,10]])},at).valid,false);
 assert.equal(h.r.depthSnapshot({...book(at),at:at+1},at).valid,false);
});
function fixtureCheck(h,close,p=.8,p2=.9){
 const at=(close-60)*1000;
 const depth=h.r.depthSnapshot(book(at),at);
 return {at,status:'forecast',p,p2,marketStatus:'active',exchange:{exchange_active:true,trading_active:true},depth,
  arrival:{at:at+1000,depth:h.r.depthSnapshot(book(at+1000),at+1000),exchange:{exchange_active:true,trading_active:true}}};
}
test('simulation preserves limit, arrival deadline, depth haircut, fees and exchange gate',()=>{
 const h=harness(),close=1800000900,k=fixtureCheck(h,close);
 const fill=h.r.simulate(k,'p',close);assert.equal(fill.filled,1);assert.equal(fill.costCents,50);assert.equal(fill.feesCents,2);
 k.arrival.depth.yes[0].price=51;assert.equal(h.r.simulate(k,'p',close).filled,0);
 k.arrival.depth.yes[0].price=50;k.arrival.depth.yes[0].size=1;assert.equal(h.r.simulate(k,'p',close).filled,0);
 k.arrival.depth.yes[0].size=10;k.arrival.at=k.at+4001;assert.equal(h.r.simulate(k,'p',close).filled,0);
 k.arrival.at=k.at+1000;k.arrival.exchange.trading_active=false;assert.equal(h.r.simulate(k,'p',close).filled,0);
});
function windows(h,count=100){
 const start=1800000000; // aligned 5-hour fold boundary
 return Array.from({length:count},(_,i)=>{const close=start+(i+1)*900;return {mk:'TEST-'+i,close,schema:h.r.VERSION,model:h.context.BTC15Model.VERSION,
   src:'kalshi',result:'yes',resultObservedAt:close*1000+60000,checks:{60:fixtureCheck(h,close)}};});
}
test('chronological folds never choose a variant using test outcomes or late-known training outcomes',()=>{
 const h=harness(),rows=windows(h),first=h.r.report(rows);
 assert.ok(first.evaluatedWindows>0);const fold=first.folds[0];assert.equal(fold.choices[60].variant,'p2');
 const changed=structuredClone(rows);for(const row of changed)if(row.close>=fold.testFirstClose)row.result='no';
 const after=h.r.report(changed);assert.deepEqual(after.folds[0].choices,fold.choices);
 const leak=windows(h);for(const row of leak.slice(0,65))row.resultObservedAt=rows.at(-1).close*1000+90000;
 assert.equal(h.r.report(leak).evaluatedWindows,0);
});
test('reports exclude proxy/legacy outcomes and hold checkpoints as separate experiments',()=>{
 const h=harness(),rows=windows(h),r=h.r.report(rows);
 assert.ok(r.scores[60].n>0);assert.equal(r.scores[30].n,0);assert.equal(r.readyForLive,false);
 assert.equal(r.scores[60].pnlCents,r.scores[60].filled*48);
 for(const row of rows)row.src='page';assert.equal(h.r.report(rows).settledWindows,0);
 for(const row of rows){row.src='kalshi';row.model='legacy';}assert.equal(h.r.report(rows).recordedWindows,0);
});
test('arrival results cannot alter forecast scores or variant selection',()=>{
 const h=harness(),rows=windows(h),a=h.r.report(rows);
 for(const row of rows)row.checks[60].arrival=null;
 const b=h.r.report(rows);assert.equal(b.scores[60].filled,0);assert.equal(b.scores[60].brier,a.scores[60].brier);assert.deepEqual(b.folds,a.folds);
});
test('research captures are durable and immutable, with pending delayed arrival separate from paper',async()=>{
 const h=harness(),close=1800000900,at=(close-60)*1000+20;h.setTime(at);
 h.obj.researchTicks=new Map(ticks(close-1000,close-60).map(t=>[t[0],t]));h.obj.books[h.api.marketTicker(close)]=book(at);
 vm.runInContext('signedGet=async(env,path)=>path.includes("/markets/")?{market:{floor_strike:100,status:"active"}}:{exchange_active:true,trading_active:true}',h.context);
 await h.obj.researchCapture();const row=h.data.get('r:'+close);assert.equal(row.checks[60].status,'forecast');assert.ok(h.data.has(`ri:${close}:60`));
 assert.equal(h.data.get('research.pending').length,1);assert.equal(h.data.has('trade.cfg'),false);
 const original=structuredClone(row.checks[60]);h.setTime(at+1000);h.obj.books[row.mk]=book(at+1000);await h.obj.researchArrivals();
 assert.equal(h.data.get('r:'+close).checks[60].arrival.at,at+1000);
 await h.obj.researchCapture();const {arrival,...unchanged}=h.data.get('r:'+close).checks[60];assert.deepEqual(unchanged,original);
});
test('feed receipt timestamps are first-observed and fast ticks never enter research input',()=>{
 const h=harness(),now=h.now();
 h.obj.onUpstream(JSON.stringify({type:'cfbenchmarks_value_5hz',msg:{index_id:'BRTI',source_ts_ms:now,value_usd:'200'}}));assert.equal(h.obj.researchTicks.size,0);
 const raw=JSON.stringify({type:'cfbenchmarks_value',msg:{index_id:'BRTI',data:JSON.stringify({time:now,value:100})}});
 h.obj.onUpstream(raw);h.setTime(now+1000);h.obj.onUpstream(raw);assert.equal(h.obj.researchTicks.get(now)[2],now);
});
test('final raw average is diagnostic and only Kalshi result settles research',async()=>{
 const h=harness(),close=1800000900;h.setTime((close+90)*1000);
 h.obj.researchTicks=new Map(ticks(close-60,close).map(t=>[t[0],t]));
 h.data.set('r:'+close,{mk:'TEST',close,schema:h.r.VERSION,model:h.context.BTC15Model.VERSION,checks:{},src:null});
 vm.runInContext('signedGet=async()=>({market:{}})',h.context);await h.obj.researchSettle();assert.equal(h.data.get('r:'+close).src,null);assert.equal(h.data.get('r:'+close).closingCapture.samples,60);
 vm.runInContext('signedGet=async()=>({market:{result:"no",expiration_value:"99.12"}})',h.context);await h.obj.researchSettle();
 assert.equal(h.data.get('r:'+close).result,'no');assert.equal(h.data.get('r:'+close).officialCloseAvg,99.12);assert.equal(h.data.get('r:'+close).resultObservedAt,h.now());
});
test('research endpoints enforce token, method, stable pagination and raw retention',async()=>{
 const h=harness();h.obj.env.FEED_TOKEN='secret';
 const get=(path,method='GET')=>h.obj.fetch(new Request('https://internal'+path,{method}));
 assert.equal((await get('/research/export')).status,403);assert.equal((await get('/research/export?token=secret','POST')).status,405);
 for(const row of windows(h,5))h.data.set('r:'+row.close,row);
 let r=await get('/research/export?token=secret&through=1900000000&limit=2'),d=await r.json();assert.equal(d.rows.length,2);assert.equal(d.nextAfter,d.rows[1].close);
 r=await get(`/research/export?token=secret&through=1900000000&limit=2&after=${d.nextAfter}`);d=await r.json();assert.equal(d.rows[0].mk,'TEST-2');
 assert.equal((await get('/research/export?token=secret&limit=999999')).status,400);
 assert.equal((await get('/research/inputs?token=secret&close=1&check=60')).status,404);
});
test('research warms depth briefly with no browser and schedules exact capture times',()=>{
 const h=harness(),close=1800000900;h.setTime((close-65)*1000);const messages=[];h.obj.up={send:s=>messages.push(JSON.parse(s))};h.obj.subscribeTickers();
 assert.ok(messages.some(m=>m.params.channels?.includes('orderbook_delta')));assert.equal(h.obj.nextEvent(h.now(),false,{}),(close-60)*1000);
 h.setTime((close-45)*1000);h.obj.subscribeTickers();assert.equal(h.obj.depthSubscribed,false);
});

function tagged(h,count=4){
 const rows=windows(h,count);
 for(const w of rows){const k=w.checks[60];k.bias={version:h.r.BIAS_VERSION,move5Z:1.5,spotAbove:false,projectedAbove:true};k.projection={observed:1,m:59,missing:0};}
 return rows;
}
test('bias capture preserves rounding-aware required mean and excludes later receipts from movement',()=>{
 const h=harness(),close=1800000900,at=(close-12)*1000+20,input=ticks(close-1000,close-12);
 const args={at,close,target:100,targetAt:at,ticks:input,book:book(at),marketStatus:'active',exchange:{exchange_active:true,trading_active:true}};
 const k=h.r.snapshot(args);assert.equal(k.bias.version,h.r.BIAS_VERSION);
 assert.ok(Math.abs(k.bias.requiredRemainingMean-(60*99.995-k.projection.sum)/12)<1e-9);
 const last=input.at(-1),previous=input.find(t=>t[0]===last[0]-5000);
 assert.equal(k.bias.move5Usd,last[1]-previous[1]);
 previous[2]=at+1000;assert.equal(h.r.snapshot(args).bias.move5Z,null);
});
test('bias experiments exclude old observations, unofficial labels, duplicates, future results and late checkpoints',()=>{
 const h=harness();assert.equal(h.r.biasReport(windows(h)).captured,0);
 const rows=tagged(h);let r=h.r.biasReport([...rows,...rows]);assert.equal(r.captured,4);assert.equal(r.rows.find(r=>r.hypothesis==='price-bands'&&r.side==='Up').n,4);
 rows[0].src='page';rows[1].resultObservedAt=rows[1].close*1000-1;rows[2].checks[60].at+=6000;
 r=h.r.biasReport(rows);assert.equal(r.eligibleSettledCheckpoints,1);assert.equal(r.coverage.pending,2);assert.equal(r.coverage.invalid,1);
 assert.equal(r.readyForLive,false);
});
test('price bands compare both sides independently and keep quote win rate separate from fill return',()=>{
 const h=harness(),rows=tagged(h,2);rows[1].checks[60].arrival=null;
 const r=h.r.biasReport(rows),up=r.rows.find(g=>g.hypothesis==='price-bands'&&g.side==='Up'),down=r.rows.find(g=>g.hypothesis==='price-bands'&&g.side==='Down');
 assert.equal(up.band,'50–70¢');assert.equal(up.n,2);assert.equal(up.winRate,1);assert.equal(up.filled,1);assert.equal(up.meanNetCents,48);assert.equal(up.meanAllInCents,52);
 assert.equal(down.winRate,0);assert.equal(down.meanNetCents,-62);assert.equal(down.maxDrawdownCents,62);
 assert.equal(up.skips['arrival not recorded'],1);assert.equal(r.coverage.missingArrival,1);
});
test('fixed hypothesis selection is independent of future outcome and forecast probability edge',()=>{
 const h=harness(),rows=tagged(h,2);for(const w of rows)w.checks[60].p=.01;
 const first=h.r.biasReport(rows);for(const w of rows)w.result='no';const second=h.r.biasReport(rows);
 assert.deepEqual(first.rows.map(g=>[g.hypothesis,g.checkpoint,g.side,g.band,g.n,g.attempts,g.filled]),second.rows.map(g=>[g.hypothesis,g.checkpoint,g.side,g.band,g.n,g.attempts,g.filled]));
 assert.equal(first.rows.find(g=>g.hypothesis==='settlement-disagreement').filled,2);
});
test('settlement disagreements and follow-through use frozen conditions, not a missing value or a tiny move',()=>{
 const h=harness(),rows=tagged(h,4);
 rows[0].checks[60].bias.spotAbove=null;rows[1].checks[60].bias.projectedAbove=false;rows[2].checks[60].projection.m=0;
 for(const [i,w]of rows.entries())w.checks[60].bias.move5Z=[null,.99,-1,1][i];
 const r=h.r.biasReport(rows);assert.equal(r.rows.find(g=>g.hypothesis==='settlement-disagreement').n,1);
 assert.equal(r.rows.find(g=>g.hypothesis==='index-follow-through'&&g.side==='Down').n,1);assert.equal(r.rows.find(g=>g.hypothesis==='index-follow-through'&&g.side==='Up').n,1);
});
test('follow-through midpoint diagnostics sign NO correctly and never count stale arrivals as profit',()=>{
 const h=harness(),rows=tagged(h,1),k=rows[0].checks[60];k.bias.move5Z=-2;
 k.arrival.depth.bidCents-=4;k.arrival.depth.askCents-=4;
 let g=h.r.biasReport(rows).rows.find(g=>g.hypothesis==='index-follow-through');assert.equal(g.meanMarkoutCents,4);assert.equal(g.meanDelayMs,1000);assert.equal(g.meanNetCents,-62);
 k.arrival.depth.valid=false;g=h.r.biasReport(rows).rows.find(g=>g.hypothesis==='index-follow-through');assert.equal(g.markoutN,0);assert.equal(g.meanMarkoutCents,null);assert.equal(g.filled,0);
});
test('bias drawdown is chronological even when export rows arrive out of order',()=>{
 const h=harness(),rows=tagged(h,3);rows[0].result='no';rows[1].result='no';
 const a=h.r.biasReport(rows).rows,b=h.r.biasReport([...rows].reverse()).rows;assert.deepEqual(a,b);
});
test('small upstream clock skew is explicit and bounded; local future receipts still fail',()=>{
 const h=harness(),at=h.now();
 const b=h.r.depthSnapshot({...book(at),sourceAt:at+70},at);assert.equal(b.valid,true);assert.equal(b.clockAheadMs,70);assert.equal(b.sourceAgeMs,-70);
 assert.equal(h.r.depthSnapshot({...book(at),sourceAt:at+250},at).valid,true);
 assert.equal(h.r.depthSnapshot({...book(at),sourceAt:at+251},at).valid,false);
 assert.equal(h.r.depthSnapshot({...book(at),at:at+1,sourceAt:at},at).valid,false);
});
test('fixed-point deltas remove canceled levels without leaving crossed phantom depth',()=>{
 const h=harness(),at=h.now(),send=d=>h.obj.onUpstream(JSON.stringify(d));
 send({type:'orderbook_snapshot',sending_ts_ms:at,msg:{market_ticker:'TEST',yes_dollars_fp:[['0.9000','0.30'],['0.4000','10.00']],no_dollars_fp:[['0.5000','10.00']]}});
 send({type:'orderbook_delta',msg:{market_ticker:'TEST',side:'yes',price_dollars:'0.9000',delta_fp:'-0.10',ts_ms:at}});
 send({type:'orderbook_delta',msg:{market_ticker:'TEST',side:'yes',price_dollars:'0.9000',delta_fp:'-0.20',ts_ms:at}});
 assert.equal(h.obj.books.TEST.yes.has(.9),false);assert.equal(h.r.depthSnapshot(h.obj.books.TEST,at).valid,true);
 const fractional={...book(at),no:new Map([[.9,1e-12],[.5,.75]])};
 const asks=h.context.BTC15Model.asks(fractional,'Up');assert.equal(asks.length,1);assert.equal(asks[0].size,.75);
});
