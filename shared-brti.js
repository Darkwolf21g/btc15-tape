// Canonical BRTI replica. scripts/sync-model.cjs embeds this exact source in the tape page.
// Re-implements the published CME CF Real Time Indices calculation (methodology v17.0,
// 21 Sep 2026) from the constituent order books the page can see. It is research context:
// it never replaces the official index, never settles anything and is not used by the
// frozen probability model. Deviations from the official calculation are listed in REPLICA.md.
// v2 corrects D from 5% to the published 0.5%; v1 integrated hundreds of BTC deep and ran $30-40 off.
(() => {
const VERSION = "brti-replica-v2";
const METHODOLOGY = "CME CF RTI methodology v17.0";
// BTC-USD parameters (methodology sections 6.1-6.2).
const PARAMS = Object.freeze({
  deviation: 0.005,     // D: utilized depth stops where the ask curve is more than 0.5% above the mid curve
  erroneous: 0.05,      // a book whose mid is >5% from the median mid is excluded
  reinstate: 0.025,     // ...and readmitted only once back within half that
  lagMs: 10000,         // a book retrieved more than 10 s before the calculation is excluded
  tau: 100,             // level-based spacing: smaller side's liquidity / 100
  lambdaFrac: 0.3,      // lambda = 1 / (0.3 * utilized depth)
  capSd: 5,             // order size cap = trimmed mean + 5 winsorized standard deviations
  capLevels: 50, capBand: 0.05, winsor: 0.01,
  effectiveMs: 200,
});

// Aggregate one side by price, dropping non-numeric or non-positive entries.
function side(raw, bids) {
  const byPrice = new Map();
  for (const level of raw || []) {
    const p = +level[0], s = +level[1];
    if (!(Number.isFinite(p) && p > 0 && Number.isFinite(s) && s > 0)) continue;
    byPrice.set(p, (byPrice.get(p) || 0) + s);
  }
  return [...byPrice].sort(bids ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
}
// One exchange's relevant order book, or the reason it is excluded (methodology section 5).
function cleanBook(book) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return {error: "unparseable"};
  const bids = side(book.bids, true), asks = side(book.asks, false);
  if (!bids.length || !asks.length) return {error: "one-sided"};
  if (bids[0][0] >= asks[0][0]) return {error: "crossed"};
  return {bids, asks, mid: (bids[0][0] + asks[0][0]) / 2};
}
function merge(books, bids) {
  const byPrice = new Map();
  for (const b of books) for (const [p, s] of bids ? b.bids : b.asks) byPrice.set(p, (byPrice.get(p) || 0) + s);
  return [...byPrice].sort(bids ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
}
function winsorized(sorted) {          // sorted ascending; k = floor(1% of n) each tail
  const n = sorted.length, k = Math.floor(PARAMS.winsor * n);
  const lo = sorted[k], hi = sorted[n - 1 - k];
  return {k, values: sorted.map(x => Math.min(hi, Math.max(lo, x)))};
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
// Dynamic order size cap from the uncapped consolidated book (section 4.1.3).
function sizeCap(bids, asks) {
  const take = (levels, inBand) => levels.slice(0, Math.max(levels.filter(inBand).length, Math.min(levels.length, PARAMS.capLevels)));
  const a = take(asks, ([p]) => p <= asks[0][0] * (1 + PARAMS.capBand));
  const b = take(bids, ([p]) => p >= bids[0][0] * (1 - PARAMS.capBand));
  const sizes = a.concat(b).map(([, s]) => s).sort((x, y) => x - y);
  const {k, values} = winsorized(sizes);
  const trimmed = sizes.slice(k, sizes.length - k);
  return mean(trimmed) + PARAMS.capSd * sd(values);
}
// Remove the lesser top size from both sides while the consolidated book is crossed (v16.8+).
function uncross(bids, asks) {
  bids = bids.map(l => l.slice()); asks = asks.map(l => l.slice());
  let i = 0, j = 0;
  while (i < bids.length && j < asks.length && bids[i][0] >= asks[j][0]) {
    const m = Math.min(bids[i][1], asks[j][1]);
    bids[i][1] -= m; asks[j][1] -= m;
    if (bids[i][1] <= 1e-12) i++;
    if (asks[j][1] <= 1e-12) j++;
  }
  return {bids: bids.slice(i), asks: asks.slice(j)};
}
// Mode of a Gaussian kernel density over winsorized sizes, evaluated at the sample values.
// The methodology does not state the search grid; evaluating at the samples is this replica's choice.
// Books with tens of thousands of levels are subsampled (every k-th size after sorting) to keep
// a 200 ms tick cheap; up to KDE_MAX_SAMPLES every size is used. A replica choice, not CF's.
const KDE_MAX_SAMPLES = 4000;
function kdeMode(sizes) {
  let sorted = sizes.slice().sort((x, y) => x - y);
  if (sorted.length > KDE_MAX_SAMPLES) { const k = Math.ceil(sorted.length / KDE_MAX_SAMPLES); sorted = sorted.filter((_, i) => i % k === 0); }
  const n = sorted.length;
  if (n < 4) return sorted[0];
  const {values} = winsorized(sorted), sigma = sd(values);
  if (!(sigma > 0)) return values[0];
  const h = 1.06 * sigma * Math.pow(n, -0.2), reach = 6 * h;
  let best = values[0], bestD = -1, lo = 0, hi = 0, prev = NaN;
  for (const x of values) {
    if (x === prev) continue; prev = x;
    while (values[lo] < x - reach) lo++;
    while (hi < n && values[hi] <= x + reach) hi++;
    let d = 0;
    for (let i = lo; i < hi; i++) d += Math.exp(-0.5 * ((x - values[i]) / h) ** 2);
    if (d > bestD) { bestD = d; best = x; }
  }
  return best;
}
const total = levels => levels.reduce((a, [, s]) => a + s, 0);
function spacing(bids, asks) {
  const tb = total(bids), ta = total(asks);
  const lev = Math.min(ta, tb) / PARAMS.tau;
  const kde = kdeMode((tb < ta ? bids : asks).map(([, s]) => s));
  return Math.min(lev, kde);
}
// Marginal price at cumulative volume v for each grid point s, 2s, ... while both sides last.
function curve(levels, s, maxN) {
  const out = []; let cum = 0, j = 0;
  for (let i = 1; i <= maxN; i++) {
    const v = i * s;
    while (j < levels.length && cum + levels[j][1] < v - 1e-9 * v) { cum += levels[j][1]; j++; }
    if (j >= levels.length) break;
    out.push(levels[j][0]);
  }
  return out;
}

// state: {excluded: {exchange: true}} carried between calls for the erroneous-data hysteresis.
function calculate(books, nowMs, state = {excluded: {}}) {
  const used = [], excluded = {}, valid = [];
  for (const [name, book] of Object.entries(books || {})) {
    if (!book || !Number.isFinite(book.at)) { excluded[name] = "no book"; continue; }
    if (nowMs - book.at > PARAMS.lagMs) { excluded[name] = "delayed"; continue; }
    const c = cleanBook(book);
    if (c.error) { excluded[name] = c.error; continue; }
    valid.push([name, c]);
  }
  const mids = valid.map(([, c]) => c.mid).sort((a, b) => a - b);
  const median = mids.length ? (mids[(mids.length - 1) >> 1] + mids[mids.length >> 1]) / 2 : null;
  const nextState = {excluded: {}};
  const kept = [];
  for (const [name, c] of valid) {
    const dev = Math.abs(c.mid / median - 1);
    const limit = state.excluded && state.excluded[name] ? PARAMS.reinstate : PARAMS.erroneous;
    if (dev > limit) { excluded[name] = "potentially erroneous"; nextState.excluded[name] = true; continue; }
    kept.push(c); used.push(name);
  }
  const fail = reason => ({value: null, reason, used, excluded, state: nextState, version: VERSION});
  if (!kept.length) return fail("no usable books");
  let bids = merge(kept, true), asks = merge(kept, false);
  const cap = sizeCap(bids, asks);
  bids = bids.map(([p, s]) => [p, Math.min(s, cap)]);
  asks = asks.map(([p, s]) => [p, Math.min(s, cap)]);
  ({bids, asks} = uncross(bids, asks));
  if (!bids.length || !asks.length) return fail("book exhausted by uncrossing");
  const s = spacing(bids, asks);
  if (!(s > 0)) return fail("no spacing");
  const maxN = Math.floor(Math.min(total(bids), total(asks)) / s + 1e-9);
  const ask = curve(asks, s, maxN), bid = curve(bids, s, maxN), n = Math.min(ask.length, bid.length);
  if (!n) return fail("no curve");
  let last = 0;                                   // index of the last grid point within D
  for (let i = 0; i < n; i++) {
    const mid = (ask[i] + bid[i]) / 2;
    if (ask[i] / mid - 1 <= PARAMS.deviation) last = i; else break;
  }
  const depthLimited = last === n - 1;            // the visible books ran out before the 0.5% band did
  const vT = (last + 1) * s, lambda = 1 / (PARAMS.lambdaFrac * vT);
  let sum = 0, wsum = 0;
  for (let i = 0; i <= last; i++) {
    const w = Math.exp(-lambda * (i + 1) * s);
    sum += w * (ask[i] + bid[i]) / 2; wsum += w;
  }
  const value = sum / wsum;
  return {value, rounded: Math.round(value * 100) / 100, vT, spacing: s, cap, lambda, points: last + 1,
          depthLimited, used, excluded, state: nextState, version: VERSION};
}

// Tracking against the official index. Replica values are stamped with local compute time;
// official ticks carry both their source timestamp and local receipt time.
function track(replica, official, opts = {}) {
  const lags = opts.lags || Array.from({length: 31}, (_, i) => (i - 10) * 200);   // -2 s .. +4 s
  const maxGap = opts.maxGapMs || 1500;
  // Official value in force at a moment on the chosen clock (last tick at or before it).
  const at = (series, key, t) => {
    let lo = 0, hi = series.length - 1, hit = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m][key] <= t) { hit = m; lo = m + 1; } else hi = m - 1; }
    return hit >= 0 && t - series[hit][key] <= maxGap ? series[hit].v : null;
  };
  const score = key => {
    const series = official.filter(o => Number.isFinite(o[key]) && Number.isFinite(o.v)).sort((a, b) => a[key] - b[key]);
    let best = null; const curveOut = [];
    for (const lag of lags) {
      let errs = [];
      for (const r of replica) { const o = at(series, key, r.t + lag); if (o != null && Number.isFinite(r.v)) errs.push(r.v - o); }
      if (errs.length < (opts.minPairs || 20)) { curveOut.push({lag, n: errs.length, mae: null}); continue; }
      if (opts.demean) {            // a series with a level offset (a perpetual's basis): score around its median difference
        const sorted = errs.slice().sort((a, b) => a - b), med = sorted[(sorted.length - 1) >> 1];
        errs = errs.map(e => e - med);
      }
      errs = errs.map(Math.abs).sort((a, b) => a - b);
      const mae = mean(errs), med = errs[(errs.length - 1) >> 1];
      curveOut.push({lag, n: errs.length, mae, median: med});
      if (!best || mae < best.mae) best = {lag, n: errs.length, mae, median: med};
    }
    return {best, curve: curveOut};
  };
  // Same-instant error against the source timestamp (accuracy), and the shift against
  // receipt time that best aligns the two (positive = the replica moves first).
  const source = score("t"), receipt = score("at");
  const zero = source.curve.find(c => c.lag === 0);
  return {accuracy: zero && zero.mae != null ? zero : null, sourceBest: source.best, headStartMs: receipt.best ? receipt.best.lag : null,
          receiptBest: receipt.best, receiptCurve: receipt.curve};
}

// Does the Kalshi book move after the replica, or before it? Event-based: a replica event is a
// one-second index move of at least `moveUsd` (default: three robust standard deviations of
// one-second moves in the window); a book event is a mid change of at least `midCents` while the
// mid is between `minMid` and `maxMid` (far from the strike the book has no reason to move).
// For each replica event the nearest book event within `windowMs` is found and dt = book - replica.
function leadLag(replica, mids, opts = {}) {
  const windowMs = opts.windowMs || 5000, dead = opts.deadbandMs || 150, midCents = opts.midCents || 1;
  const minMid = opts.minMid ?? 10, maxMid = opts.maxMid ?? 90, debounce = opts.debounceMs || 2000;
  const r = replica.filter(x => Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  const m = mids.filter(x => Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  // One-second moves of the replica.
  const moves = []; let j = 0;
  for (let i = 0; i < r.length; i++) {
    while (j < i && r[i].t - r[j + 1].t >= 1000) j++;
    if (r[i].t - r[j].t >= 800 && r[i].t - r[j].t <= 1500) moves.push({t: r[i].t, d: r[i].v - r[j].v});
  }
  if (moves.length < 20) return {events: 0, reason: "too few replica moves", moveUsd: null};
  let moveUsd = opts.moveUsd;
  if (!(moveUsd > 0)) {
    const abs = moves.map(x => Math.abs(x.d)).sort((a, b) => a - b), med = abs[(abs.length - 1) >> 1];
    moveUsd = Math.max(1, 3 * 1.4826 * med);
  }
  // The book mid in force at a moment (last change at or before it); an index move while the
  // mid sits outside [minMid, maxMid] is not an event, since the book has no reason to react.
  const midAt = t => { let lo = 0, hi = m.length - 1, hit = -1; while (lo <= hi) { const k = (lo + hi) >> 1; if (m[k].t <= t) { hit = k; lo = k + 1; } else hi = k - 1; } return hit >= 0 ? m[hit].v : null; };
  const rEvents = []; let lastAt = -Infinity, pinned = 0;
  for (const x of moves) {
    if (!(Math.abs(x.d) >= moveUsd && x.t - lastAt >= debounce)) continue;
    lastAt = x.t;
    const mid = midAt(x.t);
    if (mid == null || mid < minMid || mid > maxMid) { pinned++; continue; }
    rEvents.push({t: x.t, dir: Math.sign(x.d)});
  }
  const mEvents = []; let prev = null; lastAt = -Infinity;
  for (const x of m) {
    if (prev && Math.abs(x.v - prev.v) >= midCents && x.v >= minMid && x.v <= maxMid && prev.v >= minMid && prev.v <= maxMid && x.t - lastAt >= 1000) { mEvents.push({t: x.t, dir: Math.sign(x.v - prev.v)}); lastAt = x.t; }
    prev = x;
  }
  let after = 0, before = 0, same = 0, none = 0, agree = 0; const dts = [];
  for (const e of rEvents) {
    let best = null;
    for (const k of mEvents) { const dt = k.t - e.t; if (Math.abs(dt) <= windowMs && (!best || Math.abs(dt) < Math.abs(best.dt))) best = {dt, dir: k.dir}; }
    if (!best) { none++; continue; }
    dts.push(best.dt);
    if (best.dt > dead) after++; else if (best.dt < -dead) before++; else same++;
    if (best.dir === e.dir) agree++;
  }
  dts.sort((a, b) => a - b);
  return {events: rEvents.length, bookEvents: mEvents.length, after, before, same, none, agree, moveUsd, pinned,
          medianDtMs: dts.length ? dts[(dts.length - 1) >> 1] : null, reacted: rEvents.length - none};
}

globalThis.BTC15Replica = Object.freeze({VERSION, METHODOLOGY, PARAMS, cleanBook, sizeCap, uncross, kdeMode, spacing, curve, calculate, track, leadLag});
})();
