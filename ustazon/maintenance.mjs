import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runtime,remainingUpload,alreadyPublished} from './reliability.mjs';
import {writeJSON} from './state.mjs';
import {redact} from './gemini.mjs';

export async function fileDigest(file) {
  const handle=await fs.open(file,'r'),hash=createHash('sha256');
  try{for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);}
  finally{await handle.close();}
  return hash.digest('hex');
}
export async function diskSpace(directory) {
  const info=await fs.statfs(directory);
  return {freeBytes:info.bavail*info.bsize,totalBytes:info.blocks*info.bsize};
}
export async function requireDisk(directory,config) {
  const space=await diskSpace(directory);
  if(space.freeBytes<runtime(config).minFreeMB*1024*1024){const e=new Error('Disk space is below '+runtime(config).minFreeMB+' MB. Generation is paused until space is available.');e.code='LOW_DISK';throw e;}
  return space;
}
export async function removeOwnedFile(root,target) {
  const base=await fs.realpath(root);
  const resolved=path.resolve(target),rel=path.relative(base,resolved);
  if(!rel||rel.startsWith('..'+path.sep)||rel==='..'||path.isAbsolute(rel))throw new Error('Cleanup target is outside the managed directory');
  const stat=await fs.lstat(resolved).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!stat)return false;
  if(!stat.isFile()||stat.isSymbolicLink())return false;
  const actual=await fs.realpath(resolved);
  const actualRel=path.relative(base,actual);
  if(actualRel.startsWith('..'+path.sep)||actualRel==='..'||path.isAbsolute(actualRel))throw new Error('Cleanup target escapes its managed directory');
  await fs.unlink(resolved);return true;
}
async function pruneFiles(directory,{pattern,olderThan,protectedFiles=new Set()}) {
  const names=await fs.readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  let removed=0,bytes=0;
  for(const name of names) {
    if(!pattern.test(name)||protectedFiles.has(name))continue;
    const target=path.join(directory,name),stat=await fs.lstat(target);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.mtimeMs<olderThan&&await removeOwnedFile(directory,target)){removed++;bytes+=stat.size;}
  }
  return {removed,bytes};
}
export async function maintain({store,state,stateDir,config,now=new Date(),date}) {
  if(state.maintenance?.lastDate===date)return {skipped:true};
  const cfg=runtime(config),active=state.jobs.filter(j=>!alreadyPublished(j)&&(remainingUpload(j)||!['ready','expired','failed'].includes(j.status)||j.status==='failed'&&j.date===date));
  const protectedAudio=new Set(active.flatMap(j=>j.audioFiles||[]).map(file=>path.basename(file)));
  const cache=await pruneFiles(path.join(stateDir,'audio'),{pattern:/^[a-f0-9]{64}\.wav$/,olderThan:+now-cfg.cacheDays*86400000,protectedFiles:protectedAudio});
  const scratch=await pruneFiles(path.join(stateDir,'audio'),{pattern:/^[a-f0-9]{64}\.wav\.(?:corrupt-[a-f0-9-]+|[a-f0-9-]+\.tmp)$/,olderThan:+now-7*86400000});
  const pendingNarrations=new Set(active.map(j=>j.id+'.wav'));
  const narration=await pruneFiles(path.join(stateDir,'narration'),{pattern:/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.wav$/,olderThan:+now-cfg.cacheDays*86400000,protectedFiles:pendingNarrations});
  await pruneFiles(path.join(stateDir,'narration'),{pattern:/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.wav\.[a-f0-9-]+\.wav$/,olderThan:+now-7*86400000});
  const logs=await pruneFiles(path.join(stateDir,'logs'),{pattern:/^bot-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/,olderThan:+now-cfg.logDays*86400000});
  await store.backup(path.join(stateDir,'backups'),date);
  const backups=await pruneFiles(path.join(stateDir,'backups'),{pattern:/^ustazon-\d{4}-\d{2}-\d{2}\.sqlite$/,olderThan:+now-cfg.backupDays*86400000,protectedFiles:new Set(['ustazon-'+date+'.sqlite'])});
  const keepSince=new Date(+now-120*86400000).toISOString().slice(0,10);
  for(const day of Object.keys(state.requests))if(day<keepSince)delete state.requests[day];
  state.maintenance={lastDate:date,at:now.toISOString(),cache,scratch,narration,logs,backups};
  return state.maintenance;
}
export async function logEvent(stateDir,event,details={},secrets=[],config={}) {
  const now=new Date(),date=now.toISOString().slice(0,10),dir=path.join(stateDir,'logs');
  await fs.mkdir(dir,{recursive:true});
  const text=JSON.stringify({time:now.toISOString(),event,details:JSON.parse(redactJSON(details,secrets))})+'\n';
  let file=path.join(dir,'bot-'+date+'.jsonl');
  const limit=(config.runtime?.logMaxMB||5)*1024*1024;
  for(let i=0;i<5;i++) {
    const candidate=path.join(dir,'bot-'+date+(i?'.'+i:'')+'.jsonl');
    const size=await fs.stat(candidate).then(s=>s.size).catch(e=>{if(e.code==='ENOENT')return 0;throw e;});
    if(size+Buffer.byteLength(text)<=limit){file=candidate;await fs.appendFile(file,text,{mode:0o600});return;}
  }
  // Keep the log budget bounded; health.json still reports the latest error.
}
function redactJSON(value,secrets) {
  return JSON.stringify(value, (key,item)=>{
    if(/api.?key|access.?token|refresh.?token|client.?secret|session.?url|authorization/i.test(key))return '[REDACTED]';
    return typeof item==='string'?redact(item,secrets):item;
  });
}
export async function healthSnapshot({stateDir,state,config,phase='idle',error=null,currentJob=null}) {
  const space=await diskSpace(stateDir).catch(()=>null);
  const failed=state.jobs.filter(j=>j.error||j.uploadError).slice(-20).map(j=>({id:j.id,status:j.status,error:j.error||j.uploadError,nextAttempt:j.retries?.generate?.nextAt||j.retries?.publish?.nextAt||null,attention:Object.values(j.retries||{}).some(r=>r.kind==='attention')}));
  const result={version:1,pid:process.pid,heartbeat:new Date().toISOString(),phase,currentJob,timezone:config.timezone,
    youtubeEnabled:config.youtube.enabled,memoryMB:Math.round(process.memoryUsage().rss/1024/1024),counts:state.jobs.reduce((out,j)=>(out[j.status]=(out[j.status]||0)+1,out),{}),
    diskFreeMB:space?Math.floor(space.freeBytes/1024/1024):null,failed,error:error?redact(error):null};
  await writeJSON(path.join(stateDir,'health.json'),result);return result;
}
