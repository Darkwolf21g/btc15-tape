const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const start='// BEGIN SHARED BTC15 MODEL',end='// END SHARED BTC15 MODEL';
const block=start+'\n'+fs.readFileSync(path.join(root,'shared-model.js'),'utf8').trimEnd()+'\n'+end;
for(const file of ['worker.js','public/index.html']) {
 const name=path.join(root,file),text=fs.readFileSync(name,'utf8');
 const a=text.indexOf(start),b=text.indexOf(end);
 if(a<0||b<a)throw Error('Missing model markers in '+file);
 const next=text.slice(0,a)+block+text.slice(b+end.length);
 if(process.argv.includes('--check')) {if(next!==text)throw Error('Stale shared model in '+file);}else fs.writeFileSync(name,next);
}
if(!process.argv.includes('--check'))fs.copyFileSync(path.join(root,'public/index.html'),path.join(root,'index.html'));
