# BTC 15 Tape

## Current application behavior

The tape uses fresh official BRTI for its model and requires a recently confirmed
active contract as well as an open exchange for trade signals. Missing data means
WAIT. The blue average contains official BRTI readings only. Flow lean is displayed
as research context and is not applied to the frozen model.

Production order writes are disabled. The two autonomous experiments are legacy
PAPER and an explicitly started one-hour paper session; they cannot run together.
The separate demo panel submits only manually requested mock-fund demo orders.
There is no enabled LIVE mode or automatic promotion.

The full source audit and remaining work are in [APPLICATION_AUDIT.md](APPLICATION_AUDIT.md).
Legacy paper execution `paper-delayed-depth-v3` requires integer contract counts;
v2 records remain stored and are excluded from the current legacy execution report.
Timed sessions remain `paper-session-v2` / `brti-driftless-v4` with unchanged rules.
Older dated release notes below describe historical versions and are superseded
by current behavior, the settlement correction, and the audit handoff.

## BRTI replica (research)

The Worker recomputes BRTI itself, next to its Kalshi socket, and scores whether the
Kalshi book moves after the replica or before it (`GET /replica/status`; `REPLICA=off`
to disable). The tape also recomputes BRTI every 200 ms from the constituent exchanges' public
order books using CF Benchmarks' published calculation (methodology v17.0), and
measures it against Kalshi's official stream: dollar error at the same source time,
and whether it shows a move before the official tick reaches the page. Open
**BRTI replica** under the levels. It is research context only and is not used by
the frozen model, signals, paper trading or settlement. See [REPLICA.md](REPLICA.md)
for the calculation, feeds, known differences and how to read the tracking lines.

## Settlement interval correction (v4)

The KXBTC15M forecast now uses the 60 one-second BRTI readings strictly before
its reference/close time: `[close - 60s, close)`. The model is
`brti-driftless-v4`; older forecasts remain stored and are excluded from current
version scores. This supersedes the v3 interval and aggregate-substitution
behavior described in earlier release notes. No execution settings, collection
cadence, retention or deployment configuration change.

## Pricing bias lab

The agent page now compares fixed forward experiments for price bands, settlement
average versus spot, and contract-price follow-through after BRTI moves. Filter by
side and checkpoint to see sample coverage, simulated fills and net results.
Collection runs automatically with the existing collector, including while
trading is off. Old observations are excluded from this new phase. See
[RESEARCH.md](RESEARCH.md) for the frozen definitions and limitations.

## Settlement research

The collector now records seven settlement-aware checkpoints, delayed depth
snapshots, and official outcomes for chronological evaluation. Open **Settlement
research** on `/agent.html`; see [RESEARCH.md](RESEARCH.md) for data retention,
export commands, model selection, fee assumptions and limitations. This does not
change any trading mode. New records begin after deployment.

## Paper research release — October 12, 2026 (v3)

This section supersedes the earlier release notes below.

- The chart and server now embed the identical frozen `brti-driftless-v3` model from `shared-model.js`. Run `npm run sync:model` after editing it; `npm run check` rejects diverging copies. Official one-second BRTI drives volatility and settlement; faster BRTI can supply current spot. Flow lean remains experimental and is not applied to the official baseline.
- Forecast history records only estimates actually observed at that time. It does not reconstruct earlier probabilities using later inputs. Missing observations leave gaps. The chart supports a close-up view and distance from target; its official rolling average requires all 60 observations.
- Paper simulation records an intent, waits (default 1,000 ms), checks exchange/market status again, and uses fresh contract depth at arrival. It preserves the original limit, uses only 50% of displayed whole-contract quantity by default, and records partial fills and no fills. Stale depth, missed checkpoints, closed markets and unconfirmed status produce no fill. This is an assumption-based simulation, not measured execution performance or a queue-position model.
- Fee scenarios distinguish direct Kalshi, Robinhood standard and Robinhood Gold. Estimates use conservative whole-cent rounding. Robinhood scenarios still use Kalshi depth, not Robinhood executable liquidity; the exchange charge is configurable. Actual account fees need reconciliation before any future exchange execution.
- The Agent report separates model/execution versions and settings, and shows attempts, fills, settled net P&L, fees, drawdown and observed simulation delay. Mixed settings are not one validated strategy. Old page signals are hypothetical and excluded from the new paper report.
- Only OFF and PAPER are enabled. Demo/live requests are rejected, including old persisted live settings. No portfolio order submission is reachable in this release. Deployment does not turn paper on.

### Enable the paper trial

The collector runs through Durable Object alarms and the cron watchdog with the existing index data entitlement. Set `FEED_TOKEN` securely as a Cloudflare Worker secret if it is not already configured. Open Agent, save that same token locally, review simulation settings and select PAPER. Do not commit tokens or private keys. A phone does not need to stay open. Missing credentials, entitlement or fresh data remain visible and suppress entries.

Keep the model/settings frozen during a forward trial. Review results by whole contract window and day, including fees and missed fills; test slower execution and lower available depth before concluding an edge exists. There is no automatic promotion to live and no profit guarantee. More sophisticated depth signals should be added only if held-out results improve. This chat itself is not an always-running trading service.

Validation: `npm test` (47 checks), `npm run check`, `npm run test:runtime`. Runtime tests cover authentication and SQLite-backed endpoints; deterministic tests cover settlement boundaries, missing ticks, delayed/partial/no fills, halt handling, fee scenarios and model-separated reports. These checks validate software behavior, not predictive accuracy.

### Cloudflare preview builds

Non-production branches use `npx wrangler preview`; production uses `npx wrangler deploy`. The `previews` block explicitly binds `FEED` to `KalshiFeed`, giving each preview its own Durable Object namespace and storage. Do not add `script_name` pointing at production. Assets and migrations remain top-level. Cron triggers do not run on previews; verify the continuous collector on production after deployment. Production secrets are not inherited: a preview without separately configured index credentials will show unavailable index data and WAIT. It must not be treated as a live-feed or profitability test. Configure any preview secrets securely in Cloudflare, never in git.

## Reliability review — October 12, 2026

This section supersedes older operational claims below. The collector now keeps the read-only BRTI stream connected without a phone, wakes at least every 30 seconds, and has a one-minute Cloudflare cron watchdog. It repairs overdue alarms, schedules recovery before network work, bounds upstream requests to 12 seconds, and retains up to 20 minutes of actual one-second observations. This creates ongoing Durable Object usage; check your Cloudflare usage rather than assuming it is free. Trading mode is not changed by these improvements.

Forecasts use fresh stream snapshots captured before REST requests. Historical ticks may seed volatility, but stale history cannot produce a probability. Missing forecasts have a reason instead of looking successful. Previously missing forecasts are not reconstructed after outcomes are known. New collector forecasts carry model version `brti-driftless-v2`; `/collector/status` reports freshness, forecast count, and separate descriptive Brier scores on the newest third of settled windows. There is no automatic model promotion. Page forecasts include a flow lean and are scored separately from relay forecasts.

Final-minute maths requires all elapsed one-second BRTI readings or an official aggregate with exactly the expected count. Five-Hz readings are for live price/volatility, not settlement observations. Missing elapsed ticks pause signals. Source timestamps prevent replayed frames appearing fresh. The required remaining mean includes cent rounding, with the displayed threshold rounded upward to cents. The UI shows data/collector health, a neutral WAIT bar, fractional-cent quotes, explicit YES/NO rules, and uncalibrated model labels. Agent-page refreshes do not overlap.

Reconnects resubscribe to contract channels and discard old books/quotes. Missing order-book sequence numbers trigger a rebuild. Existing execution code gains stale-quote and exchange-status gates, input bounds, persisted order intent before sending (an uncertain request is not automatically retried), and P&L based on actual fill cost. An uncertain order requires manual reconciliation with Kalshi; automatic order reconciliation is not implemented. No trading modes are enabled by deployment. The existing direct-Kalshi fee estimate still needs venue-specific fee-schedule validation before live use.

Validation: `npm ci` (Node 22+), `npm test` (36 regression checks), `npm run check`, and `npm run test:runtime` (Worker build, SQLite health, authentication, default OFF, control validation and record endpoints). The root and `public/` page copies are checked byte-for-byte. Live deployment verification is recorded in the change report; unit tests do not establish predictive accuracy.

Remaining work: five spot-venue depth signals, server-side flow/lean learning, longer out-of-sample calibration, and execution reconciliation. Kalshi contract depth is already present; it is not five-venue spot depth.


Live view of the BTC 15-minute event contract (Robinhood "BTC 15 min", settled on Kalshi): spot from the exchanges behind the index, the 60-second settlement average, the target, a modelled chance of Up, and the order flow behind the price. Open `index.html` in a browser, or use the hosted page. Not financial advice.

## What is on the page

- **Spot and the 60-second average.** Spot uses fresh official BRTI when available and labels the five-exchange consensus as context otherwise. The blue line requires a complete official BRTI trailing window; missing readings leave gaps. It is not the official final settlement label. The Hyperliquid perpetual is separate context.
- **Chance of Up.** A random walk from spot to the closing average, against the target, with fat tails. Volatility is measured two ways, over the last two minutes and the last fifteen, and the quick one gives way to the slow one along the horizon. The level's uncertainty against the official index is measured from Kalshi's own average feed. The chance comes with a band: what it would be with volatility 30% lower or 50% higher, the lean off, and a one-sd adverse move while the order is placed.
- **Buy, thin, no.** The Up/Down boxes compare the chance with Kalshi's prices after Robinhood's fees. *Buy* means 3¢ is left at the bad end of the band, and comes with a quarter-Kelly size capped at 2% of the bankroll (set in the calibration panel). *Thin* means an edge at the model's chance only. *No* means none.
- **Record.** At 10, 5, 2 and 1 minutes before each close the page notes its chance and Kalshi's price. Brier scores and simulated buy-call P&L use **only confirmed Kalshi outcomes**. Proxy closing averages stay separate as diagnostics; old proxy outcomes are removed from scoring and await confirmation. Kept in the browser; the Record panel lists the last 25 windows.
- **Order flow.** Trades from seven venues (the index exchanges, the Hyperliquid and Binance perpetuals) are sorted by who crossed the spread. Bars show net buying or selling per 5 or 10 seconds and the line shows the total since open. Prints of $200k and up are listed. The fitted flow/perpetual lean is experimental context and does not alter official model probabilities.
- **Liquidations** from Bybit, OKX, Deribit, BitMEX and Binance: longs liquidated is forced selling, shorts liquidated is forced buying.
- **Sound.** Tap Sound once. Two rising or falling notes on a sharp move, three notes when Kalshi's price leaves a 3¢ edge, one low note at a minute to go.

## The relay scores every window on its own

With the key set, the relay wakes at 10, 5, 2 and 1 minutes before each close and 90 seconds after it, reads the index's tick history and the market, runs the same projection, and stores the chance, Kalshi's book and later the official result for every window, whether or not a page is open. The page merges that into its Record once a minute. `GET /record` returns the stored windows as JSON, `GET /record.csv` as a spreadsheet, `GET /collector/status` the last run and any errors.

## The trading agent (off by default)

The legacy agent supports OFF and PAPER only. Between the configured start minute
and 15 seconds before close, it evaluates simulated entries using the frozen model,
fees, risk caps and delayed depth fills. The timed session is a separate four-window
experiment with entries and exits. Open `agent.html` for controls, reports and the
isolated manual demo panel. All controls require the configured `FEED_TOKEN`.
No production exchange order is sent. Performance reports do not enable live trading.

## Exact Kalshi data

Browsers are not allowed to read Kalshi directly, so on its own the page estimates the target. Deployed as a Cloudflare Worker, the same repo serves the page and relays allowlisted read-only Kalshi requests. Continuous collection uses Cloudflare resources; check account usage.

1. Sign up at cloudflare.com and connect your GitHub account.
2. Workers & Pages → Create → **Import a repository** → choose `btc15-tape` → Deploy. The settings are in `wrangler.jsonc`.
3. Open the Worker's address (`https://btc15-tape.<your-subdomain>.workers.dev`). That is the page, with Kalshi data built in.

`public/index.html` is the page the Worker serves; the copy at the repo root is what GitHub Pages serves. Keep them identical.

## Kalshi's own stream (optional, recommended)

With an API key the Worker also streams Kalshi's own data to the page: the official BRTI index up to five times a second, the official trailing 60-second average, Kalshi's close-inclusive final-minute aggregate as a separate diagnostic, and the market's bid/ask the moment they change. The page then shows "official" readings with their age instead of the exchange estimate, and contract forecasts use the actual one-second readings before close.

1. On Kalshi: profile settings → **API Keys** → **Create New API Key**, Ed25519 (the default). Save the downloaded key file; the private key is shown once. Note the key ID.
2. On Cloudflare: the `btc15-tape` Worker → **Settings → Variables and Secrets** → add secrets `KALSHI_KEY_ID` (the key ID) and `KALSHI_PRIVATE_KEY` (the whole key file, including the BEGIN/END lines). Optionally `FEED_TOKEN`: any password; then enter it in the page under *Target and calibration → Stream token*.
3. Reload the page. The Market chips show `BRTI official 0.3 s` when the stream is live, or why it is not (no key, Kalshi refused, connecting).

The key signs the WebSocket handshake and read-only API requests. The Worker subscribes to BRTI and the current contract; depth is enabled for viewers, paper activity and research bursts. CF Benchmarks data needs the account entitlement. One Durable Object shares the upstream connection and keeps collecting without viewers when credentials are configured. Never paste the key anywhere but the Cloudflare secret.

## Settlement and data completeness

KXBTC15M's [contract terms](https://assets.kalshi.com/contract_terms/CRYPTO.pdf), linked by its [series metadata](https://api.elections.kalshi.com/trade-api/v2/series/KXBTC15M), define the average over the 60 seconds prior to the reference time. The forecast uses `[close - 60 seconds, close)`: for an 8:30 close, observations run from 8:29:00 through 8:29:59. Use the reference/last-trading close, not the later API `expiration_time`. This is scoped to KXBTC15M, not an assumption about every Kalshi market.

All 60 actual one-second BRTI samples are required for a completed contract average; the exchange-proxy diagnostic likewise needs 60 samples. During the final minute, a missing elapsed sample displays **WAIT / INCOMPLETE** and pauses probability and buy signals. Coinbase trade backfill is still an estimate and its sample count is identified; it does not become official BRTI data. A delayed diagnostic capture can receive a late pre-close sample; it never adds the tick at close. All 60 readings can be known in the final second before close. The existing $0.30 model-scale floor is unchanged, so a complete local average still does not set an official outcome.

The probability model integrates the covariance of future price observations, including fractional seconds and the existing horizon-dependent volatility. It retains both the wider Student-t scale and the variance-matched comparison. Neither has demonstrated probability calibration. Measured exchange/index dispersion is not capped at $6, and a manually estimated offset has no guaranteed lifetime. Buy calls require an exact market target retrieved from Kalshi or entered by the user, rather than a candle-derived estimate.

The [WebSocket final-minute helper](https://docs.kalshi.com/websockets/cfbenchmarks-value#averaging-semantics) separately uses `(close - 60s, close]`. Its values/counts are preserved as stream diagnostics, never substituted into the contract projection, even when a count appears to match. Trailing-average display semantics are unchanged. Official settlement still comes only from the published market result and expiration value.

Regression coverage includes boundary ticks, incomplete/final projections, unchanged stream diagnostics, cohort separation, and four public finalized market records from October 12 (23:00–23:45 UTC). The public fixtures contain official metadata only; private feed observations are not included.

## Timed-session compatibility

New timed paper sessions use `paper-session-v2` with explicit model `brti-driftless-v4`
and settlement interval `[close-60s,close)`. Existing v1 sessions stop new decisions
and cancel pending simulations on upgrade while keeping their original history;
open positions still await official settlement. A fresh session requires an explicit
start. Five-second looks, four-window duration and strategy thresholds are unchanged.

The tape and agent dashboard share collector health rules. A recent successful
run does not mask failures in the latest completed run. Expand **Collector details**
on the tape, or read **Collector and record** on `/agent`, to see failed task names,
timestamps, and errors. After recovery, retained errors are labelled as history.
These diagnostics require the existing stream token. A live BRTI feed alone does
not establish complete recording or paper-session coverage.

Slow session and collector maintenance requests run outside the research alarm's
critical path. Single-flight jobs and atomic earliest-wake scheduling allow the next
research arrival to run while those requests are pending. Legacy checkpoint quotes
cannot come from a later receipt timestamp. See RESEARCH.md for rollout limits.

## Checks

Timed-session status and exports include observed five-second coverage per window,
missed slots, evaluated decisions without an intent, largest evaluation gap and
filled-arrival delay. Only finished slots count while running; manual stop closes
the partial slot and the durable deadline caps coverage. These are observed bins,
not reconstructed forecasts or a guarantee of five-second delivery.

Session metadata and due official outcomes are fetched concurrently with a shared
two-second HTTP deadline. Unavailable metadata blocks simulated fills. New looks
retain target/receipt time, volatility, probability variants and read timing under
`reads.version = session-reads-v1`; arrivals also retain read timing. Older records
are not rewritten. Keep different read-policy versions separate when comparing
execution performance. Raw one-Hz buffers are still retained only by checkpoint
research, not by every session look.

The page/model unit checks require Node.js 22 or newer and no npm dependencies:

```sh
node --test tests/settlement.test.cjs
```

Tests run the actual page script with network calls and browser side effects stubbed. They cover settlement boundaries, incomplete averages, fractional-second covariance, reconstructed samples, official-only scoring, closing-sample timing, target confirmation, and clearing probability/buy indicators when data becomes incomplete. They also check the two page copies are identical. These checks do not measure live feed latency or establish a trading advantage.

The complete release checks are `npm test`, `npm run check`, `npm run test:runtime`,
`node tests/websocket-runtime.mjs` and `node tests/alarm-runtime.mjs`. Runtime checks
use the pinned development dependencies and local Miniflare/workerd, not production.

## If a feed shows nothing

The exchange message formats were taken from each exchange's documentation and the open-source AGGR project, not tried against every venue live. If a chip says "no trades" or a liquidation venue never counts anything while connected, open Diagnostics: it prints the last message that venue sent, which is enough to fix the parser.

### Exchange health, rate limits, and isolated demo tests (2026-10-12)

The tape shows Kalshi Open, Paused, or Status Unknown with the last successful
check's age. Failed checks and checks older than 90 seconds block trade signals;
model probabilities remain descriptive. The public relay coalesces concurrent
polls through the authenticated collector when configured, briefly caches successful responses, and honors `Retry-After` without
retrying 429s through another hostname. Authenticated reads learn the account's
read/write token budgets from `/account/limits`; these are conservative local
budgets, not a replacement for Kalshi's account-wide limiter. Other clients using
the same account can still cause 429s. Collector diagnostics include limits and
the last successful limits check.

WebSocket terminal channel errors 10/25 restart the connection and subscriptions;
command throttling (27) backs off at least 30 seconds. Stale subscription frames
are ignored; depth sequence gaps invalidate the book and request a fresh stream.
Cloudflare's WebSocket runtime handles protocol ping/pong. REST reconciliation
remains authoritative for demo execution; private fill/order streams are not
relayed to the public tape.

The **Demo test panel** on `/agent.html` is separate from the paper agent and
production market data. Setup in Cloudflare Worker runtime secrets:

- `FEED_TOKEN`: required for every demo endpoint (also protected inside the DO).
- `KALSHI_DEMO_KEY_ID` and `KALSHI_DEMO_PRIVATE_KEY`: separate demo API credentials.
  Never reuse production credentials or put private keys in the page or repository.

Open the agent page, save the stream token, and choose **Load demo markets**.
Choose an available demo BTC15 contract and a YES/NO limit, then submit one demo
contract. No open BTC15 markets means the test is unavailable, not permission to
substitute a production contract. Limits are one contract per order and ten order
attempts per ET day. This is a manual integration test, not autonomous demo trading.

V2 execution uses `POST /portfolio/events/orders`: YES buys map to `bid` at the
YES limit; NO buys map to `ask` at `1 - NO limit`, using exact four-decimal dollar
strings. Orders are IOC with cancel-on-pause. The durable `demo.ledger` is separate
from paper records, and intent is persisted before submission. A network timeout
leaves an unknown outcome: reload demo status and reconcile; never blindly submit
a replacement. The same client ID cannot submit a second order. New attempts
are blocked until the previous order is terminal and its fills reconcile.
Reconcile loads orders, paginated fills, and positions from the demo host. Positions
are displayed as account context, not assumed to equal this test order's fills.
An order not found after an uncertain submission remains blocked for investigation.
A cancellation is not considered final until reconciliation.

No production write request is permitted by the API client. The paper agent still
accepts only OFF/PAPER. Demo performance does not establish a live trading edge.

Contracts reviewed: https://docs.kalshi.com/openapi.yaml (3.34.0),
https://docs.kalshi.com/asyncapi.yaml (2.0.0), and
https://docs.kalshi.com/getting_started/demo_env.
