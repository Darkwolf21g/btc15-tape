"""Browser smoke tests using explicit local fixtures; never contacts production."""
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "test"))
from fake_market import new_page, run_seconds

OUT = ROOT / ".audit-artifacts"
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    # Exercise the actual tape with deterministic exchange/BRTI fixtures.
    browser, page, errors = new_page(p, seconds_into_window=300, width=390, height=844)
    page.evaluate("""() => {
      window.__kalshi=true; window.__stream=true; window.__kTarget=82900;
      window.__kBid=.4; window.__kAsk=.5; kalshi.relay='https://fixture.test';
      kalshi.base=null; connectFeed(); pollKalshi();
    }""")
    run_seconds(page, 75)
    assert "%" in page.locator("#pBig").inner_text(), "official model did not warm up"
    assert "60/60" in page.locator("#lvAvgNote").inner_text()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "tape overflow"
    page.screenshot(path=str(OUT / "tape-mobile.png"), full_page=True)
    page.evaluate("""() => {
      kalshi.market.status='inactive'; kalshi.market.statusAt=Date.now(); render();
    }""")
    assert "WAIT" in page.locator("#vUp").inner_text()
    assert not errors, errors
    browser.close()

    # Independent agent UI fixture. All API requests are intercepted explicitly.
    browser = p.chromium.launch(executable_path=os.environ.get("BTC15_TEST_CHROMIUM"))
    page = browser.new_page(viewport={"width":390,"height":844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    now = 1800000900000
    coverage = {"observedSlots":1,"elapsedSlots":6,"missedSlots":5,"maxEvaluationGapMs":None,
                "windows":[{"startAt":now,"observedSlots":1,"elapsedSlots":6,"missedSlots":5}]}
    report = {"looks":1,"eligible":0,"attempts":0,"wins":0,"losses":0,"feesCents":0,
              "drawdownCents":0,"pnlCents":0,"entryFills":0,"exitFills":0,"open":0,
              "reasons":{"fixture skip":1},"coverage":coverage,"model":"brti-driftless-v4",
              "settlementConvention":"[close-60s,close)","skippedDecisions":1,"fillDelayMs":None}
    session = {"id":"browser-fixture","status":"running","version":"paper-session-v2",
               "startAt":now,"endAt":now+3600000,"stoppedAt":None,"pending":None}
    status = {"session":session,"report":report,"now":now+30000}
    fail_session = False

    def route(r):
        path = urlparse(r.request.url).path
        if path == "/agent.html":
            r.fulfill(content_type="text/html", body=(ROOT / "public/agent.html").read_text())
        elif path == "/paper-session/status":
            r.fulfill(status=503 if fail_session else 200, content_type="application/json",
                      body=json.dumps({"error":"fixture outage"} if fail_session else status))
        else:
            # Deliberately unavailable legacy/research services: session still refreshes.
            r.abort()

    page.route("**/*", route)
    page.goto("https://fixture.test/agent.html", wait_until="domcontentloaded")
    page.wait_for_function("document.getElementById('sessionCoverage').textContent.includes('5 missed')")
    assert page.locator("#sessionPnl").inner_text() == "+$0.00"
    assert page.locator("#sessionStop").is_enabled()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "agent overflow"
    page.screenshot(path=str(OUT / "agent-mobile.png"), full_page=True)
    fail_session = True
    page.evaluate("refreshSession()")
    assert "STALE" in page.locator("#sessionStatus").inner_text()
    assert page.locator("#sessionPnl").inner_text() == "—"
    assert page.locator("#sessionStart").is_disabled()
    assert page.locator("#sessionStop").is_enabled()
    assert not errors, errors
    browser.close()

print("Browser fixtures PASS: tape warm-up, contract gate, mobile overflow, independent session and stale-state controls")
