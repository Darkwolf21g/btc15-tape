const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function agent(){
 const nodes=new Map(),requests=[];
 const context=vm.createContext({console,Intl,Date,AbortSignal,
  $:id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false});return nodes.get(id);},
  q:()=>'?token=fixture',ET:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'}),
  money:c=>(c/100).toFixed(2),fetch:async url=>{requests.push(url);return new Response(JSON.stringify(context.payload));},Response,
 });
 for(const f of ['shared-model.js','shared-research.js','shared-session.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),context);
 const html=fs.readFileSync(path.join(__dirname,'../public/agent.html'),'utf8');
 vm.runInContext(html.slice(html.indexOf('let sessionData='),html.indexOf('let cfg =')),context);
 const s=context.BTC15Session.create(1800000000000,'ui-fixture'),at=s.startAt;
 s.looks=[{at,reason:'missing settlement readings'}];context.BTC15Session.stop(s,at+30000,'manual stop');
 context.payload={session:s,report:context.BTC15Session.report(s,at+30000),now:at+30000};
 return {context,nodes,requests,refresh:()=>vm.runInContext('refreshSession()',context)};
}
test('session UI renders missed slots and cohort without depending on legacy status',async()=>{
 const h=agent();await h.refresh();
 assert.equal(h.requests.length,1);assert.match(h.requests[0],/paper-session\/status/);
 const text=h.nodes.get('sessionCoverage').textContent;
 assert.match(text,/brti-driftless-v4/);assert.match(text,/1\/6 finished 5s slots observed · 5 missed/);assert.match(text,/no fills/);
 assert.equal(h.nodes.get('sessionPnl').textContent,'0.00');assert.equal(h.nodes.get('sessionStart').disabled,false);
});
test('session UI clears stale result tiles and prevents a start after failed refresh',async()=>{
 const h=agent();await h.refresh();h.context.fetch=async()=>{throw Error('network unavailable');};await h.refresh();
 assert.match(h.nodes.get('sessionStatus').textContent,/STALE.*network unavailable/);
 for(const id of ['sessionPnl','sessionFills','sessionOpen'])assert.equal(h.nodes.get(id).textContent,'—');
 assert.equal(h.nodes.get('sessionStart').disabled,true);assert.equal(h.nodes.get('sessionCoverage').textContent,'Session coverage unavailable.');
});
test('overlapping session polls coalesce while a response is pending',async()=>{
 const h=agent();let release,calls=0;const gate=new Promise(resolve=>release=resolve);
 h.context.fetch=async()=>{calls++;await gate;return new Response(JSON.stringify(h.context.payload));};
 const first=h.refresh();await h.refresh();assert.equal(calls,1);release();await first;
 await h.refresh();assert.equal(calls,2);
});
