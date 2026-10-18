const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const start='// BEGIN SHARED BTC15 MODEL',end='// END SHARED BTC15 MODEL';
const block=start+'\n'+fs.readFileSync(path.join(root,'shared-model.js'),'utf8').trimEnd()+'\n'+end;
const researchStart='// BEGIN SHARED BTC15 RESEARCH',researchEnd='// END SHARED BTC15 RESEARCH';
for(const file of ['worker.js','public/index.html']) {
 const name=path.join(root,file),text=fs.readFileSync(name,'utf8');
 const a=text.indexOf(start),b=text.indexOf(end);
 if(a<0||b<a)throw Error('Missing model markers in '+file);
 let next=text.slice(0,a)+block+text.slice(b+end.length);
 if(file==='worker.js'){
  const sa=next.indexOf('// BEGIN SHARED BTC15 SESSION'),sb=next.indexOf('// END SHARED BTC15 SESSION');
  if(sa<0||sb<sa)throw Error('Missing session markers');
  next=next.slice(0,sa)+'// BEGIN SHARED BTC15 SESSION\n'+fs.readFileSync(path.join(root,'shared-session.js'),'utf8').trimEnd()+'\n'+next.slice(sb);
  const ra=next.indexOf(researchStart),rb=next.indexOf(researchEnd);
  if(ra<0||rb<ra)throw Error('Missing research markers');
  next=next.slice(0,ra)+researchStart+'\n'+fs.readFileSync(path.join(root,'shared-research.js'),'utf8').trimEnd()+'\n'+next.slice(rb);
 }
 if(process.argv.includes('--check')) {if(next!==text)throw Error('Stale shared model in '+file);}else fs.writeFileSync(name,next);
}
for(const file of ['public/index.html','public/agent.html']) {
 const name=path.join(root,file),text=fs.readFileSync(name,'utf8');
 const start='// BEGIN SHARED BTC15 COLLECTOR HEALTH',end='// END SHARED BTC15 COLLECTOR HEALTH';
 const a=text.indexOf(start),b=text.indexOf(end);
 if(a<0||b<a)throw Error('Missing collector health markers in '+file);
 const next=text.slice(0,a)+start+'\n'+fs.readFileSync(path.join(root,'shared-collector-health.js'),'utf8').trimEnd()+'\n'+text.slice(b);
 if(process.argv.includes('--check')) {if(next!==text)throw Error('Stale collector health in '+file);}else fs.writeFileSync(name,next);
}
{
 const name=path.join(root,'public/index.html'),text=fs.readFileSync(name,'utf8');
 const start='// BEGIN SHARED BTC15 REPLICA',end='// END SHARED BTC15 REPLICA';
 const a=text.indexOf(start),b=text.indexOf(end);
 if(a<0||b<a)throw Error('Missing replica markers in public/index.html');
 const next=text.slice(0,a)+start+'\n'+fs.readFileSync(path.join(root,'shared-brti.js'),'utf8').trimEnd()+'\n'+text.slice(b);
 if(process.argv.includes('--check')) {if(next!==text)throw Error('Stale replica in public/index.html');}else fs.writeFileSync(name,next);
}
if(!process.argv.includes('--check'))fs.copyFileSync(path.join(root,'public/index.html'),path.join(root,'index.html'));

if(!process.argv.includes('--check'))fs.copyFileSync(path.join(root,'public/agent.html'),path.join(root,'agent.html'));
if(process.argv.includes('--check'))for(const file of ['index.html','agent.html']){
 if(fs.readFileSync(path.join(root,'public',file),'utf8')!==fs.readFileSync(path.join(root,file),'utf8'))throw Error('Stale page mirror: '+file);
}
