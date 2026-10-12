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
    Date: Clock, console, Intl, URL, setInterval() {}, clearTimeout() {},
    setTimeout(fn, ms) { timers.push({fn, ms}); return timers.length; },
    window: {addEventListener() {}}, navigator: {},
    document: {getElementById: node, addEventListener() {}},
    location: {protocol: 'https:', hostname: 'example.com', origin: 'https://example.com'},
    localStorage: {getItem: k => saved.get(k) || null, setItem: (k, v) => saved.set(k, v)},
    fetch: async () => { throw Error('No network in tests'); },
  });
  // Skip only startup: initialise all real declarations and event handlers.
  vm.runInContext(script.slice(0, script.indexOf('// ---------------------------------------------------------------- start')) + `
    drawMain = drawFlow = drawProb = renderChips = renderFlowText = () => {};
    globalThis.api = {
      avgAt, project, windowSamples, captureProxyClose, settleWindow, settleOfficial,
      scoreRecord, recordLine, recordText, verdict, render, target, tickers, record,
      samples, backfill, venue, kalshi, pHist, feed, feedLive, officialSeconds, officialSettle, officialTrailing, acceptIndex, indexVols, decisionLine,
      setBasisValue(v, sd = 0.5) { basis = v; basisSrc = 'kalshi'; basisSd = sd; },
      setMarketResponse(market) { kalshiGet = async () => ({market}); },
      seedVol() { volN = 60; for (const row of vol) { row[0] = 4; row[1] = 1; } },
      setTarget(mk, value) { typedTarget[mk] = value; },
    };
  `, context);
  const api = context.api;
  api.setBasisValue(0);
  return {api, node, timers, setTime: value => { now = value; }};
}

function fill(api, start, end, value = 100) {
  for (let s = start; s <= end; s++) api.samples.set(s, value);
}
function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test('Worker and GitHub Pages serve identical page copies', () => {
  assert.equal(readFileSync(join(root, 'public/index.html'), 'utf8'), html);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('final average excludes start and includes close; boundary can change the outcome', () => {
  const {api} = page();
  fill(api, 60, 120);
  api.samples.set(60, 0);
  assert.equal(api.avgAt(120), 100);
  const r = {close: 120, tgt: 99};
  api.captureProxyClose(r);
  assert.equal(r.proxyResult, 'yes');
  assert.equal(r.proxySamples, 60);
  assert.equal(r.result, undefined);
});

test('any missing reading prevents a final average, including a formerly accepted 54/60', () => {
  const {api} = page();
  fill(api, 61, 120);
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
  fill(api, 61, 89);
  const r = api.project(90.5, 120, 500, {s: 2, l: 2}, []);
  assert.equal(r.mean, null);
  assert.equal(r.sd, null);
  assert.equal(r.observed, 29);
  assert.equal(r.missing, 1);
});

test('start boundary has zero elapsed samples, close has all 60', () => {
  const {api} = page();
  const initial = api.project(60, 120, 100, {s: 2, l: 2}, []);
  assert.equal(initial.observed, 0);
  assert.equal(initial.missing, 0);
  assert.equal(initial.mean, 100);
  fill(api, 61, 120);
  api.samples.set(120, 160);
  assert.equal(api.project(120, 120, 500, {s: 2, l: 2}, []).mean, 101);
});

test('fractional last-second variance equals sigma squared times remaining time / 60 squared', () => {
  const {api} = page();
  fill(api, 61, 119);
  const r = api.project(119.75, 120, 100, {s: 2, l: 2}, []);
  near(r.sd ** 2 - 0.5 ** 2, 4 * 0.25 / 3600);
  assert.equal(r.observed, 59);
});

test('constant-volatility full-minute variance agrees with closed-form Brownian covariance', () => {
  const {api} = page();
  const r = api.project(60, 120, 100, {s: 2, l: 2}, []);
  near(r.sd ** 2 - 0.5 ** 2, 4 * (60 * 61 * 121 / 6) / 3600);
});

test('reconstructed trade samples are counted separately and never called official observations', () => {
  const {api} = page();
  fill(api, 61, 119);
  api.backfill.set(120, 160);
  const r = api.project(120, 120, 100, {s: 2, l: 2}, []);
  assert.equal(r.mean, 101);
  assert.equal(r.reconstructed, 1);
});

test('measured index-basis uncertainty is not capped at six dollars', () => {
  const {api} = page();
  api.setBasisValue(0, 30);
  fill(api, 61, 120);
  assert.equal(api.project(120, 120, 100, {s: 2, l: 2}, []).sd, 30);
});

test('closing-tick capture waits for onSecond and never assigns a proxy as the official result', () => {
  const {api, timers} = page();
  fill(api, 61, 119);
  const r = {close: 120, tgt: 99, result: null, src: null};
  api.settleWindow(r);
  assert.equal(r.closeAvg, null);
  api.samples.set(120, 100);
  timers.find(t => t.ms === 1200).fn();
  assert.equal(r.proxyResult, 'yes');
  assert.equal(r.result, null);
  assert.equal(r.src, null);
});

test('legacy proxy outcomes are retained as diagnostics and excluded from Brier and P&L', () => {
  const checks = {300: {p: 0.9, p2: 0.8, bid: 0.4, ask: 0.6}};
  const buys = [{side: 'Up', price: 50}];
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
  fill(api, close - 59, now);
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
  api.render();
  assert.match(node('pBig').textContent, /%$/);
  api.samples.delete(3550);
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
test('official aggregate must contain exactly the elapsed number of seconds', () => {
  const {api,setTime}=page(); setTime(90500);
  api.feed.settle={v:100,n:29,end:89000,at:89000};
  assert.equal(api.officialSettle(120),null);
  api.feed.settle={v:100,n:30,end:90000,at:90000};
  assert.equal(api.officialSettle(120).n,30);
});
test('official model never fills a missing BRTI tick from exchange samples', () => {
  const {api,setTime}=page(); setTime(90500); fill(api,61,90,100);
  api.acceptIndex(100,90000);
  const p=api.project(90.5,120,100,{s:2,l:2},[]);
  assert.equal(p.mean,null); assert.equal(p.missing,30);
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
