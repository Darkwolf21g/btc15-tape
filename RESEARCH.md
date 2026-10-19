# Settlement-aware research

Audit update (October 16): checkpoint market/exchange reads now run concurrently
with one two-second deadline, retaining actual market receipt time and
`reads.version = research-reads-v1`. A timeout is an unavailable capture, not a
successful forecast. Checkpoints, tolerance, model, hypotheses and simulated-fill
rules are unchanged. Saved old captures are not rewritten; separate read-policy
versions when comparing collection performance.

This is a read-only experiment attached to the existing collector. Deployment
starts new observations without enabling paper, demo or live trading. Older
records cannot supply missing historical depth or receipt times.

## Capture

Independent checkpoints: 600, 300, 120, 60, 30, 15 and 5 seconds before close.
Captures retain their actual time and seconds remaining. More than five seconds
late is a coverage gap. Existing page forecasts and four-checkpoint records stay
separate. Each new snapshot records:

- The official target, when it was read, rules, market and exchange status.
- One-Hz BRTI source/value/first-receipt triples, short/long volatility, observed
  settlement sum/count, missing readings, projected mean/scale and both existing
  probability variants. Exact input buffers are kept separately.
- Ten ask levels for YES and NO; separate source/sending and local receipt times.
- A delayed arrival book and its actual time, independent of paper-trading mode.
- Kalshi's official outcome, expiration value and when the label became known.
  A locally computed final-minute average is diagnostic only.

Five-Hz prices, exchange proxies and later backfills never become research
settlement observations. Cold restarts warm up from new receipts. Earlier
forecast targets remain immutable when later metadata changes.

Depth is subscribed from five seconds before through ten seconds after each
checkpoint, even without a browser. Outside these bursts, the existing
browser/paper policy applies. This adds WebSocket traffic, alarm wakeups, REST
reads and storage usage; it is not a free-storage guarantee.

### Prospective settlement-window correction

The current cohort uses schema `settlement-research-v2`, model
`brti-driftless-v4` and bias version `btc15-bias-v3`. For KXBTC15M, the contract's
sixty seconds before `close_time` are `[close-60s, close)`: include the first
second and exclude the close second. The stream trailing aggregate describes
`(close-60s, close]` instead, so it is not a settlement input. New snapshots and
closing diagnostics record `settlementConvention` explicitly. Source timestamps,
first-receipt timestamps, checkpoint cadence and retention are unchanged.

Versions start prospectively. The current evaluator excludes legacy schema/model
cohorts and does not reconstruct their forecasts. An upgrade during a legacy
window skips its remaining checkpoints and drops any unfinished delayed-arrival
capture; collection resumes in the next window. This deliberate rollout gap
keeps old forecast, target, book and bias observations intact. Official Kalshi
outcomes can still attach to legacy windows.

Existing closing captures and raw input buffers are never rewritten. A legacy
window without a closing capture retains the old `(close-60s, close]` diagnostic
convention, now explicitly tagged, and keeps its original schema/model labels.
If a raw closing buffer already exists after an interrupted summary write, the
diagnostic uses that buffer and its original capture time. These local averages
remain diagnostics; only official Kalshi outcomes supply evaluation labels.
An orphan checkpoint raw buffer is likewise preserved: its lost forecast is
marked skipped rather than reconstructed from a later book or target.

Contract reference: https://assets.kalshi.com/contract_terms/CRYPTO.pdf, page 1,
sixty seconds before the reference time (last trading time).

### Timed paper sessions and deployment boundaries

The timed experiment remains five-second looks over four complete windows, with
the same delayed one-contract simulated entries/exits, fees, depth haircut,
thresholds, cooldown and loss stop. New sessions are `paper-session-v2`, explicitly
pinned to model `brti-driftless-v4` and interval `[close-60s,close)`. Decisions,
intents, attempts and trades retain that attribution; arrivals also record the
arrival model/interval. Mismatched or unattributed snapshots cannot create fills.

A saved v1 session is never silently upgraded. The first session clock tick
stops further decisions, records a compatibility reason, cancels a queued
simulation once, and leaves open positions pending their official outcome.
Its original settings and observations remain unchanged; missing historical
interval attribution stays missing. Status/export reads do not perform migration.
Starting a new session first preserves any necessary transition in the old one.
The release itself does not start a timed session or enable the legacy agent.

Research capture/arrival runs in the alarm's fast path. Session REST and slower
collector maintenance are independent single-flight `waitUntil` jobs. An atomic
minimum-alarm scheduler preserves research wakes, including newly queued arrivals;
busy background jobs cannot spin on their own overdue decision deadlines. These
jobs do not change checkpoint cadence, the 750ms publication grace, receipt-time
filters, maximum fill latency or retention. Slow research metadata itself still
fails closed when the existing capture tolerance is exceeded. This is isolation
from unrelated work, not a guarantee of network latency or executable fills.

## Depth timestamp policy — depth-clock-v2 (October 19, 2026)

A Kalshi book frame carries Kalshi's own timestamp (`ts_ms` on deltas,
`sending_ts_ms` on snapshots). Until now a frame was rejected as "missing, stale
or future depth timestamp" if that timestamp ran more than 250 ms ahead of the
Worker's clock. On the evening of 15 October Kalshi's clock was 266–365 ms ahead,
so books 1–3 ms old were rejected: four of the eleven attempts in the first timed
paper session failed on this gate alone. In the research export the offset has a
25 ms median and 297 ms maximum, so earlier checkpoints were affected rarely.

The Worker now keeps the median of (source timestamp − local receipt) over the
last 64 book frames, estimated from frames *before* the one being judged and only
once eight samples exist. Depth snapshots record `clockOffsetMs` and
`correctedSourceAgeMs` and are fresh when the corrected age is within
[−250 ms, 1500 ms]. The local receipt age bound (≤ 1500 ms) is unchanged, so a
replayed old frame is still rejected regardless of the estimate. Snapshots carry
`depthPolicy: "depth-clock-v2"`; older records have no such field and were judged
under the uncorrected rule. The estimate is visible on `/selftest` as
`bookClockOffsetMs`. No model, threshold or cohort definition changed.

## Chronological evaluation

Fixed UTC test blocks contain 20 windows (five hours). For each checkpoint, choose
between the wider t4 and variance-matched probabilities using Brier loss on
previous windows whose official outcomes were known before the block opened.
Require at least 60 eligible earlier windows at that checkpoint. Ties choose the
wider model. Test outcomes never select their own model; no live model changes.
Missing or late-resolving windows cannot shift block membership.

The report gives Brier, log loss and ten calibration bins. Model and market-mid
Brier use identical eligible forecasts. Positive Brier improvement means lower
forecast loss, not established profitability.

Each checkpoint is a separate one-contract scenario. Take the better side only
if forecast minus ask and estimated fee clears 3 cents. Retain that original
limit at arrival. Delay is at least 1 second; more than 3 seconds of additional
lateness, arrival at/after closing, missing/stale/future/crossed depth or lack of
quantity at the limit means no simulated fill. Credit only 50% of displayed
whole-contract depth. Fees assume general Kalshi taker coefficient 0.07,
multiplier 1, conservatively rounded to whole cents per fill level. These are
explicit assumptions, not a live account-specific fee quote.

Arrival reuses checkpoint exchange status for the bounded 1–4 second horizon.
An intervening halt, competing orders and exchange rejection remain unknown.
Displayed quantity does not guarantee execution. This experiment cannot measure
subsecond price-discovery latency and does not infer Robinhood execution/fees.

P&L, fees, fill counts, win rate and drawdown stay separate per checkpoint. Do not
add their P&L or select the best checkpoint using test results and call that
selection independently validated. No significance claim, fitted calibration or
automatic trading promotion is included. Export a fixed dataset before further
comparisons; rolling retention changes available history.

## View, retain and export

Open `/agent.html`: **Settlement research → Refresh research**. The panel shows
coverage and later-window scores. **Download research data** exports all retained
summary pages as one JSON file. Normal feed-token protection applies throughout.

| Endpoint | Purpose |
| --- | --- |
| `GET /research/status` | Coverage and retention |
| `GET /research/report` | Evaluation of retained records |
| `GET /research/export?after=0&limit=25&through=<unix seconds>` | Close-ordered summaries; preserve `through` and advance `nextAfter` until null |
| `GET /research/inputs?close=<unix seconds>&check=60` | Exact forecast inputs; `check=0` gives closing-minute observations |

Retention: approximately **10 days of summaries**, **24 hours of raw inputs**,
pruned hourly. Export daily for a longer study. Unavailable inputs return 404.
An export's close-time range is fixed but settlement labels can update while it
runs; re-export once pending markets resolve. Whole-window gaps between the first
and last retained record are reported, never manufactured into forecasts.

Use Node 22+, with `FEED_TOKEN` set locally when required:

```bash
node scripts/research.mjs download https://btc15-tape.calvin-cherry26.workers.dev/ research-data.json --inputs
node scripts/research.mjs evaluate research-data.json research-report.json
```

The browser export contains summaries only; `--inputs` archives raw buffers too.
Keep datasets private and outside the repository. The command does not print the
token, and only issues GET requests. Offline evaluation needs no keys or packages.

## Verification

`npm test`, `npm run check` and `npm run test:runtime` cover receipt-time filtering,
missing settlement samples, source freshness, delayed depth/limit handling, fees,
chronological isolation, official-only labels, immutable capture, authentication,
pagination and the SQLite runtime. Synthetic fixtures do not demonstrate an edge.
Live collection and predictive performance must be checked after deployment.

References reviewed 2026-10-12:

- https://docs.kalshi.com/websockets/cfbenchmarks-value
- https://docs.kalshi.com/websockets/orderbook-updates
- https://docs.kalshi.com/websockets/market-ticker
- https://kalshi.com/docs/kalshi-fee-schedule.pdf

## Pricing bias phase — btc15-bias-v3

This phase starts prospectively with checkpoints carrying `bias.version` equal to
`btc15-bias-v3` under the current schema/model cohort. Older checkpoints remain
stored and exportable but are excluded from the current bias study. No historical
signals are reconstructed. The settlement-window correction changes the forecast
interval; agent mode and order submission permissions do not change.

The following definitions are frozen before outcomes arrive:

1. **Price bands:** observe each side independently in ask-price intervals
   `[0,10)`, `[10,30)`, `[30,50)`, `[50,70)`, `[70,90)`, `[90,100)` cents. A quote
   is a one-contract hypothetical purchase, regardless of model edge.
2. **Settlement disagreement:** only in the final minute with at least one
   observed and one remaining settlement reading, when current official BRTI
   and the model's projected settlement average lie on opposite sides of
   `target - 0.005`. Test the side indicated by the projection. This is a fixed
   hypothesis about spot anchoring, not evidence that traders make that error.
3. **Index follow-through:** measure the BRTI change from its source second five
   seconds earlier, divided by `short_vol * sqrt(5)`. Require absolute value at
   least 1 and test the move's direction. Both readings must already have been
   received. Missing earlier readings do not become a zero move. The existing
   volatility estimate includes recent observations; this is not an independently
   estimated statistical z-test.

Each experiment uses the existing delayed one-contract simulation: original ask
as limit, arrival 1–4 seconds later and strictly before close, valid fresh source
and receipt timestamps, active exchange, 50% depth haircut, and conservative
whole-cent general Kalshi taker fees. No resting-order or queue fills are inferred.
The last market/exchange status is reused for the bounded delay, as in the initial
research release; intervening status changes and competing orders are unknown.

Only officially resolved, current-model windows with a timely valid forecast,
active market/exchange and valid depth enter the results. Thus coverage is
conditional on the collector and volatility model being ready. Counts for pending,
invalid, legacy, missing-movement and missing-arrival observations remain separate.

Results stay separate by **checkpoint, side, hypothesis and price band**. Each
row contains at most one observation per market. Do not combine rows into a
portfolio, add their sample counts, or optimize the thresholds on these results
and call the resulting strategy independently tested. Repeated adjacent windows
can still be dependent; this release makes no significance or confidence claim.

The quote win rate and mean ask-plus-fee include every eligible quote. Net P&L,
return on cost and drawdown use only delayed simulated fills. Fill selection can
change the observed outcomes. Midpoint markout is signed in the selected direction
and measured over the actual recorded delay; it is neither executable profit nor
proof of a causal price-discovery lag. This snapshot design cannot measure
subsecond lead/lag or prove which venue moved first.

View **Pricing bias lab** under Settlement research on the agent page. Filters
select one checkpoint and side. The graph compares observed win rate with average
quoted all-in cost; the table reports fills and net per fill. The existing report
and offline evaluator now include `bias` with definitions, coverage, results and
limitations. Stored raw inputs include the information needed to reproduce the
new snapshot fields, including the cent-rounding-aware required remaining mean.

Before considering any trading change, archive a fixed dataset, specify the
selection rule and a fresh future holdout period, test dependence-aware uncertainty
and multiple comparisons, and stress fees, fill rates and latency. A positive
cell in this descriptive report is a hypothesis for that next test, not approval
for automated real-money trading.

### Depth quality correction

Live export inspection found canceled fractional quantities leaving tiny positive
floating-point residuals. Those became phantom crossed levels and made every
initial depth capture unusable. Book deltas now add/subtract integer hundredths
of a contract; canceled levels disappear exactly. Ask extraction preserves real
fractional sizes and drops quantities that round to zero. Fill simulation still
requires whole contracts after the depth haircut. The paper execution version is
`paper-delayed-depth-v2` so results do not pool with the older depth implementation.

Observed upstream book clocks led local receipt time by roughly 3–70 ms. Research
allows at most 250 ms of source-clock lead, records the raw signed source age and
`clockAheadMs`, and still rejects local receipts after capture or source ages over
1.5 seconds. This is a bounded clock-skew allowance, not a claim of synchronized
clocks or permission to use data received later. That correction introduced bias
version v2, excluding v1 captures. The current settlement-window correction starts
a separate v3 cohort. No prior captured book is repaired retrospectively.
