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
 storage.transaction=async fn=>fn(storage);
 const tasks=[];const obj=new context.api.KalshiFeed({storage,waitUntil:task=>tasks.push(task)},{KALSHI_KEY_ID:'fixture',KALSHI_PRIVATE_KEY:'fixture'});
 return {context,obj,data,tasks,api:context.api,r:context.api.research,now:()=>now,setTime:v=>now=v,alarm:()=>alarm};
}
const book=at=>({at,sourceAt:at-20,sourceKind:'ts_ms',yes:new Map([[.4,10]]),no:new Map([[.5,10]])});
const ticks=(from,to)=>Array.from({length:to-from+1},(_,i)=>[(from+i)*1000,100+Math.sin(i), (from+i)*1000+10]);
test('research metadata shares a two-second deadline and a timeout leaves no simulated arrival',async()=>{
 const h=harness(),close=1800000900,at=(close-60)*1000+750;h.setTime(at);
 const controller=new AbortController(),budgets=[],calls=[];
 h.context.AbortSignal={timeout:ms=>{budgets.push(ms);return controller.signal;}};
 h.context.read=async(_env,path,_query,{signal})=>{calls.push(path);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 vm.runInContext('signedGet=read',h.context);
 const job=h.obj.researchCapture();for(let i=0;i<40&&calls.length<2;i++)await Promise.resolve();
 assert.equal(calls.length,2);assert.deepEqual(budgets,[2000]);h.setTime(at+2000);controller.abort();await job;
 const k=h.data.get('r:'+close).checks[60];assert.equal(k.status,'market or exchange read unavailable');assert.equal(k.p,null);assert.equal(k.reads.version,'research-reads-v1');
 assert.equal(k.reads.startedAt,at);assert.equal(k.reads.finishedAt,at+2000);assert.equal(k.targetAt,null);assert.equal(h.data.get('research.pending').length,0);
});
test('session metadata reads start together and preserve actual target receipt and read duration',async()=>{
 const h=harness(),S=h.context.BTC15Session,s=S.create(h.now(),'parallel-reads');h.setTime(s.startAt);await h.obj.saveSession(s);
 const close=(Math.floor(s.startAt/900000)+1)*900,mk=h.api.marketTicker(close),calls=[];
 h.obj.researchTicks=new Map(ticks(Math.floor(s.startAt/1000)-200,Math.floor(s.startAt/1000)).map(t=>[t[0],t]));
 let release;const gate=new Promise(resolve=>release=resolve);
 h.context.read=async(_env,path,_query,options)=>{
  calls.push({path,signal:options.signal});
  if(path.endsWith('/exchange/status')){await gate;return {exchange_active:true,trading_active:true};}
  return {market:{floor_strike:100,status:'active'}};
 };
 vm.runInContext('signedGet=read',h.context);
 const job=h.obj.sessionTick();for(let i=0;i<40&&calls.length<2;i++)await Promise.resolve();
 assert.equal(calls.length,2);assert.equal(calls[0].signal,calls[1].signal);
 for(let i=0;i<10;i++)await Promise.resolve(); // let the immediate market response record its receipt
 h.setTime(s.startAt+200);h.obj.books[mk]=book(h.now());release();await job;
 const final=await h.obj.loadSession(),look=final.looks[0];assert.equal(final.looks.length,1);
 assert.equal(look.targetAt,s.startAt);assert.equal(look.at,s.startAt+200);assert.equal(look.reads.startedAt,s.startAt);assert.equal(look.reads.finishedAt,look.at);
 assert.equal(look.reads.exchangeAt,look.at);assert.equal(look.reads.budgetMs,2000);assert.equal(look.target,100);assert.ok(look.vols);
});
test('session read budget abort records a skipped look and never fabricates an arrival fill',async()=>{
 for(const pending of [false,true]){
  const h=harness(),S=h.context.BTC15Session,s=S.create(h.now(),'read-timeout-'+pending);h.setTime(s.startAt);
  if(pending){s.pending={sessionVersion:s.version,model:s.settings.model,settlementConvention:s.settings.settlementConvention,action:'buy',side:'Up',at:s.startAt-1000,readyAt:s.startAt,mk:'TEST',close:s.startAt/1000+300,limit:50,decision:{p:.8}};}
  await h.obj.saveSession(s);
  const controller=new AbortController(),budgets=[],calls=[];
  h.context.AbortSignal={timeout:ms=>{budgets.push(ms);return controller.signal;}};
  h.context.read=async(_env,path,_query,{signal})=>{calls.push(path);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  vm.runInContext('signedGet=read',h.context);
  const job=h.obj.sessionTick();for(let i=0;i<40&&calls.length<2;i++)await Promise.resolve();
  assert.equal(calls.length,2);assert.deepEqual(budgets,[2000]);h.setTime(s.startAt+2000);controller.abort();await job;
  const final=await h.obj.loadSession();assert.equal(final.trades.length,0);assert.equal(final.pending,null);
  if(pending){assert.equal(final.attempts[0].filled,0);assert.equal(final.attempts[0].arrivalReads.budgetMs,2000);}
  else{assert.equal(final.looks[0].reason,'market or exchange read unavailable');assert.equal(final.looks[0].p,null);assert.equal(final.looks[0].reads.marketAt,null);}
 }
});
test('session official outcome reads cannot defer launching the current market reads',async()=>{
 const h=harness(),S=h.context.BTC15Session,s=S.create(h.now()-900000,'outcome-batch');h.setTime(s.startAt+900000);
 s.trades=[{mk:'OLD',close:s.startAt/1000+900,side:'Up',entryCents:50,entryFeeCents:2,pnlCents:null}];await h.obj.saveSession(s);
 let release;const gate=new Promise(resolve=>release=resolve),calls=[];
 h.context.read=async(_env,path)=>{calls.push(path);if(path.endsWith('/OLD')){await gate;return {market:{result:'yes'}};}return path.includes('/markets/')?{market:{floor_strike:100,status:'active'}}:{exchange_active:true,trading_active:true};};
 vm.runInContext('signedGet=read',h.context);
 const job=h.obj.sessionTick();for(let i=0;i<40&&calls.length<3;i++)await Promise.resolve();assert.equal(calls.length,3);
 release();await job;const final=await h.obj.loadSession();assert.equal(final.trades[0].resolution,'official settlement');assert.equal(final.trades[0].pnlCents,48);assert.equal(final.looks.length,1);
});
test('research uses only one-Hz observations available at capture and pauses on an elapsed gap',()=>{
 const h=harness(),close=1800000900,at=(close-30)*1000+20,input=ticks(close-1000,close-30);
 const base={at,close,target:100,targetAt:at-10,ticks:input,book:book(at),marketStatus:'active',exchange:{exchange_active:true,trading_active:true}};
 const good=h.r.snapshot(base);assert.equal(good.status,'forecast');assert.equal(good.projection.observed,31);assert.ok(good.depth.valid);
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
 const h=harness(),close=1800000900,at=(close-60)*1000+750;h.setTime(at);
 h.obj.researchTicks=new Map(ticks(close-1000,close-60).map(t=>[t[0],t]));h.obj.books[h.api.marketTicker(close)]=book(at);
 vm.runInContext('signedGet=async(env,path)=>path.includes("/markets/")?{market:{floor_strike:100,status:"active"}}:{exchange_active:true,trading_active:true}',h.context);
 await h.obj.researchCapture();const row=h.data.get('r:'+close);assert.equal(row.checks[60].status,'forecast');assert.ok(h.data.has(`ri:${close}:60`));
 assert.equal(row.schema,'settlement-research-v2');assert.equal(row.model,'brti-driftless-v4');
 assert.equal(row.settlementConvention,'[close-60s,close)');assert.equal(row.checks[60].settlementConvention,row.settlementConvention);
 assert.equal(row.checks[60].model,row.model);assert.equal(row.checks[60].bias.version,'btc15-bias-v3');
 assert.equal(h.data.get(`ri:${close}:60`).settlementConvention,row.settlementConvention);
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
 h.obj.researchTicks.get((close-60)*1000)[1]=10;h.obj.researchTicks.get(close*1000)[1]=1000;
 h.data.set('r:'+close,{mk:'TEST',close,schema:h.r.VERSION,model:h.context.BTC15Model.VERSION,checks:{},src:null});
 vm.runInContext('signedGet=async()=>({market:{}})',h.context);await h.obj.researchSettle();assert.equal(h.data.get('r:'+close).src,null);assert.equal(h.data.get('r:'+close).closingCapture.samples,60);
 const capture=h.data.get('r:'+close).closingCapture,raw=h.data.get(`ri:${close}:0`);
 assert.equal(capture.settlementConvention,'[close-60s,close)');assert.equal(raw.settlementConvention,capture.settlementConvention);
 assert.equal(raw.schema,h.r.VERSION);assert.equal(raw.model,h.context.BTC15Model.VERSION);
 assert.equal(raw.ticks[0][0],(close-60)*1000);assert.equal(raw.ticks.at(-1)[0],(close-1)*1000);
 assert.equal(capture.localAverage,raw.ticks.reduce((sum,t)=>sum+t[1],0)/60);
 vm.runInContext('signedGet=async()=>({market:{result:"no",expiration_value:"99.12"}})',h.context);await h.obj.researchSettle();
 assert.equal(h.data.get('r:'+close).result,'no');assert.equal(h.data.get('r:'+close).officialCloseAvg,99.12);assert.equal(h.data.get('r:'+close).resultObservedAt,h.now());
 assert.deepEqual(h.data.get('r:'+close).closingCapture,capture);assert.deepEqual(h.data.get(`ri:${close}:0`),raw);
});
test('a mid-window upgrade skips legacy captures and pending arrivals without changing original observations',async()=>{
 const h=harness(),close=1800000900,at=(close-30)*1000+20,key='r:'+close;h.setTime(at);
 const original=structuredClone({schema:'settlement-research-v1',model:'brti-driftless-v3',mk:h.api.marketTicker(close),close,
  target:100,checks:{60:{...fixtureCheck(h,close),bias:{version:'btc15-bias-v2'}}},src:null,result:null});
 delete original.checks[60].arrival;
 const raw={schema:original.schema,model:original.model,close,check:60,ticks:ticks(close-120,close-60)};
 h.data.set(key,structuredClone(original));h.data.set(`ri:${close}:60`,structuredClone(raw));
 h.data.set('research.pending',[{key,check:60,readyAt:at-1}]);h.obj.books[original.mk]=book(at);
 vm.runInContext('signedGet=async()=>{throw Error("legacy window must not fetch a new checkpoint");}',h.context);
 await h.obj.researchCapture();await h.obj.researchArrivals();
 assert.deepEqual(h.data.get(key),original);assert.deepEqual(h.data.get(`ri:${close}:60`),raw);
 assert.equal(h.data.has(`ri:${close}:30`),false);assert.deepEqual(h.data.get('research.pending'),[]);
 assert.equal(h.r.report([original]).recordedWindows,0);assert.equal(h.r.biasReport([original]).captured,0);
});
test('research reports isolate old schema, model and bias cohorts without rewriting their snapshots',()=>{
 const h=harness(),current=structuredClone(tagged(h,1)[0]),oldSchema=structuredClone(current),oldModel=structuredClone(current),oldBias=structuredClone(current);
 oldSchema.mk='OLD-SCHEMA';oldSchema.schema='settlement-research-v1';
 oldModel.mk='OLD-MODEL';oldModel.model='brti-driftless-v3';
 oldBias.mk='OLD-BIAS';oldBias.checks[60].bias.version='btc15-bias-v2';
 const rows=[current,oldSchema,oldModel,oldBias],original=structuredClone(rows),report=h.r.report(rows);
 assert.equal(report.recordedWindows,2);assert.equal(report.bias.captured,1);assert.equal(report.bias.coverage.legacy,1);
 assert.equal(report.settlementConvention,'[close-60s,close)');assert.deepEqual(rows,original);
});
test('an orphan checkpoint raw buffer is preserved without reconstructing a forecast or blocking later checkpoints',async()=>{
 const h=harness(),close=1800000900,key='r:'+close,at=(close-60)*1000+750;h.setTime(at);
 const original={schema:'settlement-research-v1',model:'brti-driftless-v3',mk:h.api.marketTicker(close),close,
  check:60,at,ticks:ticks(close-120,close-60),target:100,targetAt:at};
 h.data.set(`ri:${close}:60`,structuredClone(original));
 vm.runInContext('signedGet=async()=>{throw Error("an orphan raw buffer must not trigger recapture");}',h.context);
 await h.obj.researchCapture();
 assert.deepEqual(h.data.get(`ri:${close}:60`),original);assert.equal(h.data.get(key).checks[60].p,null);
 assert.match(h.data.get(key).checks[60].status,/original raw input already exists/);
 assert.equal(h.data.has('research.pending'),false);
 const later=(close-30)*1000+750;h.setTime(later);
 h.obj.researchTicks=new Map(ticks(close-1000,close-30).map(t=>[t[0],t]));h.obj.books[original.mk]=book(later);
 vm.runInContext('signedGet=async(env,path)=>path.includes("/markets/")?{market:{floor_strike:101,status:"active"}}:{exchange_active:true,trading_active:true}',h.context);
 await h.obj.researchCapture();
 assert.equal(h.data.get(key).checks[30].status,'forecast');assert.equal(h.data.get(key).checks[30].model,'brti-driftless-v4');
 assert.deepEqual(h.data.get(`ri:${close}:60`),original);
});
test('legacy closing captures and raw inputs stay immutable while official outcomes still attach',async()=>{
 const h=harness(),close=1800000900,key='r:'+close;h.setTime((close+90)*1000);
 const original={schema:'settlement-research-v1',model:'brti-driftless-v3',mk:'LEGACY',close,target:101,
  checks:{60:{at:(close-60)*1000,p:.83,p2:.92,bias:{version:'btc15-bias-v2'}}},src:null,result:null,
  closingCapture:{at:(close+61)*1000,samples:60,complete:true,localAverage:101.25}};
 const raw={schema:original.schema,mk:original.mk,close,check:0,at:original.closingCapture.at,ticks:ticks(close-59,close)};
 h.data.set(key,structuredClone(original));h.data.set(`ri:${close}:0`,structuredClone(raw));
 h.obj.researchTicks=new Map(ticks(close-60,close).map(t=>[t[0],[t[0],300,t[2]]]));
 vm.runInContext('signedGet=async()=>({market:{result:"yes",expiration_value:"101.27"}})',h.context);
 await h.obj.researchSettle();
 assert.deepEqual(h.data.get(key),{...original,src:'kalshi',result:'yes',resultObservedAt:h.now(),officialCloseAvg:101.27});
 assert.deepEqual(h.data.get(`ri:${close}:0`),raw);
});
test('legacy rows lacking a closing capture retain the explicitly tagged old diagnostic convention',async()=>{
 const h=harness(),close=1800000900,key='r:'+close;h.setTime((close+90)*1000);
 const original={schema:'settlement-research-v1',model:'brti-driftless-v3',mk:'LEGACY',close,checks:{},src:null};
 h.data.set(key,structuredClone(original));h.obj.researchTicks=new Map(ticks(close-60,close).map(t=>[t[0],t]));
 h.obj.researchTicks.get((close-60)*1000)[1]=10;h.obj.researchTicks.get(close*1000)[1]=1000;
 vm.runInContext('signedGet=async()=>({market:{}})',h.context);await h.obj.researchSettle();
 const row=h.data.get(key),raw=h.data.get(`ri:${close}:0`),{closingCapture,...unchanged}=row;
 assert.deepEqual(unchanged,original);assert.equal(closingCapture.settlementConvention,'(close-60s,close]');
 assert.equal(closingCapture.samples,60);assert.equal(closingCapture.localAverage,raw.ticks.reduce((sum,t)=>sum+t[1],0)/60);
 assert.equal(raw.schema,original.schema);assert.equal(raw.model,original.model);assert.equal(raw.settlementConvention,closingCapture.settlementConvention);
 assert.equal(raw.ticks[0][0],(close-59)*1000);assert.equal(raw.ticks.at(-1)[0],close*1000);
});
test('an existing closing raw buffer survives an interrupted summary write without being replaced by later ticks',async()=>{
 const h=harness(),close=1800000900,key='r:'+close;h.setTime((close+90)*1000);
 const row={schema:'settlement-research-v1',model:'brti-driftless-v3',mk:'LEGACY',close,checks:{},src:null};
 const raw={schema:row.schema,mk:row.mk,close,check:0,at:(close+61)*1000,ticks:ticks(close-59,close)};
 h.data.set(key,row);h.data.set(`ri:${close}:0`,structuredClone(raw));
 h.obj.researchTicks=new Map(ticks(close-60,close).map(t=>[t[0],[t[0],300,t[2]]]));
 vm.runInContext('signedGet=async()=>({market:{}})',h.context);await h.obj.researchSettle();
 assert.deepEqual(h.data.get(`ri:${close}:0`),raw);
 const capture=h.data.get(key).closingCapture;
 assert.equal(capture.at,raw.at);assert.equal(capture.settlementConvention,'(close-60s,close]');
 assert.equal(capture.localAverage,raw.ticks.reduce((sum,t)=>sum+t[1],0)/60);
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
 assert.equal(k.projection.m,11);assert.ok(Math.abs(k.bias.requiredRemainingMean-(60*99.995-k.projection.sum)/11)<1e-9);
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
test('timed session routes require token, reject overlapping runs and keep legacy agent separate',async()=>{
 const h=harness();h.obj.ensureUpstream=async()=>{};
 const req=(p,method='POST')=>new Request('https://test/paper-session/'+p+'?token=unit-token',{method});
 assert.equal((await h.obj.fetch(req('start'))).status,403);h.obj.env.FEED_TOKEN='unit-token';
 assert.equal((await h.obj.fetch(req('start'))).status,200);
 const s=h.data.get('session.current');assert.equal(s.status,'scheduled');assert.ok(h.alarm());
 assert.equal((await h.obj.fetch(req('start'))).status,409);
 const legacy=await h.obj.fetch(new Request('https://test/trade/config',{method:'POST',body:JSON.stringify({mode:'paper'})}));assert.equal(legacy.status,409);
 assert.equal((await h.obj.fetch(req('stop'))).status,200);assert.equal(h.data.get('session.current').status,'complete');
 assert.equal((await h.obj.fetch(req('start'))).status,200);assert.equal(h.data.get('session.previous').id,s.id);
});
test('manual stop during market read cannot be undone by the pending session tick',async()=>{
 const h=harness();h.obj.env.FEED_TOKEN='unit-token';const S=h.context.BTC15Session,s=S.create(h.now(),'race-test');h.setTime(s.startAt);
 h.data.set('session.current',s);
 h.context.stopDuringRead=async()=>h.obj.fetch(new Request('https://test/paper-session/stop?token=unit-token',{method:'POST'}));
 vm.runInContext('signedGet=async(env,path)=>{await stopDuringRead();return path.includes("/markets/")?{market:{floor_strike:100,status:"active"}}:{exchange_active:true,trading_active:true};}',h.context);
 await h.obj.sessionTick();const final=h.data.get('session.current');assert.equal(final.status,'complete');assert.equal(final.pending,null);assert.equal(final.looks.length,0);
});
test('timed session durable deadline survives alarm failure and next event includes pending arrival',async()=>{
 const h=harness(),S=h.context.BTC15Session,s=S.create(h.now(),'deadline-test');h.data.set('session.current',s);h.setTime(s.endAt+10000);
 h.obj.ensureAlarm=async()=>{};h.obj.researchCapture=async()=>{};h.obj.researchSettle=async()=>{};h.obj.checkpoint=async()=>{};
 await h.obj.alarm();await Promise.all(h.tasks);assert.equal(h.data.get('session.current').status,'complete');assert.ok(h.alarm()>h.now());
 const another=S.create(h.now(),'next');another.pending={readyAt:h.now()+1000};assert.equal(S.due(another,h.now()),h.now()+1000);
});
test('fixed checkpoint publication grace waits without relabeling later data as earlier',async()=>{
 const h=harness(),close=1800000900,at=(close-30)*1000+100;h.setTime(at);
 vm.runInContext('signedGet=async(env,path)=>path.includes("/markets/")?{market:{floor_strike:100,status:"active"}}:{exchange_active:true,trading_active:true}',h.context);
 await h.obj.researchCapture();assert.equal(h.data.get('r:'+close).checks[30],undefined);
 h.setTime(at+650);h.obj.researchTicks=new Map(ticks(close-1000,close-30).map(t=>[t[0],t]));h.obj.books[h.api.marketTicker(close)]=book(at+650);
 await h.obj.researchCapture();const k=h.data.get('r:'+close).checks[30];assert.equal(k.at,at+650);assert.equal(k.status,'forecast');
});
test('session history is chunked and stale saves cannot undo a stop',async()=>{
 const h=harness(),S=h.context.BTC15Session,s=S.create(h.now(),'chunks');
 s.looks=Array.from({length:720},(_,i)=>({at:s.startAt+i*5000,reason:'fixture'}));
 await h.obj.saveSession(s);assert.equal(h.data.get('session.current').looks.length,0);assert.equal(h.data.get('session.current').looksCount,720);
 const loaded=await h.obj.loadSession();assert.equal(loaded.looks.length,720);
 S.stop(loaded,h.now(),'manual stop');await h.obj.saveSession(loaded);
 assert.equal(await h.obj.saveSession(s),false);assert.equal((await h.obj.loadSession()).status,'complete');
});

test('slow session and maintenance reads cannot hold capture or newly queued research arrivals', {timeout:3000}, async()=>{
 const h=harness(),close=1800000900,at=(close-300)*1000+750,mk=h.api.marketTicker(close);h.setTime(at);
 const S=h.context.BTC15Session,s=S.create(at-900000,'slow-session');await h.obj.saveSession(s);
 h.obj.ensureAlarm=async()=>{};h.obj.researchSettle=async()=>{};
 h.obj.researchTicks=new Map(ticks(close-1000,close-300).map(t=>[t[0],t]));h.obj.books[mk]=book(at);
 let release;const blocked=new Promise(resolve=>release=resolve);let sessionReads=0,maintenanceReads=0,reads=0;
 h.context.read=async(_env,path)=>{
  // Capture gets its two timely reads first. Session's first read stays pending
  // across the next alarm, just as a delayed HTTP response would.
  if(++reads===3){sessionReads++;await blocked;}
  return path.includes('/markets/')?{market:{floor_strike:100,status:'active'}}:{exchange_active:true,trading_active:true};
 };
 vm.runInContext('signedGet=read',h.context);
 h.obj.checkpoint=async()=>{maintenanceReads++;await blocked;};
 await h.obj.alarm();
 const k=h.data.get('r:'+close).checks[300];assert.equal(k.status,'forecast');assert.equal(k.at,at);
 // Ensure both background tasks entered their blocked I/O, but alarm returned.
 for(let i=0;i<20&&sessionReads===0;i++)await Promise.resolve();
 assert.equal(sessionReads,1);assert.equal(maintenanceReads,1);assert.ok(h.alarm()>at&&h.alarm()<=at+1000);
 assert.ok(h.obj.sessionTask);assert.ok(h.obj.collectorTask);assert.equal(h.obj.alarmBusy,false);
 h.setTime(at+1000);h.obj.books[mk]=book(h.now());await h.obj.alarm();
 const captured=h.data.get('r:'+close).checks[300];assert.equal(captured.arrival.at-captured.at,1000);
 assert.equal(captured.arrival.depth.valid,true);assert.equal(sessionReads,1);assert.equal(maintenanceReads,1);
 assert.equal(h.data.get('collector').runs,2);
 // No later result can relabel the already-recorded research input.
 const frozen=structuredClone(captured);h.setTime(at+6000);release();await Promise.all(h.tasks);
 assert.deepEqual(h.data.get('r:'+close).checks[300],frozen);
 assert.equal(h.obj.sessionTask,null);assert.equal(h.obj.collectorTask,null);
});

test('alarm scheduling preserves earlier wakes and does not spin on in-flight session I/O',async()=>{
 const h=harness(),now=h.now()+10000;h.setTime(now);const S=h.context.BTC15Session,s=S.create(now-900000,'scheduling');
 s.nextLookAt=now-5000;await h.obj.saveSession(s);h.obj.sessionTask=Promise.resolve();h.obj.collectorTask=Promise.resolve();h.data.set('t:pending',{pendingPaper:{readyAt:now-1000}});
 await h.obj.scheduleAlarm();assert.ok(h.alarm()>now+100);
 await h.obj.state.storage.setAlarm(now+350);h.data.set('research.pending',[{readyAt:now+1000}]);
 await h.obj.scheduleAlarm();assert.equal(h.alarm(),now+350);
 h.obj.sessionTask=null;await h.obj.scheduleAlarm();assert.equal(h.alarm(),now+100);
 h.data.set('trade.cfg',{mode:'paper'});await h.obj.scheduleAlarm();assert.ok(Number.isFinite(h.alarm()));
 h.obj.sessionTask=Promise.resolve();h.data.set('research.pending',[]);await h.obj.state.storage.setAlarm(now-1);
 await h.obj.scheduleAlarm();assert.equal(h.alarm(),now+100);
});

test('background errors are observable and do not wedge the next session job or collector alarm',async()=>{
 const h=harness();let calls=0;h.obj.sessionTick=async()=>{calls++;throw Error('session fixture timeout');};
 h.obj.startSessionTask();h.obj.startSessionTask();await Promise.all(h.tasks);
 assert.equal(calls,1);assert.equal(h.obj.sessionTask,null);assert.equal(h.obj.sessionError.error,'session fixture timeout');
 h.obj.startSessionTask();await Promise.all(h.tasks);assert.equal(calls,2);assert.ok(h.alarm()>h.now());
 h.obj.collectorMaintenance=async()=>{throw Error('maintenance fixture timeout');};
 h.obj.startCollectorTask();await Promise.all(h.tasks);
 assert.equal(h.obj.collectorTask,null);assert.equal(h.data.get('collector').errors.at(-1).error,'maintenance fixture timeout');
});

test('legacy session cancellation persists before slow official outcome reads and exports retain attribution',async()=>{
 const h=harness(),S=h.context.BTC15Session,s=S.create(h.now()-900000,'old-session'),at=h.now();
 s.version='paper-session-v1';s.settings.model='brti-driftless-v3';delete s.settings.settlementConvention;
 s.looks=[{at:at-5000,p:.8,reason:'old observation'}];
 s.trades=[{id:'old-trade',mk:'OLD',close:at/1000-10,side:'Up',entryCents:50,entryFeeCents:2,pnlCents:null}];
 s.pending={action:'sell',mk:'OLD',close:at/1000-10,at:at-1000,readyAt:at,decision:{p:.2}};
 const old=structuredClone(s);await h.obj.saveSession(s);
 assert.deepEqual(structuredClone((await h.obj.loadSession()).looks),old.looks);assert.equal((await h.obj.loadSession()).stoppedAt,null);
 let release;const gate=new Promise(resolve=>release=resolve);h.context.read=async()=>{await gate;return {market:{result:'yes'}};};vm.runInContext('signedGet=read',h.context);
 const job=h.obj.sessionTick();for(let i=0;i<20&&!h.data.get('session.current').stoppedAt;i++)await Promise.resolve();
 const stopped=await h.obj.loadSession();assert.equal(stopped.status,'settling');assert.equal(stopped.pending,null);
 assert.equal(stopped.version,old.version);assert.deepEqual(stopped.settings,old.settings);assert.deepEqual(structuredClone(stopped.looks),old.looks);
 assert.match(stopped.stopReason,/incompatible session cohort/);assert.match(stopped.attempts[0].reason,/incompatible/);
 release();await job;const settled=await h.obj.loadSession();assert.equal(settled.status,'complete');assert.equal(settled.trades[0].resolution,'official settlement');
 assert.equal(settled.trades[0].model,undefined);assert.equal(settled.settings.model,'brti-driftless-v3');assert.deepEqual(structuredClone(settled.looks),old.looks);
});

test('a rejected stop save returns conflict instead of claiming the session stopped',async()=>{
 const h=harness(),s=h.context.BTC15Session.create(h.now(),'stop-conflict');await h.obj.saveSession(s);h.obj.env.FEED_TOKEN='unit-token';
 h.obj.saveSession=async()=>false;
 const response=await h.obj.fetch(new Request('https://test/paper-session/stop?token=unit-token',{method:'POST'}));
 assert.equal(response.status,409);assert.equal((await h.obj.loadSession()).stoppedAt,null);
});

test('official outcome reads preserve an arrival recorded while background settlement was awaiting I/O',async()=>{
 const h=harness(),close=1800000900,key='r:'+close;h.setTime((close+90)*1000);
 const row={schema:h.r.VERSION,model:h.context.BTC15Model.VERSION,mk:'OLD',close,checks:{60:fixtureCheck(h,close)},src:null,closingCapture:{complete:true}};
 delete row.checks[60].arrival;h.data.set(key,row);h.data.set('research.pending',[{key,check:60,readyAt:close*1000}]);h.obj.books.OLD=book(h.now());
 h.context.arriveDuringRead=async()=>h.obj.researchArrivals();
 vm.runInContext('signedGet=async()=>{await arriveDuringRead();return {market:{result:"yes",expiration_value:"101.23"}};}',h.context);
 await h.obj.researchSettle();const saved=h.data.get(key);
 assert.equal(saved.src,'kalshi');assert.equal(saved.officialCloseAvg,101.23);assert.equal(saved.checks[60].arrival.at,h.now());
});

test('starting v2 reconciles and archives a pending legacy session before replacing it',async()=>{
 const h=harness(),S=h.context.BTC15Session,s=S.create(h.now()-900000,'old-pending');
 s.version='paper-session-v1';s.settings.model='brti-driftless-v3';delete s.settings.settlementConvention;
 s.status='running';s.pending={action:'buy',at:h.now()-1000,readyAt:h.now(),mk:'OLD',close:h.now()/1000+900};
 await h.obj.saveSession(s);h.obj.env.FEED_TOKEN='unit-token';h.obj.ensureUpstream=async()=>{};
 const response=await h.obj.fetch(new Request('https://test/paper-session/start?token=unit-token',{method:'POST'}));
 assert.equal(response.status,200);const previous=h.data.get('session.previous');
 assert.equal(previous.version,'paper-session-v1');assert.equal(previous.settings.model,'brti-driftless-v3');
 assert.equal(previous.status,'complete');assert.equal(previous.pending,null);assert.equal(previous.stoppedAt,h.now());
 assert.equal(previous.attemptsCount,1);assert.match(h.data.get('se:old-pending:attempts:0')[0].reason,/incompatible session cohort/);
 assert.equal(h.data.get('session.current').version,'paper-session-v2');assert.equal(h.data.get('session.current').status,'scheduled');
});
