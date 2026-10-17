'use strict';
// Trusted publisher. Install outside the agent sandbox. Configuration is administrator-owned.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {autoPublishAllowed,childEnvironment}=require('./fault-agent-worker');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,env:childEnvironment(),timeout:90000,stdio:['ignore','pipe','pipe']}).trim();
async function publish(manifestFile,configurationFile){
  if(!path.isAbsolute(manifestFile||'')||!path.isAbsolute(configurationFile||''))throw new Error('Absolute manifest and trusted configuration paths required');
  const m=JSON.parse(await fs.readFile(manifestFile,'utf8')),c=JSON.parse(await fs.readFile(configurationFile,'utf8'));
  if(!path.isAbsolute(c.repo||'')||!path.isAbsolute(m.workspace||'')||!Number.isSafeInteger(m.job_id)||!/^[a-f0-9]{40}$/.test(m.base_revision||'')||!Array.isArray(m.changed_files)||!autoPublishAllowed(m.changed_files))throw new Error('Invalid repair manifest');
  const remote=c.remote||'origin',branch=c.branch||'main';if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(remote)||!/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(branch)||branch.includes('..'))throw new Error('Invalid deployment target');
  const origin=new URL(c.public_origin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('HTTPS production origin required');
  if(git(c.repo,['status','--porcelain','--untracked-files=no']))throw new Error('Deployment checkout is dirty');
  git(c.repo,['fetch',remote,branch]);if(git(c.repo,['rev-parse',`${remote}/${branch}`])!==m.base_revision)throw new Error('Deployment branch changed; rebuild repair on current code');
  const payload=[];
  for(const name of m.changed_files){
    const file=path.resolve(m.workspace,name),stat=await fs.lstat(file);if(!file.startsWith(path.resolve(m.workspace)+path.sep)||!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error('Invalid repair file');
    const data=await fs.readFile(file);if(sha(data)!==m.hashes[name])throw new Error('Repair changed after validation');payload.push({name,data});
  }
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ironbend-publish-')),checkout=path.join(root,'source'),repairBranch=`codex/fault-${m.job_id}-${crypto.randomBytes(4).toString('hex')}`;
  git(c.repo,['worktree','add','-b',repairBranch,checkout,m.base_revision]);
  for(const {name,data} of payload)await fs.writeFile(path.join(checkout,name),data);
  // Tests come from the trusted base: the agent cannot change this suite or the command.
  const tests=(await fs.readdir(path.join(checkout,'test'))).filter(name=>name.endsWith('.test.js')).map(name=>path.join('test',name));
  if(!tests.length)throw new Error('No trusted regression suite');
  execFileSync(process.execPath,['--test',...tests],{cwd:checkout,env:{...childEnvironment(),NODE_ENV:'test',NODE_PATH:path.join(c.repo,'node_modules')},windowsHide:true,timeout:5*60000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
  // Snapshot bytes above are the ones tested and committed. The agent cannot race this checkout.
  git(checkout,['add','--',...m.changed_files]);
  git(checkout,['-c','user.name=IronBend Fault Agent','-c','user.email=fault-agent@ironbend.local','commit','-m',`Fix fault report ${m.job_id}`]);
  const revision=git(checkout,['rev-parse','HEAD']);git(checkout,['push',remote,`HEAD:refs/heads/${branch}`]);
  const deadline=Date.now()+9*60000;
  do{
    let verified=true;
    for(const {name,data} of payload){try{const url=new URL('/'+name.slice('public/'.length),origin);url.searchParams.set('fault_revision',revision);const response=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok||sha(Buffer.from(await response.arrayBuffer()))!==sha(data))verified=false;}catch{verified=false;}}
    if(verified)return{deployed:true,tests_passed:true,revision};await new Promise(resolve=>setTimeout(resolve,15000));
  }while(Date.now()<deadline);
  throw new Error('Code pushed but live assets not verified. Do not retry without checking deployment.');
}
if(require.main===module)publish(process.argv[2],process.argv[3]).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('[fault-publisher] Stopped; inspect deployment before retrying.');process.exitCode=1;});
module.exports={publish};
