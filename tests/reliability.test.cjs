const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function worker() {
  let now = 1791811200000;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({Date: Clock, Intl, URL, Request, Response, AbortSignal, console, setTimeout: () => 1, clearTimeout() {}, TextEncoder, crypto: require('node:crypto').webcrypto});
  const source = fs.readFileSync(path.join(root, 'worker.js'), 'utf8').replace('export default {', 'const entry = {').replace('export class KalshiFeed', 'class KalshiFeed');
  vm.runInContext(source + '\nglobalThis.api = {KalshiFeed, projectFrom, volsFrom, parseTicks, calibrationReport, MODEL_VERSION, entry, paperReport, model:globalThis.BTC15Model};', context);
  const data = new Map(); let alarm = null;
  const storage = {get: async k => data.get(k), put: async (k, v) => data.set(k, structuredClone(v)), getAlarm: async () => alarm, setAlarm: async v => { alarm = v; }, list: async ({prefix}) => new Map([...data].filter(([k]) => k.startsWith(prefix))), delete: async k => data.delete(k)};
  const obj = new context.api.KalshiFeed({storage}, {KALSHI_KEY_ID: 'test', KALSHI_PRIVATE_KEY: 'test'});
  return {api: context.api, context, obj, data, storage, now, setTime(t) { now = t; }, getAlarm: () => alarm};
}
const ticks = (start, end, value = 100) => Array.from({length: end - start + 1}, (_, i) => [(start + i) * 1000, value]);
test('backend rejects any missing elapsed settlement reading', () => {
  const {api} = worker(); const p = api.projectFrom(ticks(61, 89), 90500, 120, 999, {s: 2, l: 2});
  assert.equal(p.mean, null); assert.equal(p.missing, 1);
});
test('backend final-minute boundaries exclude start and include closing tick', () => {
  const {api} = worker(); const t = ticks(60, 120); t[0][1] = 500; t.at(-1)[1] = 160;
  assert.equal(api.projectFrom(t, 120000, 120, 100, {s: 2, l: 2}).mean, 101);
});
test('delayed aggregate cannot silently shrink denominator below sixty', () => {
  const {api} = worker();
  const p = api.projectFrom([], 90500, 120, 100, {s: 2, l: 2}, {n: 29, v: 100, end: 89000});
  assert.equal(p.mean, null);
  const good = api.projectFrom([], 90500, 120, 110, {s: 2, l: 2}, {n: 30, v: 100, end: 90000});
  assert.equal(good.mean, 105); assert.equal(good.observed + good.m, 60);
});
test('partial-second variance is retained', () => {
  const {api} = worker(); const p = api.projectFrom(ticks(61,119),119500,120,100,{s:2,l:2});
  assert.ok(Math.abs(p.sd ** 2 - (0.09 + 2 / 3600)) < 1e-12);
});
test('watchdog repairs overdue alarms and reconnects without a browser', async () => {
  const h = worker(); let connects = 0; h.obj.ensureUpstream = async () => connects++;
  await h.storage.setAlarm(h.now - 120000); await h.obj.ensureAlarm();
  assert.equal(h.getAlarm(), h.now + 1000); assert.equal(connects, 1); assert.equal(h.obj.clients.size, 0);
});
test('alarm is rescheduled even when checkpoint request fails', async () => {
  const h = worker(); h.setTime(Math.floor(h.now / 900000) * 900000 + 300000);
  h.obj.ensureUpstream = async () => {};
  h.obj.checkpoint = async () => { throw Error('upstream timeout'); };
  await h.obj.alarm(); assert.ok(h.getAlarm() > Math.floor(h.now / 900000) * 900000 + 300000);
  assert.equal(h.data.get('collector').errors.at(-1).error, 'upstream timeout');
  assert.equal(h.obj.alarmBusy, false);
});
test('alarm retains one-Hz observations while trading stays off', async () => {
  const h = worker(); h.obj.ensureUpstream = async () => {}; h.obj.settleTrades = async () => {};
  h.obj.indexSeconds.set(h.now - 1000, 100); await h.obj.alarm();
  assert.equal(h.data.get('index.seconds')[0][1], 100); assert.equal((await h.obj.tradeConfig()).mode, 'off');
});
test('five-Hz ticks never become official one-Hz settlement observations', () => {
  const h = worker(); h.obj.onUpstream(JSON.stringify({type:'cfbenchmarks_value_5hz',msg:{index_id:'BRTI',source_ts_ms:h.now,value_usd:'100'}}));
  assert.equal(h.obj.ticks.length,1); assert.equal(h.obj.indexSeconds.size,0);
  h.obj.onUpstream(JSON.stringify({type:'cfbenchmarks_value',msg:{index_id:'BRTI',data:JSON.stringify({time:h.now,value:'100'})}}));
  assert.equal(h.obj.indexSeconds.size,1);
});
test('replayed, future and invalid ticks do not refresh model data', () => {
  const h = worker(); h.obj.pushTick(h.now - 10000,100); h.obj.pushTick(h.now + 2000,100); h.obj.pushTick(h.now,Infinity);
  assert.equal(h.obj.ticks.length,0); h.obj.pushTick(h.now,100); h.obj.pushTick(h.now,101); assert.equal(h.obj.ticks.length,1);
});
test('live checkpoint saves immutable forecast without history request', async () => {
  const h=worker(); const close=Math.floor(h.now/900000)*900+900; const now=(close-300)*1000; h.setTime(now);
  h.obj.ticks=ticks(now/1000-180,now/1000).map(([t,v],i)=>[t,v+Math.sin(i)]);
  vm.runInContext('signedGet = async (env, path) => { if (!path.includes("/markets/")) throw Error("unneeded history"); return {market:{floor_strike:100,yes_bid_dollars:"0.48",yes_ask_dollars:"0.52"}}; };',h.context);
  h.obj.indexSeconds=new Map(h.obj.ticks);
  await h.obj.checkpoint('TEST',close,300,now); const first=structuredClone(h.data.get('w:TEST').checks[300]);
  assert.equal(first.status,'forecast'); assert.ok(Number.isFinite(first.p));
  h.obj.ticks=[]; await h.obj.checkpoint('TEST',close,300,now+1000); assert.deepEqual(h.data.get('w:TEST').checks[300],first);
});
test('stale checkpoint explicitly records reason and no probability', async () => {
  const h=worker(); vm.runInContext('signedGet = async (env,path) => path.includes("/markets/") ? {market:{floor_strike:100}} : {data:{payload:[]}};',h.context);
  await h.obj.checkpoint('TEST',h.now/1000+300,300,h.now);
  assert.equal(h.data.get('w:TEST').checks[300].status,'stale index'); assert.equal(h.data.get('w:TEST').checks[300].p,undefined);
});
test('calibration separates model versions and holds out whole newest windows', () => {
  const {api}=worker(); const rows=Array.from({length:6},(_,i)=>({close:1000+i,result:'yes',src:'kalshi',checks:{300:{model:api.MODEL_VERSION,p:.6,p2:.7,bid:.5,ask:.6,at:1}}}));
  rows.push({close:2000,result:'yes',src:'page',checks:rows[0].checks});
  const r=api.calibrationReport(rows); assert.equal(r.settledWindows,6); assert.equal(r.holdoutWindows,2); assert.equal(r.scores[300].n,2); assert.equal(r.autoPromotion,false);
});
test('trade controls reject unsafe numeric settings without persisting', async () => {
  const h=worker(); h.obj.env.FEED_TOKEN='test';
  const r=await h.obj.fetch(new Request('https://internal/trade/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({perWindowCents:-1})}));
  assert.equal(r.status,400); assert.equal(h.data.has('trade.cfg'),false);
});
test('settlement P&L uses actual fill cost, not limit price', async () => {
  const h=worker(); h.data.set('t:TEST',{trades:[{filled:2,price:60,cost:110,feesCents:2,side:'Up'}]});
  vm.runInContext('signedGet = async () => ({market:{result:"yes"}});',h.context);
  await h.obj.settleTrades('TEST',h.now/1000); assert.equal(h.data.get('t:TEST').trades[0].pnlCents,88);
});
test('agent page mirror and inline JavaScript remain valid', () => {
  const html=fs.readFileSync(path.join(root,'agent.html'),'utf8'); assert.equal(html,fs.readFileSync(path.join(root,'public/agent.html'),'utf8'));
  assert.doesNotThrow(()=>new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});
test('a missing order-book sequence invalidates depth and reconnects',()=>{
 const h=worker();h.obj.books.TEST={yes:new Map(),no:new Map(),at:h.now};h.obj.bookSequence=10;
 let retried=false;h.obj.retry=()=>{retried=true;};
 h.obj.onUpstream(JSON.stringify({type:'orderbook_delta',seq:12,msg:{market_ticker:'TEST',side:'yes',price_dollars:'0.5',delta_fp:'1'}}));
 assert.equal(Object.keys(h.obj.books).length,0);assert.equal(retried,true);
});

test('paper fills wait, preserve the limit, haircut depth and retain fractional cents', () => {
 const h=worker(),m=h.api.model, cfg={paperBookMaxAgeMs:1500,paperDepthFraction:.5,paperVenue:'kalshi'};
 const intent={at:1000,readyAt:2000,close:60,side:'Up',n:10,price:40.1};
 const book={at:2000,no:new Map([[.599,6],[.59,100]]),yes:new Map()};
 assert.equal(m.paperFill(intent,book,1999,cfg),null);
 const f=m.paperFill(intent,book,2000,cfg);
 assert.equal(f.filled,3);assert.equal(f.cost,120.3);assert.equal(f.status,'paper-partial');assert.equal(f.latencyMs,1000);
 assert.equal(m.paperFill(intent,{...book,at:0},2000,cfg).filled,0);
 assert.equal(m.paperFill(intent,{...book,no:new Map([[.59,100]])},2000,cfg).filled,0);
 assert.match(m.paperFill(intent,book,12001,cfg).reason,/checkpoint missed/);
 assert.match(m.paperFill(intent,book,60000,cfg).reason,/closed/);
});
test('fee scenarios charge quantity-based commissions and separate exchange costs',()=>{
 const m=worker().api.model;
 assert.equal(m.feesCents(50,100,'kalshi'),175);
 assert.equal(m.feesCents(90,100,'robinhood-gold',1),145);
 assert.equal(m.feesCents(90,100,'robinhood',1),190);
});
function pendingFixture() {
 const h=worker();h.obj.up={};h.data.set('t:TEST',{mk:'TEST',close:h.now/1000+60,trades:[],pendingPaper:{at:h.now-1000,readyAt:h.now,close:h.now/1000+60,side:'Up',price:40,n:10,mode:'paper',model:h.api.MODEL_VERSION,executionModel:h.api.model.EXECUTION_VERSION,cfg:{paperBookMaxAgeMs:1500,paperDepthFraction:.5,paperVenue:'kalshi'}}});
 h.obj.books.TEST={at:h.now,no:new Map([[.6,8]]),yes:new Map()};
 vm.runInContext('signedCall=async()=>{throw Error("portfolio API must not be called")};signedGet=async(env,path)=>path.includes("exchange/status")?{exchange_active:true,trading_active:true}:{market:{status:"active",result:"yes"}};',h.context);return h;
}
test('paper arrival persists partial fills once and settlement uses their actual cost',async()=>{
 const h=pendingFixture();assert.equal(await h.obj.processPaper(h.now,{mode:'paper'}),true);
 assert.equal(await h.obj.processPaper(h.now,{mode:'paper'}),false);
 const w=h.data.get('t:TEST');assert.equal(w.trades.length,1);assert.equal(w.trades[0].filled,4);assert.equal(w.pendingPaper,null);
 await h.obj.settleTrades('TEST',w.close);assert.equal(h.data.get('t:TEST').trades[0].pnlCents,233);
});
test('exchange halt or stopping paper cancels executable-looking depth',async()=>{
 const h=pendingFixture();vm.runInContext('signedGet=async()=>({exchange_active:false,market:{status:"active"}})',h.context);
 await h.obj.processPaper(h.now,{mode:'paper'});assert.equal(h.data.get('t:TEST').trades[0].filled,0);
 const stopped=pendingFixture();await stopped.obj.processPaper(stopped.now,{mode:'off'});assert.equal(stopped.data.get('t:TEST').trades[0].status,'paper-canceled');
});
test('research release rejects exchange modes and malformed settings',async()=>{
 const h=worker();h.obj.env.FEED_TOKEN='test';h.data.set('trade.cfg',{mode:'live'});assert.equal((await h.obj.tradeConfig()).mode,'off');
 for(const body of [{mode:'demo'},{mode:'live'},{paperDelayMs:'bad'},{paperDepthFraction:0}]) {
 const r=await h.obj.fetch(new Request('https://internal/trade/config',{method:'POST',body:JSON.stringify(body)}));assert.equal(r.status,400);
 }
});
test('paper report excludes legacy models and separates simulation settings',()=>{
 const h=worker(),base={mode:'paper',model:h.api.MODEL_VERSION,executionModel:h.api.model.EXECUTION_VERSION,filled:1,feesCents:2,pnlCents:10,latencyMs:1000};
 const rows=[{close:1,settled:true,trades:[{...base,paperSettings:{paperDelayMs:1000}}]},{close:2,settled:true,trades:[{...base,pnlCents:-20,paperSettings:{paperDelayMs:2000}},{...base,model:'old'}]}];
 const r=h.api.paperReport(rows);assert.equal(r.attempts,2);assert.equal(r.scenarios.length,2);assert.equal(r.pnlCents,-10);assert.equal(r.maxDrawdownCents,20);assert.equal(r.readyForLive,false);
});

test('collector exceptions become redacted diagnostic 503 responses',async()=>{
 const h=worker();const env={FEED:{idFromName:()=>1,get:()=>({fetch:async()=>{throw Error("daily storage limit exceeded SECRET");}})}};
 const response=await h.api.entry.fetch(new Request('https://test/collector/status'),env);const body=await response.json();
 assert.equal(response.status,503);assert.equal(body.error,'platform_limit');assert.ok(body.trace);assert.ok(!JSON.stringify(body).includes('SECRET'));assert.equal(response.headers.get('Retry-After'),'30');
});
