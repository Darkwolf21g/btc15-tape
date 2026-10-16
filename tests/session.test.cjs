const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function h(){const c=vm.createContext({console});for(const f of ['shared-model.js','shared-research.js','shared-session.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),c);return {S:c.BTC15Session,R:c.BTC15Research,M:c.BTC15Model,context:c};}
const exchange={exchange_active:true,trading_active:true};
function quote(R,at,p=.8,yes=.4,no=.5,size=10){return {model:'brti-driftless-v4',settlementConvention:'[close-60s,close)',at,status:'forecast',p,marketStatus:'active',exchange,depth:R.depthSnapshot({at,sourceAt:at,yes:new Map([[yes,size]]),no:new Map([[no,size]])},at)};}
function setup(){const {S,R}=h(),s=S.create(1800000000100,'unit-fixture'),at=s.startAt,close=Math.ceil(at/900000)*900;return {S,R,s,at,close};}
test('session spans four complete windows, starts next quarter with publication grace',()=>{const {s}=setup();assert.equal(s.startAt%900000,750);assert.equal(s.endAt%900000,0);assert.equal(s.endAt-(s.startAt-750),3600000);});
test('entry at minute zero waits one second, uses arrival ask and charges actual fee',()=>{const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);assert.equal(s.pending.action,'buy');assert.equal(s.pending.limit,50);S.arrive(s,quote(R,at+999));assert.equal(s.trades.length,0);S.arrive(s,quote(R,at+1000,.8,.4,.52));assert.equal(s.trades.length,1);assert.equal(s.trades[0].entryCents,48);assert.equal(s.trades[0].entryFeeCents,2);S.arrive(s,quote(R,at+2000));assert.equal(s.trades.length,1);});
test('best current net-edge side can be NO and original buy limit cannot slide',()=>{const {S,R,s,at,close}=setup();S.decide(s,quote(R,at,.1),'TEST',close);assert.equal(s.pending.side,'Down');S.arrive(s,quote(R,at+1000,.1,.39,.5));assert.equal(s.trades.length,0);assert.match(s.attempts[0].reason,/original limit/);});
test('half-depth haircut, stale book, halted exchange and closed market all prevent fills',()=>{for(const variant of ['thin','stale','halt','closed']){const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);const k=quote(R,at+1000);if(variant==='thin')k.depth=quote(R,at+1000,.8,.4,.5,1.9).depth;if(variant==='stale')k.depth=R.depthSnapshot({at:at-3000,sourceAt:at-3000,yes:new Map([[.4,10]]),no:new Map([[.5,10]])},at+1000);if(variant==='halt')k.exchange={exchange_active:true,trading_active:false};if(variant==='closed')k.marketStatus='closed';S.arrive(s,k);assert.equal(s.trades.length,0,variant);}});
test('arrival later than four seconds never becomes a fill',()=>{const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);S.arrive(s,quote(R,at+4001));assert.equal(s.trades.length,0);assert.match(s.attempts[0].reason,/time/);});
test('early exit uses bid, original sell limit, two fees and actual proceeds',()=>{const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);S.arrive(s,quote(R,at+1000));S.decide(s,quote(R,at+5000,.5,.7,.2),'TEST',close);assert.equal(s.pending.action,'sell');assert.equal(s.pending.limit,70);S.arrive(s,quote(R,at+6000,.5,.72,.2));assert.equal(s.trades[0].exitCents,72);assert.equal(s.trades[0].pnlCents,18);assert.equal(S.report(s).feesCents,4);assert.equal(S.report(s).exitFills,1);});
test('deteriorated exit quote leaves position open rather than guaranteeing an exit',()=>{const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);S.arrive(s,quote(R,at+1000));S.decide(s,quote(R,at+5000,.5,.7,.2),'TEST',close);S.arrive(s,quote(R,at+6000,.5,.69,.2));assert.equal(s.trades[0].pnlCents,null);assert.equal(S.report(s).exitFills,0);});
test('hold decision, cadence and cooldown block repeated transactions',()=>{const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);S.arrive(s,quote(R,at+1000));S.decide(s,quote(R,at+2000),'TEST',close);assert.equal(s.looks.length,1);S.decide(s,quote(R,at+5000),'TEST',close);assert.match(s.looks.at(-1).reason,/hold/);S.decide(s,quote(R,at+10000,.5,.7,.2),'TEST',close);S.arrive(s,quote(R,at+11000,.5,.7,.2));S.decide(s,quote(R,at+15000),'TEST',close);assert.match(s.looks.at(-1).reason,/cooldown/);});
test('three attempted entries per window applies even if none fills',()=>{const {S,R,s,at,close}=setup();for(let i=0;i<4;i++){const t=at+i*30000;S.decide(s,quote(R,t),'TEST',close);if(s.pending)S.arrive(s,quote(R,t+1000,.8,.4,.49));}assert.equal(s.attempts.length,3);assert.match(s.looks.at(-1).reason,/cap/);});
test('manual stop cancels queued exit, leaves position for official outcome, survives serialization',()=>{let {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);S.arrive(s,quote(R,at+1000));S.decide(s,quote(R,at+5000,.5,.7,.2),'TEST',close);S.stop(s,at+5500,'manual stop');s=JSON.parse(JSON.stringify(s));S.arrive(s,quote(R,at+6000,.5,.7,.2));assert.equal(s.trades[0].pnlCents,null);assert.equal(s.status,'settling');S.settle(s,'TEST',null,close*1000+1000);assert.equal(s.trades[0].pnlCents,null);S.settle(s,'TEST','yes',close*1000+1000);assert.equal(s.trades[0].pnlCents,48);assert.equal(s.status,'complete');});
test('hard deadline cancels a pending entry even if alarm runs late after restart',()=>{let {S,R,s,at}=setup();const close=s.endAt/1000;S.decide(s,quote(R,s.endAt-5000),'TEST',close);assert.ok(s.pending);s=JSON.parse(JSON.stringify(s));S.arrive(s,quote(R,s.endAt+30000));assert.equal(s.status,'complete');assert.equal(s.trades.length,0);assert.equal(s.pending,null);assert.equal(S.due(s,s.endAt+30000),Infinity);});
test('no entry intent when full arrival interval will overlap close',()=>{const {S,R,s,close}=setup();S.decide(s,quote(R,close*1000-4000),'TEST',close);assert.equal(s.pending,null);assert.match(s.looks.at(-1).reason,/deadline/);});
test('settlement labels must be official, matching contract and after close',()=>{const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);S.arrive(s,quote(R,at+1000));for(const [mk,res,t]of [['OTHER','yes',close*1000+1],['TEST','yes',close*1000-1],['TEST','up',close*1000+1]])S.settle(s,mk,res,t);assert.equal(s.trades[0].pnlCents,null);S.settle(s,'TEST','no',close*1000+1);assert.equal(S.report(s).pnlCents,-52);assert.equal(S.report(s).drawdownCents,52);});
test('invalid forecasts and loss stop prevent entry; skipped decisions remain auditable',()=>{const {S,R,s,at,close}=setup();S.decide(s,{...quote(R,at),p:null,status:'missing settlement readings'},'TEST',close);s.trades.push({pnlCents:-301,exitAt:at});S.decide(s,quote(R,at+5000),'TEST',close);assert.equal(s.pending,null);assert.equal(s.looks.length,2);assert.match(s.looks.at(-1).reason,/loss stop/);});
test('unit fixture covers all 720 five-second look slots across four windows without making synthetic performance claims',()=>{const {S,R,s,at}=setup();for(let t=at;t<s.endAt;t+=5000){const close=(Math.floor(t/900000)+1)*900;S.decide(s,quote(R,t,.5),'TEST'+close,close);}S.clock(s,s.endAt);assert.equal(s.looks.length,720);assert.equal(s.trades.length,0);assert.equal(s.status,'complete');});

const copy=value=>JSON.parse(JSON.stringify(value));
test('coverage separates empty slots from evaluated skips and ignores the unfinished slot',()=>{
 const {S,R,s,at,close}=setup();
 S.decide(s,quote(R,at,.5),'TEST',close);
 S.decide(s,quote(R,at+30000,.5),'TEST',close);
 const before=JSON.stringify(s),r=S.report(s,at+31000),c=r.coverage;
 assert.equal(r.skippedDecisions,2);assert.equal(c.plannedSlots,720);
 assert.equal(c.elapsedSlots,6);assert.equal(c.observedSlots,1);assert.equal(c.missedSlots,5);
 assert.equal(c.maxEvaluationGapMs,30000);assert.equal(c.windows[0].missedSlots,5);
 assert.equal(JSON.stringify(s),before);
 S.stop(s,at+31000,'manual stop');const stopped=S.report(s,at+900000).coverage;
 assert.equal(stopped.elapsedSlots,7);assert.equal(stopped.observedSlots,2);assert.equal(stopped.missedSlots,5);
});
test('complete-hour coverage counts all windows and caps late stop at the durable deadline',()=>{
 const {S,R,s,at}=setup();
 assert.equal(S.report(s,at-1).coverage.elapsedSlots,0);
 for(let t=at;t<s.endAt;t+=5000)S.decide(s,quote(R,t,.5),'TEST'+t,(Math.floor(t/900000)+1)*900);
 S.clock(s,s.endAt+30000);const c=S.report(s,s.endAt+60000).coverage;
 assert.equal(c.elapsedSlots,720);assert.equal(c.observedSlots,720);assert.equal(c.missedSlots,0);assert.equal(c.fraction,1);
 assert.deepEqual(copy(c.windows.map(w=>w.observedSlots)),[180,180,180,180]);
});
test('duplicate looks do not conceal missing coverage and pre-start stop creates no missed slots',()=>{
 const {S,s,at}=setup();s.looks=[{at},{at:at+1000}];
 const c=S.report(s,at+10000).coverage;assert.equal(c.observedSlots,1);assert.equal(c.missedSlots,1);assert.equal(c.extraLooksInSameSlot,1);
 const other=setup();other.S.stop(other.s,other.at-1000,'manual stop');
 assert.equal(other.S.report(other.s,other.at+900000).coverage.elapsedSlots,0);
});
test('decision evidence and filled arrival latency survive serialization without inventing old fields',()=>{
 const {S,R,s,at,close}=setup(),k={...quote(R,at),p2:.85,target:101.23,targetAt:at-30,vols:{s:2,l:3},reads:{version:'session-reads-v1',startedAt:at-50,marketAt:at-30,exchangeAt:at-10}};
 S.decide(s,k,'TEST',close);S.arrive(s,{...quote(R,at+1092),reads:{version:'session-reads-v1',startedAt:at+1000}});
 const saved=copy(s),d=saved.attempts[0].decision;
 assert.equal(d.target,101.23);assert.equal(d.targetAt,at-30);assert.deepEqual(d.vols,{s:2,l:3});assert.equal(d.p2,.85);assert.equal(d.status,'forecast');assert.equal(d.reads.marketAt,at-30);
 assert.equal(saved.attempts[0].arrivalReads.startedAt,at+1000);assert.deepEqual(copy(S.report(saved,at+2000).fillDelayMs),{min:1092,mean:1092,max:1092});
});
function legacySession(){
 const {S,R,s,at,close}=setup();
 s.version='paper-session-v1';s.settings.model='brti-driftless-v3';delete s.settings.settlementConvention;
 s.status='running';s.nextLookAt=at+10000;s.lastEntryAt=at;s.entries.TEST=1;
 const first={at,mk:'TEST',close,p:.8,projection:{mean:102,sd:3,observed:0,m:60},reason:'buy intent',action:'buy',edgeCents:28};
 const exit={at:at+5000,mk:'TEST',close,p:.5,reason:'sell intent',action:'sell',edgeCents:18};
 s.looks=[first,exit];
 s.attempts=[{action:'buy',at,readyAt:at+1000,mk:'TEST',close,side:'Up',limit:50,p:.8,decision:first,arrivalAt:at+1000,filled:1,priceCents:50,feesCents:2,reason:'simulated fill'}];
 s.trades=[{id:s.id+':0',mk:'TEST',close,side:'Up',entryAt:at+1000,entryCents:50,entryFeeCents:2,pnlCents:null}];
 s.pending={action:'sell',side:'Up',limit:70,edgeCents:18,tradeId:s.trades[0].id,at:at+5000,readyAt:at+6000,mk:'TEST',close,p:.5,decision:exit};
 return {S,R,s:copy(s),at,close};
}

test('new session freezes the v4 settlement cohort without changing execution policy',()=>{
 const {S,s}=setup();
 assert.equal(S.VERSION,'paper-session-v2');assert.equal(s.version,S.VERSION);
 assert.equal(s.settings.model,'brti-driftless-v4');assert.equal(s.settings.settlementConvention,'[close-60s,close)');
 assert.equal(S.compatible(s),true);assert.equal(S.reconcile(s,s.startAt),false);
 assert.deepEqual(copy(s.settings),{durationMs:3600000,cadenceMs:5000,delayMs:1000,maxDelayMs:4000,depthFraction:.5,quantity:1,minEdgeCents:3,exitEdgeCents:3,maxEntriesPerWindow:3,cooldownMs:30000,lossStopCents:300,model:'brti-driftless-v4',settlementConvention:'[close-60s,close)',feeAssumption:'general Kalshi taker fee, rounded up per one-contract fill'});
});

test('legacy report and scheduling reads preserve serialized attribution before transition',()=>{
 const {S,s,at}=legacySession(),before=JSON.stringify(s),r=S.report(s);
 assert.equal(r.version,'paper-session-v1');assert.equal(r.model,'brti-driftless-v3');assert.equal(r.settlementConvention,null);
 assert.equal(r.compatible,false);assert.match(r.compatibilityReason,/incompatible session cohort/);
 assert.equal(S.active(s,at+5500),false);assert.equal(S.due(s,at+5500),at+5600);
 assert.equal(JSON.stringify(s),before);
});

test('upgrade cancels a legacy pending exit once, preserves all history, and only settles its open trade officially',()=>{
 let {S,R,s,at,close}=legacySession();const original=copy(s),upgradeAt=at+5500;
 assert.equal(S.reconcile(s,upgradeAt),true);
 assert.equal(s.version,original.version);assert.deepEqual(s.settings,original.settings);
 assert.deepEqual(s.looks,original.looks);assert.deepEqual(s.attempts.slice(0,1),original.attempts);assert.deepEqual(s.trades,original.trades);
 assert.equal(s.stoppedAt,upgradeAt);assert.equal(s.status,'settling');assert.equal(s.pending,null);
 assert.match(s.stopReason,/incompatible session cohort/);assert.match(s.stopReason,/brti-driftless-v3/);
 assert.equal(s.attempts.length,2);assert.equal(s.attempts[1].filled,0);assert.equal(s.attempts[1].reason,s.stopReason);
 assert.equal(s.attempts[1].model,'brti-driftless-v3');assert.equal(s.attempts[1].settlementConvention,null);
 assert.deepEqual(s.attempts[1].decision,original.pending.decision);
 s=copy(s);const transitioned=JSON.stringify(s);
 assert.equal(S.reconcile(s,upgradeAt+1000),false);S.clock(s,upgradeAt+2000);
 S.decide(s,quote(R,at+10000,.5,.7,.2),'TEST',close);S.arrive(s,quote(R,at+11000,.5,.7,.2));S.report(s);
 assert.equal(JSON.stringify(s),transitioned);
 for(const [mk,result,t]of [['OTHER','yes',close*1000+1],['TEST','yes',close*1000-1],['TEST',null,close*1000+1]])S.settle(s,mk,result,t);
 assert.equal(s.trades[0].pnlCents,null);
 S.settle(s,'TEST','yes',close*1000+1000);
 assert.equal(s.trades[0].pnlCents,48);assert.equal(s.trades[0].resolution,'official settlement');assert.equal(s.status,'complete');
 assert.equal(s.version,'paper-session-v1');assert.equal(s.settings.model,'brti-driftless-v3');assert.equal('model' in s.trades[0],false);
 assert.deepEqual(s.looks,original.looks);assert.equal(S.report(s).model,'brti-driftless-v3');
 const settled=JSON.stringify(s);S.clock(s,close*1000+2000);S.settle(s,'TEST','no',close*1000+3000);assert.equal(JSON.stringify(s),settled);
});

test('both decision and arrival entry points stop unchecked legacy sessions after deserialization',()=>{
 for(const method of ['decide','arrive']){
  const {S,R,s,at,close}=legacySession(),looks=copy(s.looks),trades=copy(s.trades);
  S[method](s,quote(R,at+6000,.5,.7,.2),'TEST',close);
  assert.equal(s.pending,null,method);assert.equal(s.status,'settling',method);assert.equal(s.attempts.length,2,method);
  assert.equal(s.attempts[1].filled,0);assert.match(s.stopReason,/incompatible session cohort/);
  assert.deepEqual(s.looks,looks);assert.deepEqual(s.trades,trades);
 }
});

test('legacy pending entry is cancelled without a fill and completed historical sessions remain unchanged',()=>{
 const {S,R,s,at}=legacySession();s.trades=[];s.pending.action='buy';delete s.pending.tradeId;
 S.arrive(s,quote(R,at+6000));assert.equal(s.status,'complete');assert.equal(s.trades.length,0);assert.equal(s.pending,null);
 const stopped=JSON.stringify(s);S.clock(s,at+7000);assert.equal(S.reconcile(s,at+8000),false);assert.equal(JSON.stringify(s),stopped);
 const old=legacySession().s;old.status='complete';old.pending=null;old.trades[0].pnlCents=48;old.trades[0].exitAt=at-1;
 const completed=JSON.stringify(old);assert.equal(S.reconcile(old,at+8000),false);S.report(old);assert.equal(JSON.stringify(old),completed);
});

test('session version, frozen model, and frozen interval are independently required',()=>{
 for(const change of [{version:'paper-session-v1'},{model:'brti-driftless-v3'},{settlementConvention:'(close-60s,close]'},{settlementConvention:undefined}]){
  const {S,R,s,at,close}=setup();
  if('version' in change)s.version=change.version;else Object.assign(s.settings,change);
  const settings=JSON.stringify(s.settings);S.decide(s,quote(R,at),'TEST',close);
  assert.equal(s.pending,null);assert.equal(s.looks.length,0);assert.equal(s.status,'complete');assert.equal(JSON.stringify(s.settings),settings);
  assert.match(s.stopReason,/incompatible session cohort/);
 }
});

test('new v4 look, pending intent, attempt and filled trade retain actual model and settlement attribution through restart',()=>{
 let {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);s=copy(s);
 assert.equal(S.compatible(s),true);assert.equal(S.reconcile(s,at+500),false);S.arrive(s,quote(R,at+1000));
 for(const r of [s.looks[0],s.attempts[0],s.attempts[0].decision,s.trades[0]]){
  assert.equal(r.sessionVersion,'paper-session-v2');assert.equal(r.model,'brti-driftless-v4');assert.equal(r.settlementConvention,'[close-60s,close)');
 }
 assert.equal(s.attempts[0].arrivalModel,'brti-driftless-v4');assert.equal(s.attempts[0].arrivalSettlementConvention,'[close-60s,close)');
 const report=S.report(s);assert.equal(report.compatible,true);assert.equal(report.compatibilityReason,null);assert.equal(report.model,'brti-driftless-v4');
 S.stop(s,at+2000,'manual stop');S.settle(s,'TEST','yes',close*1000+1);
 assert.equal(s.status,'complete');assert.equal(s.trades[0].model,'brti-driftless-v4');assert.equal(s.trades[0].pnlCents,48);
});

test('mismatched or unattributed decision snapshots cannot create intents and retain their original attribution',()=>{
 for(const change of [{model:'brti-driftless-v3'},{settlementConvention:'(close-60s,close]'},{model:undefined},{settlementConvention:undefined}]){
  const {S,R,s,at,close}=setup(),k={...quote(R,at),...change};
  S.decide(s,k,'TEST',close);assert.equal(s.pending,null);assert.equal(s.looks.length,1);assert.match(s.looks[0].reason,/snapshot model or settlement interval mismatch/);
  assert.equal(s.looks[0].model,k.model??null);assert.equal(s.looks[0].settlementConvention,k.settlementConvention??null);
  assert.equal(S.report(s).eligible,0);assert.equal(s.stoppedAt,null);
  S.decide(s,quote(R,at+5000),'TEST',close);assert.equal(s.pending.action,'buy');
 }
});

test('mismatched arrival snapshot cancels an attempt without relabeling its decision',()=>{
 for(const change of [{model:'brti-driftless-v3'},{settlementConvention:'(close-60s,close]'},{model:undefined},{settlementConvention:undefined}]){
  const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);const decision=copy(s.looks[0]);
  const k={...quote(R,at+1000),...change};S.arrive(s,k);
  assert.equal(s.pending,null);assert.equal(s.trades.length,0);assert.equal(s.attempts[0].filled,0);assert.match(s.attempts[0].reason,/snapshot model or settlement interval mismatch/);
  assert.equal(s.attempts[0].model,'brti-driftless-v4');assert.equal(s.attempts[0].settlementConvention,'[close-60s,close)');
  assert.equal(s.attempts[0].arrivalModel,k.model??null);assert.equal(s.attempts[0].arrivalSettlementConvention,k.settlementConvention??null);
  assert.deepEqual(copy(s.attempts[0].decision),decision);
 }
});

test('arrival rejects an incompatible persisted intent even when the session and arrival snapshot are current',()=>{
 for(const field of ['sessionVersion','model','settlementConvention']){
  const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);s.pending[field]='legacy';
  S.arrive(s,quote(R,at+1000));assert.equal(s.trades.length,0);assert.equal(s.attempts[0].filled,0);assert.match(s.attempts[0].reason,/intent model or settlement interval mismatch/);
 }
});

test('a current arrival still uses executable depth when its new forecast is unavailable',()=>{
 const {S,R,s,at,close}=setup();S.decide(s,quote(R,at),'TEST',close);
 S.arrive(s,{...quote(R,at+1000),p:null,status:'stale official index'});
 assert.equal(s.trades.length,1);assert.equal(s.attempts[0].reason,'simulated fill');
});

test('runtime model and interval changes stop current sessions before new decisions or delayed fills',()=>{
 for(const method of ['decide','arrive'])for(const change of [{VERSION:'brti-driftless-v3'},{SETTLEMENT_CONVENTION:'(close-60s,close]'}]){
  const {S,R,M,context}=h(),s=S.create(1800000000100,'runtime-fixture'),at=s.startAt,close=Math.ceil(at/900000)*900;
  if(method==='arrive')S.decide(s,quote(R,at),'TEST',close);
  context.BTC15Model={...M,...change};S[method](s,quote(R,at+1000),'TEST',close);
  assert.equal(s.pending,null);assert.equal(s.trades.length,0);assert.equal(s.status,'complete');assert.match(s.stopReason,/incompatible runtime model or settlement interval/);
  assert.equal(s.settings.model,'brti-driftless-v4');assert.equal(s.settings.settlementConvention,'[close-60s,close)');
 }
});

test('canonical v4 research snapshots drive attributed timed-session decisions and fills',()=>{
 const {S,R,s,at,close}=setup(),second=Math.floor(at/1000)*1000;
 const ticks=Array.from({length:902},(_,i)=>[second-(901-i)*1000,100,second-(901-i)*1000]);
 const capture=t=>R.snapshot({at:t,close,target:90,targetAt:at,ticks,book:{at:t,sourceAt:t,yes:new Map([[.4,10]]),no:new Map([[.5,10]])},marketStatus:'active',exchange});
 const k=capture(at);assert.equal(k.status,'forecast');assert.equal(k.model,s.settings.model);assert.equal(k.settlementConvention,s.settings.settlementConvention);
 S.decide(s,k,'TEST',close);assert.equal(s.pending.action,'buy');S.arrive(s,capture(at+1000));
 assert.equal(s.trades.length,1);assert.equal(s.trades[0].model,k.model);assert.equal(s.trades[0].settlementConvention,k.settlementConvention);
});
