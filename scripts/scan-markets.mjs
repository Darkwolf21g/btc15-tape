// Scan open Kalshi markets, series by series, for the shape that pays: a liquid external
// reference price (crypto, index, sportsbook line, official data release) next to a thin
// book. Public endpoints only; no key, no orders. Output in scan/: markets.json,
// series.json, SUMMARY.md, raw-sample.json. Run where api.elections.kalshi.com is reachable.
import fs from 'node:fs';
const API=process.env.KALSHI_API||'https://api.elections.kalshi.com/trade-api/v2';
const out=process.env.SCAN_OUT||'scan';fs.mkdirSync(out,{recursive:true});
const HORIZON_DAYS=Number(process.env.SCAN_DAYS||14);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let calls=0;
async function get(path,tries=6){
 for(let i=0;i<tries;i++){
  calls++;const r=await fetch(API+path,{headers:{accept:'application/json'}});
  if(r.ok)return r.json();
  if(r.status===429||r.status>=500){await sleep(700*(i+1));continue;}
  throw new Error(`${r.status} ${path}`);
 }
 throw new Error('retries exhausted '+path);
}
const num=v=>{if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
// Newer API versions carry *_fp / *_dollars strings; older ones integers. Take whichever is present.
const cents=(m,k)=>{const d=num(m[k+'_dollars']);if(d!=null)return Math.round(d*100);const v=num(m[k]);return v;};
const count=(m,k)=>{const f=num(m[k+'_fp']);if(f!=null)return f;return num(m[k]);};
const now=Date.now(),maxClose=now+HORIZON_DAYS*86400000;
// 1. Every series, with Kalshi's own category.
const seriesList=[];{let cursor='';for(let p=0;p<50;p++){const j=await get(`/series?limit=1000${cursor?'&cursor='+encodeURIComponent(cursor):''}`);for(const s of j.series||[])seriesList.push({ticker:s.ticker,title:s.title,category:s.category,frequency:s.frequency,tags:s.tags||[]});cursor=j.cursor;if(!cursor||!(j.series||[]).length)break;await sleep(110);}}
process.stderr.write(`${seriesList.length} series\n`);
const skip=t=>/^KXMVE/.test(t); // multivariate/parlay combinations: hundreds of thousands, no book
// 2. Open markets per series, closing within the horizon.
const markets=[];let rawSample=null;
for(const s of seriesList){
 if(skip(s.ticker))continue;
 let cursor='';
 for(let p=0;p<20;p++){
  let j;try{j=await get(`/markets?series_ticker=${encodeURIComponent(s.ticker)}&status=open&limit=1000&min_close_ts=${Math.floor(now/1000)}&max_close_ts=${Math.floor(maxClose/1000)}${cursor?'&cursor='+encodeURIComponent(cursor):''}`);}catch(e){process.stderr.write(`${s.ticker}: ${e.message}\n`);break;}
  for(const m of j.markets||[]){
   if(!rawSample&&(count(m,'volume_24h')||0)>0)rawSample=m;
   const yb=cents(m,'yes_bid'),ya=cents(m,'yes_ask');
   markets.push({ticker:m.ticker,event:m.event_ticker,series:s.ticker,category:s.category,title:m.title,subtitle:m.yes_sub_title||m.subtitle||'',
    yesBid:yb,yesAsk:ya,spread:(yb!=null&&ya!=null)?ya-yb:null,last:cents(m,'last_price'),volume:count(m,'volume'),volume24h:count(m,'volume_24h'),
    openInterest:count(m,'open_interest'),liquidityCents:cents(m,'liquidity'),closeTime:m.close_time,type:m.market_type,strike:m.strike_type??null,floor:m.floor_strike??null,cap:m.cap_strike??null});
  }
  cursor=j.cursor;if(!cursor||!(j.markets||[]).length)break;await sleep(110);
 }
 await sleep(110);
}
process.stderr.write(`${markets.length} open markets within ${HORIZON_DAYS} days after ${calls} calls\n`);
fs.writeFileSync(`${out}/raw-sample.json`,JSON.stringify(rawSample,null,1));
// Reference class: what public price or feed anchors the market before it settles.
const CLASSES=[
 [/^KX(BTC|ETH|SOL|XRP|DOGE|CRYPTO|ADA|LTC|BNB|AVAX|HYPE)/,'crypto: exchange spot/perp, live'],
 [/^KX(INX|NASDAQ|SPX|SP500|DJI|DOW|NDX|RUSSELL|VIX|TSLA|NVDA|AAPL|MSFT|AMZN|GOOG|META|STOCK|AAA)/,'equity index/stock: exchange tape, live'],
 [/^KX(USDJPY|EURUSD|GBPUSD|USDCAD|FX|GOLD|SILVER|OIL|WTI|BRENT|NATGAS|GAS|XAU)/,'FX/commodity: futures tape, live'],
 [/^KX(HIGH|LOW|TEMP|RAIN|SNOW|WEATHER|HURRICANE|NWS|PRECIP)/,'weather: NWS forecast/obs, hourly'],
 [/^KX(CPI|FED|FOMC|GDP|JOBS|NFP|PAYROLL|UNEMPLOY|PCE|RATE|TREASURY|TBILL|INFLATION|CLAIMS|RETAIL|ISM|PPI)/,'macro: scheduled release, one print'],
];
const classify=(s,cat)=>{const hit=CLASSES.find(([re])=>re.test(s));if(hit)return hit[1];
 if(/sport/i.test(cat||''))return 'sports: sportsbook lines (pre-game slow, in-play live)';
 if(/crypto/i.test(cat||''))return 'crypto (by category)';if(/financ|econom/i.test(cat||''))return (cat||'')+': market data';
 if(/climate|weather/i.test(cat||''))return 'weather (by category)';return (cat||'other')+': no live reference';};
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y);return b[b.length>>1];};
const bySeries=new Map();
for(const m of markets){
 const s=bySeries.get(m.series)||{series:m.series,category:m.category,reference:classify(m.series,m.category),n:0,volume24h:0,volume:0,openInterest:0,liquidityCents:0,spreads:[],twoSided:0,sample:m.title};
 s.n++;s.volume24h+=m.volume24h||0;s.volume+=m.volume||0;s.openInterest+=m.openInterest||0;s.liquidityCents+=m.liquidityCents||0;
 if(m.spread!=null&&m.yesBid>0&&m.yesAsk<100){s.spreads.push(m.spread);s.twoSided++;}
 bySeries.set(m.series,s);
}
const series=[...bySeries.values()].map(s=>({...s,medianSpread:median(s.spreads),spreads:undefined,
 thinButActive:(median(s.spreads)??0)>=6&&s.volume24h>=500})).sort((a,b)=>b.volume24h-a.volume24h);
// 3. Top of book for the widest active markets.
const candidates=markets.filter(m=>m.spread!=null&&m.spread>=6&&m.yesBid>0&&m.yesAsk<100&&(m.volume24h||0)>=200)
 .sort((a,b)=>(b.volume24h||0)-(a.volume24h||0)).slice(0,150);
for(const m of candidates){
 try{const ob=await get(`/markets/${m.ticker}/orderbook?depth=3`);const book=ob.orderbook||{};
  const side=k=>{const fp=book[k+'_dollars']||book[k+'_fp'];const lv=(fp||book[k]||[]).map(l=>[fp?Math.round(Number(l[0])*100):Number(l[0]),Number(l[1])]);return lv;};
  const yes=side('yes'),no=side('no'),top=a=>a.length?Math.max(...a.map(l=>l[0])):null,size=(a,p)=>a.filter(l=>l[0]===p).reduce((t,l)=>t+l[1],0);
  const yb=top(yes),nb=top(no);m.book={yesBid:yb,yesBidSize:yb==null?null:size(yes,yb),noBid:nb,noBidSize:nb==null?null:size(no,nb),impliedSpread:(yb!=null&&nb!=null)?100-yb-nb:null};
 }catch(e){m.book={error:String(e.message||e)};}
 await sleep(120);
}
fs.writeFileSync(`${out}/markets.json`,JSON.stringify({at:new Date().toISOString(),horizonDays:HORIZON_DAYS,count:markets.length,markets}));
fs.writeFileSync(`${out}/series.json`,JSON.stringify({at:new Date().toISOString(),series},null,1));
const fmt=v=>v==null?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:0});
let md=`# Kalshi open-market scan · ${new Date().toISOString()}\n\n${markets.length} open markets closing within ${HORIZON_DAYS} days across ${series.length} series (${seriesList.length} series listed; KXMVE* parlays skipped). Public data only.\n\n`;
md+=`## Series by 24h volume (top 80)\n\n| Series | Category | Reference | Markets | 24h vol | OI | Median spread (2-sided n) | Thin+active |\n|---|---|---|---|---|---|---|---|\n`;
for(const s of series.slice(0,80))md+=`| ${s.series} | ${s.category||''} | ${s.reference} | ${s.n} | ${fmt(s.volume24h)} | ${fmt(s.openInterest)} | ${s.medianSpread==null?'—':s.medianSpread+'¢'} (${s.twoSided}) | ${s.thinButActive?'**yes**':''} |\n`;
md+=`\n## Thin but active series (median two-sided spread ≥ 6¢ and ≥ 500 contracts / 24h)\n\n| Series | Reference | Markets | 24h vol | Median spread | Example |\n|---|---|---|---|---|---|\n`;
for(const s of series.filter(s=>s.thinButActive))md+=`| ${s.series} | ${s.reference} | ${s.n} | ${fmt(s.volume24h)} | ${s.medianSpread}¢ | ${s.sample} |\n`;
md+=`\n## Candidate markets with top-of-book depth (spread ≥ 6¢, ≥ 200 / 24h; top 150 by volume)\n\n| Ticker | Title | Bid/Ask | Spread | 24h vol | Yes bid × size | No bid × size | Implied spread |\n|---|---|---|---|---|---|---|---|\n`;
for(const m of candidates){const b=m.book||{};md+=`| ${m.ticker} | ${(m.title+' '+m.subtitle).slice(0,70)} | ${m.yesBid}/${m.yesAsk} | ${m.spread}¢ | ${fmt(m.volume24h)} | ${b.yesBid==null?'—':b.yesBid+'¢ × '+fmt(b.yesBidSize)} | ${b.noBid==null?'—':b.noBid+'¢ × '+fmt(b.noBidSize)} | ${b.impliedSpread==null?(b.error||'—'):b.impliedSpread+'¢'} |\n`;}
fs.writeFileSync(`${out}/SUMMARY.md`,md);process.stderr.write('done\n');
