const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
const source=html.slice(html.indexOf('function connectFeed()'),html.indexOf('setInterval(() => {                                  // the relay answers'));
function harness(fetch, token='') {
  const sockets=[],timers=new Map();let next=0;
  class Socket {
    constructor(url){this.url=url;this.readyState=0;sockets.push(this);}
    close(){this.readyState=3;this.onclose?.();}
    open(){this.readyState=1;this.onopen?.();}
  }
  const feed={ws:null,state:'off',check:null,timer:null,token,backoff:1000,fails:0,counts:{}};
  const context=vm.createContext({feed,relayPauseUntil:0,Date,URL,AbortController,fetch,WebSocket:Socket,
    feedUrl:()=>`wss://relay.test/base/feed${feed.token?'?token='+encodeURIComponent(feed.token):''}`,
    render(){},setTimeout(fn,ms){timers.set(++next,{fn,ms});return next;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(source,context);
  return {feed,sockets,timers,run:s=>vm.runInContext(s,context)};
}
test('missing and rejected tokens stop the WebSocket reconnect loop',async()=>{
  for(const token of ['', 'invalid + token']) {
    let requested;
    const h=harness(async url=>{requested=new URL(url);return new Response('token',{status:403});},token);
    h.run('connectFeed()');const ws=h.sockets[0];ws.readyState=3;
    await h.run('diagnoseFeed(feed.ws, feed.ws.url)');
    assert.equal(requested.pathname,'/base/feed/status');assert.equal(requested.searchParams.get('token'),token||null);
    assert.equal(h.feed.state,'auth');assert.equal(h.feed.check,null);assert.equal(h.timers.size,0);
    h.run('retryFeed(); connectFeed()');assert.equal(h.sockets.length,1);assert.equal(h.timers.size,0);
  }
});
test('outages and unrelated 403 responses keep bounded reconnects',async()=>{
  for(const response of [()=>new Response('unavailable',{status:503}),()=>new Response('proxy blocked',{status:403}),()=>{throw Error('offline');}]) {
    const h=harness(async()=>response());h.run('connectFeed()');
    await h.run('diagnoseFeed(feed.ws, feed.ws.url)');
    assert.notEqual(h.feed.state,'auth');assert.equal(h.timers.size,1);
    assert.equal([...h.timers.values()][0].ms,1000);assert.equal(h.feed.backoff,2000);
  }
});
test('saving a token reconnects immediately and ignores a delayed rejection from the old token',async()=>{
  let release,signal;
  const h=harness((_url,options)=>{signal=options.signal;return new Promise(resolve=>release=resolve);});
  h.run('connectFeed()');const old=h.sockets[0],pending=h.run('diagnoseFeed(feed.ws, feed.ws.url)');
  h.feed.token='new token';h.run('resetFeed()');
  assert.equal(signal.aborted,true);assert.equal(h.sockets.length,2);assert.match(h.sockets[1].url,/token=new%20token/);
  h.sockets[1].open();old.onopen();old.onclose();
  release(new Response('token',{status:403}));await pending;
  assert.equal(h.feed.state,'open');assert.equal(h.feed.ws,h.sockets[1]);assert.equal(h.feed.check,null);assert.equal(h.timers.size,0);
});
test('saving a token during an open connection detaches its asynchronous close handler',()=>{
  const h=harness(async()=>new Response('token',{status:403}));h.run('connectFeed()');const old=h.sockets[0];old.open();
  h.feed.state='auth';h.feed.token='valid';h.run('resetFeed()');h.sockets[1].open();old.onclose();
  assert.equal(h.feed.state,'open');assert.equal(h.sockets.length,2);assert.equal(h.feed.fails,0);assert.equal(h.timers.size,0);
});
