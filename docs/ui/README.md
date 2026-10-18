# Dashboard UI review

The tape now starts with the active market, remaining time, current BTC price, target, distance and projected settlement average. A status panel explains the existing trading gates. One primary chart stays visible; flow, liquidations, probability history, settlement, feed details, performance and diagnostics expand separately.

Model probabilities use percent. Kalshi bid/ask prices and manual quote overrides use cents, with separate provenance and freshness labels. The dashboard provides signals; agent controls and execution remain on the existing agent page.

## Screenshots

These are deterministic simulated market data, captured in Chromium from the actual application. They are not production prices or evidence of model performance. Baseline: commit `8188259`.

| Viewport | Before | After |
| --- | --- | --- |
| 390px mobile | [Before](before-mobile.png) | [After](after-mobile.png) |
| 1440px desktop | [Before](before-desktop.png) | [After](after-desktop.png) |
| 768px tablet | — | [After](after-tablet.png) |

[Expanded mobile sections](expanded-mobile.png)

## Verification

- `npm test` — existing unit suite, including forecast, settlement, status gates, fees and paper execution.
- `npm run check` — JavaScript syntax and canonical model/page mirror checks.
- `BTC15_TEST_CHROMIUM=/usr/bin/chromium python tests/browser-smoke.py` — tape warm-up, complete trailing average, inactive-market gate, agent session and stale-state controls.
- `BTC15_TEST_CHROMIUM=/usr/bin/chromium python tests/dashboard-browser.py` — 390/768/1440px overflow; quote editing, focus, expiry and rollover; touch/pointer/keyboard chart inspection; navigation; target editing; expanded charts and sections; stale/closed states; pending/confirmed settlement. Also asserts live updates do not move the active quote input.
- Add `--before-ref 8188259` to regenerate the baseline screenshots alongside the current UI.

The browser fixture serves local HTML at an intercepted HTTPS test origin and pauses its clock before loading. No live API data is used by these regression tests. Hidden average content is checked with `text_content()` because it now lives in a disclosure. The existing positive-verdict assertion follows the new “Qualifies” label.

## Behavior fixes and limits

The closing-average presentation fix from main `15c522d` is retained: uncertainty bars at the close, separate from the trailing average, with sub-dollar precision and held-estimate labeling. Its regression tests are also retained. Calculation, probability, fee, sizing and trade-eligibility formulas are unchanged. At rollover a focused quote is retained and explicitly expired; it must be edited to become fresh in the new market. Non-focused quotes still clear. Chart extents now include observed history and series are clipped to the plot, preventing historical prices from entering the time axis. Lines and market bands break at missing samples instead of connecting across outages.

A separate Chromium check loaded the modified HTML over the production origin without deploying it: exchange prices updated over 24 seconds, the manual quote retained its value and focus, and no JavaScript errors occurred. The official BRTI WebSocket returned HTTP 403 in the fresh unauthenticated session; the dashboard correctly withheld forecasts and signals. Authenticated BRTI states were covered by fixtures. The proxy and TLS verification stayed enabled.

Browser checks use Chromium with emulated touch. Physical iPhone/Safari behavior and live order execution have not been tested. The existing agent page remains accessible and its smoke tests pass; this change focuses on the tape dashboard.

## BRTI access recovery

The production `/feed/status` endpoint returned HTTP 403 with `token` for a fresh unauthenticated session. A rejected WebSocket handshake previously appeared as an endless reconnect. The client now confirms that rejection through the protected status endpoint, pauses retries, and displays a masked token field through a visible setup action. Saving a corrected token reconnects immediately; delayed responses from the previous connection cannot overwrite the new connection. Network failures still retry with backoff. Authentication, calculation logic and trading modes are unchanged.

The combined release retains main's BRTI replica, shared collector failure details and unlisted-market 404 handling from #21–23. The replica remains research context in Detailed analytics; its values do not replace official BRTI or feed the trading model.

`tests/feed-access.test.cjs` covers rejection, network errors and connection races. `BTC15_TEST_CHROMIUM=/usr/bin/chromium python tests/feed-access-browser.py` passed at 390px and 1440px, including editable token preservation, wrong-token feedback and recovery to official BRTI using fixtures. [Mobile access state](brti-access-mobile.png). An authenticated production BRTI stream still requires the relay's existing FEED_TOKEN; no production credential was available for this verification.
