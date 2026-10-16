"""A stand-in for every exchange, Kalshi and Coinbase's REST, injected into the page before it loads.

The page's WebSocket and fetch are replaced. Six price venues quote at their own cadence (Bitstamp is
frozen, as a stale quote should be ignored), each sends trades in its own real message shape, four
liquidation venues send liquidations, Binance refuses to connect (as it does from the US). Kalshi is
mocked when window.__kalshi is set. Web Audio is replaced by a tone counter (window.__tones).

Knobs on window: __drift (dollars per 100 ms), __buyBias (share of market buys), __fast (every venue
quotes every 250 ms, as they do while price moves), __kalshi/__kTarget/__kBid/__kAsk, __pastResult
({ticker: "yes"|"no"} for settled markets), __impact (dollars per BTC a trade pushes price over the
next 30 s), __lag (seconds the spot venues quote behind the perp).
"""
import datetime as _d
import os
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "public" / "index.html"
PAGE_URL = PAGE.as_uri()
WINDOW_START = 1791676800          # a window open, 8:00 PM ET on 10 Oct 2026


def at(seconds_into_window):
    """A datetime for installing the page's clock: `seconds_into_window` after the window's open."""
    return _d.datetime.fromtimestamp(WINDOW_START + seconds_into_window, _d.timezone.utc)


FAKE = r"""
(() => {
  let price = 82900, seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const hist = [];
  for (let i = 5000; i > 0; i--) { price += gauss() * 0.7; hist.push([Date.now() - i * 100, price]); }
  window.__drift = 0.06; window.__impact = 0; window.__pending = []; window.__lag = 0;
  setInterval(() => { let push = 0; for (const p of window.__pending) { push += p.per; p.left--; } window.__pending = window.__pending.filter(p => p.left > 0);
     price += gauss() * 0.4 + window.__drift + push; hist.push([Date.now(), price]); if (hist.length > 5000) hist.shift(); }, 100);
  const spotPx = () => window.__lag ? hist[Math.max(0, hist.length - 1 - window.__lag * 10)][1] : price;
  const off = {coinbase: 0, kraken: 6, bitstamp: -9, gemini: 4, cryptocom: -3, hyperliquid: 35};
  const gap = {coinbase: 4000, kraken: 5000, bitstamp: 300, gemini: 6000, cryptocom: 9000, hyperliquid: 150}; window.__price = () => price;
  const tgap = {coinbase: 700, kraken: 1500, bitstamp: 2500, gemini: 3000, cryptocom: 4000, hyperliquid: 400};   // ms between trades
  const lgap = {bybit: 20000, okx: 30000, deribit: 2000, bitmex: 45000};
  window.__frames = {}; window.__hb = {}; window.__sent = {}; window.__buyBias = 0.5;
  const venueOf = url => url.includes("coinbase") ? "coinbase" : url.includes("kraken") ? "kraken" : url.includes("bitstamp") ? "bitstamp"
              : url.includes("gemini") ? "gemini" : url.includes("hyperliquid") ? "hyperliquid" : url.includes("crypto.com") ? "cryptocom"
              : url.includes("bybit") ? "bybit" : url.includes("okx") ? "okx" : url.includes("deribit") ? "deribit" : url.includes("bitmex") ? "bitmex"
              : url.includes("binance") ? "binance" : "unknown";
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0;
      const k = this.k = venueOf(url);
      window.__sockets = (window.__sockets || 0) + 1;
      if (url.includes("/feed")) {                 // the relay's stream of Kalshi's own data, when window.__stream is set
        this.k = "feed";
        if (!window.__stream) { setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({}); }, 30); return; }
        setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); this.emit({type: "relay", msg: {state: "open", hasKey: true}}); }, 50);
        const emit = msg => { if (this.readyState !== 1) return; this.onmessage && this.onmessage({data: JSON.stringify(msg)}); };
        this.emit = emit;
        const brti = () => price + 2.0;             // the official index sits $2 above the sim's Coinbase price
        this.timer = setInterval(() => emit({type: "cfbenchmarks_value_5hz", msg: {index_id: "BRTI", value_usd: brti().toFixed(2), source_ts_ms: Date.now() - 150, received_at: Date.now()}}), 200);
        this.hb = setInterval(() => {
          const now = Date.now(), closeMs = (Math.floor(now / 900000) + 1) * 900000;
          const win = (from, to) => { const v = hist.filter(h => h[0] > from && h[0] <= to).map(h => h[1] + 2.0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : brti(); };
          const msg = {index_id: "BRTI", received_at: now, data: JSON.stringify({type: "value", id: "BRTI", time: now, value: brti().toFixed(2)}),
                       avg_60s_data: {value: win(now - 60000, now).toFixed(8), window_size: 60, window_start_ts_ms: now - 60000, window_end_ts_exclusive: now}};
          const into = Math.floor((now - (closeMs - 60000)) / 1000);
          if (into >= 1 && into <= 60) msg.last_60s_windowed_average_15min = {value: win(closeMs - 60000, now).toFixed(8), window_size: into, window_start_ts_ms: closeMs - 60000, window_end_ts_exclusive: closeMs};
          emit({type: "cfbenchmarks_value", msg});
        }, 1000);
        this.btimer = setInterval(() => { if (window.__kalshi) { const tk = window.__curTicker ? window.__curTicker() : "";
          emit({type: "orderbook_snapshot", msg: {market_ticker: tk, yes_dollars_fp: [[(window.__kBid - 0.02).toFixed(4), "40.00"], [window.__kBid.toFixed(4), "12.00"]], no_dollars_fp: [[(1 - window.__kAsk - 0.01).toFixed(4), "80.00"], [(1 - window.__kAsk).toFixed(4), String(window.__askSize || 5) + ".00"]]}});
          emit({type: "orderbook_delta", msg: {market_ticker: tk, price_dollars: (1 - window.__kAsk).toFixed(4), delta_fp: "2.00", side: "no"}}); } }, 3000);
        this.ttimer = setInterval(() => { if (window.__kalshi) emit({type: "ticker", msg: {market_ticker: window.__curTicker ? window.__curTicker() : "", yes_bid_dollars: String(window.__kBid), yes_ask_dollars: String(window.__kAsk), ts: Math.floor(Date.now() / 1000)}}); }, 2000);
        return;
      }
      if (k === "binance") { setTimeout(() => { this.readyState = 3; this.onerror && this.onerror({}); this.onclose && this.onclose({}); }, 30); return; }
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 50);
      const emit = msg => { if (this.readyState !== 1) return; window.__frames[k] = (window.__frames[k] || 0) + 1; this.onmessage && this.onmessage({data: typeof msg === "string" ? msg : JSON.stringify(msg)}); };
      this.emit = emit;
      const quote = () => {
        if (k === "cryptocom" && !this.sub) return;
        const m = (k === "bitstamp" && !window.__bitstampLive ? 82880 : k === "hyperliquid" ? price : spotPx()) + off[k], b = (m - 0.5).toFixed(2), a = (m + 0.5).toFixed(2);
        let msg;
        if (k === "coinbase") msg = {type: "ticker", best_bid: b, best_ask: a};
        if (k === "kraken") msg = {channel: "ticker", type: "update", data: [{symbol: "BTC/USD", bid: +b, ask: +a}]};
        if (k === "bitstamp") msg = {event: "data", channel: "order_book_btcusd", data: {bids: [[b, "1"]], asks: [[a, "1"]]}};
        if (k === "gemini") msg = {type: "update", timestampms: Date.now(), events: [{type: "change", side: "bid", price: b, remaining: "1"}, {type: "change", side: "ask", price: a, remaining: "1"}]};
        if (k === "cryptocom") msg = {method: "subscribe", result: {channel: "ticker", instrument_name: "BTC_USD", data: [{b, k: a}]}};
        if (k === "hyperliquid") msg = {channel: "bbo", data: {coin: "BTC", time: Date.now(), bbo: [{px: b, sz: "1", n: 1}, {px: a, sz: "1", n: 1}]}};
        emit(msg);
      };
      if (k in gap) { this.timer = setInterval(quote, gap[k]); this.ftimer = setInterval(() => { if (window.__fast) quote(); }, 250); }   // every venue pushes quotes while price moves
      if (k in tgap) this.ttimer = setInterval(() => {         // trades, in each venue's own shape
        if (k === "cryptocom" && !this.sub) return;
        const buy = rnd() < window.__buyBias, px = (price + off[k]).toFixed(2), size = (0.01 + rnd() * (k === "hyperliquid" ? 3 : 0.8)).toFixed(4), now = Date.now();
        if (window.__impact) window.__pending.push({left: 300, per: (buy ? 1 : -1) * (+size) * window.__impact / 300});
        let msg;
        if (k === "coinbase") msg = {type: "match", trade_id: 1, product_id: "BTC-USD", size, price: px, side: buy ? "sell" : "buy", time: new Date(now).toISOString()};
        if (k === "kraken") msg = {channel: "trade", type: "update", data: [{symbol: "BTC/USD", side: buy ? "buy" : "sell", price: +px, qty: +size, ord_type: "market", trade_id: 1, timestamp: new Date(now).toISOString()}]};
        if (k === "bitstamp") msg = {event: "trade", channel: "live_trades_btcusd", data: {id: 1, amount: +size, amount_str: size, price: +px, price_str: px, type: buy ? 0 : 1, microtimestamp: String(now * 1000)}};
        if (k === "gemini") msg = {type: "update", timestampms: now, events: [{type: "trade", tid: 1, price: px, amount: size, makerSide: buy ? "ask" : "bid"}, {type: "change", side: "bid", price: (price + 3.5).toFixed(2), remaining: "1", reason: "trade"}]};
        if (k === "cryptocom") msg = {method: "subscribe", result: {channel: "trade", instrument_name: "BTC_USD", subscription: "trade.BTC_USD", data: [{d: "1", t: now, p: px, q: size, s: buy ? "BUY" : "SELL", i: "BTC_USD"}]}};
        if (k === "hyperliquid") msg = {channel: "trades", data: [{coin: "BTC", side: buy ? "B" : "A", px, sz: size, time: now, hash: "0x", tid: 1}]};
        emit(msg);
      }, tgap[k]);
      if (k in lgap) this.ltimer = setInterval(() => {
        const px = (price + 30).toFixed(1), now = Date.now(), long = rnd() < 0.6;
        let msg;
        if (k === "bybit") msg = {topic: "allLiquidation.BTCUSDT", type: "snapshot", ts: now, data: [{T: now, s: "BTCUSDT", S: long ? "Buy" : "Sell", v: (0.5 + rnd() * 5).toFixed(3), p: px}]};
        if (k === "okx") msg = {arg: {channel: "liquidation-orders", instType: "SWAP"}, data: [{instId: "BTC-USDT-SWAP", instType: "SWAP", details: [{bkLoss: "0", bkPx: px, ccy: "", posSide: long ? "long" : "short", side: long ? "sell" : "buy", sz: String(Math.round(100 + rnd() * 900)), ts: String(now)}]}, {instId: "ETH-USDT-SWAP", instType: "SWAP", details: [{bkPx: "3000", posSide: "long", side: "sell", sz: "5", ts: String(now)}]}]};
        if (k === "deribit") msg = {jsonrpc: "2.0", method: "subscription", params: {channel: "trades.BTC-PERPETUAL.100ms", data: [{trade_seq: 1, trade_id: "1", timestamp: now, price: +px, instrument_name: "BTC-PERPETUAL", direction: long ? "sell" : "buy", amount: Math.round(1000 + rnd() * 400000), liquidation: rnd() < 0.08 ? "T" : undefined}]}};
        if (k === "bitmex") msg = {table: "liquidation", action: "insert", data: [{orderID: "x", symbol: "XBTUSD", side: long ? "Sell" : "Buy", price: +px, leavesQty: Math.round(10000 + rnd() * 500000)}]};
        emit(msg);
      }, lgap[k]);
      this.hb = setInterval(() => {      // heartbeats between quotes; pongs for the ones that are pinged
        if (this.readyState !== 1) return;
        window.__hb[k] = (window.__hb[k] || 0) + 1;
        const msg = k === "coinbase" ? {type: "heartbeat"} : k === "kraken" ? {channel: "heartbeat"} : k === "gemini" ? {type: "heartbeat"}
                  : k === "cryptocom" ? {id: 9, method: "public/heartbeat"} : k === "hyperliquid" ? {channel: "pong"} : k === "bitstamp" ? {event: "bts:heartbeat", data: {status: "success"}}
                  : k === "bybit" ? {op: "pong", success: true} : k === "okx" ? "pong" : k === "deribit" ? {jsonrpc: "2.0", id: 2, result: {version: "1"}} : k === "bitmex" ? "pong" : null;
        if (msg) emit(msg);
      }, k in lgap ? 12000 : 1000);
    }
    send(s) {
      window.__sent[this.k] = (window.__sent[this.k] || []).concat([s]).slice(-6);
      if (this.k === "feed") { if (s === "ping") this.emit && this.emit({type: "pong"}); return; }
      let d; try { d = JSON.parse(s); } catch (e) { return; }
      if (d.method === "subscribe" && this.k === "cryptocom") {
        this.sub = true;
        // Crypto.com replays recent trades on subscribing: these are old and must not be counted
        setTimeout(() => this.emit({method: "subscribe", result: {channel: "trade", instrument_name: "BTC_USD", data: [{d: "0", t: Date.now() - 40000, p: "82900", q: "5", s: "BUY", i: "BTC_USD"}]}}), 100);
      }
    }
    close() { this.readyState = 3; clearInterval(this.btimer); clearInterval(this.timer); clearInterval(this.ftimer); clearInterval(this.ttimer); clearInterval(this.ltimer); clearInterval(this.hb); this.onclose && this.onclose(); }
  }
  window.WebSocket = FakeWS;
  window.__trades = true;
  window.fetch = function (u) {
    u = String(u);
    if (u.includes("/trades") && window.__trades) {
      const m = u.match(/after=(\d+)/); let start = m ? +m[1] - 1 : hist.length - 1;
      const rows = []; let i = start;
      for (; i >= 0 && rows.length < 1000; i -= 1) rows.push({time: new Date(hist[i][0]).toISOString(), price: hist[i][1].toFixed(2), trade_id: i});
      window.__pages = (window.__pages || 0) + 1;
      return Promise.resolve({ok: true, json: async () => rows, headers: {get: h => h === "cb-after" ? String(i + 1) : null}});
    }
    if (u.includes("/markets/") && window.__kalshi) {
      const tk = u.split("/markets/")[1]; window.__mkReq = (window.__mkReq || []).concat([tk]);
      const past = window.__pastResult && window.__pastResult[tk];
      return Promise.resolve({ok: true, json: async () => past ? {market: {ticker: tk, status: "finalized", result: past, floor_strike: window.__kTarget}}
        : {market: {ticker: tk, status: "active", strike_type: "greater_or_equal", floor_strike: window.__kTarget, yes_bid_dollars: String(window.__kBid), yes_ask_dollars: String(window.__kAsk)}}});
    }
    if (u.includes("/trade/status")) return Promise.resolve({ok: true, status: 200, json: async () => ({config: {mode: window.__agentMode || "off", perWindowCents: 1000, dailyLossStopCents: 3000, maxTradesPerDay: 12}, today: {day: "2026-10-10", trades: 1, pnlCents: 1232}, hasDemoKey: false, tokenSet: true, stream: "open", ticks: 1500,
      windows: [{mk: "X", result: "yes", trades: [{at: Date.now() - 600000, mode: "paper", side: "Up", filled: 22, n: 22, price: 42, offered: 30, edge: 55.6, p: 0.999, pnlCents: 1232}]}], decisions: [{at: Date.now() - 60000, left: 300, p: 0.6, lo: 0.5, hi: 0.7, up: {price: 62, edge: -4, call: "no"}, down: {price: 40, edge: 1, call: "thin"}, note: "no trade"}], errors: []})});
    if (u.includes("/trade/config")) { window.__agentMode = JSON.parse(arguments[1].body).mode || window.__agentMode; window.__cfgPosts = (window.__cfgPosts || []).concat([arguments[1].body]); return Promise.resolve({ok: true, status: 200, json: async () => ({}), text: async () => ""}); }
    if (u.includes("/brti/history") && window.__stream) {      // the official index's ticks for the hour asked for
      const h = Date.parse(decodeURIComponent(u.match(/timestamp=([^&]+)/)[1]));
      const rows = hist.filter(x => x[0] >= h && x[0] < h + 3600000).filter((x, i) => i % 10 === 0).map(x => ({time: new Date(x[0]).toISOString(), value: (x[1] + 2.0).toFixed(2)}));
      window.__histReq = (window.__histReq || 0) + 1;
      return Promise.resolve({ok: true, status: 200, json: async () => ({data: {serverTime: new Date().toISOString(), payload: rows}})});
    }
    if (u.includes("/exchange/status") && window.__kalshi) return Promise.resolve({ok: true, status: 200, json: async () => ({exchange_active: true, trading_active: window.__tradingActive !== false})});
    if (u.includes("/live_data/") && window.__kalshi) return Promise.resolve({ok: true, json: async () => ({live_data: {details: {timeseries: []}}})});
    if (u.includes("candles") && window.__candle) { const m = u.match(/start=([^&]+)/); const t = Date.parse(decodeURIComponent(m[1]))/1000;
      return Promise.resolve({ok: true, json: async () => [[t, 82890, 82910, 82895, 82905, 1]]}); }
    return Promise.reject(new TypeError("Failed to fetch"));
  };
  window.__candle = true; window.__kalshi = false;
  // Web Audio stand-in: counts the tones
  window.__tones = [];
  class FakeCtx { constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createOscillator() { const o = {frequency: {value: 0}, type: "sine", connect() {}, start() { window.__tones.push(o.frequency.value); }, stop() {}}; return o; }
    createGain() { return {gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}, connect() {}}; } }
  window.AudioContext = FakeCtx;
})();
"""


def new_page(playwright, seconds_into_window=300, width=400, height=1500):
    """A page with the fake market installed and the clock set; returns (browser, page, errors)."""
    browser = playwright.chromium.launch(executable_path=os.environ.get("BTC15_TEST_CHROMIUM"))
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and "ERR_FAILED" not in m.text and errors.append(m.text))
    page.clock.install(time=at(seconds_into_window))
    page.add_init_script(FAKE)
    page.route("**/fonts.googleapis.com/**", lambda r: r.abort())
    page.goto(PAGE_URL)
    return browser, page, errors


def run_seconds(page, n):
    for _ in range(n):
        page.clock.run_for(1000)
    page.wait_for_timeout(100)
