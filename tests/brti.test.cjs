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
  // One book: bids 99.9 x1, 99.6 x1; asks 100.1 x1, 100.2 x1. Cap = 1 (all sizes equal).
  // Spacing = min(2/100, kde(n<4 -> smallest size 1)) = 0.02; grid 0.02..2.00 (100 points).
  // Mid-spread stays within D = 0.5% (0.1% then 0.3%), so every grid point is used.
  const r = R.calculate({a: book([[99.9, 1], [99.6, 1]], [[100.1, 1], [100.2, 1]])}, now);
  close(r.cap, 1); close(r.spacing, 0.02); assert.equal(r.points, 100); assert.equal(r.depthLimited, true);
  const s = 0.02, vT = 2, lambda = 1 / (0.3 * vT);
  let sum = 0, w = 0;
  for (let i = 1; i <= 100; i++) { const v = i * s, mid = v <= 1 + 1e-9 ? 100 : 99.9, e = Math.exp(-lambda * v); sum += e * mid; w += e; }
  close(r.value, sum / w, 1e-9);
  assert.ok(r.value > 99.95 && r.value < 100, 'front of the book carries more weight');
  assert.equal(r.rounded, Math.round(r.value * 100) / 100);
});

test('the deviation parameter is the published 0.5%, and a wide touch floors the depth at one spacing', () => {
  assert.equal(R.PARAMS.deviation, 0.005);
  // Half-spread 1% at the touch: the first grid point already exceeds D, so v_T = s and the value is the top mid.
  const r = R.calculate({a: book([[99, 1], [97, 1]], [[101, 1], [102, 1]])}, now);
  assert.equal(r.points, 1); close(r.vT, r.spacing); close(r.value, 100);
});

test('utilized depth stops at the 0.5% mid-spread band when the books are deep enough', () => {
  const bids = [[100, 1], [90, 1], [50, 1]], asks = [[101, 1], [120, 1], [200, 1]];
  const r = R.calculate({a: book(bids, asks)}, now);
  // Spacing 3/100 = 0.03. v<=1: ask 101 / mid 100.5 - 1 = 0.498% <= D; v>1: 120 / 105 - 1 = 14% > D.
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
    globalThis.api = {DEPTH_VENUES, depthBooks, depthOps, sharedDepth, replica, replicaTick, replicaText, renderReplica, acceptIndex, feed, krakenChecksum, crc32, truncateBook, VENUES, noteLeadMid, leadSeries};
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

// Feed one adapter real message shapes; returns the held book as sorted arrays.
function drive(api, key, messages) {
  const sent = [], ws = {readyState: 1, send: m => sent.push(m), close() { this.closed = true; }};
  const b = {bids: new Map(), asks: new Map(), at: 0, ready: false, state: 'waiting', note: ''};
  const ops = api.depthOps(b, ws), st = {};
  for (const m of messages) api.DEPTH_VENUES[key].msg(JSON.parse(JSON.stringify(m)), ops, ws, st, b);
  const sorted = (m, desc) => [...m].sort((x, y) => desc ? y[0] - x[0] : x[0] - y[0]);
  return {b, ws, sent, bids: sorted(b.bids, true), asks: sorted(b.asks, false)};
}

test('Kraken checksum reproduces the documented worked example', () => {
  const {api} = pageHarness();
  const bids = [[45283.5, .1], [45283.4, 1.54582015], [45282.1, .1], [45281.0, .1], [45280.3, 1.54592586], [45279.0, .0799], [45277.6, .03310103], [45277.5, .3], [45277.3, 1.54602737], [45276.6, .15445238]];
  const asks = [[45285.2, .001], [45286.4, 1.54571953], [45286.6, 1.54571109], [45289.6, 1.54560911], [45290.2, .1589066], [45291.8, 1.54553491], [45294.7, .04454749], [45296.1, .3538], [45297.5, .09945542], [45299.5, .18772827]];
  assert.equal(api.krakenChecksum({bids: new Map(bids), asks: new Map(asks)}), 3310070434);
  assert.equal(api.crc32('123456789'), 0xCBF43926);
});

test('Kraken adapter applies snapshot and updates, truncates, and resyncs on a bad checksum', () => {
  const {api} = pageHarness();
  const snap = {channel: 'book', type: 'snapshot', data: [{symbol: 'BTC/USD', bids: [{price: 100, qty: 1}, {price: 99, qty: 2}], asks: [{price: 101, qty: 1}, {price: 102, qty: 3}]}]};
  const sum = book => api.krakenChecksum({bids: new Map(book.bids), asks: new Map(book.asks)});
  snap.data[0].checksum = sum({bids: [[100, 1], [99, 2]], asks: [[101, 1], [102, 3]]});
  const upd = {channel: 'book', type: 'update', data: [{symbol: 'BTC/USD', bids: [{price: 100, qty: 0}, {price: 99.5, qty: 4}], asks: []}]};
  upd.data[0].checksum = sum({bids: [[99.5, 4], [99, 2]], asks: [[101, 1], [102, 3]]});
  let r = drive(api, 'kraken', [snap, upd]);
  assert.deepEqual(r.bids, [[99.5, 4], [99, 2]]);
  assert.equal(r.b.ready, true);
  const bad = JSON.parse(JSON.stringify(upd)); bad.data[0].checksum = 1;
  r = drive(api, 'kraken', [snap, upd, bad]);
  assert.equal(r.b.ready, false); assert.equal(r.ws.closed, true); assert.match(r.b.note, /checksum/);
  const m = {bids: new Map([[1, 1], [2, 1], [3, 1]]), asks: new Map([[5, 1], [4, 1]])};
  api.truncateBook(m, 2);
  assert.deepEqual([...m.bids.keys()].sort(), [2, 3]); assert.deepEqual([...m.asks.keys()].sort(), [4, 5]);
});

test('Coinbase level2_batch adapter: snapshot, absolute changes, heartbeats', () => {
  const {api} = pageHarness();
  const r = drive(api, 'coinbase', [
    {type: 'l2update', product_id: 'BTC-USD', changes: [['buy', '1', '1']]},          // before the snapshot: ignored
    {type: 'snapshot', product_id: 'BTC-USD', bids: [['100.00', '1.5'], ['99.00', '2']], asks: [['101.00', '1']]},
    {type: 'l2update', product_id: 'BTC-USD', time: 'x', changes: [['buy', '100.00', '0'], ['sell', '101.50', '0.25'], ['buy', '99.00', '3']]},
    {type: 'heartbeat', sequence: 1},
  ]);
  assert.deepEqual(r.bids, [[99, 3]]); assert.deepEqual(r.asks, [[101, 1], [101.5, 0.25]]);
  assert.match(api.DEPTH_VENUES.coinbase.url, /ws-feed\.exchange\.coinbase\.com/);
});

test('Crypto.com and Bullish adapters replace the book with each snapshot', () => {
  const {api} = pageHarness();
  let r = drive(api, 'cryptocom', [{id: 7, method: 'public/heartbeat'},
    {method: 'subscribe', result: {channel: 'book', subscription: 'book.BTC_USD.50', instrument_name: 'BTC_USD', data: [{bids: [['100', '1', '3']], asks: [['101', '0.5', '1']], t: 1}]}}]);
  assert.deepEqual(r.bids, [[100, 1]]); assert.deepEqual(r.asks, [[101, 0.5]]);
  assert.deepEqual(JSON.parse(r.sent[0]), {id: 7, method: 'public/respond-heartbeat'});
  r = drive(api, 'bullish', [{type: 'snapshot', dataType: 'V1TALevel2', data: {symbol: 'BTCUSD', bids: ['100.0', '1.0', '99.0', '2.0'], asks: ['101.0', '3.0']}},
                              {type: 'update', data: {symbol: 'BTCUSD', bids: ['100.0', '0'], asks: []}}]);
  assert.deepEqual(r.bids, [[100, 1], [99, 2]], 'undocumented updates are not applied');
  assert.match(r.b.note, /undocumented/);
});

test('Gemini adapter builds from initial events, applies changes, and resyncs on a sequence gap', () => {
  const {api} = pageHarness();
  const init = {type: 'update', socket_sequence: 0, events: [
    {type: 'change', reason: 'initial', side: 'bid', price: '100.00', remaining: '1'},
    {type: 'change', reason: 'initial', side: 'ask', price: '101.00', remaining: '2'}]};
  const chg = {type: 'update', socket_sequence: 1, events: [{type: 'change', reason: 'place', side: 'bid', price: '100.50', remaining: '0.5'},
                                                            {type: 'change', reason: 'cancel', side: 'ask', price: '101.00', remaining: '0'},
                                                            {type: 'change', reason: 'place', side: 'ask', price: '101.20', remaining: '1'}]};
  let r = drive(api, 'gemini', [init, chg, {type: 'heartbeat', socket_sequence: 2}]);
  assert.deepEqual(r.bids, [[100.5, 0.5], [100, 1]]); assert.deepEqual(r.asks, [[101.2, 1]]);
  r = drive(api, 'gemini', [init, {...chg, socket_sequence: 3}]);
  assert.equal(r.b.ready, false); assert.match(r.b.note, /sequence gap/);
});

test('Bitstamp depth comes from the tape quote socket, and a recovered book clears its note', () => {
  const {api} = pageHarness();
  assert.equal(api.DEPTH_VENUES.bitstamp.shared, true);
  api.sharedDepth('bitstamp', [['100', '1'], ['99', '2']], [['101', '1']]);
  const b = api.depthBooks.bitstamp;
  assert.equal(b.ready, true); assert.equal(b.bids.get(99), 2); assert.equal(b.ws, null);
  b.note = 'silent for 30 s, reconnecting';
  api.sharedDepth('bitstamp', [['100', '1']], [['101', '1']]);
  assert.equal(b.note, '');
  const r = api.replicaTick(3560000);
  assert.ok(r.used.includes('Bitstamp'));
  assert.match(api.replicaText(3560000).out, /Bitstamp: used .* via the tape's quote socket/);
});

test('tracking with the level removed finds a perpetual that leads despite its basis', () => {
  const perp = [], official = [];
  const path = t => 60000 + 50 * Math.sin(t / 3000) + 20 * Math.sin(t / 700);
  for (let t = 0; t < 120000; t += 100) perp.push({t, v: path(t + 800) + 35});   // 800 ms early, $35 above spot
  for (let t = 0; t < 120000; t += 200) official.push({t, at: t + 300, v: path(t)});
  const r = R.track(perp, official, {demean: true, minPairs: 50});
  assert.equal(r.receiptBest.lag, 1200, '800 ms market lead plus 300 ms delivery, on a 200 ms grid');
  assert.ok(r.receiptBest.median < 0.1, 'basis removed, residual is small at the right lag');
  const raw = R.track(perp, official, {minPairs: 50});
  assert.ok(raw.receiptBest.mae > 30, 'without demeaning the basis dominates the error');
});

test('Binance perp adapter subscribes by message, recognises quotes and trades by shape, and feeds the lead series', () => {
  const {api} = pageHarness();
  const spec = api.VENUES.binancef;
  assert.equal(spec.lead, true);
  const sent = []; spec.open({send: m => sent.push(JSON.parse(m))});
  assert.deepEqual(sent, [{method: 'SUBSCRIBE', params: ['btcusdt@bookTicker', 'btcusdt@aggTrade'], id: 1}]);
  const quotes = [], trades = [], q = (b, a) => quotes.push([b, a]), tr = (p, s, buy, t) => trades.push([p, s, buy, t]);
  spec.msg({result: null, id: 1}, q, {}, {}, tr);                                                         // acknowledgement
  spec.msg({e: 'bookTicker', u: 1, s: 'BTCUSDT', b: '100.0', B: '7', a: '100.2', A: '3', T: 5, E: 5}, q, {}, {}, tr);   // raw frame, bookTicker carries T too
  spec.msg({stream: 'btcusdt@aggTrade', data: {e: 'aggTrade', p: '100.1', q: '0.5', m: false, T: 7}}, q, {}, {}, tr);   // wrapped frame
  spec.msg({s: 'BTCUSDT', a: 9, p: '100.0', q: '0.2', f: 1, l: 2, T: 8, m: true}, q, {}, {}, tr);           // untagged, as AGGR tolerates
  assert.deepEqual(quotes, [[100, 100.2]]);
  assert.deepEqual(trades, [[100.1, 0.5, true, 7], [100, 0.2, false, 8]]);
  api.noteLeadMid('binancef', 100.1, 3560000); api.noteLeadMid('binancef', 100.3, 3560100);
  assert.deepEqual(JSON.parse(JSON.stringify(api.leadSeries.binancef)), [{t: 3560000, v: 100.1}, {t: 3560100, v: 100.3}]);
  api.noteLeadMid('binancef', 100.4, 3560100);
  assert.equal(api.leadSeries.binancef.length, 2); assert.equal(api.leadSeries.binancef[1].v, 100.4);
});

test('lead/lag scorer sees the Kalshi book move after the replica when it does, and before when it does', () => {
  // Index steps of $12 every 20 s; otherwise a gentle wander. Book mid steps 3c, 700 ms after each index step.
  const replica = [], mids = [];
  let level = 60000, mid = 50;
  for (let t = 0; t < 600000; t += 200) {
    if (t % 20000 === 0 && t > 0) level += (t % 40000 === 0 ? 12 : -12);
    replica.push({t, v: level + 0.3 * Math.sin(t / 1300)});
  }
  for (let t = 700; t < 600000; t += 20000) { mid += (t % 40000 === 700 ? 3 : -3); mids.push({t, v: mid}); }
  mids.unshift({t: 0, v: 50});
  const r = R.leadLag(replica, mids);
  assert.ok(r.events >= 28 && r.events <= 30, 'about 29 index events');
  assert.equal(r.before, 0); assert.equal(r.same, 0);
  assert.equal(r.after, r.events); assert.equal(r.agree, r.events);
  assert.ok(Math.abs(r.medianDtMs - 700) <= 200);
  // Book that moves 900 ms BEFORE the index: the scorer must say so.
  const early = mids.map(x => ({t: Math.max(0, x.t - 1600), v: x.v}));
  const e = R.leadLag(replica, early);
  assert.equal(e.after, 0); assert.equal(e.before, e.events);
  // A book pinned at 99c never counts as reacting.
  const pinned = mids.map(x => ({t: x.t, v: 99 + (x.v % 2) * 0.5}));
  assert.equal(R.leadLag(replica, pinned).none, R.leadLag(replica, pinned).events);
});

test('lead/lag needs enough replica movement to score', () => {
  assert.equal(R.leadLag([{t: 0, v: 1}, {t: 1000, v: 1}], [{t: 0, v: 50}]).events, 0);
});

test('kernel-density spacing subsamples very large books and is unchanged below the cap', () => {
  const sizes = Array.from({length: 3000}, (_, i) => 0.05 + (i % 7) * 0.01);
  const small = R.kdeMode(sizes);
  const big = R.kdeMode(sizes.concat(Array.from({length: 30000}, (_, i) => 0.05 + (i % 7) * 0.01)));
  close(small, big, 0.011, 'the mode survives subsampling');
  const t0 = Date.now(); R.kdeMode(Array.from({length: 45000}, (_, i) => 0.001 + (i % 1000) * 0.0001)); assert.ok(Date.now() - t0 < 500, 'bounded cost');
});
