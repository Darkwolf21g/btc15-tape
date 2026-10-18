const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the actual page script with browser/network side effects disabled. No copies of the maths.
function page(savedRecord = []) {
  const nodes = new Map(), timers = [], saved = new Map();
  saved.set('btc15tape.record', JSON.stringify(savedRecord));
  let now = 3560000;
  class Clock extends Date { static now() { return now; } }
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', style: {}, dataset: {}, classList: {toggle() {}, contains() { return false; }},
      parentElement: {classList: {toggle() {}}, addEventListener() {}}, addEventListener() {},
      hidden: false, open: false, textContent: '',
    });
    return nodes.get(id);
  };
  const context = vm.createContext({
    Date: Clock, console, Intl, URL, AbortSignal, getComputedStyle() { return {getPropertyValue() { return "#888"; }}; }, setInterval() {}, clearTimeout() {},
    setTimeout(fn, ms) { timers.push({fn, ms}); return timers.length; },
    window: {addEventListener() {}}, navigator: {},
    document: {getElementById: node, addEventListener() {}},
    location: {protocol: 'https:', hostname: 'example.com', origin: 'https://example.com'},
    localStorage: {getItem: k => saved.get(k) || null, setItem: (k, v) => saved.set(k, v)},
    fetch: async () => { throw Error('No network in tests'); },
  });
  // Skip only startup: initialise all real declarations and event handlers.
  vm.runInContext(script.slice(0, script.indexOf('// ---------------------------------------------------------------- start')) + `
    const realRenderChips=renderChips,realDrawMain=drawMain;
    drawMain = drawFlow = drawProb = renderChips = renderFlowText = () => {};
    globalThis.api = {
      avgAt, project, windowSamples, captureProxyClose, settleWindow, settleOfficial,
      scoreRecord, recordLine, recordText, verdict, render, target, tickers, record,
      samples, backfill, venue, kalshi, pHist, feed, feedLive, officialSeconds, streamedFinalMinute, officialTrailing, trailingAverageStatus, acceptIndex, acceptOfficialMessage, acceptOfficialSnapshot, indexVols, decisionLine,
      setBasisValue(v, sd = 0.5) { basis = v; basisSrc = 'kalshi'; basisSd = sd; },
      setMarketResponse(market) { kalshiGet = async () => ({market}); },
      seedVol() { volN = 60; for (const row of vol) { row[0] = 4; row[1] = 1; } },
      setTarget(mk, value) { typedTarget[mk] = value; },
      drawMainActual:realDrawMain,refreshCollector,VENUES,connectFeed,renderChipsActual:realRenderChips,kalshiGet,pollExchange,onTrade,onLiq,flow,liqs,
    };
  `, context);
  const api = context.api;
  api.setBasisValue(0);
  return {api, node, timers, context, setTime: value => { now = value; }};
}

function fill(api, start, end, value = 100) {
  for (let s = start; s <= end; s++) api.samples.set(s, value);
}
test('invalid fast index values and trade amounts never poison the tape buffers',()=>{
 const h=page();h.api.acceptIndex(Infinity,3560000);assert.equal(h.api.feed.brti,null);
 h.api.onTrade('coinbase',{openedAt:0},100,Infinity,true,3560000);assert.equal(h.api.flow.size,0);
 h.api.onLiq('bybit',{openedAt:0},100,Infinity,true,3560000);assert.equal(h.api.liqs.length,0);
});
test('an inactive individual market suppresses tape buy signals even when the exchange is open',()=>{
 const h=readyPage(),{api,node}=h;api.acceptIndex(100,3560000);for(let t=3380;t<=3560;t++)api.officialSeconds.set(t,100);
 const mk=api.tickers(3600)[1];api.kalshi.market={ticker:mk,target:90,status:'inactive',at:3560000,bid:.29,ask:.3};
 vm.runInContext('exch.at=Date.now();exch.active=exch.trading=true;manualQuoteAt.Up=Date.now()',h.context);
 api.render();assert.match(node('vUp').textContent,/WAIT.*market/);assert.doesNotMatch(node('decision').textContent,/^Buy/);
});
test('tape market requests have a timeout signal',async()=>{
 const h=page(),requests=[];h.api.feed.token='fixture-secret';
 h.context.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({exchange_active:true,trading_active:true})};};
 await h.api.pollExchange();assert.ok(requests[0].options.signal);
});
test('relay error markup is displayed as text in source chips and their summary',()=>{
 const h=page();h.api.feed.state='open';h.api.feed.relay={hasKey:true,state:'off',error:'<img src=x onerror=alert(1)>'};
 h.api.renderChipsActual(3560000,h.api.tickers(3600)[1]);
 for(const id of ['sources','srcSum']){assert.doesNotMatch(h.node(id).innerHTML,/<img/);assert.match(h.node(id).innerHTML,/&lt;img/);}
});
test('fresh active contract status permits a signal and stale status pauses it',()=>{
 const h=readyPage(),{api,node}=h;api.acceptIndex(100,3560000);for(let t=3380;t<=3560;t++)api.officialSeconds.set(t,100);
 api.kalshi.market={ticker:api.tickers(3600)[1],target:90,status:'active',statusAt:3560000,at:3560000,bid:.29,ask:.3};
 vm.runInContext('exch.at=Date.now();exch.active=exch.trading=true;manualQuoteAt.Up=Date.now()',h.context);
 api.render();assert.match(node('vUp').textContent,/^Qualifies/);
 api.kalshi.market.statusAt-=30000;api.render();assert.match(node('vUp').textContent,/WAIT.*market/);
});
test('retired relay sockets cannot inject ticks and ticker-only updates cannot assert active market status',()=>{
 const h=page(),sockets=[];h.context.WebSocket=class{constructor(){this.readyState=1;sockets.push(this);}};
 h.api.connectFeed();sockets[0].readyState=3;h.api.connectFeed();
 const frame={type:'cfbenchmarks_value_5hz',msg:{index_id:'BRTI',value_usd:'100',source_ts_ms:3560000}};
 sockets[0].onmessage({data:JSON.stringify(frame)});assert.equal(h.api.feed.brti,null);
 sockets[1].onmessage({data:JSON.stringify(frame)});assert.equal(h.api.feed.brti.v,100);
 sockets[1].onmessage({data:JSON.stringify({type:'ticker',msg:{market_ticker:h.api.tickers(3600)[1],yes_bid_dollars:'.3',yes_ask_dollars:'.4'}})});
 assert.equal(h.api.kalshi.market.status,null);
});
test('all eleven venue parsers preserve quote, taker-side and liquidation conventions in fixtures',()=>{
 const h=page(),V=h.api.VENUES,at=3560000;
 const cases={coinbase:[{type:'ticker',best_bid:'99',best_ask:'101'},{type:'match',price:'100',size:'1',side:'sell',time:new Date(at).toISOString()}],
  kraken:[{channel:'ticker',data:[{bid:99,ask:101}]},{channel:'trade',type:'update',data:[{price:100,qty:1,side:'buy',timestamp:new Date(at).toISOString()}]}],
  bitstamp:[{event:'data',data:{bids:[[99,1]],asks:[[101,1]]}},{event:'trade',data:{price:100,amount:1,type:0,microtimestamp:at*1000}}],
  gemini:[{type:'update',events:[{type:'change',side:'bid',price:99,remaining:1},{type:'change',side:'ask',price:101,remaining:1}]},{type:'update',timestampms:at,events:[{type:'trade',price:100,amount:1,makerSide:'ask'}]}],
  cryptocom:[{result:{channel:'ticker',data:[{b:99,k:101}]}},{result:{channel:'trade',data:[{p:100,q:1,s:'BUY',t:at}]}}],
  hyperliquid:[{channel:'bbo',data:{bbo:[{px:99},{px:101}]}},{channel:'trades',data:[{coin:'BTC',px:100,sz:1,side:'B',time:at}]}]};
 for(const [key,frames]of Object.entries(cases)){
  const quotes=[],trades=[],st={};for(const frame of frames)V[key].msg(frame,(...q)=>quotes.push(q),{},st,(...t)=>trades.push(t));
  assert.deepEqual([...quotes[0]],[99,101],key);assert.deepEqual([...trades[0]],[100,1,true,at],key);
 }
 const liqs={bybit:{topic:'allLiquidation.BTCUSDT',data:[{p:100,v:1,S:'Buy',T:at}]},okx:{arg:{channel:'liquidation-orders'},data:[{instId:'BTC-USDT-SWAP',details:[{bkPx:100,sz:100,posSide:'long',ts:at}]}]},
  deribit:{method:'subscription',params:{data:[{liquidation:'T',direction:'sell',price:100,amount:100,timestamp:at}]}},bitmex:{table:'liquidation',action:'insert',data:[{symbol:'XBTUSD',price:100,leavesQty:100,side:'Sell'}]},binance:{e:'forceOrder',o:{s:'BTCUSDT',p:100,q:1,S:'SELL',T:at}}};
 for(const [key,frame]of Object.entries(liqs)){const rows=[];V[key].msg(frame,()=>{}, {},{},()=>{},(...row)=>rows.push(row));assert.deepEqual([...rows[0]].slice(0,3),[100,100,true],key);}
});
function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test('Worker and GitHub Pages serve identical page copies', () => {
  assert.equal(readFileSync(join(root, 'public/index.html'), 'utf8'), html);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('contract average includes start and excludes close while trailing diagnostic is unchanged', () => {
  const {api} = page();
  fill(api, 60, 120);
  api.samples.set(60, 0);
  assert.equal(api.avgAt(120), 100);
  const r = {close: 120, tgt: 99};
  api.captureProxyClose(r);
  assert.equal(r.proxyResult, 'no');
  assert.equal(r.proxySamples, 60);
  assert.equal(r.proxyConvention, '[close-60s,close)');
  assert.equal(r.result, undefined);
});

test('any missing reading prevents a final average, including a formerly accepted 54/60', () => {
  const {api} = page();
  fill(api, 60, 120);
  api.samples.delete(90);
  assert.equal(api.avgAt(120), null);
  for (let s = 91; s <= 95; s++) api.samples.delete(s);
  assert.equal(api.avgAt(120), null);
  const r = {close: 120, tgt: 99};
  api.captureProxyClose(r);
  assert.equal(r.closeAvg, null);
  assert.equal(r.proxyResult, null);
  assert.equal(r.proxySamples, 54);
  assert.equal(r.proxyMissing, 6);
});

test('elapsed gap pauses projection instead of replacing a missing sample with spot', () => {
  const {api} = page();
  fill(api, 60, 89);
  const r = api.project(90.5, 120, 500, {s: 2, l: 2}, []);
  assert.equal(r.mean, null);
  assert.equal(r.sd, null);
  assert.equal(r.observed, 30);
  assert.equal(r.missing, 1);
});

test('start boundary requires its reading; the final contract reading is one second before close', () => {
  const {api} = page();
  const before = api.project(59.5, 120, 100, {s: 2, l: 2}, []);
  assert.equal(before.observed, 0); assert.equal(before.m, 60); assert.equal(before.mean, 100);
  const absent = api.project(60, 120, 100, {s: 2, l: 2}, []);
  assert.equal(absent.missing, 1); assert.equal(absent.mean, null);
  fill(api, 60, 119); api.samples.set(60, 160); api.samples.set(120, 1000);
  const first = api.project(60, 120, 100, {s: 2, l: 2}, []);
  assert.equal(first.observed, 1); assert.equal(first.m, 59); assert.equal(first.mean, 101);
  const final = api.project(119, 120, 500, {s: 2, l: 2}, []);
  assert.equal(final.observed, 60); assert.equal(final.m, 0); assert.equal(final.mean, 101);
  assert.equal(api.project(120, 120, 999, {s: 2, l: 2}, []).mean, 101);
});

test('fractional last-second variance equals sigma squared times remaining time / 60 squared', () => {
  const {api} = page();
  fill(api, 60, 118);
  const r = api.project(118.75, 120, 100, {s: 2, l: 2}, []);
  near(r.sd ** 2 - 0.5 ** 2, 4 * 0.25 / 3600);
  assert.equal(r.observed, 59);
});

test('constant-volatility full-minute variance agrees with closed-form Brownian covariance', () => {
  const {api} = page();
  const r = api.project(59, 120, 100, {s: 2, l: 2}, []);
  near(r.sd ** 2 - 0.5 ** 2, 4 * (60 * 61 * 121 / 6) / 3600);
});

test('reconstructed trade samples are counted separately and never called official observations', () => {
  const {api} = page();
  fill(api, 60, 118);
  api.backfill.set(119, 160);
  const r = api.project(120, 120, 100, {s: 2, l: 2}, []);
  assert.equal(r.mean, 101);
  assert.equal(r.reconstructed, 1);
});

test('measured index-basis uncertainty is not capped at six dollars', () => {
  const {api} = page();
  api.setBasisValue(0, 30);
  fill(api, 60, 119);
  assert.equal(api.project(120, 120, 100, {s: 2, l: 2}, []).sd, 30);
});

test('late pre-close capture retries without using the closing tick or assigning an official result', () => {
  const {api, timers} = page();
  fill(api, 60, 118);
  const r = {close: 120, tgt: 99, result: null, src: null};
  api.settleWindow(r);
  assert.equal(r.closeAvg, null);
  api.samples.set(119, 100); api.samples.set(120, 999);
  timers.find(t => t.ms === 1200).fn();
  assert.equal(r.proxyResult, 'yes');
  assert.equal(r.result, null);
  assert.equal(r.src, null);
});

test('legacy proxy outcomes are retained as diagnostics and excluded from Brier and P&L', () => {
  const checks = {300: {model:"brti-driftless-v4",p: 0.9, p2: 0.8, bid: 0.4, ask: 0.6}};
  const buys = [{model:'brti-driftless-v4',side: 'Up', price: 50}];
  const {api} = page([
    {mk: 'proxy', close: 120, src: 'page', result: 'yes', checks, buys},
    {mk: 'official', close: 120, src: 'kalshi', result: 'no', checks, buys},
  ]);
  assert.equal(api.record.windows[0].result, null);
  assert.equal(api.record.windows[0].proxyResult, 'yes');
  const scores = api.scoreRecord();
  assert.equal(scores.settled, 1);
  near(scores.briers[300].model, 0.81);
  near(scores.briers[300].market, 0.25);
  assert.equal(scores.briers[300].matchedN, 1);
  assert.equal(scores.buys.length, 1);
  assert.equal(scores.buys[0].won, false);
});

test('official result overrides a contradictory proxy and stores official closing average', async () => {
  const {api} = page();
  const r = {mk: 'BTC', proxyResult: 'yes', closeAvg: 100, result: null, src: null};
  api.record.windows.push({...r, checks: {}, buys: []});
  api.setMarketResponse({result: 'no', floor_strike: 99, expiration_value: '98.45'});
  await api.settleOfficial(r);
  assert.equal(r.result, 'no');
  assert.equal(r.src, 'kalshi');
  assert.equal(r.officialCloseAvg, 98.45);
  assert.equal(r.proxyResult, 'yes');
});

test('pending official result stays unscored', async () => {
  const {api} = page();
  const r = {mk: 'BTC', result: null, src: null, close: 120, checks: {}, buys: []};
  api.record.windows.push(r);
  api.setMarketResponse({result: '', status: 'closed'});
  await api.settleOfficial(r);
  assert.equal(api.scoreRecord().settled, 0);
  assert.match(api.recordText(), /awaiting official result/);
});

function readyPage(missing = false) {
  const fixture = page(), {api, node} = fixture;
  const now = 3560, close = 3600;
  api.seedVol();
  fill(api, close - 60, now);
  if (missing) api.samples.delete(3550);
  for (const name of ['coinbase', 'kraken']) api.venue[name] = {
    mid: 100, offset: 0, at: now * 1000, changedAt: now * 1000, ws: {readyState: 1},
  };
  const mk = api.tickers(close)[1];
  api.setTarget(mk, 99);
  node('rhUp').value = '30';
  return fixture;
}

test('render shows WAIT and clears probability and buy indicators after an elapsed gap', () => {
  const {api, node} = readyPage();
  api.acceptIndex(100,3560000); for(let t=3380;t<=3560;t++) api.officialSeconds.set(t,100+Math.sin(t));
  api.render();
  assert.match(node('pBig').textContent, /%$/);
  api.samples.delete(3550); api.officialSeconds.delete(3550);
  api.render();
  assert.equal(node('pBig').textContent, 'WAIT');
  assert.equal(node('pBar').style.width, '0%');
  assert.equal(node('fairUp').textContent, 'Up –');
  assert.match(node('why').textContent, /INCOMPLETE/);
  assert.match(node('vUp').textContent, /WAIT/);
  assert.doesNotMatch(node('lvProjNote').textContent, /locked/);
});

test('estimated candle target cannot trigger buy calls', () => {
  const {api, node} = readyPage();
  api.acceptIndex(100,3560000); for(let t=3380;t<=3560;t++) api.officialSeconds.set(t,100+Math.sin(t));
  const mk = api.tickers(3600)[1];
  api.setTarget(mk, null);
  // Kalshi history is a target estimate, not a confirmed market strike.
  api.kalshi.feed.set(2699, 99);
  api.render();
  assert.match(node('pBig').textContent, /%$/);
  assert.match(node('vUp').textContent, /WAIT: enter or retrieve the exact target/);
});


test('source timestamps reject replayed index frames rather than freshening their age', () => {
  const {api}=page();
  assert.equal(api.acceptIndex(100,3550000),false);
  assert.equal(api.feedLive(),false);
  assert.equal(api.acceptIndex(100,3560000),true);
  assert.equal(api.feedLive(),true);
});
test('streamed final-minute diagnostic retains its documented close-inclusive count', () => {
  const {api,setTime}=page(); setTime(90500);
  api.feed.settle={v:100,n:29,end:89000,at:89000};
  assert.equal(api.streamedFinalMinute(120),null);
  api.feed.settle={v:100,n:30,end:90000,at:90000};
  assert.equal(api.streamedFinalMinute(120).n,30);
});
test('official model never fills a missing BRTI tick from exchange samples', () => {
  const {api,setTime}=page(); setTime(90500); fill(api,61,90,100);
  api.acceptIndex(100,90000);
  const p=api.project(90.5,120,100,{s:2,l:2},[]);
  assert.equal(p.mean,null); assert.equal(p.missing,31);
});
test('index volatility warms independently of exchange consensus', () => {
  const {api,setTime}=page(); setTime(100000);
  for(let t=60;t<=100;t++) api.officialSeconds.set(t,100+Math.sin(t));
  assert.ok(api.indexVols().s>0);
});
test('decision line uses the supplied manual quote and clears when model is paused', () => {
  const {api,node}=page();
  api.decisionLine(.8,{lo:.7,hi:.9},{call:'buy',worst:4},null,61,40,100);
  assert.match(node('decision').textContent,/61¢/);
  api.decisionLine(null,null,null,null,61,40,100);
  assert.equal(node('decision').textContent,'');
});

test('trailing BRTI average requires sixty readings and excludes current source second', () => {
  const {api}=page(); for(let t=40;t<100;t++) api.officialSeconds.set(t,100);
  api.officialSeconds.set(100,200);
  assert.equal(api.officialTrailing(100).v,100);
  api.officialSeconds.delete(99); assert.equal(api.officialTrailing(100),null);
});

test('exchange-only data cannot display probability or issue trade signals',()=>{const {api,node}=readyPage();api.render();assert.equal(node('pBig').textContent,'WAIT');assert.match(node('why').textContent,/official BRTI is unavailable/);assert.match(node('vUp').textContent,/WAIT/);assert.equal(api.pHist.size,0);});


test('BRTI average tile reports missing readings and never substitutes a complete exchange window', () => {
  const {api,node}=readyPage();
  fill(api, 3500, 3559, 999);
  api.acceptIndex(100,3560000);
  for(let s=3500;s<=3560;s++) api.officialSeconds.set(s,100);
  api.officialSeconds.delete(3530);
  api.render();
  assert.equal(node('lvAvg').textContent,'–');
  assert.match(node('lvAvgNote').textContent,/59\/60 readings/);
  assert.doesNotMatch(node('lvAvgNote').textContent,/proxy samples|Exchange proxy/);
});
test('BRTI trailing average stays anchored to its latest one-second tick while faster spot advances', () => {
  const {api,node,setTime}=readyPage();setTime(3561200);
  api.acceptIndex(1000,3561200);
  for(let s=3500;s<=3560;s++) api.officialSeconds.set(s,s===3560?999:100);
  const a=api.trailingAverageStatus();assert.equal(a.v,100);assert.equal(a.n,60);
  api.render();assert.equal(node('lvAvg').textContent,'$100.00');
  assert.match(node('lvAvgNote').textContent,/trailing, not final settlement/);
  setTime(3564000);assert.equal(api.trailingAverageStatus().v,null);
});
test('only a fresh complete BRTI aggregate can supply an average before local history warms', () => {
  const {api}=page();
  api.feed.avg60={v:101,n:60,end:3560000,at:3560000};
  assert.equal(api.trailingAverageStatus().v,101);
  api.feed.avg60.n=59;assert.equal(api.trailingAverageStatus().v,null);
  api.feed.avg60.n=60;api.feed.avg60.at=3550000;assert.equal(api.trailingAverageStatus().v,null);
  api.feed.avg60.at=3565000;api.feed.avg60.end=3565000;assert.equal(api.trailingAverageStatus().v,null);
});

test('late one-Hz observations repair a missing average without refreshing live spot', () => {
  const {api, setTime} = page(); const now = 1791811200000; setTime(now);
  api.acceptIndex(120, now);
  for(let i=0;i<=60;i++) if(i!==12) api.acceptOfficialMessage({index_id:'BRTI',data:JSON.stringify({time:now-i*1000,value:'100'})});
  assert.equal(api.trailingAverageStatus().v,null);
  api.acceptOfficialMessage({index_id:'BRTI',data:JSON.stringify({time:String(now-12000),value:'100'})});
  assert.equal(api.trailingAverageStatus().v,100);
  assert.equal(api.feed.brti.t,now); assert.equal(api.feed.brti.v,120);
});
test('relay snapshots hydrate the real one-Hz buffer without creating fresh spot or forecasts', () => {
  const {api}=page(); const now=3560000;
  const ticks=Array.from({length:61},(_,i)=>[now-i*1000,100]);
  api.acceptOfficialSnapshot({index_id:'BRTI',source:'cfbenchmarks_value_5hz',ticks});
  assert.equal(api.officialSeconds.size,0);
  api.acceptOfficialSnapshot({index_id:'BRTI',source:'cfbenchmarks_value',ticks:[...ticks,[now+10000,100],[now-1300000,100],[now-2000,Infinity]]});
  assert.equal(api.trailingAverageStatus().v,100); assert.equal(api.feed.brti,null); assert.equal(api.pHist.size,0);
  api.acceptOfficialMessage({index_id:'ETHUSD_RTI',data:JSON.stringify({time:now,value:200})});
  assert.equal(api.officialSeconds.get(now/1000),100);
});

test('brief newest-second publication delay keeps the display stable but disables signals and records', () => {
  const {api,node,setTime}=readyPage();
  api.acceptIndex(100,3560000); for(let t=3380;t<=3560;t++)api.officialSeconds.set(t,100+Math.sin(t));
  setTime(3560900);api.render();
  const prior=node('pBig').textContent, count=node('stIn').textContent;
  setTime(3561100);api.acceptIndex(100,3561100);api.render();
  assert.equal(node('pBig').textContent,prior);
  assert.equal(node('stIn').textContent,count);assert.equal(node('settle').hidden,false);
  assert.match(node('healthMode').textContent,/Awaiting next BRTI/);
  assert.match(node('lvProjNote').textContent,/awaiting next BRTI; estimate/);
  assert.match(node('vUp').textContent,/WAIT/);assert.match(node('vDown').textContent,/WAIT/);
  assert.match(node('decision').textContent,/trade signals paused/);
  assert.equal(api.pHist.has(3561),false);
  api.officialSeconds.set(3561,100);api.render();
  assert.doesNotMatch(node('healthMode').textContent,/Awaiting/);assert.equal(api.pHist.has(3561),true);
});
test('publication grace expires and does not hide real data gaps', () => {
  const {api,node,setTime}=readyPage();
  api.acceptIndex(100,3560000);for(let t=3380;t<=3560;t++)api.officialSeconds.set(t,100+Math.sin(t));
  setTime(3560900);api.render();setTime(3561100);api.render();
  assert.match(node('pBig').textContent,/%$/);
  setTime(3561800);api.render();assert.equal(node('pBig').textContent,'WAIT');
  assert.equal(node('settle').hidden,false);assert.equal(node('stAvg').textContent,'–');
  assert.match(node('lvProjNote').textContent,/BRTI readings/);
});
test('a held estimate cannot survive a change of target or contract window', () => {
  const {api,node,setTime}=readyPage();
  api.acceptIndex(100,3560000);for(let t=3380;t<=3560;t++)api.officialSeconds.set(t,100+Math.sin(t));
  setTime(3560900);api.render();setTime(3561100);
  api.setTarget(api.tickers(3600)[1],101);api.render();assert.equal(node('pBig').textContent,'WAIT');
  setTime(3600100);api.render();assert.equal(node('pBig').textContent,'WAIT');
  assert.equal(node('settle').hidden,true);
});

test('exchange health becomes unknown after failed checks or ninety seconds',()=>{
 const h=page();
 vm.runInContext('exch.at=Date.now();exch.active=true;exch.trading=true;exch.failed=false',h.context);
 assert.equal(vm.runInContext('exchangeHealth()',h.context),'open');
 vm.runInContext('exch.failed=true',h.context);assert.equal(vm.runInContext('exchangeHealth()',h.context),'unknown');
 vm.runInContext('exch.failed=false;exch.at=Date.now()-90000',h.context);assert.equal(vm.runInContext('exchangeHealth()',h.context),'unknown');
});


test('four public official settlements remain authoritative over contrary local diagnostics', async () => {
  const fixture = JSON.parse(readFileSync(join(__dirname,'fixtures/kxbtc15m-official-settlements.json'),'utf8'));
  for (const market of fixture.markets) {
    const {api} = page();
    const r = {mk:market.ticker,close:Date.parse(market.close_time)/1000,tgt:market.floor_strike,
      closeAvg:1,proxyResult:'yes',result:null,src:null,checks:{},buys:[]};
    api.record.windows.push(r); api.setMarketResponse(market);
    await api.settleOfficial(r);
    assert.equal(r.officialCloseAvg,Number(market.expiration_value));
    assert.equal(r.result,market.result); assert.equal(r.src,'kalshi');
    assert.equal(r.closeAvg,1); assert.equal(r.proxyResult,'yes');
  }
});
test('stream diagnostic still includes the close tick but cannot repair missing contract readings', () => {
  const {api,setTime}=page();setTime(120000);
  api.feed.settle={v:500,n:60,end:120000,at:120000};
  assert.equal(api.streamedFinalMinute(120).sum,30000);
  api.feed.brti={v:100,t:120000,at:120000};
  for(let s=61;s<=120;s++)api.officialSeconds.set(s,100);
  const pr=api.project(120,120,100,{s:2,l:2},[]);
  assert.equal(pr.mean,null);assert.equal(pr.observed,59);assert.equal(pr.missing,1);assert.equal(pr.m,0);
});
test('last pre-close reading completes the displayed contract count without claiming an official outcome', () => {
  const {api,node,setTime}=readyPage();setTime(3599100);
  api.acceptIndex(100,3599000);
  for(let t=3380;t<=3599;t++)api.officialSeconds.set(t,100);
  api.render();
  assert.equal(node('stIn').textContent,'60 / 60');assert.equal(node('stNeed').textContent,'–');
  assert.match(node('stInNote').textContent,/pre-close BRTI/);
  assert.doesNotMatch(node('lvProjNote').textContent,/Kalshi's own average/);
  assert.match(node('lvProjNote').textContent,/±0.30 model scale/);
  assert.equal(api.scoreRecord().settled,0);
});
test('current-version page scores exclude old model forecasts without rewriting them', () => {
  const old={mk:'old',close:120,src:'kalshi',result:'yes',closeAvg:101,checks:{300:{model:'brti-driftless-v3',p:.9,p2:.8,bid:.4,ask:.6}},buys:[]};
  const {api}=page([old]);const before=JSON.stringify(api.record.windows);
  assert.equal(api.scoreRecord().briers[300],null);
  api.captureProxyClose(api.record.windows[0]);
  assert.equal(JSON.stringify(api.record.windows),before);
});

test('first contract sample gets publication grace for display only, then resumes on receipt', () => {
  const {api,node,setTime}=readyPage();setTime(3539900);
  api.acceptIndex(100,3539000);
  for(let s=3360;s<=3539;s++)api.officialSeconds.set(s,100);
  api.render();const prior=node('pBig').textContent;assert.match(prior,/%$/);
  setTime(3540100);api.render();
  assert.equal(node('pBig').textContent,prior);assert.match(node('vUp').textContent,/WAIT/);
  assert.equal(api.pHist.has(3540),false);assert.match(node('healthMode').textContent,/Awaiting/);
  api.officialSeconds.set(3540,100);api.render();
  assert.equal(api.pHist.has(3540),true);assert.equal(node('stIn').textContent,'1 / 60');
});

test('collector health separates failed work, stalled maintenance and successful cycles using server time',async()=>{
 const h=page(),now=9000000;
 const show=async payload=>{h.context.fetch=async()=>({ok:true,json:async()=>({now,...payload})});await h.api.refreshCollector();return h.node('healthCollector');};
 let n=await show({lastOk:now-1000,lastCycleAt:now-500,cycleFailures:1,lastRun:now-500});
 assert.match(n.textContent,/degraded.*1 failed/);assert.equal(n.className,'bad');
 n=await show({lastOk:now-1000,maintenanceRunning:true,maintenanceStartedAt:now-20000});
 assert.match(n.textContent,/stalled/);assert.equal(n.className,'bad');
 n=await show({lastOk:now-1000,lastCycleAt:now-500,cycleFailures:0});
 assert.match(n.textContent,/active.*1s ago/);assert.equal(n.className,'good');
 n=await show({lastOk:now-300000,lastRun:now-1000});assert.match(n.textContent,/working.*5m ago/);assert.equal(n.className,'bad');
 n=await show({lastOk:now-300000,lastRun:now-300000});assert.match(n.textContent,/stale/);
});
test('tape exposes task errors as text, labels history after recovery and clears details when status is unavailable',async()=>{
 const h=page(),now=9000000,error={at:now-500,stage:'research settlement',error:'upstream 503 <img src=x onerror=alert(1)>'};
 let payload={now,lastOk:now-60000,lastCycleAt:now-500,lastRun:now-500,cycleFailures:1,cycleErrors:[error],errors:[error]};
 h.context.fetch=async()=>({ok:true,json:async()=>payload});await h.api.refreshCollector();
 assert.equal(h.node('collectorDetails').hidden,false);assert.match(h.node('healthCollector').textContent,/1 failed task ·/);
 assert.match(h.node('collectorErrorDetails').textContent,/research settlement: upstream 503 <img/);
 payload={...payload,lastOk:now,cycleFailures:0,cycleErrors:[]};await h.api.refreshCollector();
 assert.equal(h.node('healthCollector').className,'good');assert.match(h.node('collectorErrorDetails').textContent,/history \(latest run succeeded\)/);
 h.context.fetch=async()=>({ok:false,status:403,json:async()=>({})});await h.api.refreshCollector();
 assert.match(h.node('healthCollector').textContent,/token required/);assert.equal(h.node('collectorDetails').hidden,true);assert.equal(h.node('collectorErrorDetails').textContent,'');
});

test('official closing projection uses spot before the final minute and weights remaining readings without flow lean',()=>{
 const h=page(),a=h.api;a.feed.brti={v:160,t:90500};
 const vols={s:2,l:2};
 let p=a.project(59,120,160,vols,[[999,1]]);assert.equal(p.mean,160);assert.equal(p.observed,0);assert.equal(p.m,60);
 for(let sec=60;sec<=90;sec++)a.officialSeconds.set(sec,100);
 // Future stored ticks and experimental lean must not enter the forecast.
 for(let sec=91;sec<=120;sec++)a.officialSeconds.set(sec,1000);
 p=a.project(90.5,120,160,vols,[[999,1]]);
 near(p.mean,(31*100+29*160)/60);assert.equal(p.observed,31);assert.equal(p.m,29);
 a.officialSeconds.delete(80);assert.equal(a.project(90.5,120,160,vols,[]).mean,null);
 a.officialSeconds.set(80,100);
 for(let sec=91;sec<120;sec++)a.officialSeconds.set(sec,100);
 p=a.project(119.5,120,99999,vols,[]);assert.equal(p.mean,100);assert.equal(p.m,0);near(p.sd,.3);
});
test('closing-estimate chart renders endpoint scales without requiring a trailing average',()=>{
 const h=page(),rects=[],lines=[],arcs=[];let moves=[];
 const g=new Proxy({beginPath(){moves=[];},moveTo(...v){moves.push(v);},lineTo(...v){moves.push(v);},stroke(){lines.push(moves);},fillRect(...v){rects.push(v);},arc(...v){arcs.push(v);}}, {get:(o,k)=>k in o?o[k]:(()=>{})});
 h.context.chartContext=g;vm.runInContext('setupCanvas=()=>[chartContext,600,400]',h.context);
 h.api.drawMainActual(0,900,300,105,{mean:110,sd:5});
 // The 6px and 10px endpoint bars are present even without 60 historical readings.
 const outer=rects.find(r=>r[2]===6),inner=rects.find(r=>r[2]===10);assert.ok(outer);assert.ok(inner);
 near(outer[3],2*inner[3]);assert.ok(arcs.length);
 const centre=lines.find(line=>line.length===2&&line[0][1]===arcs[0][1]&&line[1][1]===arcs[0][1]);assert.ok(centre);
 // Both scales stay inside the chart's vertical plotting region.
 assert.ok(outer[1]>=10&&outer[1]+outer[3]<=378);
});
