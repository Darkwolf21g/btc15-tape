const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),context=vm.createContext({Date});
vm.runInContext(fs.readFileSync(path.join(root,'shared-collector-health.js'),'utf8'),context);
const summarize=context.BTC15CollectorHealth.summarize,now=1800000000000;
test('collector health uses server time and never paints a failed or explicitly unhealthy run green',()=>{
 const c={now,lastOk:now-1000,lastCycleAt:now-500,lastRun:now-500,cycleFailures:1};
 assert.equal(summarize(c).state,'degraded');
 assert.equal(summarize({...c,lastCycleAt:now-130000}).healthy,false);
 assert.equal(summarize({...c,cycleFailures:0,healthy:false}).healthy,false);
 assert.equal(summarize({...c,cycleFailures:0}).state,'active');
 const stalled=summarize({...c,maintenanceRunning:true,maintenanceStartedAt:now-20000,stage:'research settlement'});
 assert.equal(stalled.state,'stalled');assert.match(stalled.details,/research settlement.*20s/);
});
test('current cycle failures are distinct from unrelated errors and older deployment history',()=>{
 const old={at:now-100000,stage:'checkpoint',error:'old failure'};
 const recent={at:now-500,stage:'research settlement',error:'read deadline exceeded'};
 const c={now,lastOk:now-60000,lastCycleAt:now-500,cycleFailures:1,cycleErrors:[recent],errors:[old,recent]};
 assert.match(summarize(c).details,/Failures in the last completed run/);assert.doesNotMatch(summarize(c).details,/old failure/);
 const legacy={...c};delete legacy.cycleErrors;
 assert.match(summarize(legacy).details,/Recent error history/);assert.doesNotMatch(summarize(legacy).details,/Failures in the last completed run/);
 assert.match(summarize({...c,cycleErrors:[],cycleFailures:0,lastOk:now}).details,/latest run succeeded/);
});

function agent() {
 const nodes=new Map(),calls=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',classList:{toggle(){}},addEventListener(){},querySelector:()=>({innerHTML:'',appendChild(){}})});return nodes.get(id);};
 let payload={now,lastOk:now-1000,lastCycleAt:now-500,lastRun:now-500,cycleFailures:1,
  cycleErrors:[{at:now-500,stage:'research settlement',error:'fixture 503'}]},status=200;
 const context=vm.createContext({console,Intl,Date,URL,AbortSignal,setTimeout(){},document:{getElementById:node,createElement:()=>({})},localStorage:{getItem:()=>null},
  fetch:async url=>{calls.push(String(url));return String(url).includes('/collector/status')?new Response(JSON.stringify(payload),{status}):new Response('{}',{status:503});}});
 const script=fs.readFileSync(path.join(root,'public/agent.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 vm.runInContext(script.slice(0,script.indexOf('refreshSession(); setInterval')),context);
 return {node,calls,refresh:()=>vm.runInContext('refresh()',context),set:(p,s=200)=>{payload=p;status=s;}};
}
test('agent reports degraded collector even when legacy status fails, then recovers and handles authentication errors',async()=>{
 const h=agent();await h.refresh();
 assert.match(h.node('collector').textContent,/Collector degraded.*1 failed task/);assert.match(h.node('collector').textContent,/research settlement: fixture 503/);
 assert.equal(h.node('collector').className,'bad');assert.equal(h.calls.length,2);
 h.set({now,lastOk:now-1000,cycleFailures:0});await h.refresh();
 assert.match(h.node('collector').textContent,/Collector active/);assert.equal(h.node('collector').className,'good');
 h.set({error:'denied'},403);await h.refresh();
 assert.equal(h.node('collector').textContent,'Collector unavailable · token required');assert.equal(h.node('collector').className,'bad');
 h.set({error:'service unavailable'},503);await h.refresh();assert.match(h.node('collector').textContent,/unavailable · HTTP 503/);
});
