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
  const ra=next.indexOf(researchStart),rb=next.indexOf(researchEnd);
  if(ra<0||rb<ra)throw Error('Missing research markers');
  next=next.slice(0,ra)+researchStart+'\n'+fs.readFileSync(path.join(root,'shared-research.js'),'utf8').trimEnd()+'\n'+next.slice(rb);
 }
 if(process.argv.includes('--check')) {if(next!==text)throw Error('Stale shared model in '+file);}else fs.writeFileSync(name,next);
}
if(!process.argv.includes('--check'))fs.copyFileSync(path.join(root,'public/index.html'),path.join(root,'index.html'));
