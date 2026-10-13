// Forward-only timed paper experiment. No exchange order calls.
(() => {
const VERSION='paper-session-v1';
const SETTINGS=Object.freeze({durationMs:3600000,cadenceMs:5000,delayMs:1000,maxDelayMs:4000,depthFraction:.5,quantity:1,minEdgeCents:3,exitEdgeCents:3,maxEntriesPerWindow:3,cooldownMs:30000,lossStopCents:300,model:'brti-driftless-v3',feeAssumption:'general Kalshi taker fee, rounded up per one-contract fill'});
const M=()=>globalThis.BTC15Model,finite=Number.isFinite;
function create(now,id){const startAt=(Math.floor(now/900000)+1)*900000+750;return {version:VERSION,id,settings:{...SETTINGS},createdAt:now,startAt,endAt:startAt+SETTINGS.durationMs-750,status:'scheduled',looks:[],attempts:[],trades:[],pending:null,nextLookAt:startAt,entries:{},lastEntryAt:null,stoppedAt:null};}
function active(s,at){return !!s&&!s.stoppedAt&&at<s.endAt&&['scheduled','running'].includes(s.status);}
function position(s){return s.trades.find(t=>t.pnlCents==null);}
function stop(s,at,reason='time limit'){s.stoppedAt=at;s.stopReason=reason;s.status=position(s)?'settling':'complete';if(s.pending){s.attempts.push({...s.pending,filled:0,arrivalAt:at,reason:'session stopped'});s.pending=null;}}
function clock(s,at){if(!s.stoppedAt&&at>=s.endAt)stop(s,at);if(s.stoppedAt&&!position(s))s.status='complete';if(active(s,at)&&at>=s.startAt)s.status='running';}
function valid(k){return M().VERSION===SETTINGS.model&&k?.status==='forecast'&&finite(k.p)&&k.p>=0&&k.p<=1&&k.depth?.valid&&k.marketStatus==='active'&&k.exchange?.exchange_active===true&&k.exchange?.trading_active===true;}
function bid(depth,side){return side==='Up'?depth.bidCents:100-depth.askCents;}
function decide(s,k,mk,close){const at=k.at;clock(s,at);if(!active(s,at)||at<s.startAt||at<s.nextLookAt||s.pending)return;
 s.nextLookAt=at+SETTINGS.cadenceMs;
 const record={at,mk,close,p:k.p,index:k.index,projection:k.projection,depth:k.depth,marketStatus:k.marketStatus,exchange:k.exchange,reason:null};
 const finish=reason=>{record.reason=reason;s.looks.push(record);};
 if(!valid(k))return finish(k.status!=='forecast'?k.status:k.depth?.reason||'market or exchange unavailable');
 if(at+SETTINGS.maxDelayMs>=Math.min(close*1000,s.endAt))return finish('too close to deadline');
 const held=position(s);record.action=held?'sell':'buy';let intent;
 if(held){if(held.mk!==mk)return finish('awaiting official settlement');const price=bid(k.depth,held.side),prob=held.side==='Up'?k.p:1-k.p,edge=price-M().feesCents(price,1,'kalshi')-100*prob;
  record.edgeCents=edge;if(edge<SETTINGS.exitEdgeCents)return finish('hold: exit advantage below 3c');
  intent={action:'sell',side:held.side,limit:price,edgeCents:edge,tradeId:held.id};
 }else{
  const candidates=[['Up',k.p,k.depth.yes[0]],['Down',1-k.p,k.depth.no[0]]].filter(x=>x[2]).map(([side,p,l])=>({side,limit:l.price,edgeCents:100*p-l.price-M().feesCents(l.price,1,'kalshi')})).sort((a,b)=>b.edgeCents-a.edgeCents);
  intent=candidates[0];record.edgeCents=intent?.edgeCents??null;
  if(!intent||intent.edgeCents<SETTINGS.minEdgeCents)return finish('entry edge below 3c');
  if(s.trades.reduce((n,t)=>n+(t.pnlCents||0),0)<=-SETTINGS.lossStopCents)return finish('session loss stop');
  if((s.entries[mk]||0)>=SETTINGS.maxEntriesPerWindow)return finish('window entry-attempt cap');
  if(s.lastEntryAt!=null&&at-s.lastEntryAt<SETTINGS.cooldownMs)return finish('entry cooldown');
  intent.action='buy';s.entries[mk]=(s.entries[mk]||0)+1;s.lastEntryAt=at;
 }
 s.pending={...intent,at,readyAt:at+SETTINGS.delayMs,mk,close,p:k.p,decision:record};finish(intent.action+' intent');
}
function arrive(s,k){const at=k.at;clock(s,at);const q=s.pending;if(!q||at<q.readyAt)return;
 s.pending=null;const result={...q,arrivalAt:at,arrivalDepth:k.depth,arrivalExchange:k.exchange,arrivalMarketStatus:k.marketStatus,filled:0,reason:null};s.attempts.push(result);
 if(!active(s,at)||at>=q.close*1000||at-q.at>SETTINGS.maxDelayMs){result.reason='arrival outside allowed time';return;}
 // Arrival requires a live market and book; never requires a new favourable prediction.
 if(!k.depth?.valid||k.marketStatus!=='active'||k.exchange?.exchange_active!==true||k.exchange?.trading_active!==true){result.reason=k.depth?.reason||'arrival market or exchange unavailable';return;}
 const levels=q.action==='buy'?(q.side==='Up'?k.depth.yes:k.depth.no):(q.side==='Up'?k.depth.no:k.depth.yes).map(l=>({...l,price:100-l.price}));
 const level=levels.find(l=>Math.floor(l.size*SETTINGS.depthFraction)>=1&&(q.action==='buy'?l.price<=q.limit+1e-9:l.price>=q.limit-1e-9));
 if(!level){result.reason='no depth at original limit after haircut';return;}
 const fee=M().feesCents(level.price,1,'kalshi');result.filled=1;result.priceCents=level.price;result.feesCents=fee;result.reason='simulated fill';
 if(q.action==='buy')s.trades.push({id:s.id+':'+s.trades.length,mk:q.mk,close:q.close,side:q.side,entryAt:at,entryCents:level.price,entryFeeCents:fee,pnlCents:null});
 else{const t=s.trades.find(t=>t.id===q.tradeId&&t.pnlCents==null);if(!t)throw Error('paper position missing');Object.assign(t,{exitAt:at,exitCents:level.price,exitFeeCents:fee,pnlCents:level.price-fee-t.entryCents-t.entryFeeCents,resolution:'early exit'});}
}
function settle(s,mk,result,at){if(!['yes','no'].includes(result))return;for(const t of s.trades.filter(t=>t.mk===mk&&t.pnlCents==null&&at>=t.close*1000)){const won=(t.side==='Up')===(result==='yes');Object.assign(t,{exitAt:at,exitCents:won?100:0,exitFeeCents:0,pnlCents:(won?100:0)-t.entryCents-t.entryFeeCents,resolution:'official settlement',officialResult:result});}clock(s,at);}
function report(s){const closed=s.trades.filter(t=>t.pnlCents!=null).sort((a,b)=>a.exitAt-b.exitAt);let pnl=0,peak=0,drawdown=0;for(const t of closed){pnl+=t.pnlCents;peak=Math.max(peak,pnl);drawdown=Math.max(drawdown,peak-pnl);}const reasons={};for(const r of [...s.looks,...s.attempts.filter(a=>!a.filled)])reasons[r.reason]=(reasons[r.reason]||0)+1;
 return {looks:s.looks.length,eligible:s.looks.filter(l=>finite(l.edgeCents)).length,attempts:s.attempts.length+(s.pending?1:0),entryFills:s.trades.length,exitFills:closed.filter(t=>t.resolution==='early exit').length,wins:closed.filter(t=>t.pnlCents>0).length,losses:closed.filter(t=>t.pnlCents<0).length,open:s.trades.length-closed.length,feesCents:s.attempts.reduce((n,a)=>n+(a.feesCents||0),0),pnlCents:pnl,drawdownCents:drawdown,edgeAvailable:s.looks.some(l=>l.action==='buy'&&l.edgeCents>=SETTINGS.minEdgeCents),reasons,unrealizedExcluded:true};}
function due(s,now){if(!s)return Infinity;if(!active(s,now))return !s.stoppedAt?now+100:Infinity;return Math.max(now+100,Math.min(s.endAt,s.pending?.readyAt??Infinity,s.nextLookAt));}
globalThis.BTC15Session={VERSION,SETTINGS,create,active,clock,stop,decide,arrive,settle,report,due};
})();
