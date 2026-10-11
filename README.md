# BTC 15 Tape

Live view of the BTC 15-minute event contract (Robinhood "BTC 15 min", settled on Kalshi): spot from the exchanges behind the index, the 60-second settlement average, the target, and a modelled chance of Up. Open `index.html` in a browser, or use the hosted page. Not financial advice.

## Exact Kalshi data (optional)

Browsers are not allowed to read Kalshi directly, so by default the page estimates the target and asks you to type it. A small relay of your own fixes that: the page then shows the exact target, the official 60-second average and Kalshi's own Up price.

1. Sign up at cloudflare.com (free).
2. Workers & Pages → Create → Start with Hello World → Deploy.
3. Edit code, replace everything with the contents of `worker.js`, Deploy again.
4. Copy the worker's address (`https://….workers.dev`) and paste it into the page under **Target and calibration** → **Use relay**.

The relay forwards only two public, read-only requests and involves no account or key.
