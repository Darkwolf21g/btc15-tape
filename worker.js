// Kalshi relay for the BTC 15 Tape page. Runs as a Cloudflare Worker (free tier is plenty).
//
// Browsers are not allowed to read Kalshi's API directly. This forwards two public, read-only
// requests (the BTC 15-minute market record and its 60-second-average feed) and adds the header
// browsers need. Nothing else is forwarded, and no account or key is involved.
//
// Set up: dash.cloudflare.com -> Workers & Pages -> Create -> Start with Hello World -> Deploy,
// then Edit code, replace everything with this file, Deploy again, and paste the worker's address
// (https://....workers.dev) into the page under "Target and calibration".

const UPSTREAMS = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2"];
const ALLOWED = [/^\/markets\/KXBTC15M-[A-Z0-9-]+$/, /^\/live_data\/events\/KXBTC15M-[A-Z0-9]+$/];
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Cache-Control": "no-store"};

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (request.method === "OPTIONS") return new Response(null, {headers: CORS});
    if (request.method !== "GET" || !ALLOWED.some(re => re.test(path))) {
      return new Response("not found", {status: 404, headers: CORS});
    }
    let last = null;
    for (const base of UPSTREAMS) {
      try {
        const up = await fetch(base + path, {headers: {"Accept": "application/json", "User-Agent": "btc15-tape relay"}});
        const body = await up.text();
        if (up.ok) return new Response(body, {status: 200, headers: {...CORS, "Content-Type": "application/json"}});
        last = new Response(body, {status: up.status, headers: CORS});
      } catch (e) {
        last = new Response("upstream unreachable", {status: 502, headers: CORS});
      }
    }
    return last;
  },
};
