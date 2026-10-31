// Scan every open Kalshi market for the shape that pays: a liquid external reference
// price (crypto, index, sportsbook line, official data release) next to a thin book.
// Public endpoints only; no key, no orders. Output: scan/markets.json, scan/series.json,
// scan/SUMMARY.md. Run from a machine that can reach api.elections.kalshi.com.
import fs from 'node:fs';
const API=process.env.KALSHI_API||'https://api.elections.kalshi.com/trade-api/v2';
const out=process.env.SCAN_OUT||'scan';fs.mkdirSync(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path,tries=5){
 for(let i=0;i<tries;i++){
  const r=await fetch(API+path,{headers:{accept:'application/json'}});
  if(r.ok)return r.json();
  if(r.status===429||r.status>=500){await sleep(500*(i+1));continue;}
  throw new Error(`${r.status} ${path}`);
 }
 throw new Error('retries exhausted '+path);
}
const cents=(m,k)=>{const v=m[k];if(Number.isFinite(v))return v;const d=m[k+'_dollars'];return d==null?null:Math.round(parseFloat(d)*100);};
const markets=[];let cursor='';
for(let page=0;page<200;page++){
 const j=await get(`/markets?status=open&limit=1000${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
 for(const m of j.markets||[]){
  const yb=cents(m,'yes_bid'),ya=cents(m,'yes_ask');
  markets.push({ticker:m.ticker,event:m.event_ticker,series:(m.event_ticker||m.ticker).split('-')[0],title:m.title,
   yesBid:yb,yesAsk:ya,spread:(yb!=null&&ya!=null)?ya-yb:null,volume:m.volume??null,volume24h:m.volume_24h??null,
   openInterest:m.open_interest??null,liquidityCents:cents(m,'liquidity'),closeTime:m.close_time,expiration:m.expiration_time,
   type:m.market_type,strike:m.strike_type??null,floor:m.floor_strike??null,cap:m.cap_strike??null});
 }
 cursor=j.cursor;process.stderr.write(`page ${page+1}: ${markets.length} markets\n`);
 if(!cursor||!(j.markets||[]).length)break;await sleep(120);
}
// Reference class by series prefix: what public price or feed settles or anchors it.
const CLASSES=[
 [/^KX(BTC|ETH|SOL|XRP|DOGE|CRYPTO|ADA|LTC|BNB|AVAX)/,'crypto: exchange spot/perp (live, sub-second)'],
 [/^KX(INX|NASDAQ|SPX|SP500|DJI|DOW|NDX|RUSSELL|VIX|TSLA|NVDA|AAPL|MSFT|AMZN|GOOG|META|STOCK)/,'equity index/stock: exchange tape (live)'],
 [/^KX(USDJPY|EURUSD|GBPUSD|USDCAD|FX|GOLD|SILVER|OIL|WTI|BRENT|NATGAS|GAS)/,'FX/commodity: futures tape (live)'],
 [/^KX(NFL|NBA|MLB|NHL|NCAA|UFC|MMA|PGA|GOLF|TENNIS|ATP|WTA|F1|NASCAR|SOCCER|EPL|MLS|UCL|LALIGA|SERIEA|BUNDESLIGA|LIGUE|WNBA|CFB|CBB|BOXING|CRICKET|RUGBY|LOL|CS2|DOTA|VAL|ESPORTS|NBAGAME|NFLGAME|MLBGAME|NHLGAME)/,'sports: sportsbook lines (slow-moving pre-game, live in-play)'],
 [/^KX(HIGH|LOW|TEMP|RAIN|SNOW|WEATHER|HURRICANE|NWS)/,'weather: NWS forecast/obs (hourly)'],
 [/^KX(CPI|FED|FOMC|GDP|JOBS|NFP|PAYROLL|UNEMPLOY|PCE|RATE|TREASURY|TBILL|INFLATION|CLAIMS)/,'macro: scheduled release (one print)'],
 [/^KX(TRUMP|BIDEN|SENATE|HOUSE|GOV|ELECTION|PRES|POTUS|APPROVAL|POLL|SCOTUS|CONGRESS|CABINET|TARIFF|SHUTDOWN|EXEC)/,'politics: polls/news (no live reference)'],
 [/^KX(OSCAR|GRAMMY|EMMY|BOX|MOVIE|BILLBOARD|SPOTIFY|ROTTEN|RT|NETFLIX|TOP|CHART)/,'entertainment: published charts (daily/weekly)'],
];
const classify=s=>(CLASSES.find(([re])=>re.test(s))||[null,'other/none identified'])[1];
const bySeries=new Map();
for(const m of markets){
 const s=bySeries.get(m.series)||{series:m.series,reference:classify(m.series),n:0,volume24h:0,volume:0,openInterest:0,liquidityCents:0,spreads:[],twoSided:0,sample:m.title};
 s.n++;s.volume24h+=m.volume24h||0;s.volume+=m.volume||0;s.openInterest+=m.openInterest||0;s.liquidityCents+=m.liquidityCents||0;
 if(m.spread!=null&&m.yesBid>0&&m.yesAsk<100){s.spreads.push(m.spread);s.twoSided++;}
 bySeries.set(m.series,s);
}
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y);return b[b.length>>1];};
const series=[...bySeries.values()].map(s=>({...s,medianSpread:median(s.spreads),spreads:undefined,
 // The shape we want: real volume, wide spread, a live external reference.
 thinButActive:(median(s.spreads)??0)>=6&&s.volume24h>=500})).sort((a,b)=>b.volume24h-a.volume24h);
// Top of book depth for the best-looking candidates (both sides at touch), public orderbook endpoint.
const candidates=markets.filter(m=>m.spread!=null&&m.spread>=6&&m.yesBid>0&&m.yesAsk<100&&(m.volume24h||0)>=200)
 .sort((a,b)=>(b.volume24h||0)-(a.volume24h||0)).slice(0,120);
for(const m of candidates){
 try{const ob=await get(`/markets/${m.ticker}/orderbook?depth=3`);const yes=ob.orderbook?.yes||[],no=ob.orderbook?.no||[];
  const top=side=>side.length?side.reduce((a,l)=>Math.max(a,l[0]),0):null,size=(side,p)=>side.filter(l=>l[0]===p).reduce((a,l)=>a+l[1],0);
  const yb=top(yes),nb=top(no);m.book={yesBid:yb,yesBidSize:yb==null?null:size(yes,yb),noBid:nb,noBidSize:nb==null?null:size(no,nb),impliedSpread:(yb!=null&&nb!=null)?100-yb-nb:null};
 }catch(e){m.book={error:String(e.message||e)};}
 await sleep(130);
}
fs.writeFileSync(`${out}/markets.json`,JSON.stringify({at:new Date().toISOString(),count:markets.length,markets}));
fs.writeFileSync(`${out}/series.json`,JSON.stringify({at:new Date().toISOString(),series},null,1));
const fmt=v=>v==null?'—':Number(v).toLocaleString('en-US');
let md=`# Kalshi open-market scan · ${new Date().toISOString()}\n\n${markets.length} open markets, ${series.length} series. Public data only.\n\n`;
md+=`## Series by 24h volume (top 60)\n\n| Series | Reference | Markets | 24h vol | OI | Median spread (2-sided) | Thin+active |\n|---|---|---|---|---|---|---|\n`;
for(const s of series.slice(0,60))md+=`| ${s.series} | ${s.reference} | ${s.n} | ${fmt(s.volume24h)} | ${fmt(s.openInterest)} | ${s.medianSpread==null?'—':s.medianSpread+'¢'} (${s.twoSided}) | ${s.thinButActive?'**yes**':''} |\n`;
md+=`\n## Thin but active series (median spread ≥ 6¢ and ≥ 500 contracts / 24h)\n\n| Series | Reference | Markets | 24h vol | Median spread | Example |\n|---|---|---|---|---|---|\n`;
for(const s of series.filter(s=>s.thinButActive))md+=`| ${s.series} | ${s.reference} | ${s.n} | ${fmt(s.volume24h)} | ${s.medianSpread}¢ | ${s.sample} |\n`;
md+=`\n## Candidate markets with top-of-book depth (spread ≥ 6¢, ≥ 200 / 24h; top 120 by volume)\n\n| Ticker | Title | Bid/Ask | Spread | 24h vol | Yes bid × size | No bid × size | Implied spread |\n|---|---|---|---|---|---|---|---|\n`;
for(const m of candidates){const b=m.book||{};md+=`| ${m.ticker} | ${(m.title||'').slice(0,60)} | ${m.yesBid}/${m.yesAsk} | ${m.spread}¢ | ${fmt(m.volume24h)} | ${b.yesBid==null?'—':b.yesBid+'¢ × '+fmt(b.yesBidSize)} | ${b.noBid==null?'—':b.noBid+'¢ × '+fmt(b.noBidSize)} | ${b.impliedSpread==null?(b.error||'—'):b.impliedSpread+'¢'} |\n`;}
fs.writeFileSync(`${out}/SUMMARY.md`,md);process.stderr.write('done\n');
