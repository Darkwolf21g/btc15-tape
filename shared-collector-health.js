// One read-only health presentation for the tape and agent dashboard.
(() => {
function summarize(c) {
  const now=Number.isFinite(c.now)?c.now:Date.now();
  const age=t=>Number.isFinite(t)&&t>0?Math.max(0,(now-t)/1000):Infinity;
  const okAge=age(c.lastOk),cycleAge=age(c.lastCycleAt),runAge=age(c.lastRun);
  const lastSuccess=Number.isFinite(okAge)?(okAge<60?Math.round(okAge)+'s':Math.round(okAge/60)+'m')+' ago':'no successful run';
  const failures=Number.isFinite(c.cycleFailures)?Math.max(0,c.cycleFailures):0;
  let state,text;
  if(c.maintenanceRunning&&age(c.maintenanceStartedAt)>=15){state='stalled';text='maintenance overdue'+(c.stage?' · '+c.stage:'');}
  else if(failures>0&&cycleAge<120){state='degraded';text=failures+' failed task'+(failures===1?'':'s')+' · last success '+lastSuccess;}
  else if(okAge<120&&!failures&&c.healthy!==false){state='active';text=Math.round(okAge)+'s ago · '+(c.forecasts||0)+' forecasts';}
  else if(runAge<120){state='working';text='last success '+lastSuccess;}
  else {state='stale';text=lastSuccess;}
  const history=Array.isArray(c.errors)?c.errors:[];
  // New responses identify failures from the completed cycle explicitly. Old
  // deployments retain a clearly labelled history instead of guessing attribution.
  const cycleErrors=failures>0&&Array.isArray(c.cycleErrors)?c.cycleErrors:[];
  const when=t=>Number.isFinite(t)&&t>0?new Date(t).toISOString():'time unavailable';
  const describe=e=>when(e.at)+' · '+(e.stage||'collector')+': '+String(e.error||'unknown error');
  const details=[];
  if(state==='stalled')details.push('Current task: '+(c.stage||'unknown')+' · running '+Math.round(age(c.maintenanceStartedAt))+'s.');
  if(cycleErrors.length)details.push('Failures in the last completed run ('+when(c.lastCycleAt)+'):\n'+cycleErrors.map(describe).join('\n'));
  else if(history.length)details.push((state==='active'?'Recent error history (latest run succeeded):':'Recent error history:')+'\n'+history.slice(-3).map(describe).join('\n'));
  if(failures>0&&!cycleErrors.length)details.push('The last completed run reported '+failures+' failed task'+(failures===1?'':'s')+'.');
  return {state,healthy:state==='active',text:'Collector '+state+' · '+text,details:details.join('\n')};
}
globalThis.BTC15CollectorHealth=Object.freeze({summarize});
})();
