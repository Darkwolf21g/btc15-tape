"""End-to-end check of the page on a busy simulated market: feeds, flow, liquidations, target, Kalshi
prices, verdicts, sounds, a sharp move, the settlement minute. Prints what it sees; the last line
lists page errors (should be empty). About 3 minutes.

    pip install playwright && playwright install chromium
    python3 test/check_page.py
"""
from playwright.sync_api import sync_playwright
from fake_market import new_page, run_seconds

probe = """() => ({p: document.getElementById('pBig').textContent, tgt: document.getElementById('lvTgt').textContent,
  tgtNote: document.getElementById('lvTgtNote').textContent, spot: document.getElementById('lvSpot').textContent,
  spotNote: document.getElementById('lvSpotNote').textContent, proj: document.getElementById('lvProjNote').textContent,
  why: document.getElementById('why').textContent, vUp: document.getElementById('vUp').textContent,
  flow: document.getElementById('flowLine').textContent, flow2: document.getElementById('flowLine2').textContent,
  whales: document.getElementById('whales').textContent, clock: document.getElementById('clock').textContent,
  sources: document.getElementById('sources').textContent, snd: document.getElementById('snd').textContent,
  scrollW: document.documentElement.scrollWidth})"""

with sync_playwright() as p:
    b, pg, errs = new_page(p, seconds_into_window=300)          # 8:05 PM, ten minutes to go
    run_seconds(pg, 3)
    r = pg.evaluate(probe); print("at 3 s:", {k: r[k] for k in ("flow", "sources")})
    print("subscriptions:", pg.evaluate("() => Object.fromEntries(Object.entries(window.__sent).map(([k, v]) => [k, v.filter(s => /subscribe/.test(s)).slice(0, 2)]))"))
    run_seconds(pg, 45)
    r = pg.evaluate(probe); print("at 48 s:", {k: r[k] for k in ("p", "spot", "spotNote", "flow", "flow2", "why")})
    print("events/min by venue:", pg.evaluate("() => Object.fromEntries(Object.keys(tstat).map(k => [k, eventsPerMin(k)]))"))
    print("replayed old trade dropped:", pg.evaluate("() => { let big = 0; for (const f of flow.values()) if (f.b > 400000) big++; return big === 0; }"))
    # a typed target and the sound button
    pg.evaluate("() => { document.getElementById('tgtIn').value = (window.__price() - 40).toFixed(2); document.getElementById('tgtSet').click(); document.getElementById('snd').click(); }")
    run_seconds(pg, 1)
    print("sound:", pg.evaluate("() => [document.getElementById('snd').textContent, window.__tones]"))
    # Kalshi reachable, with an edge on Up
    pg.evaluate("() => { window.__kalshi = true; window.__kTarget = window.__price() - 40; window.__kBid = 0.50; window.__kAsk = 0.52; kalshi.base = null; kalshi.ok = null; pollKalshi(); }")
    run_seconds(pg, 8)
    r = pg.evaluate(probe); print("with Kalshi:", {k: r[k] for k in ("p", "tgt", "tgtNote", "vUp")}, "tones:", pg.evaluate("() => window.__tones"))
    # a sharp move with heavy buying behind it
    pg.evaluate("() => { window.__buyBias = 0.95; window.__drift = 1.5; window.__fast = true; }")
    run_seconds(pg, 10)
    pg.evaluate("() => { window.__buyBias = 0.5; window.__drift = 0.06; window.__fast = false; }")
    r = pg.evaluate(probe); print("sharp move:", {k: r[k] for k in ("why", "flow")})
    run_seconds(pg, 200)
    r = pg.evaluate(probe); print("later:", {k: r[k] for k in ("sources", "flow2", "clock")})
    print("liquidations by venue:", pg.evaluate("() => liqs.reduce((a, l) => { a[l.key] = (a[l.key] || 0) + 1; return a; }, {})"), "binance failures:", pg.evaluate("() => venue.binance.fails"))
    print("diagnostics:\n" + pg.evaluate("() => diagnostics(Date.now()/1000, bounds(Date.now()/1000)[0])"))
    # into the settlement minute
    left = pg.evaluate("() => bounds(Date.now()/1000)[1] - Date.now()/1000")
    run_seconds(pg, int(left) - 30)
    r = pg.evaluate(probe); print("settlement minute:", {k: r[k] for k in ("clock", "proj", "why")}, "tones:", pg.evaluate("() => window.__tones"))
    print("fits a phone:", r["scrollW"] <= 400)
    pg.screenshot(path="check_page.png", full_page=True)
    print("errors:", errs)
    b.close()
