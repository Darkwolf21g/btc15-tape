# Engineering review — October 16, 2026

Base: GitHub main `77eb7741a34c05d636241cf8b16f3f39a35934d9`. No AGENTS.md is present in the repository tree. HANDOFF.md, README.md and RESEARCH.md describe conventions and superseding release notes. Earlier review artifacts and source files were preserved separately.

## Application and scope

The application serves self-contained tape and agent pages from a Cloudflare Worker. The root/public page copies must match. Canonical model/research/session JavaScript is embedded by scripts/sync-model.cjs. A single SQLite Durable Object holds the read-only authenticated Kalshi stream, book state, research captures and paper records. Durable alarms and a one-minute cron watchdog support collection without a browser. The main flows are tape monitoring, checkpoint research/export, a legacy paper agent, an explicitly started four-window timed paper session, and separate manually controlled demo API tests.

Production mutations are rejected in signedCall; timed-session arrivals simulate against fresh depth and original limits. FEED_TOKEN protects controls. Model v4 uses [close-60s,close), and official published market results alone settle paper trades. These controls were preserved. No real or demo order was submitted, no secret changed, and no deployment performed.

## Prioritized findings and fixes

| Priority | Finding | Impact and change | Code |
| --- | --- | --- | --- |
| High | A session evaluation awaited market and exchange REST calls sequentially, each with a 12-second timeout; outcome reads preceded both. | Slow reads could consume many five-second opportunities and invalidate a queued fill. The session now starts all relevant reads concurrently with a shared 2,000ms abort signal, propagated through signedGet/signedCall/timedFetch. Failures remain skips/no-fills; outcome failures leave positions pending. This addresses a plausible source of long gaps, not a verified attribution of the old session's 30-second gap. | worker.js: SESSION_READ_BUDGET_MS, timedFetch, signedGet, signedCall, KalshiFeed.sessionTick |
| High | Counts of recorded looks did not reveal completely missed evaluations. | Report now measures finished five-second bins, empty bins and duplicate observations separately, including per-window counts. Evaluated decisions without intent remain separate from missed slots. No historical forecasts are invented. | shared-session.js: coverage, report |
| Medium | Session records omitted the target and volatility values returned by the snapshot function. | New decision records retain target, actual receipt time, volatility, p2, forecast status and metadata-read timing. Filled/no-fill arrivals retain their own read timing. Existing records are not backfilled. | shared-session.js: decide, arrive; worker.js: sessionTick |
| Medium | Periodic session refresh depended on a successful legacy trade/status response; failures could leave old result tiles visible. | Session polling runs independently every five seconds with an overlap guard. Failed refreshes mark status stale, clear result tiles and disable starting until a successful refresh. Manual stop remains available. | public/agent.html: refreshSession, refresh and polling setup; mirrored agent.html |

## Baseline and validation

Git clone and npm ci fail at the environment's configured network proxy. GitHub connector access works. Text source bytes were verified against GitHub blob hashes before creating a separate local Git branch. The review branch is based on the current main tree through GitHub's Git-data API, preserving binary assets and unchanged files. No previous uncommitted work was overwritten.

Baseline: 145 regression tests passed using `node --test --test-isolation=none tests/*.test.cjs`; npm test and npm run check also passed. There are no separate lint or TypeScript scripts/configurations. The normal Node 24 test invocation reports file-level summaries in this environment, so the nonisolated run is used to enumerate assertions.

Added regression tests cover parallel reads, caller abort propagation, timeout skips/no-fills, actual target receipt timing, outcomes in the same batch, missed/duplicate/unfinished bins, pre-start/manual/late automatic stops, all 720 synthetic slots, retained decision evidence and fill latency. Agent-script tests exercise coverage rendering, stale tiles and overlapping polls. Existing tests continue to cover manual stop during reads, persisted revision races, cohort boundaries, official settlement, delayed depth fills, fees and exits.

Final deterministic validation: all 156 tests passed (145 baseline plus 11 regressions), npm test passed, npm run check passed, and git diff --check passed. An attempted real Chromium mobile check could not launch: the sandbox rejected crashpad's setsockopt operation and Chromium exited with SIGTRAP before loading the page. Browser layout is therefore unverified; the three agent-script tests passed.

The dependency-based workerd build/runtime, alarm and WebSocket checks remain blocked by npm installation. Runtime compatibility and live timing must be verified before any deployment approval. Unit fixtures do not establish live coverage or profitability.

## Remaining work and limits

- Five-second scheduling still uses the actual last evaluation plus 5,000ms. This PR preserves that policy rather than silently introducing a different strategy schedule. Alarm, storage and upstream latency can still produce misses; the new report exposes them. An anchored schedule needs a separately documented policy and prospective comparison.
- The shared two-second read budget is an explicit operational policy (`session-reads-v1`), not a measured ideal timeout. Keep older/unattributed reads separate when comparing fill performance. A deployment during an existing compatible session can mix read policies, identified in its individual look/attempt records.
- Every decision retains derived inputs, not its full raw one-Hz buffer. Checkpoint research's separate raw-input retention does not make every session replayable. Per-look raw retention would need bounded, separately chunked storage; embedding full buffers in the existing 20-look chunks risks storage-value limits.
- No new authenticated dashboard run was started. This environment has no configured Cloudflare or feed credentials, and its proxy prevents direct requests. The legacy export named in the conversation is absent. Its losing trade and 30-second gap were not reconstructed or used to tune thresholds.
- The one-hour current-version trial, official settlement completion and measured entries/exits, fees, net P&L and drawdown remain operational validation after explicit deployment approval and working access. The older v1 session remains a separate cohort.
- The default-public feed/read endpoints remain optional-token protected as designed; credentialed users should retain the deployed FEED_TOKEN. This review did not change authentication or claim a comprehensive penetration test or dependency vulnerability scan.
