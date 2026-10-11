# BTC 15 Tape

Live view of the BTC 15-minute event contract (Robinhood "BTC 15 min", settled on Kalshi): spot from the exchanges behind the index, the 60-second settlement average, the target, a modelled chance of Up, and the order flow behind the price. Open `index.html` in a browser, or use the hosted page. Not financial advice.

## What is on the page

- **Spot and the 60-second average.** Spot is one price from the five exchanges in the CF Benchmarks BRTI index (Coinbase, Kraken, Bitstamp, Gemini, Crypto.com), each one's usual distance from the others taken off. The blue line is the trailing 60-second average, the quantity the contract settles on and the number Robinhood shows. The perpetual future on Hyperliquid is drawn as a lead line.
- **Chance of Up.** A random walk from spot to the closing average, against the target, with fat tails. Volatility is measured two ways, over the last two minutes and the last fifteen, and the quick one gives way to the slow one along the horizon. The level's uncertainty against the official index is measured from Kalshi's own average feed. The chance comes with a band: what it would be with volatility 30% lower or 50% higher, the lean off, and a one-sd adverse move while the order is placed.
- **Buy, thin, no.** The Up/Down boxes compare the chance with Kalshi's prices after Robinhood's fees. *Buy* means 3¢ is left at the bad end of the band, and comes with a quarter-Kelly size capped at 2% of the bankroll (set in the calibration panel). *Thin* means an edge at the model's chance only. *No* means none.
- **Record.** At 10, 5, 2 and 1 minutes before each close the page notes its chance and Kalshi's price; when the market settles it scores both (Brier) and every buy call as one contract held to settlement. Kept in the browser; the Record panel lists the last 25 windows.
- **Order flow.** Every trade on the six venues, sorted by who crossed the spread. Bars are net buying or selling per 5 or 10 seconds, the line is the running total since the open, prints of $200k and up are listed. The page also fits, as it runs, how far spot moves in the next 30 seconds against the last 30 seconds of net flow and the perp's gap to spot; each enters the projection only once its own relation is clear (the flow line says when the lean is on).
- **Liquidations** from Bybit, OKX, Deribit and BitMEX (Binance refuses US connections): longs liquidated is forced selling, shorts liquidated is forced buying.
- **Sound.** Tap Sound once. Two rising or falling notes on a sharp move, three notes when Kalshi's price leaves a 3¢ edge, one low note at a minute to go.

## Exact Kalshi data

Browsers are not allowed to read Kalshi directly, so on its own the page estimates the target. Deployed as a Cloudflare Worker (free), the same repo serves the page and relays two read-only Kalshi requests, and the page then shows the exact target, the official 60-second average and Kalshi's own prices.

1. Sign up at cloudflare.com and connect your GitHub account.
2. Workers & Pages → Create → **Import a repository** → choose `btc15-tape` → Deploy. The settings are in `wrangler.jsonc`.
3. Open the Worker's address (`https://btc15-tape.<your-subdomain>.workers.dev`). That is the page, with Kalshi data built in.

`public/index.html` is the page the Worker serves; the copy at the repo root is what GitHub Pages serves. Keep them identical.

## If a feed shows nothing

The exchange message formats were taken from each exchange's documentation and the open-source AGGR project, not tried against every venue live. If a chip says "no trades" or a liquidation venue never counts anything while connected, open Diagnostics: it prints the last message that venue sent, which is enough to fix the parser.
