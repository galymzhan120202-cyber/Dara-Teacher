import fs from 'node:fs/promises';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
const TAG='ustazon-runtime-state-v1',PREFIX='ustazon-state-',MAX=96*1024*1024;
function fail(message){throw Object.assign(new Error(message),{code:'REMOTE_STATE_FAILED'});}
export function stateKey(value) {
  if(typeof value!=='string')fail('Set USTAZON_STATE_KEY to a random 32-byte base64 key.');
  const key=Buffer.from(value,'base64');
  if(key.length!==32||key.toString('base64')!==value)fail('USTAZON_STATE_KEY must encode exactly 32 random bytes.');
  return key;
}
export function sealState(payload,key,repo) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('ustazon-state-v1:'+repo));
  const compressed=gzipSync(Buffer.from(JSON.stringify(payload)));
  if(compressed.length>MAX)fail('Runtime snapshot exceeds 96 MiB. Archive completed local videos and inspect the cache.');
  const encrypted=Buffer.concat([cipher.update(compressed),cipher.final()]);
  return Buffer.concat([Buffer.from('USTAZON1'),iv,cipher.getAuthTag(),encrypted]);
}
export function openState(bytes,key,repo) {
  try {
    if(bytes.length>MAX+36||bytes.subarray(0,8).toString()!=='USTAZON1')throw new Error();
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));decipher.setAAD(Buffer.from('ustazon-state-v1:'+repo));decipher.setAuthTag(bytes.subarray(20,36));
    return JSON.parse(gunzipSync(Buffer.concat([decipher.update(bytes.subarray(36)),decipher.final()]),{maxOutputLength:256*1024*1024}).toString());
  }catch{fail('Runtime snapshot is corrupt, belongs to another repository, or uses a different state key. Restore the correct key and latest snapshot; history was not reset.');}
}
export function allowedStatePath(name) {
  return /^(?:\.state\/(?:bot\.sqlite|database-initialized\.json|youtube-token\.json|audio\/[a-f0-9]{64}\.wav)|output\/daily\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\/(?:video\.mp4|metadata\.json|storyboard\.png|thumbnail\.png|captions\.srt|narration\.txt))$/.test(name);
}
export function validateSnapshot(payload,repo) {
  if(payload.version!==1||payload.repository!==repo||!Array.isArray(payload.files)||payload.files.length>10000)fail('Invalid runtime snapshot');
  const seen=new Set();
  for(const file of payload.files) {
    if(!allowedStatePath(file.path)||seen.has(file.path)||typeof file.data!=='string')fail('Invalid path in runtime snapshot');
    seen.add(file.path);
    if(createHash('sha256').update(Buffer.from(file.data,'base64')).digest('hex')!==file.sha256)fail('Runtime snapshot file checksum mismatch');
  }
  if(!payload.bootstrap&&(!seen.has('.state/bot.sqlite')||!seen.has('.state/database-initialized.json')))fail('Runtime snapshot is missing the authoritative database');
  if(payload.bootstrap&&payload.files.length)fail('Invalid bootstrap snapshot');
  return payload;
}
export class GitHubState {
  constructor({repo=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN,key=process.env.USTAZON_STATE_KEY,fetchImpl=fetch}={}) {
    if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'')||!token)fail('GitHub repository and token are required for remote state');
    this.repo=repo;this.token=token;this.key=stateKey(key);this.fetch=fetchImpl;this.base='https://api.github.com/repos/'+repo;
  }
  async request(url,{method='GET',json,bytes,binary=false,allow404=false}={}) {
    const host=new URL(url).hostname;if(!['api.github.com','uploads.github.com'].includes(host))fail('Invalid GitHub state endpoint');
    let res;try{res=await this.fetch(url,{method,headers:{Authorization:'Bearer '+this.token,Accept:binary?'application/octet-stream':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(json?{'Content-Type':'application/json'}:{}),...(bytes?{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)}:{})},body:bytes||(json?JSON.stringify(json):undefined),signal:AbortSignal.timeout(60000)});}catch{fail('GitHub state request did not complete; external generation/publication is stopped until state is durable.');}
    if(allow404&&res.status===404)return null;
    if(!res.ok)fail('GitHub state request failed (HTTP '+res.status+'). Check repository Contents write permission.');
    if(res.status===204)return null;
    return binary?Buffer.from(await res.arrayBuffer()):res.json();
  }
  async release(){return this.request(this.base+'/releases/tags/'+TAG,{allow404:true});}
  async list(release) {
    const all=[];
    for(let page=1;page<=20;page++) {
      const entries=await this.request(this.base+'/releases/'+release.id+'/assets?per_page=100&page='+page);
      all.push(...entries.filter(a=>a.name.startsWith(PREFIX)&&a.name.endsWith('.bin')&&a.state==='uploaded'));
      if(entries.length<100)return all.sort((a,b)=>b.id-a.id);
    }
    fail('Too many runtime snapshots; inspect the dedicated state release.');
  }
  async upload(release,payload) {
    validateSnapshot(payload,this.repo);
    const data=sealState(payload,this.key,this.repo),name=PREFIX+Date.now()+'-'+randomUUID()+'.bin';
    const upload=release.upload_url.split('{')[0]+'?name='+name;
    const saved=await this.request(upload,{method:'POST',bytes:data});
    if(saved.state!=='uploaded'||saved.size!==data.length)fail('GitHub did not confirm the runtime checkpoint');
    if(saved.digest&&saved.digest!=='sha256:'+createHash('sha256').update(data).digest('hex'))fail('Remote checkpoint digest mismatch');
    // Keep the newest two complete snapshots. Unrelated release assets are never removed.
    const older=(await this.list(release)).slice(2);
    for(const a of older)try{await this.request(this.base+'/releases/assets/'+a.id,{method:'DELETE'});}catch{/* Retention failure never invalidates a confirmed new checkpoint. */}
    return saved.id;
  }
  async seed(store,state,baseDir) {
    let release=await this.release();
    if(release&&(await this.list(release)).length)fail('Remote history already exists. Refusing to overwrite it with a local seed.');
    if(!release)release=await this.request(this.base+'/releases',{method:'POST',json:{tag_name:TAG,name:'Ustazon encrypted runtime state',body:'Encrypted runtime checkpoints; keep the state key and this release.',prerelease:true,make_latest:'false'}});
    return this.checkpoint(store,state,baseDir);
  }
  async restore(baseDir,{initialize=false}={}) {
    if(await fs.access(path.join(baseDir,'.state','bot.sqlite')).then(()=>true,()=>false))fail('Restore requires a fresh runner; refusing to overwrite a local database.');
    let release=await this.release();
    if(!release) {
      if(!initialize)fail('No runtime snapshot exists. Use the explicit first-run initialize option, or restore your existing state.');
      release=await this.request(this.base+'/releases',{method:'POST',json:{tag_name:TAG,name:'Ustazon encrypted runtime state',body:'Encrypted runtime checkpoints. Do not remove this release or change its encryption key while the bot is in use.',prerelease:true,make_latest:'false'}});
      await this.upload(release,{version:1,repository:this.repo,createdAt:new Date().toISOString(),bootstrap:true,files:[]});
    }
    const snapshots=await this.list(release);
    if(!snapshots.length)fail('The state release has no complete snapshot. Restore its backup; a new history will not be created.');
    // Never silently fall back to an older snapshot: that could lose an upload receipt.
    const bytes=await this.request(this.base+'/releases/assets/'+snapshots[0].id,{binary:true});
    const payload=validateSnapshot(openState(bytes,this.key,this.repo),this.repo);
    for(const entry of payload.files) {
      const file=path.resolve(baseDir,entry.path),relative=path.relative(baseDir,file);
      if(relative.startsWith('..')||path.isAbsolute(relative))fail('Snapshot path escapes runtime directory');
      await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,Buffer.from(entry.data,'base64'),{mode:0o600});
    }
    return {files:payload.files.length,checkpoint:snapshots[0].id};
  }
  async checkpoint(store,state,baseDir) {
    const release=await this.release();if(!release)fail('Restore or initialize remote state before starting the worker');
    const temporary=await store.backup(path.join(baseDir,'.state','remote-tmp'),randomUUID());
    const files=[];
    const add=async(name,source)=>{if(!allowedStatePath(name))fail('Invalid checkpoint path');const data=await fs.readFile(source);files.push({path:name,sha256:createHash('sha256').update(data).digest('hex'),data:data.toString('base64')});};
    try {
      await add('.state/bot.sqlite',temporary);
      for(const name of ['database-initialized.json','youtube-token.json']) {const file=path.join(baseDir,'.state',name);if(await fs.access(file).then(()=>true,()=>false))await add('.state/'+name,file);}
      const audio=path.join(baseDir,'.state','audio');
      for(const name of await fs.readdir(audio).catch(e=>{if(e.code==='ENOENT')return [];throw e;}))if(/^[a-f0-9]{64}\.wav$/.test(name))await add('.state/audio/'+name,path.join(audio,name));
      const seen=new Set();
      for(const job of state.jobs.filter(j=>j.outputDir&&!j.mediaRemoved&&((!j.youtube?.videoId&&j.status!=='uploaded')||(j.socialEligible&&['instagram','tiktok'].some(p=>!j.social?.[p]?.postId))))) {
        for(const name of ['video.mp4','metadata.json','storyboard.png','thumbnail.png','captions.srt','narration.txt']) {
          const source=path.join(job.outputDir,name),rel=path.relative(baseDir,source).replaceAll('\\','/');
          if(!allowedStatePath(rel)||seen.has(rel))continue;
          if(await fs.access(source).then(()=>true,()=>false)){await add(rel,source);seen.add(rel);}
        }
      }
      return await this.upload(release,{version:1,repository:this.repo,createdAt:new Date().toISOString(),bootstrap:false,files});
    }finally{await fs.unlink(temporary).catch(()=>{});}
  }
}
export async function installYouTubeSecrets(baseDir,env=process.env) {
  for(const [variable,relative] of [['YOUTUBE_CLIENT_JSON_B64','../client_secrets.json'],['YOUTUBE_TOKEN_JSON_B64','.state/youtube-token.json']]) {
    if(!env[variable])continue;const destination=path.resolve(baseDir,relative);
    if(await fs.access(destination).then(()=>true,()=>false))continue;
    let data;try{data=Buffer.from(env[variable],'base64');JSON.parse(data.toString());}catch{fail('Invalid '+variable+' secret');}
    await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,data,{mode:0o600});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const baseDir=fileURLToPath(new URL('./',import.meta.url));
  if(process.argv[2]!=='restore')throw new Error('Usage: node ustazon/remote-state.mjs restore [--initialize]');
  try{const remote=new GitHubState();const result=await remote.restore(baseDir,{initialize:process.argv.includes('--initialize')});await installYouTubeSecrets(baseDir);console.log('Restored encrypted runtime checkpoint: '+result.checkpoint+' ('+result.files+' files)');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
