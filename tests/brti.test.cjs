const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const context = vm.createContext({});
vm.runInContext(readFileSync(join(root, 'shared-brti.js'), 'utf8'), context);
const R = context.BTC15Replica;
const now = 1_000_000;
const book = (bids, asks, at = now) => ({bids, asks, at});
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('page embeds the canonical replica source', () => {
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  const src = readFileSync(join(root, 'shared-brti.js'), 'utf8').trimEnd();
  assert.ok(html.includes('// BEGIN SHARED BTC15 REPLICA\n' + src + '\n// END SHARED BTC15 REPLICA'));
});

test('weighted mid over the grid matches the discrete exponential sum by hand', () => {
  // One book: bids 99 x1, 97 x1; asks 101 x1, 102 x1. Cap = 1 (all sizes equal).
  // Spacing = min(2/100, kde(n<4 -> smallest size 1)) = 0.02; grid 0.02..2.00 (100 points).
  const r = R.calculate({a: book([[99, 1], [97, 1]], [[101, 1], [102, 1]])}, now);
  close(r.cap, 1); close(r.spacing, 0.02); assert.equal(r.points, 100); assert.equal(r.depthLimited, true);
  const s = 0.02, vT = 2, lambda = 1 / (0.3 * vT);
  let sum = 0, w = 0;
  for (let i = 1; i <= 100; i++) { const v = i * s, mid = v <= 1 + 1e-9 ? 100 : 99.5, e = Math.exp(-lambda * v); sum += e * mid; w += e; }
  close(r.value, sum / w, 1e-9);
  assert.ok(r.value > 99.75 && r.value < 100, 'front of the book carries more weight');
  assert.equal(r.rounded, Math.round(r.value * 100) / 100);
});

test('utilized depth stops at the 5% mid-spread band when the books are deep enough', () => {
  const bids = [[100, 1], [90, 1], [50, 1]], asks = [[101, 1], [120, 1], [200, 1]];
  const r = R.calculate({a: book(bids, asks)}, now);
  // Spacing 3/100 = 0.03. v<=1: ask 101 / mid 100.5 - 1 = 0.5%; v>1: 120 / 105 - 1 = 14% > D.
  // The last grid point within the band is 33 x 0.03 = 0.99.
  close(r.spacing, 0.03);
  assert.equal(r.depthLimited, false);
  close(r.vT, 0.99, 1e-9);
  close(r.value, 100.5, 1e-9);
});

test('consolidated book is capped and then uncrossed across exchanges', () => {
  const r = R.calculate({
    a: book([[101, 2]], [[102, 1], [103, 1]]),
    b: book([[99, 1], [98, 1]], [[100, 1]]),
  }, now);
  assert.deepEqual([...r.used].sort(), ['a', 'b']);
  // Crossed 101 bid x2 against 100 ask x1: one unit removed from each side.
  const u = R.uncross([[101, 2], [99, 1]], [[100, 1], [102, 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(u)), {bids: [[101, 1], [99, 1]], asks: [[102, 1]]});
  assert.ok(Number.isFinite(r.value));
});

test('order size cap clips an outsized level using trimmed mean and winsorized deviation', () => {
  const bids = Array.from({length: 100}, (_, i) => [1000 - i, 1]);
  const asks = Array.from({length: 100}, (_, i) => [1001 + i, i === 0 ? 1000 : 1]);
  const cap = R.sizeCap(bids, asks);
  close(cap, 1);                                    // the 1000 is winsorized away (k = 2 per tail)
  const r = R.calculate({a: book(bids, asks)}, now);
  close(r.cap, 1);
});

test('kernel density mode picks the most common level size', () => {
  const sizes = [0.1, 0.1, 0.1, 0.1, 0.1, 0.5, 2, 3, 0.11, 0.09];
  close(R.kdeMode(sizes), 0.1, 0.02);
  assert.equal(R.kdeMode([3, 2]), 2);
});

test('delayed, crossed, one-sided and unparseable books are excluded', () => {
  const good = book([[99, 1]], [[101, 1]]);
  const r = R.calculate({
    good, old: book([[99, 1]], [[101, 1]], now - 10001), crossed: book([[102, 1]], [[101, 1]]),
    empty: book([], [[101, 1]]), junk: {at: now}, bad: book([[NaN, 1], [-1, 1], [99, 0]], [[101, 1]]),
  }, now);
  assert.deepEqual([...r.used], ['good']);
  assert.equal(r.excluded.old, 'delayed'); assert.equal(r.excluded.crossed, 'crossed');
  assert.equal(r.excluded.empty, 'one-sided'); assert.equal(r.excluded.junk, 'unparseable');
  assert.equal(r.excluded.bad, 'one-sided');
  close(r.value, 100);
  const kept = R.calculate({x: book([[99, 1]], [[101, 1]], now - 10000)}, now);
  assert.deepEqual([...kept.used], ['x']);   // exactly 10 s old is still within the lag threshold
});

test('a book far from the median is excluded until it returns within half the threshold', () => {
  const at = mid => book([[mid - 1, 1]], [[mid + 1, 1]]);
  let r = R.calculate({a: at(100), b: at(100), c: at(106)}, now);
  assert.equal(r.excluded.c, 'potentially erroneous');
  r = R.calculate({a: at(100), b: at(100), c: at(103)}, now, r.state);
  assert.equal(r.excluded.c, 'potentially erroneous', '3% is inside 5% but outside the 2.5% reinstatement');
  r = R.calculate({a: at(100), b: at(100), c: at(102)}, now, r.state);
  assert.ok(r.used.includes('c'));
  r = R.calculate({a: at(100), b: at(100), c: at(103)}, now, r.state);
  assert.ok(r.used.includes('c'), 'an included book stays in until it breaches 5%');
});

test('no usable books produces no value', () => {
  const r = R.calculate({a: book([[99, 1]], [[101, 1]], now - 20000)}, now);
  assert.equal(r.value, null); assert.equal(r.reason, 'no usable books');
});

test('tracking finds how far ahead of the official receipt the replica moves', () => {
  const replica = [], official = [];
  const path = t => 60000 + 50 * Math.sin(t / 3000) + 20 * Math.sin(t / 700);
  for (let t = 0; t < 120000; t += 200) {
    replica.push({t, v: path(t) + 0.2});                 // small constant level error
    official.push({t, at: t + 600, v: path(t)});         // published 600 ms after it is true
  }
  const r = R.track(replica, official);
  assert.equal(r.headStartMs, 600);
  assert.equal(r.sourceBest.lag, 0);
  close(r.accuracy.mae, 0.2, 1e-6);
});

test('tracking needs enough overlapping pairs', () => {
  const r = R.track([{t: 0, v: 1}], [{t: 0, at: 0, v: 1}]);
  assert.equal(r.headStartMs, null); assert.equal(r.accuracy, null);
});

// The page's replica plumbing, run from the actual page script with network and DOM stubbed.
function pageHarness() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  let clock = 3560000;
  class Clock extends Date { static now() { return clock; } }
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {value: '', style: {}, dataset: {}, classList: {toggle() {}, contains() { return false; }},
      parentElement: {classList: {toggle() {}}, addEventListener() {}}, addEventListener() {}, hidden: false, open: true, textContent: ''});
    return nodes.get(id);
  };
  const ctx = vm.createContext({
    Date: Clock, console, Intl, URL, AbortSignal, getComputedStyle() { return {getPropertyValue() { return '#888'; }}; },
    setInterval() {}, clearTimeout() {}, setTimeout() { return 0; }, window: {addEventListener() {}}, navigator: {},
    document: {getElementById: node, addEventListener() {}},
    location: {protocol: 'https:', hostname: 'example.com', origin: 'https://example.com'},
    localStorage: {getItem: () => null, setItem() {}}, fetch: async () => { throw Error('No network in tests'); },
  });
  vm.runInContext(script.slice(0, script.indexOf('// ---------------------------------------------------------------- start')) + `
    globalThis.api = {DEPTH_VENUES, depthBooks, depthOps, replica, replicaTick, replicaText, renderReplica, acceptIndex, feed};
  `, ctx);
  return {api: ctx.api, node, setTime: t => { clock = t; }};
}

test('page replica uses only ready, fresh books and tracks official ticks', () => {
  const h = pageHarness(), {api} = h;
  const keys = Object.keys(api.DEPTH_VENUES);
  assert.ok(keys.length >= 4, 'depth adapters for the visible constituents');
  const [k1, k2] = keys;
  for (const k of [k1, k2]) api.depthBooks[k] = {bids: new Map(), asks: new Map(), at: 0, ready: false, state: 'off'};
  const fakeWs = {close() {}};
  const o1 = api.depthOps(api.depthBooks[k1], fakeWs), o2 = api.depthOps(api.depthBooks[k2], fakeWs);
  o1.snapshot([[99, 1], ['98', '2']], [[101, 1], [102, 2]]);
  o2.set(true, 99, 1);                                   // updates before a snapshot are ignored
  assert.equal(api.depthBooks[k2].bids.size, 0);
  let r = api.replicaTick(3560000);
  assert.deepEqual([...r.used], [api.DEPTH_VENUES[k1].name]);
  assert.ok(Number.isFinite(r.value));
  o1.set(false, 101, 0);                                 // size zero deletes the level
  assert.equal(api.depthBooks[k1].asks.has(101), false);
  h.setTime(3571000);                                    // 11 s without any message: delayed
  r = api.replicaTick(3571000);
  assert.equal(r.value, null);
  assert.equal(r.excluded[api.DEPTH_VENUES[k1].name], 'delayed');
  o1.touch();                                            // a heartbeat proves the held book is current
  r = api.replicaTick(3571000);
  assert.ok(Number.isFinite(r.value));
  assert.ok(api.acceptIndex(100.5, 3570900));
  assert.equal(api.replica.official.length, 1);
  assert.equal(api.replica.official[0].at, 3571000);
  const text = api.replicaText(3571000);
  assert.match(text.sum, /1 of 7 books/);
  assert.match(text.out, /LMAX Digital/);
});
