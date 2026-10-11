# BTC 15 Tape — handoff

Written for whoever picks this up next (a person or another assistant). It says what exists, where it is, how it works, what has and has not been verified, and what was decided and why. Read it in full before changing anything. Settlement-integrity corrections below were added on 11 Oct 2026; see `tests/settlement.test.cjs` for the corresponding regression checks.

## 1. What this is

A single-page web app the owner opens on his phone while trading Robinhood's **"BTC 15 min"** prediction contract by hand. The contract is Kalshi's `KXBTC15M` series (Robinhood routes event contracts to Kalshi). Every 15 minutes a market asks: will the 60-second average of the CF Benchmarks BRTI bitcoin index at the close be **at or above** the same average taken at the open (the "target")?

The page streams the five exchanges behind BRTI, shows spot, the trailing 60-second average (the number Robinhood displays), the target, a projected closing average with its uncertainty, a modelled **chance of Up**, Kalshi's own Up/Down prices with an edge verdict (buy / thin / no) and a size, order flow and liquidations from eleven venues, sound alerts, and a running record that scores the model's chance against the market's price in every window it watches.

**Status:** deployed and in use. The page's maths has been checked numerically (section 7). Every exchange message format was taken from documentation and the open-source AGGR project and exercised against a simulator, but **not all have been observed live** (section 8). No trading is automated anywhere; the owner explicitly deferred automation ("forget the trade automation for now").

## 2. Where everything is

| Thing | Location |
|---|---|
| Repository | https://github.com/Darkwolf21g/btc15-tape (branch `main`) |
| Hosted page with Kalshi data | https://btc15-tape.calvin-cherry26.workers.dev — a Cloudflare Worker that serves the page and relays two read-only Kalshi requests. Redeploys automatically on push (Cloudflare Workers Builds, "Import a repository"). |
| Hosted page without Kalshi data | https://darkwolf21g.github.io/btc15-tape/ — GitHub Pages from the repo root. On it the target is estimated and Kalshi's prices are typed by hand, unless a relay address is set in the page. |
| The page | `public/index.html` (what the Worker serves) and `index.html` at the repo root (what GitHub Pages serves). **They must stay byte-identical**; edit `public/index.html` and copy it over. One file: inline CSS and JS, no build step, no dependencies beyond two Google Fonts. |
| The relay | `worker.js` (42 lines) and `wrangler.jsonc`. |
| Checks | `test/` — Playwright scripts against a simulated market (section 9). |
| Earlier, separate deliverable | A Python paper-trading/alert bot (`btc15_bot.py`, `test_btc15_bot.py`, its README) was delivered to the owner as files in an earlier session. It is **not in this repo**. It never places orders; it was reviewed and tested in simulation but the owner has not yet run it against the live market. |

Commit messages so far end with `Co-Authored-By` and `Claude-Session` trailers; keep the style of one-paragraph summaries saying what changed and why.

## 3. The contract and the market facts that matter

- **Series** `KXBTC15M`. Event ticker `KXBTC15M-26OCT110315` = close time in US Eastern (`YYMMMDDHHMM`); market ticker adds the close minute: `KXBTC15M-26OCT110315-15`. Windows are the quarter hours of the wall clock.
- **Rule.** Yes if the simple average of BRTI over the final minute, window `(close − 60 s, close]` with second-indexed counts (Kalshi's documented averaging semantics; PR #1 corrected the page to this), is ≥ the same average before the open. Kalshi publishes the open's value as the market's `floor_strike` (2 decimals, also in `yes_sub_title` as "Target Price: $…"). The page's own estimate of the target from its prices matched `floor_strike` on live windows once its level was aligned to Kalshi (within cents).
- **Robinhood's display.** Its big number is the trailing 60-second average, so it trails spot by about 30 seconds in a move. Its **Up** price is Kalshi's yes ask; **Down** is 1 − yes bid.
- **Fees** (per contract, when opening; nothing at settlement): Robinhood commission 10% × p × (1 − p), rounded up to the cent, capped at 1¢ (5% with Gold); plus a 1¢ exchange fee. Robinhood's own example (47¢ contract → 49¢ all-in with Gold) agrees. The page's `feeCents(p)` is the non-Gold version.
- **Kalshi public REST** (no key needed): `GET /trade-api/v2/exchange/status` (`trading_active`, `exchange_active`; polled every 30 s, buy calls wait while paused), `GET /trade-api/v2/markets/{ticker}` (fields used: `floor_strike`, `yes_bid_dollars`, `yes_ask_dollars`, `status`, `result`, `yes_sub_title`) and `GET /trade-api/v2/live_data/events/{event}` (`live_data.details.timeseries[]` of `{t: ms, v: trailing 60-s BRTI average}`). Bases: `https://external-api.kalshi.com` and `https://api.elections.kalshi.com`. **Browsers are CORS-blocked**, hence the relay. A public CORS proxy (`api.allorigins.win/raw?url=…`, with a cache-buster inside the forwarded URL) is the last-resort route; it is slow and caches.
- **Kalshi trading API** (for a future automation step only; nothing built): API keys from profile settings, Ed25519 or RSA-PSS, headers `KALSHI-ACCESS-KEY/TIMESTAMP/SIGNATURE`, signed string = timestamp + method + path; demo base `https://external-api.demo.kalshi.co`; `POST /portfolio/orders`. **Never ask for or accept a private key in chat.**

## 3b. Kalshi's own stream (added 11 Oct 2026)

`worker.js` now also exports a Durable Object `KalshiFeed` (binding `FEED`, SQLite migration `v1`). With secrets `KALSHI_KEY_ID` and `KALSHI_PRIVATE_KEY` (Ed25519 PKCS#8 or RSA PKCS#1/PKCS#8 PEM; signing verified against Node's crypto for all three) it opens one authenticated WebSocket to `wss://external-api-ws.kalshi.com/trade-api/ws/v2` (headers `KALSHI-ACCESS-KEY/SIGNATURE/TIMESTAMP`, signed string `timestamp + "GET" + "/trade-api/ws/v2"`), subscribes to `cfbenchmarks_value` and `cfbenchmarks_value_5hz` for `index_ids: ["BRTI"]` and to `ticker` for this window's and the next window's market tickers (renewed at each boundary), and forwards those frames verbatim to every page connected at `/feed` (optional `?token=` gated by `FEED_TOKEN`). A `{type:"relay"}` status frame is sent on connect and on changes. The upstream opens with the first page and closes a minute after the last one leaves. **Not yet observed live** at the time of writing: the owner had not set the secrets. The page's Market chips and Diagnostics (`stream:` line) report the relay state and Kalshi's refusal text if any.

Page side (`feed` object): the 5/s value is the index `x` when fresh (< 3 s), the trailing average replaces the proxy average in the tile, `last_60s_windowed_average_15min` (window `(close−60 s, close]`, counts second-indexed, per Kalshi's docs) is the known part of the projection exactly (`project()` returns `official: true`), the ticker push updates `kalshi.market` (polling backs off to 10 s and never overwrites a fresher push), the basis is learned as median(BRTI − consensus) with a robust sd, and `levelSd()` is 0.3 while the stream is live. The final minute shows the **required price**: the average the remaining seconds must reach for Up, as a tile note, in the hero text and as a dashed line on the chart. Everything falls back to the exchange estimate within 3 s of the stream dropping. `test/check_stream.py` exercises all of this against a simulated relay. The Worker also signs `GET /trade-api/v2/cfbenchmarks/history/values?id=BRTI&timespan=HOUR&timestamp=<ISO hour>` at `/brti/history` (50 read tokens a call); the page's backfill tries it first (`fetchOfficialHistory`, tolerant parsing of the payload shape since the exact CF Benchmarks response was not seen) and falls back to Coinbase trades. Kalshi says the CF Benchmarks channels and passthrough need an entitlement on the account.

## 3c. The collector (added 11 Oct 2026)

`KalshiFeed.alarm()` runs at each checkpoint (close − 600/300/120/60 s) and at close + 90 s / + 400 s, scheduled with `state.storage.setAlarm` (`nextEvent()`); the chain is (re)started by any `/feed`, `/record` or status request (`ensureAlarm`). At a checkpoint it fetches BRTI tick history for the current (and if needed previous) hour and the market record, computes volatility from 5-s changes over 2 and 15 min (`volsFrom`), projects with the page's maths (`projectFrom`, level sd 0.3, no lean), and stores `w:<ticker>` with `checks[c] = {p, p2, sd, mean, x, ask, bid, at, ticks}`; after the close it stores `result`, `src: "kalshi"`, `officialCloseAvg`. Routes: `/record` (JSON, last 400), `/record.csv`, `/collector/status` (runs, errors, next alarm). The page's `mergeRelayRecord()` pulls `/record` every minute and fills in what it lacks (windows marked `relay`, checks marked `relay`). Exercised against a fake Kalshi in Node (`scratchpad/collector_test.mjs`, not in the repo). Cost: ~5 short wake-ups per window, well inside the free tier.

## 3d. The execution agent (added 11 Oct 2026; off by default)

In `KalshiFeed`: `agentTick()` runs from the alarm every 5 s inside the zone (close − 600 s to close − 15 s; `firstSeconds`/`lastSeconds` in config) when `trade.cfg.mode !== "off"`, keeps the upstream stream open for that, and uses in-memory ticks (`pushTick`, same glitch filter as the page), the streamed settlement average and the books. Model = `projectFrom` + band (vol ×0.7/1/1.5, ±1 sd of a 10-s move) → worst-case chance → edge at the ask from the book (Up from resting No bids, Down from resting Yes bids; ticker as fallback with size 1) → quarter-Kelly on the worst case, capped by `perWindowCents` (hard max 5000), 2% of `bankrollCents`, and the offered size. A call must hold across two ticks before an order. Orders: `POST /trade-api/v2/portfolio/orders` `{ticker, action: "buy", side: yes|no, count, type: "limit", yes_price|no_price (cents), time_in_force: "immediate_or_cancel", client_order_id, cancel_order_on_pause: true}`; the fill from the response (`fill_count`, `taker_fill_cost`, `taker_fees`). Modes: paper (no order), demo (`https://demo-api.kalshi.co`, demo key pair), live (`external-api.kalshi.com`). `settleTrades()` after each close scores against `result`; daily counters in `trade.day` (ET date); windows in `t:<ticker>`; decisions log in `trade.log`. Routes `/trade/status` (token-gated like the feed) and `POST /trade/config` (requires `FEED_TOKEN` to exist; live needs `confirm: "LIVE"`; demo needs the demo keys). Tested in Node against a fake stream/exchange (`scratchpad/agent_test.mjs`): paper trade only after the hold, one per window, scored after settlement, demo order shape, live refused without confirmation, alarm cadence. **Never observed live.** No nowcast lean in the agent (no flow data in the relay).

## 4. Data sources

All connections are made by the phone's browser directly to the venues (WebSocket). Message handlers live in the `VENUES` table in the page.

**Price (the BRTI constituents).** Quote = best bid/ask; the page keeps the mid.

| Venue | Endpoint | Channel | Notes |
|---|---|---|---|
| Coinbase | `wss://ws-feed.exchange.coinbase.com` | `ticker`, `heartbeat`, `matches` | In `match`, `side` is the maker's: `sell` = up-tick = taker bought (Coinbase docs, verified). |
| Kraken | `wss://ws.kraken.com/v2` | `ticker` (`event_trigger: bbo`), `trade` (`snapshot: false`) | Trade `side` = taker's (Kraken docs, verified). |
| Bitstamp | `wss://ws.bitstamp.net` | `order_book_btcusd`, `live_trades_btcusd` | Ping `bts:heartbeat`; obey `bts:request_reconnect`. Trade `type` 0 = buy, 1 = sell. |
| Gemini | `wss://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=true&trades=true&heartbeat=true` | v1 events | `makerSide: ask` = taker bought; the first, undated message is history and is skipped. |
| Crypto.com | `wss://stream.crypto.com/exchange/v1/market` | `ticker.BTC_USD`, `trade.BTC_USD` | Subscribe 1 s after open; answer `public/heartbeat` with `public/respond-heartbeat`. Trade `s` = BUY/SELL. |
| Hyperliquid (perp, **not** in the index) | `wss://api.hyperliquid.xyz/ws` | `bbo`, `trades` (coin BTC) | Drawn as a lead line and used as a nowcast input; never in the price. Trade `side` `B` = buy. |

**Liquidations** (derivatives venues, not in the index; `liq: true` in `VENUES`):

| Venue | Endpoint / subscription | Dollar size | Side |
|---|---|---|---|
| Bybit | `wss://stream.bybit.com/v5/public/linear`, `allLiquidation.BTCUSDT`, `allLiquidation.BTCPERP`; ping `{op:"ping"}` | `v × p` | `S: Buy` = a long was liquidated (Bybit docs, verified) |
| OKX | `wss://ws.okx.com:8443/ws/v5/public`, `liquidation-orders` instType SWAP; ping `"ping"` | BTC-USDT-SWAP `sz × 0.01 × bkPx` (ctVal verified); BTC-USDC-SWAP `sz × 0.0001 × bkPx`; BTC-USD-SWAP `sz × 100` (from memory, unverified) | `posSide` long/short, else `side: sell` = long |
| Deribit | `wss://www.deribit.com/ws/api/v2`, `trades.BTC-PERPETUAL.100ms`; ping `public/test` | `amount` (USD) | trades with `liquidation` set; `T` = taker was liquidated |
| BitMEX | `wss://ws.bitmex.com/realtime?subscribe=liquidation:XBTUSD,liquidation:XBTUSDT`; ping `"ping"` | XBTUSD `leavesQty` (USD); XBTUSDT `leavesQty × 1e-6 × price` | `side: Sell` = long |
| Binance | `wss://fstream.binance.com/ws/btcusdt@forceOrder` | `q × p` | `S: SELL` = long. **Refuses US connections**; retried once a minute, chip shows "off". |

**Backfill.** The minute before the page opened (and the minute before the window's open, for the target) comes from Coinbase's public REST trade list `GET https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000` paged with the `after` cursor (up to 8 pages), last trade per second carried forward. Fallback: the one-minute candle.

**Liveness rules.** Exchanges only push on change, so a quote stays valid while the socket is alive (`ALIVE_MS` 20 s with heartbeats or pings) and unchanged for less than `FROZEN_MS` 120 s. A silent socket is closed and reconnected (backoff to 15 s; 60 s after five failed connects). `quiet` venues (Binance) are exempt from the silence rule. Feeds that replay history on connect are handled by `stale()`: trades stamped more than 15 s old are dropped in the first 10 s after a connect.

## 5. How the page works (the script, top to bottom)

Settings at the top: `WINDOW 900`, `SETTLE 60`, `ALIVE_MS`, `FROZEN_MS`, `MAX_DEV 0.0005`, `MIN_LIVE 2`, `VOL_HALFLIVES [120, 900]`, `VOL_STEP 5`, `WHALE_USD 200000`, `FLOW_SPANS [30, 60]`, `VOL_TAU 180`, `NOW_H 30`, `CHECKS [600, 300, 120, 60]`.

1. **Consensus spot** (`consensus`). Each live exchange's mid minus its learned offset; outliers more than 0.05% from the median dropped; needs two. Weighted mean with weight `0.05 + exp(−age_since_last_change / 10 s)`, so the exchanges that just moved carry the price (a plain median stuck to idle exchanges). Offsets (`learnOffsets`) learn each venue's usual distance from the consensus (rate 1/(n+1) for the first 10 samples, then a 120-s half-life) and are then **re-centred so Coinbase's offset is 0**: the level is pinned to Coinbase so a calibration survives reloads and venues dropping out.
2. **Level** (`basis`, `basisSrc`, `levelSd`). Official index minus consensus. Sources, best first: Kalshi's average feed (median of feed − page average over 3 minutes, with a robust sd `1.4826 × MAD` → `basisSd`), a typed target (`setTarget` calibrates if within $60), a typed Robinhood number (`Sync`), nothing (`raw`). Stored 6 h in `localStorage btc15tape.basis`.
3. **Per-second record.** `samples` (consensus per second), `backfill`, `leadSamples` (perp on spot's footing), `flow` (dollars bought/sold at market per second, spot and perp separately), `liqs`, `whales`, `tstat` (events per venue). `avgAt(sec)` requires all 60 finite readings at seconds `sec−59 … sec`; incomplete averages return null. Reconstructed trade readings are counted separately from live proxy readings; neither is an official BRTI observation.
4. **Volatility** (`sigmas`). Two EWMAs of squared 5-second changes (per second of variance), half-lives 120 s and 900 s, each floored at $0.50/√s. `sigma()` is their RMS blend for readouts and the sharp-move test (`|move10| > 3σ√10`).
5. **Target** (`target`): Kalshi's `floor_strike` → typed → Kalshi feed value at open−1 → page's complete average at open plus basis → Coinbase candle → "tap to enter". Only the first two are confirmed targets for buy indicators; estimated targets leave buy indicators on WAIT.
6. **Nowcast** (`calibrate`, `calStats`, `nowcast`): section 6.3.
7. **Projection and chance** (`project`, `chance`, `chanceBand`): section 6.
8. **Kalshi** (`kalshiGet`, `pollKalshi`): route = user relay → same site (when served by the Worker) → direct → public proxy; re-probes the preferred route every 30 s; market every 3 s (8 s on the public proxy); feed every 20 s; one missed request is tolerated for 60 s; `kalshi.hist` keeps bid/ask per second for the chance chart.
9. **Drawing.** `drawMain` (price, average, target, projection fan, perp lead), `drawFlow` (net-flow bars per 5 or 10 s, running total since the open, liquidation triangles per bar), `drawProb` (chance of Up since the open with Kalshi's ask line and bid–ask band).
10. **render()** every 100 ms (charts every 200 ms, chips/readouts once a second): header and clock, level tiles, projection, chance and band, hero text, Up/Down verdicts, record hooks, sounds.
11. **Record** (`keepRecord`, `settleWindow`, `settleOfficial`, `scoreRecord`): section 6.6.
12. **Inputs**: target, sync, relay, bankroll, sound, keep-screen-on (Wake Lock), `visibilitychange` → reconnect all and backfill (iPhones drop sockets while another app is in front).

`localStorage` keys (prefix `btc15tape.`): `basis`, `target.<ticker>`, `relay`, `nowcal`, `record`, `bankroll`.

## 6. The model, exactly

Let `x` = spot + basis (the page's estimate of the index now), `close` the window's close, the settlement seconds `s = close−59 … close` (the interval `(close−60, close]`).

**6.1 Projected closing average.** Elapsed seconds use their recorded exchange-proxy value; future seconds follow a driftless random walk from `x`, plus a lean (6.4) that plays out linearly over 30 s. A missing elapsed reading pauses the projection, probability and buy indicators (WAIT); it is never substituted with current spot:

`mean = ( Σ_known (sample_s + basis) + m·x + Σ_future lean·min(1, d_s/30) ) / 60`

where `m` is the number of future seconds and `d_s` how far ahead each is. **So with more than a minute to go the projection is spot plus the lean**; it detaches from spot only inside the settlement minute. The tile counts available proxy readings and reconstructed readings; these are estimates, not locked official observations.

**6.2 Its variance.** The index step taken `u` seconds from now feeds every settlement second after it, so with `c(u)` = number of future settlement seconds at least `u` ahead:

`Var = ( ∫ v(u)·c(u)² du ) / 60² + levelSd²`, `v(u) = σ_L² + (σ_S² − σ_L²)·e^(−u/180)`

(σ_S the 2-minute estimate, σ_L the 15-minute one: the quick estimate governs the next minutes and gives way to the slow one). The integral is evaluated exactly between future observation times, including fractional seconds. With σ_S = σ_L it equals `σ² Σ_j d_j (2(m−j)−1) / 60²` for zero-based ascending `j`. `levelSd` uses measured `basisSd` with a 0.5 floor and no upper cap when aligned to Kalshi, else 2.5 (typed target), 3 (synced), 6 (raw). The Student-t scale below still adds the deliberate margin; the display labels it model scale.

**6.3 Chance of Up.** `P(Up) = F_t4( (mean − (target − 0.005)) / sd )` with `F_t4(z) = ½ + z(z²+6) / (2(z²+4)^1.5)`, the Student-t CDF with 4 degrees of freedom (exact closed form). The 0.005 is the 2-decimal rounding of the settlement value. **Deliberate margin:** `sd` is used as the curve's *scale*, and a t(4) with scale `s` has standard deviation `s·√2`, so the shown chance is built on a spread 41% wider than measured (at +1 sd: 81% shown, 84% normal, 88.5% variance-matched). The variance-matched chance `F_t4(z·√2)` is recorded at every checkpoint and scored beside the shown one; **if it scores better over a few dozen windows, switch the display to it** (one-line change: `chance` → `chanceMatched`).

**6.4 Nowcast (lean).** Every 5 s, for the moment 30 s ago: `x1` = net flow (market buys − sells, spot + perp, $M) over the 30 s before it; `x2` = perp − spot ($, beyond the perp's learned offset) at it; `y` = spot's move over the 30 s after it. Least squares through the origin of `y` on `(x1, x2)` jointly, sums decayed with a 3-hour half-life, persisted (`nowcal`, kept 24 h). Closed form: `det = s11·s22 − s12²`, `b1 = (s22·s1y − s12·s2y)/det`, `b2 = (s11·s2y − s12·s1y)/det`, residual variance `(syy − b1·s1y − b2·s2y)/(n_eff − 3)` with `n_eff = n/6` for the 6× overlap of samples, `se(b1)² = resid·s22/det`, `se(b2)² = resid·s11/det`. Each slope is used only when `t ≥ 3` and positive; the perp slope is held at ≤ 1 (spot closes a gap, it does not overshoot). `lean = b1·x1 + min(1,b2)·x2`, capped at `±2·σ_S·√30`. Needs `n ≥ 120` (10 minutes) before it says anything. Checked in simulation: flow-only impact switches on the flow slope only; a spot that lags the perp switches on the perp slope only (its t-statistic reaches 3 after 20–30 simulated minutes); neither switches on nothing.

**6.5 Verdict.** Band: the chance recomputed over volatility × {0.7, 1, 1.5}, lean on/off, and spot shifted by ±σ_S·√10 (one sd of a 10-s move, for the time it takes to place the order); `lo`/`hi` of those 18 values. For a price `c` (cents) and fee `f = feeCents(c/100)`: `edge = p·100 − c − f`, `worst = p_lo·100 − c − f` (for Down use `1 − p` and `1 − p_hi`). **buy** if `worst ≥ 3`; **no** if `edge ≤ 0`; **thin** otherwise. Size on a buy: Kelly for a $1 binary at all-in cost `k = (c+f)/100`, `f* = (p_lo − k)/(1 − k)`; stake = min(2% of bankroll, ¼·f*·bankroll); contracts = floor(stake / k). Bankroll default $500 (the owner's stated figure), settable.

**6.6 Record.** Per window: `checks[600|300|120|60] = {p, p2 (variance-matched), ask, bid}` noted when the clock passes each mark (waits up to 5 s for a Kalshi quote); the first buy call per side (`price, p, worst, left, typed, n`). `closeAvg` and `proxyResult` are unofficial diagnostics requiring all 60 proxy readings; capture retries after 1.2 s for the closing tick. Only Kalshi's published yes/no sets `result` and `src: kalshi`, fetched 45 s, 150 s and 600 s after close; `expiration_value` is stored separately as `officialCloseAvg`. Legacy `src: page` outcomes migrate to diagnostics and pending official confirmation. Unsettled windows retry on load. Only official results enter Brier and buy-call P&L. Brier compares `p`, `p2`, and market mid `(bid+ask)/2`; the alternate model has its own sample count. Buy calls score one contract held to settlement: `win → 100 − c − f`, `loss → −c − f`. Kept in `localStorage` (300 windows). **Interpretation rule agreed with the owner:** until the model's Brier is below the market's over a few dozen windows, buy calls are a hypothesis, not an edge.

## 7. What was verified numerically (11 Oct 2026)

Independent implementations (scipy, numpy, Monte Carlo): the t(4) CDF matches `scipy.stats.t.cdf` to 6 decimals; the projection sd matches a 300k-path Monte Carlo with rising and falling volatility at 900 s, 44 s and 15 s to go (58.64 vs 58.69, 8.06 vs 8.05, 1.06 vs 1.06); Kelly matches numeric maximisation of expected log growth; the two-variable least squares and its t-stats match `numpy.lstsq` with covariance; `1.4826 × MAD` recovers a known sd; fees match Robinhood's example. One bug found and fixed: the last partial second of the horizon was dropped (sd 0 instead of $0.03 with 1 s to go).

## 8. What has NOT been verified, and known limits

- **Live message formats.** The **quote** channels have run on the owner's phone (the page showed spot from several exchanges and a target matching Kalshi's), and the earlier bot checked Coinbase, Kraken and Gemini REST quotes and Kalshi's responses against real data. The **trade** channels and all **liquidation** feeds were added on 11 Oct 2026 and follow documentation and AGGR's connectors; they were exercised against the simulator only and have not yet been seen live. The sandbox used to build this could not open WebSockets. **Diagnostics** prints each venue's last raw message when a connected feed yields nothing; that is how a wrong parser gets found.
- **OKX inverse/USDC contract values** are from memory (BTC-USD-SWAP 100 USD; BTC-USDC-SWAP 0.0001 BTC); BTC-USDT-SWAP's 0.01 BTC was verified.
- **Which liquidation venues answer from a US phone** is unknown until the chips show it (Binance will not).
- **Calibration is pending.** The √2 margin (6.3), the nowcast's 30-s horizon, the t ≥ 3 gates, the 2-sd lean cap and the band's multipliers are judgement calls; the record is there to decide them. Nothing has been fitted to real outcomes yet.
- **The spot is a top-of-book mid**, not BRTI's methodology (BRTI uses order-book depth). The level term absorbs the offset; the dynamics are assumed to match.
- **Public CORS proxy route** is slow (several seconds) and caches; the Worker route is the real one.
- **iOS:** Web Audio obeys the ring/silent switch; sockets drop when another app is in front (handled on return); the Wake Lock needs a tap.
- The paper bot's first live run (`python3 btc15_bot.py doctor`, then `run`) has not happened.

## 9. Checks (`test/`)

Playwright against a simulated market (`test/fake_market.py` replaces `WebSocket`, `fetch` and `AudioContext` before the page loads; the page's clock is driven with `page.clock`). Install: `pip install playwright && playwright install chromium`. Run from the repo root or `test/`:

- `python3 test/check_page.py` — feeds, flow, liquidations, target, Kalshi prices, verdicts, sounds, a sharp move with flow behind it, the settlement minute, phone-width layout. Writes `check_page.png`. ~3 min.
- `python3 test/check_model.py` — projection sum vs the old closed form, band and verdicts with sizing, a window rolling over, settlement by the page then by Kalshi, persistence across a reload. ~4 min.
- `python3 test/check_nowcast.py impact|lag|none` — the three calibration scenarios (20 simulated minutes each, ~5 real minutes; run in parallel).

Each browser script prints what it sees and ends with the page errors it caught (expect none); read the output. These simulator checks do not verify live feeds or network latency. The added assertion suite, `node --test tests/settlement.test.cjs`, runs actual page JavaScript with browser/network effects stubbed and checks settlement boundaries, gaps, fractional variance, official-only scoring and WAIT behavior. All 15 tests passed on 11 Oct 2026; the existing Playwright checks were not rerun for these corrections.

## 10. Conventions and constraints

- Edit `public/index.html`, then `cp public/index.html index.html`. Keep the page one self-contained file; no bundler, no framework. Dark theme only (read at night beside Robinhood's dark screen).
- Pushing to `main` deploys both hosts. Nothing to build.
- The Worker relays **only** `/markets/KXBTC15M-…` and `/live_data/events/KXBTC15M-…`, with CORS headers and no caching. Keep it read-only.
- Never paste a Kalshi private key, an ntfy topic, or any credential into a chat. Never scrape cfbenchmarks.com. Do not add automated order placement without the owner asking for it again.
- The owner reads on a phone: readouts are short, numbers tabular, one column.

## 11. Decisions and their reasons (so they are not re-litigated by accident)

- **BRTI constituents, not AGGR's blended price.** Settlement is on BRTI; AGGR's displayed price is a volume-weighted blend of many markets and sat ~$9 from Robinhood's number.
- **Level pinned to Coinbase**, offsets learned for the others, basis from Kalshi's feed: a calibration then means the same thing after a reload or a venue dropping out.
- **Freshness-weighted mean, not median**, for spot: a median froze on idle exchanges in quiet markets.
- **Quotes valid until replaced** while the socket is alive: exchanges push only on change; treating a 3-s-old quote as dead was emptying the consensus on the phone.
- **Projection = spot until the settlement minute**: a random walk's best forecast of every future second is the current price; the uncertainty, not the centre, is what shrinks.
- **Fat tails (t4) with a √2 margin**: a deliberate wider scale, recorded beside the variance-matched alternative so the data can overrule it. It does not impose a mathematical 98% confidence ceiling; the UI clamps displayed probabilities to 1–99%. All probabilities remain uncalibrated exchange-proxy estimates.
- **Flow and the perp enter only through a gated, capped, jointly fitted lean**: shown always, applied only when the relation is there. Nothing hand-tuned feeds the chance.
- **Buy = survives the worst case.** The owner is trading real money by hand; "buy" should be rare and right, "thin" is the honest middle.
- **Kelly ¼, 2% cap, $500 bankroll** carried over from the paper bot's agreed settings.
- **Trade automation deferred** at the owner's request; the API notes in section 3 are kept for when it returns.

## 12. Suggested next steps (discussed with the owner, in order)

1. **Collect 24/7**, not only while the phone is open: run the paper bot on a PC (it already records Kalshi's book, the feed and the exchanges) so the nowcast and the record reach a few dozen settled windows in days rather than weeks. This is also the path to automation.
2. **Order-book depth** (microprice and imbalance) from the five venues, the usual next signal after trade flow.
3. **Let the record decide** the √2 margin, the lean horizon and the gates, then simplify what loses.
4. If automation returns: a Kalshi demo-environment client (`external-api.demo.kalshi.co`), signed requests, limit orders at the price the verdict was made at, cancel after a minute — the alert text the paper bot already produces is the spec.
