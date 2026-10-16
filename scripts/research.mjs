import fs from 'node:fs/promises';
import path from 'node:path';
import '../shared-model.js';
import '../shared-research.js';

const [command,input,output,...flags]=process.argv.slice(2);
if(!['download','evaluate'].includes(command)||!input||!output){
  console.error('Usage: node scripts/research.mjs download https://YOUR-WORKER/ data.json [--inputs]\n       node scripts/research.mjs evaluate data.json report.json\nSet FEED_TOKEN in your local environment when the Worker requires it.');
  process.exitCode=1;
}else{
  try{
    if(command==='evaluate'){
      const source=await fs.realpath(input),destination=await fs.realpath(output).catch(()=>path.resolve(output));
      if(source===destination)throw Error('Use different input and output files; preserve the research export');
      const bundle=JSON.parse(await fs.readFile(input,'utf8'));
      if(bundle.schema!==globalThis.BTC15Research.VERSION||!Array.isArray(bundle.rows))throw Error('Unsupported research export');
      const result=globalThis.BTC15Research.report(bundle.rows);
      await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');
      console.log(`${result.settledWindows} settled windows; ${result.evaluatedWindows} in eligible test blocks. ${result.status}`);
    }else{
      const base=new URL(input);
      if(base.protocol!=='https:'||base.username||base.password||base.search)throw Error('Use an HTTPS Worker URL without credentials or query parameters');
      const get=async(path,params={})=>{
        const url=new URL(path,base);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
        if(process.env.FEED_TOKEN)url.searchParams.set('token',process.env.FEED_TOKEN);
        const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
        if(r.status===404)return null;
        if(!r.ok)throw Error('Research request HTTP '+r.status);
        return r.json();
      };
      const bundle={schema:globalThis.BTC15Research.VERSION,capturedAt:new Date().toISOString(),rows:[]};
      let after=0,through=Math.floor(Date.now()/1000);
      do{
        const page=await get('/research/export',{after,through,limit:100});
        if(!page||page.schema!==bundle.schema||!Array.isArray(page.rows))throw Error('Research endpoint unavailable or unsupported');
        bundle.rows.push(...page.rows);bundle.model=page.model;bundle.settings=page.settings;
        if(page.nextAfter!=null&&page.nextAfter<=after)throw Error('Invalid export cursor');
        after=page.nextAfter;
      }while(after!=null);
      if(flags.includes('--inputs')){
        bundle.inputs=[];bundle.unavailableInputs=0;
        for(const row of bundle.rows)for(const check of [0,...Object.keys(row.checks||{}).filter(c=>row.checks[c].index)]){
          const d=await get('/research/inputs',{close:row.close,check});
          if(d)bundle.inputs.push(d);else bundle.unavailableInputs++;
        }
      }
      await fs.writeFile(output,JSON.stringify(bundle,null,2)+'\n');
      console.log(`Exported ${bundle.rows.length} windows${bundle.inputs?`, ${bundle.inputs.length} input snapshots, ${bundle.unavailableInputs} unavailable`:''}.`);
    }
  }catch(e){console.error(e.message);process.exitCode=1;}
}
