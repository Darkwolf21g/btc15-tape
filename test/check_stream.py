"""The streamed Kalshi data: official BRTI as spot, the official average, the settlement average as
the known part in the final minute, the required-price line, pushed prices, and the ages shown.

    python3 test/check_stream.py
"""
from playwright.sync_api import sync_playwright
from fake_market import new_page, run_seconds

probe = """() => ({spot: document.getElementById('lvSpot').textContent, spotNote: document.getElementById('lvSpotNote').textContent,
  avgNote: document.getElementById('lvAvgNote').textContent, proj: document.getElementById('lvProjNote').textContent,
  why: document.getElementById('why').textContent, p: document.getElementById('pBig').textContent, clock: document.getElementById('clock').textContent,
  market: [...document.querySelectorAll('.sg')].pop().textContent, edgeHead: document.getElementById('edgeHead').textContent})"""
with sync_playwright() as p:
    b, pg, errs = new_page(p, seconds_into_window=780)      # two minutes to go
    pg.evaluate("""() => { window.__stream = true; window.__kalshi = true; window.__kTarget = 82905; window.__kBid = 0.55; window.__kAsk = 0.57;
                          window.__curTicker = () => tickers(bounds(Date.now()/1000)[1])[1]; kalshi.relay = "https://relay.test"; kalshi.base = null; feed.fails = 0; feed.backoff = 1000; connectFeed(); }""")
    run_seconds(pg, 40)
    r = pg.evaluate(probe); print("streaming, 80 s to go:", r)
    print("basis learned from the stream:", pg.evaluate("() => [basisSrc, basis.toFixed(2), basisSd && basisSd.toFixed(2), levelSd()]"))
    print("stream counts:", pg.evaluate("() => feed.counts"), "pushAt fresh:", pg.evaluate("() => Date.now() - kalshi.pushAt < 5000"))
    run_seconds(pg, 50)
    r = pg.evaluate(probe); print("final minute:", {k: r[k] for k in ("clock", "proj", "why", "p")})
    print("official known part used:", pg.evaluate("() => { const pr = project(Date.now()/1000, bounds(Date.now()/1000)[1], 83000, sigmas(), []); return [pr.official, pr.observed, pr.m, lastNeed && lastNeed.toFixed(2)]; }"))
    # the stream drops: the page must fall back to the exchange proxy within a few seconds
    pg.evaluate("() => { window.__stream = false; if (feed.ws) feed.ws.close(); }")
    run_seconds(pg, 6)
    r = pg.evaluate(probe); print("stream lost:", {k: r[k] for k in ("spotNote", "avgNote", "market")})
    print("errors:", errs)
    b.close()
