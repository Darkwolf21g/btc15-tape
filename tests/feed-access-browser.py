"""BRTI authentication recovery in the actual UI; all market traffic is simulated."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'test'))
import fake_market as f

with sync_playwright() as pw:
    for width in [390, 1440]:
        browser, page, errors = f.new_page(pw, width=width, height=900)
        page.evaluate('''() => {
          window.fixtureFetch = window.fetch; window.accessChecks = 0;
          window.fetch = (url, options) => {
            if (String(url).includes('/feed/status')) {
              window.accessChecks++;
              return Promise.resolve(new Response('token', {status:403}));
            }
            return window.fixtureFetch(url, options);
          };
          resetFeed();
        }''')
        f.run_seconds(page, 3)
        assert page.locator('#tradeStatus').inner_text() == 'BRTI access needed'
        assert 'requires a stream token' in page.locator('#statusReason').inner_text()
        assert 'paused' in page.locator('#statusReason').inner_text()
        checks = page.evaluate('window.accessChecks')
        f.run_seconds(page, 30)
        assert page.evaluate('window.accessChecks') == checks, 'rejected token kept retrying'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        if width == 390:
            page.screenshot(path=str(ROOT / 'docs/ui/brti-access-mobile.png'), full_page=True)
        page.locator('#feedAccess').click()
        assert page.locator('#setup').evaluate('(el) => el.open')
        assert page.locator('#feedTokIn').evaluate('(el) => el === document.activeElement')
        assert page.locator('#feedTokIn').get_attribute('type') == 'password'
        page.locator('#feedTokIn').fill('invalid-fixture-token')
        f.run_seconds(page, 3)
        assert page.locator('#feedTokIn').input_value() == 'invalid-fixture-token'
        page.keyboard.press('Enter')
        f.run_seconds(page, 2)
        assert 'rejected the saved stream token' in page.locator('#statusReason').inner_text()
        assert page.locator('#feedTokIn').input_value() == ''
        # Restore the simulated feed; saving a corrected token starts it immediately.
        page.evaluate('''() => {
          window.fetch = window.fixtureFetch; window.__stream = true;
          window.__kalshi = true; window.__kTarget = 82900;
          window.__kBid = .4; window.__kAsk = .5;
        }''')
        page.locator('#feedTokIn').fill('valid-fixture-token')
        page.locator('#feedTokSet').click()
        f.run_seconds(page, 3)
        assert page.evaluate('feed.state') == 'open'
        assert page.locator('#feedAccess').is_hidden()
        assert 'BRTI live' in page.locator('#healthFeed').inner_text()
        assert 'official BRTI' in page.locator('#lvSpotNote').inner_text()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        browser.close()
print('PASS: 390/1440px BRTI token prompt, retry suppression, editable masked token, rejection and live recovery')
