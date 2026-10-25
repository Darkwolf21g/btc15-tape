// Forward-only timed paper experiment. No exchange order calls.
(() => {
const VERSION='paper-session-v2';
const SETTINGS=Object.freeze({durationMs:3600000,cadenceMs:5000,delayMs:1000,maxDelayMs:4000,depthFraction:.5,quantity:1,minEdgeCents:3,exitEdgeCents:3,maxEntriesPerWindow:3,cooldownMs:30000,lossStopCents:300,model:'brti-driftless-v4',settlementConvention:'[close-60s,close)',feeAssumption:'general Kalshi taker fee, rounded up per one-contract fill'});
const M=()=>globalThis.BTC15Model,finite=Number.isFinite;
// Strategies. 'model-edge' is the original: buy the side whose model probability beats the ask by
// the edge threshold, one contract. 'distance-v1' is a price-following rule that ignores the model:
// enter when the official index is enterUsd or more from the target, on that side, spending
// budgetCents at the ask; hold while the distance stays at least holdUsd; sell at the bid when it
// shrinks below holdUsd or the index crosses the target; after a sell, buy the same side again only
// once the index is reentryUsd further from the target than where it sold; a cross restarts the
// entry rule on the other side. No trading in the last stopBeforeCloseMs of a window.
const STRATEGIES=Object.freeze({
 'model-edge':Object.freeze({name:'model-edge'}),
 'distance-v1':Object.freeze({name:'distance-v1',enterUsd:15,holdUsd:10,reentryUsd:25,budgetCents:10000,maxEntriesPerWindow:6,cooldownMs:10000,lossStopCents:20000,stopBeforeCloseMs:60000,indexMaxAgeMs:3000}),
});
function create(now,id,strategy='model-edge'){if(!STRATEGIES[strategy])throw Error('unknown strategy '+strategy);const startAt=(Math.floor(now/900000)+1)*900000+750;return {version:VERSION,id,settings:{...SETTINGS,strategy,strategyParams:{...STRATEGIES[strategy]}},createdAt:now,startAt,endAt:startAt+SETTINGS.durationMs-750,status:'scheduled',looks:[],attempts:[],trades:[],pending:null,nextLookAt:startAt,entries:{},lastEntryAt:null,stoppedAt:null,lastSell:null};}
const strategyOf=s=>s?.settings?.strategy||'model-edge';
const paramsOf=s=>({...STRATEGIES[strategyOf(s)],...(s?.settings?.strategyParams||{})});
// A saved experiment keeps its original cohort forever. Deployment may stop it,
// but must never upgrade its settings or relabel observations with today's model.
function compatibilityReason(s){
 if(!s)return 'missing session';
 if(s.version!==VERSION||s.settings?.model!==SETTINGS.model||s.settings?.settlementConvention!==SETTINGS.settlementConvention)
  return 'incompatible session cohort: expected '+[VERSION,SETTINGS.model,SETTINGS.settlementConvention].join(' / ')+'; recorded '+[s.version??'unspecified',s.settings?.model??'unspecified',s.settings?.settlementConvention??'unspecified'].join(' / ');
 if(M()?.VERSION!==SETTINGS.model||M()?.SETTLEMENT_CONVENTION!==SETTINGS.settlementConvention)return 'incompatible runtime model or settlement interval';
 return null;
}
function compatible(s){return compatibilityReason(s)===null;}
function attribution(s,q){return {sessionVersion:q?.sessionVersion??s.version??null,model:q?.model??q?.decision?.model??s.settings?.model??null,settlementConvention:q?.settlementConvention??q?.decision?.settlementConvention??s.settings?.settlementConvention??null};}
function snapshotReason(k){return k?.model===SETTINGS.model&&k?.settlementConvention===SETTINGS.settlementConvention?null:'snapshot model or settlement interval mismatch';}
function active(s,at){return !!s&&compatible(s)&&s.stoppedAt==null&&at<s.endAt&&['scheduled','running'].includes(s.status);}
function position(s){return s.trades.find(t=>t.pnlCents==null);}
function stop(s,at,reason='time limit',pendingReason='session stopped'){
 if(s.stoppedAt==null){s.stoppedAt=at;s.stopReason=reason;}
 s.status=position(s)?'settling':'complete';
 if(s.pending){s.attempts.push({...s.pending,...attribution(s,s.pending),filled:0,arrivalAt:at,reason:pendingReason});s.pending=null;}
}
// Returns whether persistence is needed. Repeated loads and already-completed
// historical reports do not append attempts, rewrite provenance or move timestamps.
function reconcile(s,at){
 const reason=compatibilityReason(s);
 if(!s||!reason||(!s.pending&&(s.stoppedAt!=null||s.status==='complete')))return false;
 stop(s,at,reason,reason);return true;
}
function clock(s,at){reconcile(s,at);if(s.stoppedAt==null&&at>=s.endAt)stop(s,at);if(s.stoppedAt!=null&&!position(s))s.status='complete';if(active(s,at)&&at>=s.startAt)s.status='running';}
function valid(k){return k?.status==='forecast'&&finite(k.p)&&k.p>=0&&k.p<=1&&k.depth?.valid&&k.marketStatus==='active'&&k.exchange?.exchange_active===true&&k.exchange?.trading_active===true;}
function bid(depth,side){return side==='Up'?depth.bidCents:100-depth.askCents;}
function decide(s,k,mk,close){const at=k.at;clock(s,at);if(!active(s,at)||at<s.startAt||at<s.nextLookAt||s.pending)return;
 s.nextLookAt=at+SETTINGS.cadenceMs;
 const record={sessionVersion:s.version,model:k.model??null,settlementConvention:k.settlementConvention??null,at,mk,close,p:k.p,p2:k.p2,target:k.target,targetAt:k.targetAt,vols:k.vols,status:k.status,reads:k.reads,index:k.index,projection:k.projection,depth:k.depth,marketStatus:k.marketStatus,exchange:k.exchange,reason:null};
 const finish=reason=>{record.reason=reason;s.looks.push(record);};
 const mismatch=snapshotReason(k);if(mismatch)return finish(mismatch);
 if(strategyOf(s)==='distance-v1')return decideDistance(s,k,mk,close,record,finish);
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
 s.pending={...intent,sessionVersion:s.version,model:k.model,settlementConvention:k.settlementConvention,at,readyAt:at+SETTINGS.delayMs,mk,close,p:k.p,decision:record};finish(intent.action+' intent');
}
// Price-following rule. Uses the latest official one-second index reading and the market's target;
// the model probability is recorded but plays no part.
function decideDistance(s,k,mk,close,record,finish){
 const at=k.at,P=paramsOf(s),index=k.index,S0=index?.value,K=k.target;
 const live=k.depth?.valid&&k.marketStatus==='active'&&k.exchange?.exchange_active===true&&k.exchange?.trading_active===true;
 if(!live)return finish(k.depth?.reason||'market or exchange unavailable');
 if(!finite(S0)||!finite(index?.ageMs)||index.ageMs>P.indexMaxAgeMs)return finish('stale official index');
 if(!finite(K))return finish('missing target known at capture');
 const d=S0-K;record.distanceUsd=d;
 const deadline=Math.min(close*1000-P.stopBeforeCloseMs,s.endAt);
 if(at+SETTINGS.maxDelayMs>=deadline)return finish('inside the final minute');
 const held=position(s);record.action=held?'sell':'buy';
 if(held){
  if(held.mk!==mk)return finish('awaiting official settlement');
  const onSide=held.side==='Up'?d:-d;record.heldDistanceUsd=onSide;
  if(onSide>=P.holdUsd)return finish('hold: distance '+onSide.toFixed(2)+' holds above '+P.holdUsd);
  const price=bid(k.depth,held.side);if(!finite(price))return finish('no bid to sell into');
  s.pending={action:'sell',side:held.side,limit:price,n:held.n||1,tradeId:held.id,distanceUsd:d,sessionVersion:s.version,model:k.model,settlementConvention:k.settlementConvention,at,readyAt:at+SETTINGS.delayMs,mk,close,p:k.p,decision:record};
  return finish('sell intent: distance '+onSide.toFixed(2)+(onSide<0?' crossed':' below '+P.holdUsd));
 }
 const side=d>=P.enterUsd?'Up':d<=-P.enterUsd?'Down':null;
 if(!side)return finish('inside entry band: '+d.toFixed(2)+' vs ±'+P.enterUsd);
 const last=s.lastSell;
 if(last&&last.mk===mk&&last.side===side){const further=Math.abs(d)-Math.abs(last.distanceUsd);record.sinceSellUsd=further;if(further<P.reentryUsd)return finish('awaiting re-entry: '+further.toFixed(2)+' further than the sell, need '+P.reentryUsd);}
 if(s.trades.reduce((n,t)=>n+(t.pnlCents||0),0)<=-P.lossStopCents)return finish('session loss stop');
 if((s.entries[mk]||0)>=P.maxEntriesPerWindow)return finish('window entry-attempt cap');
 if(s.lastEntryAt!=null&&at-s.lastEntryAt<P.cooldownMs)return finish('entry cooldown');
 const level=(side==='Up'?k.depth.yes:k.depth.no)[0];if(!level)return finish('no ask to buy from');
 const n=Math.floor(P.budgetCents/level.price);if(n<1)return finish('budget below one contract');
 s.entries[mk]=(s.entries[mk]||0)+1;s.lastEntryAt=at;
 s.pending={action:'buy',side,limit:level.price,n,distanceUsd:d,sessionVersion:s.version,model:k.model,settlementConvention:k.settlementConvention,at,readyAt:at+SETTINGS.delayMs,mk,close,p:k.p,decision:record};
 return finish('buy intent: '+n+' contracts at ≤'+level.price+'¢, distance '+d.toFixed(2));
}
function arrive(s,k){const at=k.at;clock(s,at);const q=s.pending;if(!q||at<q.readyAt)return;
 s.pending=null;const result={...q,...attribution(s,q),arrivalModel:k.model??null,arrivalSettlementConvention:k.settlementConvention??null,arrivalAt:at,arrivalDepth:k.depth,arrivalExchange:k.exchange,arrivalMarketStatus:k.marketStatus,arrivalReads:k.reads,filled:0,reason:null};s.attempts.push(result);
 if(q.sessionVersion!==s.version||q.model!==s.settings.model||q.settlementConvention!==s.settings.settlementConvention){result.reason='intent model or settlement interval mismatch';return;}
 const mismatch=snapshotReason(k);if(mismatch){result.reason=mismatch;return;}
 if(!active(s,at)||at>=q.close*1000||at-q.at>SETTINGS.maxDelayMs){result.reason='arrival outside allowed time';return;}
 // Arrival requires a live market and book; never requires a new favourable prediction.
 if(!k.depth?.valid||k.marketStatus!=='active'||k.exchange?.exchange_active!==true||k.exchange?.trading_active!==true){result.reason=k.depth?.reason||'arrival market or exchange unavailable';return;}
 const levels=q.action==='buy'?(q.side==='Up'?k.depth.yes:k.depth.no):(q.side==='Up'?k.depth.no:k.depth.yes).map(l=>({...l,price:100-l.price}));
 const want=q.n||1;
 if(want===1){
  const level=levels.find(l=>Math.floor(l.size*SETTINGS.depthFraction)>=1&&(q.action==='buy'?l.price<=q.limit+1e-9:l.price>=q.limit-1e-9));
  if(!level){result.reason='no depth at original limit after haircut';return;}
  const fee=M().feesCents(level.price,1,'kalshi');result.filled=1;result.priceCents=level.price;result.feesCents=fee;result.reason='simulated fill';
  if(q.action==='buy')s.trades.push({...attribution(s,q),id:s.id+':'+s.trades.length,mk:q.mk,close:q.close,side:q.side,entryAt:at,entryCents:level.price,entryFeeCents:fee,pnlCents:null});
  else{const t=s.trades.find(t=>t.id===q.tradeId&&t.pnlCents==null);if(!t)throw Error('paper position missing');Object.assign(t,{exitAt:at,exitCents:level.price,exitFeeCents:fee,pnlCents:level.price-fee-t.entryCents-t.entryFeeCents,resolution:'early exit'});}
  return;
 }
 // Several contracts: walk the levels at or better than the original limit, half the displayed
 // size at each, until the quantity is met. Partial fills are real fills; the rest stays unfilled.
 let remaining=want,cost=0,fees=0;const fills=[];
 for(const l of levels){
  if(q.action==='buy'?l.price>q.limit+1e-9:l.price<q.limit-1e-9)break;
  const take=Math.min(remaining,Math.floor(l.size*SETTINGS.depthFraction));if(take<1)continue;
  fills.push({price:l.price,n:take});cost+=take*l.price;fees+=M().feesCents(l.price,take,'kalshi');remaining-=take;if(!remaining)break;
 }
 const filled=want-remaining;
 if(!filled){result.reason='no depth at original limit after haircut';return;}
 const avg=Math.round(cost/filled*100)/100;
 Object.assign(result,{filled,requested:want,priceCents:avg,feesCents:fees,levels:fills,reason:remaining?'simulated partial fill':'simulated fill'});
 if(q.action==='buy')s.trades.push({...attribution(s,q),id:s.id+':'+s.trades.length,mk:q.mk,close:q.close,side:q.side,n:filled,entryAt:at,entryCents:avg,entryFeeCents:fees,entryDistanceUsd:q.distanceUsd??null,pnlCents:null});
 else{
  const t=s.trades.find(t=>t.id===q.tradeId&&t.pnlCents==null);if(!t)throw Error('paper position missing');
  const held=t.n||1,closedN=Math.min(filled,held);
  if(closedN<held){ // the unsold remainder stays open as its own position, carrying its share of the entry fee
   const rest=held-closedN,restFee=Math.round(t.entryFeeCents*rest/held*100)/100;
   s.trades.push({...t,id:t.id+':r',n:rest,entryFeeCents:restFee,pnlCents:null});t.n=closedN;t.entryFeeCents=Math.round((t.entryFeeCents-restFee)*100)/100;
  }
  Object.assign(t,{exitAt:at,exitCents:avg,exitFeeCents:fees,pnlCents:Math.round((closedN*(avg-t.entryCents)-fees-t.entryFeeCents)*100)/100,resolution:'early exit'});
  s.lastSell={mk:q.mk,side:q.side,distanceUsd:q.distanceUsd??null,at,price:avg};
 }
}
function settle(s,mk,result,at){if(!['yes','no'].includes(result))return;for(const t of s.trades.filter(t=>t.mk===mk&&t.pnlCents==null&&at>=t.close*1000)){const won=(t.side==='Up')===(result==='yes'),n=t.n||1;Object.assign(t,{exitAt:at,exitCents:won?100:0,exitFeeCents:0,pnlCents:Math.round((n*((won?100:0)-t.entryCents)-t.entryFeeCents)*100)/100,resolution:'official settlement',officialResult:result});}clock(s,at);}
// Observed coverage, not backfilled decisions. Count only finished five-second
// bins; an in-progress bin is not a missed look. A stop closes its partial bin.
function coverage(s,now){
 const cadence=s.settings?.cadenceMs,start=s.startAt,end=s.endAt;
 if(!finite(cadence)||cadence<=0||!finite(start)||!finite(end)||end<=start)return null;
 const cutoff=Math.max(start,Math.min(now,end,s.stoppedAt??Infinity));
 const finished=cutoff>=end||s.stoppedAt!=null&&s.stoppedAt<=now;
 const planned=Math.ceil((end-start)/cadence),elapsed=Math.min(planned,Math.max(0,(finished?Math.ceil:Math.floor)((cutoff-start)/cadence)));
 const bins=new Map(),times=[];
 for(const l of s.looks){if(!finite(l.at)||l.at<start||l.at>=end||l.at>cutoff)continue;
  const slot=Math.floor((l.at-start)/cadence);bins.set(slot,(bins.get(slot)||0)+1);times.push(l.at);
 }
 const quarter=Math.floor(start/900000)*900000;
 const windows=Array.from({length:Math.ceil((end-quarter)/900000)},(_,i)=>({startAt:quarter+i*900000,close:quarter/1000+(i+1)*900,plannedSlots:0,elapsedSlots:0,observedSlots:0,missedSlots:0}));
 let observed=0;
 for(let slot=0;slot<planned;slot++){
  const w=windows[Math.floor((start+slot*cadence-quarter)/900000)];w.plannedSlots++;
  if(slot<elapsed){w.elapsedSlots++;if(bins.has(slot)){w.observedSlots++;observed++;}else w.missedSlots++;}
 }
 times.sort((a,b)=>a-b);let maxGap=0;
 for(let i=1;i<times.length;i++)maxGap=Math.max(maxGap,times[i]-times[i-1]);
 return {version:'observed-five-second-bins-v1',throughAt:cutoff,plannedSlots:planned,elapsedSlots:elapsed,observedSlots:observed,missedSlots:elapsed-observed,
  fraction:elapsed?observed/elapsed:null,extraLooksInSameSlot:[...bins.values()].reduce((n,c)=>n+Math.max(0,c-1),0),maxEvaluationGapMs:times.length>1?maxGap:null,windows};
}
function report(s,now=Date.now()){const closed=s.trades.filter(t=>t.pnlCents!=null).sort((a,b)=>a.exitAt-b.exitAt);let pnl=0,peak=0,drawdown=0;for(const t of closed){pnl+=t.pnlCents;peak=Math.max(peak,pnl);drawdown=Math.max(drawdown,peak-pnl);}const reasons={};for(const r of [...s.looks,...s.attempts.filter(a=>!a.filled)])reasons[r.reason]=(reasons[r.reason]||0)+1;
 const delays=s.attempts.filter(a=>a.filled&&finite(a.arrivalAt)&&finite(a.at)).map(a=>a.arrivalAt-a.at);
 return {version:s.version,strategy:strategyOf(s),strategyParams:paramsOf(s),model:s.settings?.model??null,settlementConvention:s.settings?.settlementConvention??null,compatible:compatible(s),contractsFilled:s.trades.reduce((n,t)=>n+(t.n||1),0),spentCents:Math.round(s.trades.reduce((n,t)=>n+(t.n||1)*t.entryCents,0)),compatibilityReason:compatibilityReason(s),looks:s.looks.length,eligible:s.looks.filter(l=>finite(l.edgeCents)).length,skippedDecisions:s.looks.filter(l=>!/^(buy|sell) intent/.test(l.reason||'')).length,coverage:coverage(s,now),fillDelayMs:delays.length?{min:Math.min(...delays),mean:delays.reduce((n,d)=>n+d,0)/delays.length,max:Math.max(...delays)}:null,attempts:s.attempts.length+(s.pending?1:0),entryFills:s.trades.length,exitFills:closed.filter(t=>t.resolution==='early exit').length,wins:closed.filter(t=>t.pnlCents>0).length,losses:closed.filter(t=>t.pnlCents<0).length,open:s.trades.length-closed.length,feesCents:s.attempts.reduce((n,a)=>n+(a.feesCents||0),0),pnlCents:pnl,drawdownCents:drawdown,edgeAvailable:s.looks.some(l=>l.action==='buy'&&l.edgeCents>=SETTINGS.minEdgeCents),reasons,unrealizedExcluded:true};}
function due(s,now){if(!s)return Infinity;if(!active(s,now))return s.stoppedAt==null?now+100:Infinity;return Math.max(now+100,Math.min(s.endAt,s.pending?.readyAt??Infinity,s.nextLookAt));}
globalThis.BTC15Session={VERSION,SETTINGS,STRATEGIES,create,compatible,reconcile,active,clock,stop,decide,arrive,settle,report,due};
})();
