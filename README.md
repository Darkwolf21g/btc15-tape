# BTC 15 Tape

Live view of the BTC 15-minute event contract (Robinhood "BTC 15 min", settled on Kalshi): spot from the exchanges behind the index, the 60-second settlement average, the target, and a modelled chance of Up. Open `index.html` in a browser, or use the hosted page. Not financial advice.

## Exact Kalshi data

Browsers are not allowed to read Kalshi directly, so on its own the page estimates the target. Deployed as a Cloudflare Worker (free), the same repo serves the page and relays two read-only Kalshi requests, and the page then shows the exact target, the official 60-second average and Kalshi's own prices.

1. Sign up at cloudflare.com and connect your GitHub account.
2. Workers & Pages → Create → **Import a repository** → choose `btc15-tape` → Deploy. The settings are in `wrangler.jsonc`.
3. Open the Worker's address (`https://btc15-tape.<your-subdomain>.workers.dev`). That is the page, with Kalshi data built in.

`public/index.html` is the page the Worker serves; the copy at the repo root is what GitHub Pages serves. Keep them identical.
