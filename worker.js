// Kalshi relay for the BTC 15 Tape page. Runs as a Cloudflare Worker (free tier is plenty).
//
// Browsers are not allowed to read Kalshi's API directly. This forwards two public, read-only
// requests (the BTC 15-minute market record and its 60-second-average feed) and adds the header
// browsers need. Nothing else is forwarded, and no account or key is involved.
//
// Deployed from the GitHub repo (wrangler.jsonc), the Worker also serves the page itself, so the
// page and its relay share one address and nothing needs pasting. Pasting the Worker's address into
// another copy of the page (under "Target and calibration") works too.

const UPSTREAMS = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2"];
const ALLOWED = [/^\/markets\/KXBTC15M-[A-Z0-9-]+$/, /^\/live_data\/events\/KXBTC15M-[A-Z0-9]+$/];
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Cache-Control": "no-store"};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (request.method === "OPTIONS") return new Response(null, {headers: CORS});
    if (request.method !== "GET" || !ALLOWED.some(re => re.test(path))) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);     // the page and its files
      return new Response("not found", {status: 404, headers: CORS});
    }
    let last = null;
    for (const base of UPSTREAMS) {
      for (let attempt = 0; attempt < 2; attempt++) {           // one quick retry per upstream
        try {
          const up = await fetch(base + path, {headers: {"Accept": "application/json",
                                                         "User-Agent": "Mozilla/5.0 (compatible; btc15-tape relay)"},
                                               cf: {cacheTtl: 0, cacheEverything: false}});
          const body = await up.text();
          if (up.ok) return new Response(body, {status: 200, headers: {...CORS, "Content-Type": "application/json"}});
          last = new Response(body.slice(0, 300), {status: up.status, headers: {...CORS, "X-Upstream": base}});
          if (up.status !== 429 && up.status < 500) break;        // a firm answer; do not hammer
        } catch (e) {
          last = new Response("upstream unreachable: " + e.message, {status: 502, headers: {...CORS, "X-Upstream": base}});
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
    return last;
  },
};
