"""Deterministic dashboard interaction checks and review screenshots; no production data."""
import sys
import argparse
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'test'))
import fake_market as f
OUT=ROOT/'docs/ui';OUT.mkdir(parents=True,exist_ok=True)

def warm(page):
    page.evaluate("""() => {window.__kalshi=true;window.__stream=true;window.__kTarget=82900;window.__kBid=.4;window.__kAsk=.5;kalshi.relay='https://fixture.test';kalshi.base=null;connectFeed();pollKalshi();}""")
    f.run_seconds(page,75)

with sync_playwright() as pw:
    parser=argparse.ArgumentParser()
    parser.add_argument('--capture-only',action='store_true',help='Refresh overview captures without repeating interaction checks')
    parser.add_argument('--before-ref',help='Git revision to capture as the current-state reference')
    args=parser.parse_args()
    if args.before_ref:
        baseline=tempfile.NamedTemporaryFile(suffix='.html')
        baseline.write(subprocess.check_output(['git','show',args.before_ref+':public/index.html'],cwd=ROOT));baseline.flush()
        before=Path(baseline.name)
        original=f.PAGE;f.PAGE=before
        for width,name in [(390,'mobile'),(1440,'desktop')]:
            b,page,errors=f.new_page(pw,width=width,height=900);warm(page)
            page.screenshot(path=str(OUT/f'before-{name}.png'),full_page=True,scale='css');b.close()
        f.PAGE=original
        baseline.close()
    for width,name in [(390,'mobile'),(768,'tablet'),(1440,'desktop')]:
        b,page,errors=f.new_page(pw,width=width,height=900)
        assert page.locator('#tradeStatus').inner_text() in ['Reconnecting','Connecting']
        warm(page)
        assert '%' in page.locator('#fairUp').inner_text()
        assert '¢' not in page.locator('#fairUp').inner_text()
        assert 'Bid 40.0¢' in page.locator('#marketUp').inner_text()
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(OUT/f'after-{name}.png'),full_page=True,scale='css')
        if args.capture_only:
            b.close()
            continue
        page.locator('#rhUp').fill('48')
        quote_y=page.locator('#rhUp').bounding_box()['y']
        f.run_seconds(page,5)
        assert page.locator('#rhUp').input_value()=='48'
        assert abs(page.locator('#rhUp').bounding_box()['y']-quote_y)<2, 'live updates shifted the active quote'
        assert page.locator('#rhUp').evaluate('(el)=>el===document.activeElement')
        f.run_seconds(page,16)
        assert 'expired' in page.locator('#quoteUpSource').inner_text()
        assert 'refresh' in page.locator('#vUp').inner_text()
        page.locator('#chartFocus').click();page.locator('#chartDelta').click()
        page.locator('#main').focus();page.keyboard.press('ArrowLeft')
        assert 'ET' in page.locator('#chartReadout').inner_text()
        page.locator('#main').click(position={'x':100,'y':100})
        assert 'ET' in page.locator('#chartReadout').inner_text()
        if width<600:
            page.locator('#main').tap(position={'x':150,'y':100})
            assert 'ET' in page.locator('#chartReadout').inner_text()
        for section in ['flowBox','probBox','settlementBox','srcbox','recordBox','diag','setup']:
            page.locator(f'#{section}>summary').click()
            assert page.locator(f'#{section}').evaluate('(el)=>el.open')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),section
        if name=='mobile': page.screenshot(path=str(OUT/f'expanded-{name}.png'),full_page=True,scale='css')
        page.locator('a[href="#analytics"]').click()
        assert page.evaluate('location.hash')=='#analytics'
        page.locator('a[href="#overview"]').click()
        assert page.evaluate('location.hash')=='#overview'
        page.locator('.lv.tgt').focus();page.keyboard.press('Enter')
        assert page.locator('#askIn').evaluate('(el)=>el===document.activeElement')
        page.locator('#askIn').fill('82901')
        f.run_seconds(page,2)
        assert page.locator('#askIn').input_value()=='82901'
        assert page.locator('#askIn').evaluate('(el)=>el===document.activeElement')
        page.locator('#askSet').click()
        assert page.locator('#ask').is_hidden()
        # Rollover may invalidate a quote but must preserve the focused input.
        page.locator('#rhUp').fill('49');page.evaluate('lastMk="previous-window";render()')
        assert page.locator('#rhUp').input_value()=='49'
        assert page.locator('#rhUp').evaluate('(el)=>el===document.activeElement')
        page.evaluate('kalshi.market.status="inactive";kalshi.market.statusAt=Date.now();render()')
        assert page.locator('#tradeStatus').inner_text()=='Market closed'
        assert 'WAIT' in page.locator('#vUp').inner_text()
        page.evaluate('feed.brti.t=Date.now()-60000;render()')
        assert page.locator('#tradeStatus').inner_text()=='Data stale'
        assert 'paused' in page.locator('#statusReason').inner_text()
        # Pending settlement is distinct from a current-market forecast.
        page.evaluate("record.windows.push({mk:'previous',close:Date.now()/1000-1,checks:{},buys:[],result:null});render()")
        assert 'settlement pending' in page.locator('#settlementState').inner_text()
        page.evaluate("Object.assign(record.windows.at(-1),{src:'kalshi',result:'yes',officialCloseAvg:82920});render()")
        assert 'confirmed by Kalshi' in page.locator('#settlementState').inner_text()
        assert 'actual average' in page.locator('#settlementState').inner_text()
        assert not errors,errors
        b.close()
print('Overview captures saved' if args.capture_only else 'PASS: 390/768/1440px, quote editing/expiry/rollover, charts, disclosures, market-closed and stale gates; fixture screenshots saved')
