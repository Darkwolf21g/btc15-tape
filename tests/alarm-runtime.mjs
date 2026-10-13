// Runtime contract for non-blocking collector/session jobs: waitUntil work must
// not hold the Durable Object alarm-handler lock after alarm() returns.
// This fixture uses only local workerd/SQLite state; it makes no network calls.
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const interfaces = os.networkInterfaces;
os.networkInterfaces = () => { try { return interfaces(); } catch { return {}; } };
syncBuiltinESMExports();
const {Miniflare, convertV4MiniflareOptions} = await import('miniflare');

const script = `
export default {
  fetch(request, env) {
    return env.PROBE.get(env.PROBE.idFromName('wait-until-alarm')).fetch(request);
  }
}
export class AlarmProbe {
  constructor(state) {
    this.state = state;
    this.runs = 0;
    this.pending = false;
    this.events = [];
    this.release = null;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/start') {
      await this.state.storage.setAlarm(Date.now() + 25);
      return new Response('started');
    }
    if (path === '/release') this.release?.();
    return Response.json({runs: this.runs, pending: this.pending, events: this.events});
  }
  async alarm() {
    this.runs++;
    this.events.push({run: this.runs, pending: this.pending});
    if (this.runs === 1) {
      this.pending = true;
      const blocked = new Promise(resolve => { this.release = resolve; });
      this.state.waitUntil(blocked.then(() => {
        this.pending = false;
        this.events.push({completed: true});
      }));
      await this.state.storage.setAlarm(Date.now() + 25);
    }
  }
}`;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script,
  compatibilityDate: '2025-06-01',
  durableObjects: {PROBE: {className: 'AlarmProbe', useSQLite: true}},
}));
const status = async () => (await mf.dispatchFetch('https://local.test/status')).json();
async function until(predicate) {
  const deadline = Date.now() + 5000;
  let observed;
  do {
    observed = await status();
    if (predicate(observed)) return observed;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail('Runtime condition timed out: ' + JSON.stringify(observed));
}
try {
  assert.equal((await mf.dispatchFetch('https://local.test/start')).status, 200);
  const second = await until(s => s.runs >= 2);
  assert.equal(second.runs, 2);
  assert.equal(second.pending, true, 'first waitUntil task must still be blocked');
  assert.deepEqual(second.events, [
    {run: 1, pending: false},
    {run: 2, pending: true},
  ], 'the second alarm must run before the first alarm\'s background task completes');
  await mf.dispatchFetch('https://local.test/release');
  const finished = await until(s => !s.pending);
  assert.deepEqual(finished.events, [...second.events, {completed: true}]);
  assert.equal(finished.runs, 2);
  console.log('Alarm runtime regression PASS: a second alarm runs while earlier waitUntil work remains pending');
} finally {
  try { await mf.dispatchFetch('https://local.test/release'); } catch {}
  await mf.dispose();
}
