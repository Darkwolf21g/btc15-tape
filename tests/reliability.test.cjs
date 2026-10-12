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
  vm.runInContext(source + '\nglobalThis.api = {KalshiFeed, projectFrom, volsFrom, parseTicks, calibrationReport, MODEL_VERSION, entry};', context);
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

test('collector exceptions become redacted diagnostic 503 responses',async()=>{
 const h=worker();const env={FEED:{idFromName:()=>1,get:()=>({fetch:async()=>{throw Error("Exceeded allowed volume of requests in Durable Objects SECRET");}})}};
 const response=await h.api.entry.fetch(new Request('https://test/collector/status'),env);const body=await response.json();
 assert.equal(response.status,503);assert.equal(body.error,'platform_limit');assert.ok(body.trace);assert.ok(!JSON.stringify(body).includes('SECRET'));assert.equal(response.headers.get('Retry-After'),'30');
});

test('background collection skips contract depth and only subscribes current market',()=>{
 const h=worker(),messages=[];h.obj.up={send:raw=>messages.push(JSON.parse(raw))};h.obj.subscribeTickers();
 assert.equal(messages.filter(m=>m.params.channels?.includes('orderbook_delta')).length,0);
 assert.equal(messages.find(m=>m.params.channels?.includes('ticker')).params.market_tickers.length,1);
 h.obj.clients.add({});h.obj.subscribeTickers();assert.equal(messages.filter(m=>m.params.channels?.includes('orderbook_delta')).length,1);
 h.obj.clients.clear();h.obj.tickerSid=2;h.obj.bookSid=3;h.obj.subscribeTickers();assert.equal(h.obj.depthSubscribed,false);assert.ok(messages.some(m=>m.cmd==='unsubscribe'));
});
test('paper agent retains depth with no phone connected',()=>{
 const h=worker(),messages=[];h.obj.agentActive=true;h.obj.up={send:raw=>messages.push(JSON.parse(raw))};h.obj.subscribeTickers();assert.ok(messages.some(m=>m.params.channels?.includes('orderbook_delta')));
});
