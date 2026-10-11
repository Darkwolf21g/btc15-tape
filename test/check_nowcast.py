"""The nowcast calibration, three scenarios of 20 simulated minutes each (about 5 minutes of real
time per scenario; run them in parallel):

    python3 test/check_nowcast.py impact   # trades push price over the next 30 s -> flow slope on, perp off
    python3 test/check_nowcast.py lag 30   # spot venues quote 5 s behind the perp -> perp slope on (t reaches 3 in 20-30 min), flow off
    python3 test/check_nowcast.py none     # neither -> neither switches on
"""
import sys
from playwright.sync_api import sync_playwright
from fake_market import new_page, run_seconds

which = sys.argv[1] if len(sys.argv) > 1 else "impact"
minutes = int(sys.argv[2]) if len(sys.argv) > 2 else 20
with sync_playwright() as p:
    b, pg, errs = new_page(p, seconds_into_window=300)
    pg.evaluate("""(w) => { window.__drift = 0; window.__bitstampLive = true;
      setInterval(() => { window.__buyBias = Math.random() < 0.5 ? 0.2 : 0.8; }, 20000);   // bursts of one-sided flow
      if (w === 'impact') window.__impact = 4; if (w === 'lag') window.__lag = 5; }""", which)
    run_seconds(pg, 2)
    for i in range(minutes * 60):
        pg.clock.run_for(1000)
        if i % 300 == 299:
            print(f"  {which}: {i // 60 + 1} min:", pg.evaluate("() => { const st = calStats(); return st ? {n: cal.n.toFixed(0), flow: st.b1.toFixed(1) + ' $/$1M, t ' + st.t1.toFixed(1), flowOn: st.flowOn, perp: 'x' + st.b2.toFixed(2) + ', t ' + st.t2.toFixed(1), leadOn: st.leadOn} : {n: cal.n.toFixed(0)}; }"), flush=True)
    print("  flow line:", pg.evaluate("() => document.getElementById('flowLine2').textContent"))
    print("  projection:", pg.evaluate("() => document.getElementById('lvProjNote').textContent"))
    print("  errors:", errs)
    b.close()
