const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('legacy dashboard trade rows escape response text instead of interpreting markup',async()=>{
 const nodes=new Map(),rows=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',classList:{toggle(){}},addEventListener(){},querySelector:()=>({set innerHTML(v){},appendChild:r=>rows.push(r)})});return nodes.get(id);};
 const config={mode:'off',paperDelayMs:1000,paperVenue:'kalshi',paperDepthFraction:.5,perWindowCents:1000,maxTradesPerDay:12,dailyLossStopCents:300,firstSeconds:300};
 const attack='<img src=x onerror=alert(1)>';
 const status={config,stream:'off',ticks:0,windows:[{trades:[{at:Date.now(),side:attack,mode:'paper',price:40,offered:10,filled:0,n:1,edge:3,p:.6,lo:.5,hi:.7,reason:attack}]}]};
 const context=vm.createContext({console,Intl,Date,URL,AbortSignal,setTimeout(){},document:{getElementById:node,createElement:()=>({})},localStorage:{getItem:()=>null},fetch:async url=>new Response(JSON.stringify(String(url).includes('/trade/status')?status:{}))});
 const html=fs.readFileSync(path.join(__dirname,'../public/agent.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 vm.runInContext(script.slice(0,script.indexOf('refreshSession(); setInterval')),context);await vm.runInContext('refresh()',context);
 assert.equal(rows.length,1);assert.doesNotMatch(rows[0].innerHTML,/<img/);assert.match(rows[0].innerHTML,/&lt;img/);
});
