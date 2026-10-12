# Settlement-aware research

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
