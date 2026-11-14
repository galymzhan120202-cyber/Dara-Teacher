import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {GitHubState,sealState,openState,validateSnapshot} from '../remote-state.mjs';
import {openStore} from '../store.mjs';
const repo='owner/ustazon',key=Buffer.alloc(32,7),keyString=key.toString('base64');
async function temp(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-remote-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
function api() {
  const files=new Map([[1,{id:1,name:'unrelated.txt',state:'uploaded',size:0,data:Buffer.alloc(0)}]]),deleted=[];
  let sequence=1;
  const release={id:20,upload_url:'https://uploads.github.com/repos/'+repo+'/releases/20/assets{?name,label}'};
  const fetchImpl=async(url,opts={})=>{
    const u=new URL(url),method=opts.method||'GET';
    if(u.pathname.includes('/releases/tags/'))return Response.json(release);
    if(u.pathname.endsWith('/releases/20/assets')&&method==='GET')return Response.json([...files.values()].map(({data,...rest})=>rest));
    if(u.hostname==='uploads.github.com'&&method==='POST') {
      const data=Buffer.from(opts.body);assert.equal(data.subarray(0,8).toString(),'USTAZON1');
      const asset={id:++sequence,name:u.searchParams.get('name'),state:'uploaded',size:data.length,digest:'sha256:'+createHash('sha256').update(data).digest('hex'),data};files.set(asset.id,asset);
      return Response.json({...asset,data:undefined});
    }
    const match=/\/releases\/assets\/(\d+)$/.exec(u.pathname);
    if(match){const id=+match[1];if(method==='DELETE'){deleted.push(id);files.delete(id);return new Response(null,{status:204});}return new Response(files.get(id).data);}
    throw new Error('Unexpected endpoint '+u.pathname);
  };
  return {files,deleted,fetchImpl};
}
test('encrypted checkpoints bind to the repository and reject corruption and escaping paths',()=>{
  const payload={version:1,repository:repo,bootstrap:true,files:[]},sealed=sealState(payload,key,repo);
  assert.deepEqual(openState(sealed,key,repo),payload);
  assert.throws(()=>openState(sealed,key,'other/repo'),{code:'REMOTE_STATE_FAILED'});
  const broken=Buffer.from(sealed);broken[broken.length-1]^=1;assert.throws(()=>openState(broken,key,repo));
  assert.throws(()=>validateSnapshot({...payload,files:[{path:'../.env.local',data:'',sha256:''}]},repo));
});
test('remote checkpoints preserve SQLite counters and upload sessions across runners and retain only owned snapshots',async t=>{
  const stores=[];t.after(()=>{for(const s of stores)try{s.close();}catch{}});
  const first=await temp(t),second=await temp(t),store=await openStore(path.join(first,'.state'));stores.push(store);store.acquire();
  const state=store.load();state.requests['2026-11-14']=8;
  state.jobs.push({id:'2026-11-14-morning-kk',date:'2026-11-14',slot:'morning',language:'kk',format:'tip',status:'ready',youtube:{sessionUrl:'https://www.googleapis.com/upload/pending',offset:123}});store.save(state);
  const mock=api(),remote=new GitHubState({repo,token:'mock-token',key:keyString,fetchImpl:mock.fetchImpl});
  await remote.checkpoint(store,state,first);state.requests['2026-11-14']=9;store.save(state);await remote.checkpoint(store,state,first);await remote.checkpoint(store,state,first);
  assert.equal(mock.files.size,3);assert(mock.files.has(1));assert.equal(mock.deleted.length,1);
  const restored=await remote.restore(second);assert(restored.files>=2);
  const next=await openStore(path.join(second,'.state'));stores.push(next);next.acquire();const loaded=next.load();
  assert.equal(loaded.requests['2026-11-14'],9);assert.equal(loaded.jobs[0].youtube.offset,123);next.release();store.release();
  await assert.rejects(remote.restore(second),/fresh runner/);
});
test('a corrupt newest snapshot is never replaced with an older history',async t=>{
  const dir=await temp(t),mock=api(),remote=new GitHubState({repo,token:'mock-token',key:keyString,fetchImpl:mock.fetchImpl});
  mock.files.set(2,{id:2,name:'ustazon-state-old.bin',state:'uploaded',data:sealState({version:1,repository:repo,bootstrap:true,files:[]},key,repo)});
  mock.files.set(3,{id:3,name:'ustazon-state-new.bin',state:'uploaded',data:Buffer.from('damaged')});
  await assert.rejects(remote.restore(dir),{code:'REMOTE_STATE_FAILED'});
  assert.equal(await fs.access(path.join(dir,'.state','bot.sqlite')).then(()=>true,()=>false),false);
});
