import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const interfaces=os.networkInterfaces;
os.networkInterfaces=()=>{try{return interfaces();}catch{return {};}};
syncBuiltinESMExports();
const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:process.cwd()+'/.wrangler/review-build/worker.js',modulesRoot:process.cwd(),compatibilityDate:'2025-06-01',durableObjects:{FEED:{className:'KalshiFeed',useSQLite:true}},bindings:{FEED_TOKEN:'local-test-token'}}));
try {
 const denied=await mf.dispatchFetch('https://test/collector/status'); assert.equal(denied.status,403);
 const r=await mf.dispatchFetch('https://test/collector/status?token=local-test-token'); const d=await r.json(); assert.equal(r.status,200); assert.equal(d.healthy,false); assert.equal(d.forecasts,0);
 const st=await (await mf.dispatchFetch('https://test/trade/status?token=local-test-token')).json(); assert.equal(st.config.mode,'off');
 const bad=await mf.dispatchFetch('https://test/trade/config?token=local-test-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minEdge:-10})}); assert.equal(bad.status,400);
 const rec=await (await mf.dispatchFetch('https://test/record?token=local-test-token')).json(); assert.deepEqual(rec,[]);
 console.log('Worker runtime: auth gate, SQLite health, default OFF, config validation, record PASS');
} finally { await mf.dispose(); }
