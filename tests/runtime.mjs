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
 assert.equal((await mf.dispatchFetch('https://test/research/export')).status,403);
 const research=await (await mf.dispatchFetch('https://test/research/status?token=local-test-token')).json();assert.equal(research.recordedWindows,0);
 const report=await (await mf.dispatchFetch('https://test/research/report?token=local-test-token')).json();assert.equal(report.evaluatedWindows,0);assert.equal(report.readyForLive,false);
 const exported=await (await mf.dispatchFetch('https://test/research/export?token=local-test-token')).json();assert.deepEqual(exported.rows,[]);assert.equal(exported.nextAfter,null);
 assert.equal((await mf.dispatchFetch('https://test/research/export?token=local-test-token',{method:'POST'})).status,405);
 assert.equal((await mf.dispatchFetch('https://test/research/inputs?token=local-test-token&close=1&check=60')).status,404);
 assert.equal((await mf.dispatchFetch('https://test/paper-session/status')).status,403);
 const session=await (await mf.dispatchFetch('https://test/paper-session/status?token=local-test-token')).json();assert.equal(session.session,null);
 assert.equal((await mf.dispatchFetch('https://test/paper-session/start?token=local-test-token',{method:'POST'})).status,409);
 // Setup link: wrong token refused; right token sets a cookie and redirects into the tape; the cookie then authenticates reads.
 assert.equal((await mf.dispatchFetch('https://test/setup?token=wrong',{redirect:'manual'})).status,403);
 const setup=await mf.dispatchFetch('https://test/setup?token=local-test-token',{redirect:'manual'});
 assert.equal(setup.status,302);assert.equal(setup.headers.get('location'),'https://test/#token=local-test-token');
 const cookie=setup.headers.get('set-cookie');assert.match(cookie,/^btc15_token=local-test-token; Path=\/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax$/);
 const viaCookie=await mf.dispatchFetch('https://test/collector/status',{headers:{Cookie:'other=1; btc15_token=local-test-token'}});assert.equal(viaCookie.status,200);
 assert.equal((await mf.dispatchFetch('https://test/collector/status',{headers:{Cookie:'btc15_token=nope'}})).status,403);
 const sessionViaCookie=await mf.dispatchFetch('https://test/paper-session/status',{headers:{Cookie:'btc15_token=local-test-token'}});assert.equal(sessionViaCookie.status,200,'the DO sees the token the outer worker forwarded');
 console.log('Worker runtime: auth, SQLite, default OFF, controls, research report/export/retention, setup link PASS');
} finally { await mf.dispose(); }
