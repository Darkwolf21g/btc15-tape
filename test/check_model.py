"""Checks of the model and the record: the projection's variance against the closed form it replaced,
the chance band and the buy/thin/no verdicts with sizing, a window rolling over, unofficial proxy
capture and then Kalshi's result, persistence across a reload. About 4 minutes.

    python3 test/check_model.py
"""
import json
from playwright.sync_api import sync_playwright
from fake_market import new_page, run_seconds

probe = """() => ({p: document.getElementById('pBig').textContent, fairUp: document.getElementById('fairUp').textContent,
  fairDown: document.getElementById('fairDown').textContent, vUp: document.getElementById('vUp').textContent,
  vDown: document.getElementById('vDown').textContent, rec: document.getElementById('recLine').textContent,
  proj: document.getElementById('lvProjNote').textContent, clock: document.getElementById('clock').textContent})"""

with sync_playwright() as p:
    b, pg, errs = new_page(p, seconds_into_window=300)
    pg.evaluate("() => { window.__kalshi = true; window.__kTarget = 82905; window.__kBid = 0.50; window.__kAsk = 0.52; }")
    run_seconds(pg, 50)
    print("projection: new variance sum vs the old closed form (equal volatilities must agree):", pg.evaluate("""() => {
      const now = Date.now()/1000, [open, close] = bounds(now), sig = 2.0;
      const newer = project(now, close, 83000, {s: sig, l: sig}, []);
      let ahead = []; for (let s = close - SETTLE + 1; s <= close; s++) if (s > now) ahead.push(s - now);
      const m = ahead.length; let walk = 0; ahead.forEach((d, j) => { walk += d * (2 * (m - (j + 1)) + 1); });
      const oldSd = Math.sqrt(sig * sig * walk / 3600 + levelSd() ** 2);
      const burst = project(now, close, 83000, {s: 2 * sig, l: sig}, []), calm = project(now, close, 83000, {s: sig, l: 2 * sig}, []);
      const leaned = project(now, close, 83000, {s: sig, l: sig}, [[10, 30]]);
      return {newSd: newer.sd.toFixed(3), oldSd: oldSd.toFixed(3), burstNowSd: burst.sd.toFixed(2), calmNowSd: calm.sd.toFixed(2), leanShift: (leaned.mean - newer.mean).toFixed(3)};
    }"""))
    r = pg.evaluate(probe); print("verdicts at 52c/50c:", {k: r[k] for k in ("p", "fairUp", "fairDown", "vUp", "vDown", "proj")})
    pg.evaluate("() => { window.__kBid = 0.20; window.__kAsk = 0.22; }")
    run_seconds(pg, 5)
    r = pg.evaluate(probe); print("Up offered at 22c:", {k: r[k] for k in ("p", "vUp", "vDown")})
    print("record during the window:", pg.evaluate("() => JSON.stringify(record.cur)"))
    left = pg.evaluate("() => bounds(Date.now()/1000)[1] - Date.now()/1000")
    mk = pg.evaluate("() => tickers(bounds(Date.now()/1000)[1])[1]")
    run_seconds(pg, int(left) + 2)
    pg.evaluate("(mk) => { window.__pastResult = {[mk]: 'yes'}; }", mk)      # Kalshi settles the market
    run_seconds(pg, 3)
    w = json.loads(pg.evaluate("(mk) => JSON.stringify(record.windows.find(w => w.mk === mk))", mk))
    print("unofficial proxy capture:", w.get("proxyResult"), "official", w["result"], w["src"], "proxy close", w["closeAvg"], "checks", sorted(w["checks"]), "buys", [(x["side"], x["price"]) for x in w["buys"]])
    run_seconds(pg, 50)
    w = json.loads(pg.evaluate("(mk) => JSON.stringify(record.windows.find(w => w.mk === mk))", mk))
    print("settled by Kalshi:", w["result"], w["src"])
    print("record line:", pg.evaluate(probe)["rec"])
    print("record panel:\n" + pg.evaluate("() => recordText()"))
    pg.reload(); pg.clock.run_for(3000); pg.wait_for_timeout(200)
    print("after a reload:", pg.evaluate("() => [record.windows.length, record.windows[0].result, record.windows[0].src, bankroll]"))
    pg.evaluate("() => { document.getElementById('bankIn').value = '1000'; document.getElementById('bankSet').click(); }")
    print("bankroll set:", pg.evaluate("() => [bankroll, localStorage.getItem('btc15tape.bankroll')]"))
    print("errors:", errs)
    b.close()
