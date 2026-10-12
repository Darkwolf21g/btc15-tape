// Regression: a fetch abort deadline must not survive a successful WebSocket upgrade.
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const interfaces=os.networkInterfaces;
os.networkInterfaces=()=>{try{return interfaces();}catch{return {};}};
syncBuiltinESMExports();
const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
const {WebSocketServer}=await import('ws');
const server=createServer(); const wss=new WebSocketServer({server});
wss.on('connection',ws=>{const timer=setInterval(()=>{if(ws.readyState===1)ws.send('tick');},25);ws.on('close',()=>clearInterval(timer));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const upstream=`http://127.0.0.1:${server.address().port}`;
const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
const fixed=source.slice(source.indexOf('async function upgradeFetch('),source.indexOf('\n}',source.indexOf('async function upgradeFetch('))+2).replace('12000','150');
async function probe(helper) {
 const script=`${helper}\nexport default {async fetch(){const r=await upgradeFetch('${upstream}',{headers:{Upgrade:'websocket'}}); const ws=r.webSocket; ws.accept(); let count=0;ws.addEventListener('message',()=>count++);await new Promise(resolve=>setTimeout(resolve,450));return Response.json({state:ws.readyState,count});}}`;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2025-06-01'}));
 try{return await(await mf.dispatchFetch('http://test')).json();} finally{await mf.dispose();}
}
try {
 const broken=await probe('const upgradeFetch=(url,opts)=>fetch(url,{...opts,signal:AbortSignal.timeout(150)});');
 const repaired=await probe(fixed);
 assert.notEqual(broken.state,1,'old persistent deadline must reproduce the closed socket');
 assert.equal(repaired.state,1,'upgraded socket must survive the former deadline');
 assert.ok(repaired.count>broken.count);
 console.log('WebSocket runtime regression PASS', {broken,repaired});
} finally {for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
