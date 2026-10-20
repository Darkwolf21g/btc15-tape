// Canonical order-book adapters for the BRTI replica. scripts/sync-model.cjs embeds this exact
// source in the tape page and in the Worker. Each adapter keeps one constituent exchange's book
// current through a book object with snapshot/set/touch/reset; the host owns the socket.
(() => {
const REPLICA_BAND = 0.15;   // levels further than this from an exchange's own touch are ignored
const CONSTITUENTS = ["Bitstamp", "Coinbase", "Kraken", "Gemini", "Bullish", "Crypto.com", "LMAX Digital"];
const DEPTH_VENUES = {
  // Coinbase Exchange: level2_batch is the full book without authentication (50 ms batches).
  // No sequence numbers on this channel; the heartbeat channel proves the connection is current.
  coinbase: {name: "Coinbase", url: "wss://ws-feed.exchange.coinbase.com",
    open: ws => ws.send(JSON.stringify({type: "subscribe", product_ids: ["BTC-USD"], channels: ["level2_batch", "heartbeat"]})),
    msg: (d, book) => {
      if (d.type === "snapshot" && d.product_id === "BTC-USD") book.snapshot(d.bids || [], d.asks || []);
      else if (d.type === "l2update" && d.product_id === "BTC-USD") for (const [side, p, sz] of d.changes || []) book.set(side === "buy", p, sz);
      else if (d.type === "heartbeat") book.touch();
    }},
  // Kraken v2 book, 1000 levels. Sizes are absolute; apply in order; levels pushed past the
  // subscribed depth are not deleted by Kraken, so the book is truncated after each message.
  // A CRC32 of the top ten levels guards the book; a mismatch forces a fresh snapshot.
  kraken: {name: "Kraken", url: "wss://ws.kraken.com/v2", depth: 1000,
    open: ws => ws.send(JSON.stringify({method: "subscribe", params: {channel: "book", symbol: ["BTC/USD"], depth: 1000}})),
    msg: (d, book, ws, st, b) => {
      if (d.channel === "heartbeat") return book.touch();
      if (d.channel !== "book" || !Array.isArray(d.data)) return;
      for (const x of d.data) {
        if (x.symbol !== "BTC/USD") continue;
        const lv = a => (a || []).map(l => [l.price, l.qty]);
        if (d.type === "snapshot") book.snapshot(lv(x.bids), lv(x.asks));
        else if (d.type === "update") { for (const [p, q] of lv(x.bids)) book.set(true, p, q); for (const [p, q] of lv(x.asks)) book.set(false, p, q); }
        else continue;
        truncateBook(b, 1000);
        if (Number.isFinite(x.checksum) && b.ready) {
          if (krakenChecksum(b) === x.checksum >>> 0) st.checked = true;
          else if (st.checked) return book.reset("checksum mismatch, resyncing");
          else b.note = "checksum format unconfirmed";
        }
      }
    }},
  // Bitstamp: every message is the full top 100 bids and asks. The page reads the book from its
  // existing Bitstamp quote socket instead (it marks this entry shared); the Worker opens this one.
  bitstamp: {name: "Bitstamp", url: "wss://ws.bitstamp.net", depth: 100,
    open: ws => ws.send(JSON.stringify({event: "bts:subscribe", data: {channel: "order_book_btcusd"}})),
    ping: ws => ws.send(JSON.stringify({event: "bts:heartbeat"})),
    msg: (d, book) => {
      if (d.event === "bts:request_reconnect") book.reset("exchange asked to reconnect");
      else if (d.event === "data" && d.channel === "order_book_btcusd" && d.data && Array.isArray(d.data.bids)) book.snapshot(d.data.bids, d.data.asks || []);
      else if (d.event === "bts:heartbeat") book.touch();
    }},
  // Gemini v1 market data, full book: the first update carries every level ("initial");
  // later changes give the absolute remaining size. socket_sequence must rise by one.
  gemini: {name: "Gemini", url: "wss://api.gemini.com/v1/marketdata/BTCUSD?bids=true&offers=true&trades=false&auctions=false&heartbeat=true",
    open: () => {},
    msg: (d, book, ws, st) => {
      if (Number.isFinite(d.socket_sequence)) {
        if (st.seq != null && d.socket_sequence !== st.seq + 1) return book.reset("sequence gap, resyncing");
        st.seq = d.socket_sequence;
      }
      if (d.type === "heartbeat") return book.touch();
      if (d.type !== "update" || !Array.isArray(d.events)) return;
      const changes = d.events.filter(e => e.type === "change");
      if (changes.length && changes.every(e => e.reason === "initial")) {
        book.snapshot(changes.filter(e => e.side === "bid").map(e => [e.price, e.remaining]), changes.filter(e => e.side === "ask").map(e => [e.price, e.remaining]));
      } else for (const e of changes) book.set(e.side === "bid", e.price, e.remaining);
      book.touch();
    }},
  // Crypto.com: SNAPSHOT mode sends the full top 50 every 500 ms; heartbeats must be answered.
  cryptocom: {name: "Crypto.com", url: "wss://stream.crypto.com/exchange/v1/market", depth: 50,
    open: ws => setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({id: 1, method: "subscribe", params: {channels: ["book.BTC_USD.50"], book_subscription_type: "SNAPSHOT"}, nonce: Date.now()})); }, 1000),
    msg: (d, book, ws) => {
      if (d.method === "public/heartbeat") { ws.send(JSON.stringify({id: d.id, method: "public/respond-heartbeat"})); return book.touch(); }
      const r = d.result;
      if (!r || r.channel !== "book" || r.instrument_name !== "BTC_USD" || !Array.isArray(r.data)) return;
      for (const x of r.data) if (Array.isArray(x.bids) && Array.isArray(x.asks)) book.snapshot(x.bids, x.asks);
    }},
  // Bullish: documented snapshots of 100 levels as flat [price, qty, price, qty, ...] arrays.
  // The incremental format is undocumented, so only snapshots are applied; a book that stops
  // receiving them ages out after 10 s like any delayed book.
  bullish: {name: "Bullish", url: "wss://api.exchange.bullish.com/trading-api/v1/market-data/orderbook", depth: 100,
    open: ws => ws.send(JSON.stringify({jsonrpc: "2.0", type: "command", method: "subscribe", id: "1", params: {topic: "l2Orderbook", symbol: "BTCUSD"}})),
    msg: (d, book, ws, st, b) => {
      const x = d.data;
      if (!x || !Array.isArray(x.bids) || !Array.isArray(x.asks) || x.symbol !== "BTCUSD") return;
      const pairs = a => { const out = []; for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };
      if (d.type === "snapshot") book.snapshot(pairs(x.bids), pairs(x.asks));
      else b.note = "ignoring undocumented " + String(d.type).slice(0, 20) + " messages";
    }},
};
function truncateBook(b, n) {            // keep only the n best levels a side, as the exchange does
  for (const [m, isBid] of [[b.bids, true], [b.asks, false]]) {
    if (m.size <= n) continue;
    const keep = [...m.keys()].sort(isBid ? (x, y) => y - x : (x, y) => x - y).slice(0, n);
    const set = new Set(keep);
    for (const p of [...m.keys()]) if (!set.has(p)) m.delete(p);
  }
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(str) { let c = 0xFFFFFFFF; for (let i = 0; i < str.length; i++) c = CRC_TABLE[(c ^ str.charCodeAt(i)) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
// Kraken's book checksum: top ten asks then bids; price (1 dp) and quantity (8 dp) with the
// decimal point and leading zeros removed, concatenated. BTC/USD precisions are assumed here.
function krakenChecksum(b) {
  const part = (p, q) => p.toFixed(1).replace(".", "").replace(/^0+/, "") + q.toFixed(8).replace(".", "").replace(/^0+/, "");
  const asks = [...b.asks].sort((x, y) => x[0] - y[0]).slice(0, 10), bids = [...b.bids].sort((x, y) => y[0] - x[0]).slice(0, 10);
  let str = "";
  for (const [p, q] of asks) str += part(p, q);
  for (const [p, q] of bids) str += part(p, q);
  return crc32(str);
}
function depthOps(b, ws) {
  const put = (m, p, sz) => { p = +p; sz = +sz; if (!(Number.isFinite(p) && p > 0)) return; if (Number.isFinite(sz) && sz > 0) m.set(p, sz); else m.delete(p); };
  return {
    snapshot(bids, asks) { b.bids.clear(); b.asks.clear(); for (const [p, sz] of bids) put(b.bids, p, sz); for (const [p, sz] of asks) put(b.asks, p, sz); b.ready = true; b.at = Date.now(); b.state = "live"; b.backoff = 1000; b.note = ""; },
    set(isBid, p, sz) { if (!b.ready) return; put(isBid ? b.bids : b.asks, p, sz); b.at = Date.now(); },
    touch() { if (b.ready) b.at = Date.now(); },               // heartbeat: the book we hold is still current
    reset(reason) { b.ready = false; b.bids.clear(); b.asks.clear(); b.note = reason; b.state = "resync"; try { ws.close(); } catch (e) {} },
  };
}
function depthSide(m, isBid, limit, ref) {
  const out = [];
  for (const [p, sz] of m) if (isBid ? p >= ref * (1 - REPLICA_BAND) : p <= ref * (1 + REPLICA_BAND)) out.push([p, sz]);
  out.sort(isBid ? (a, c) => c[0] - a[0] : (a, c) => a[0] - c[0]);
  return limit && out.length > limit ? out.slice(0, limit) : out;
}
// The books in the shape BTC15Replica.calculate takes, keyed by exchange name.
function replicaBooksFrom(depthBooks) {
  const books = {};
  for (const [key, spec] of Object.entries(DEPTH_VENUES)) {
    const b = depthBooks[key];
    if (!b || !b.ready || !b.bids.size || !b.asks.size) continue;
    let bestBid = 0, bestAsk = Infinity;
    for (const p of b.bids.keys()) if (p > bestBid) bestBid = p;
    for (const p of b.asks.keys()) if (p < bestAsk) bestAsk = p;
    const ref = (bestBid + bestAsk) / 2;
    books[spec.name] = {bids: depthSide(b.bids, true, spec.depth, ref), asks: depthSide(b.asks, false, spec.depth, ref), at: b.at};
  }
  return books;
}
const newDepthBook = () => ({bids: new Map(), asks: new Map(), at: 0, ready: false, state: "off", ws: null, backoff: 1000, timer: null, fails: 0, note: "", seq: null, openedAt: 0});
globalThis.BTC15Depth = Object.freeze({DEPTH_VENUES, CONSTITUENTS, REPLICA_BAND, depthOps, depthSide, replicaBooksFrom, newDepthBook, truncateBook, crc32, krakenChecksum});
})();
