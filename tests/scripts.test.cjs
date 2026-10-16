const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
const cli=args=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;return spawnSync(process.execPath,args,{encoding:'utf8',env});};
// Execute the actual CLI body with real filesystem I/O and isolated argv/output.
const research=async args=>{
 const vm=require('node:vm'),errors=[];
 const context=vm.createContext({fs:require('node:fs/promises'),path,process:{argv:['node','research.mjs',...args],env:{}},console:{log(){},error:s=>errors.push(s)}});
 for(const file of ['shared-model.js','shared-research.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
 const source=fs.readFileSync(path.join(root,'scripts/research.mjs'),'utf8').replace(/^import[^\n]+$/gm,'');
 await vm.runInContext('(async()=>{'+source+'})()',context);
 return {status:context.process.exitCode||0,stderr:errors.join('\n')};
};
test('offline evaluation refuses to overwrite its input dataset or a symlink to it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'btc15-export-'));
 try{
  const input=path.join(dir,'data.json'),alias=path.join(dir,'alias.json'),content=JSON.stringify({schema:'settlement-research-v2',rows:[]});fs.writeFileSync(input,content);fs.symlinkSync(input,alias);
  for(const output of [input,alias]){
   const r=await research(['evaluate',input,output]);
   assert.equal(r.status,1);assert.match(r.stderr,/different input and output/);assert.equal(fs.readFileSync(input,'utf8'),content);
  }
  const output=path.join(dir,'report.json'),r=await research(['evaluate',input,output]);
  assert.equal(r.status,0);assert.equal(JSON.parse(fs.readFileSync(output)).readyForLive,false);assert.equal(fs.readFileSync(input,'utf8'),content);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('source check rejects either stale deployed page mirror',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'btc15-mirrors-'));
 try{
  for(const file of ['scripts/sync-model.cjs','worker.js','shared-model.js','shared-research.js','shared-session.js','public/index.html','public/agent.html','index.html','agent.html']){
   const output=path.join(dir,file);fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(path.join(root,file),output);
  }
  const check=()=>cli([path.join(dir,'scripts/sync-model.cjs'),'--check']);
  assert.equal(check().status,0);
  for(const name of ['index.html','agent.html']){
   const file=path.join(dir,name),content=fs.readFileSync(file,'utf8');fs.appendFileSync(file,'\n');const r=check();assert.notEqual(r.status,0);assert.match(r.stderr,/Stale page mirror/);fs.writeFileSync(file,content);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
