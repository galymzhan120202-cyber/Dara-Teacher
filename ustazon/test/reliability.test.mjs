import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Store,openStore} from '../store.mjs';
import {runCycle} from '../runner.mjs';
import {supervise} from '../supervisor.mjs';
import {addDays,exerciseIdentity,failurePolicy,eligible,recordFailure,retryJob,textIdentity,relocatePaths} from '../reliability.mjs';
import {makeBrief} from '../content.mjs';
import {maintain,removeOwnedFile,logEvent,fileDigest} from '../maintenance.mjs';
import {resumableUpload} from '../youtube.mjs';
import {generateJob,artifactReady} from '../production.mjs';
import {loadProject} from '../model.mjs';

const here=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baseConfig=JSON.parse(await fs.readFile(path.join(here,'automation.json'),'utf8'));
const knowledge=JSON.parse(await fs.readFile(path.join(here,'knowledge.json'),'utf8'));
const config=()=>({...structuredClone(baseConfig),youtube:{...baseConfig.youtube,enabled:true,expectedChannelId:'UC'+'a'.repeat(22)}});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-stability-')),stores=[];
  t.after(async()=>{
    for(const store of stores)try{store.close();}catch{}
    const root=path.resolve(os.tmpdir()),resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),root);assert(path.basename(resolved).startsWith('ustazon-stability-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  return {directory,stores,open:async()=>{
    const store=await openStore(directory);stores.push(store);store.acquire();return store;
  }};
}
function fakeId(value){return createHash('sha256').update(value).digest('hex').slice(0,11);}
async function runNode(code) {
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    child.once('close',code=>resolve({code,output}));child.once('error',error=>resolve({code:-1,output:error.message}));
  });
}
test('legacy queue migrates once and publication receipts cannot be rolled back or duplicated',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.directory,'daily.json'),JSON.stringify({version:1,requests:{'2026-11-13':12},jobs:[
    {id:'one',date:'2026-11-13',status:'uploaded',youtube:{videoId:'abcdefghijk',channelId:'channel'}},
    {id:'two',date:'2026-11-13',status:'ready'}
  ]}));
  const store=await f.open(),state=store.load();
  assert.equal(state.jobs.length,2);assert.equal(state.requests['2026-11-13'],12);
  store.claim('content','same script','one');
  assert.throws(()=>store.claim('content','same script','two'),e=>e.code==='DUPLICATE');
  store.claim('video:channel','same bytes','one');
  assert.throws(()=>store.claim('video:channel','same bytes','two'),e=>e.code==='DUPLICATE');
  state.jobs[0].youtube={};assert.throws(()=>store.save(state),/erase or replace/);
  assert.equal(store.load().jobs[0].youtube.videoId,'abcdefghijk');
  assert.equal(store.stats().publications,1);
  store.release();store.close();
  await fs.writeFile(path.join(f.directory,'daily.json'),JSON.stringify({version:1,jobs:[],requests:{}}));
  const reopened=await f.open();assert.equal(reopened.load().jobs.length,2);
});
test('a live process excludes concurrent workers; crash recovery reclaims a dead owner and rolls back an unfinished transaction',async t=>{
  const f=await fixture(t),store=await f.open();
  const another=new Store(store.file);f.stores.push(another);
  assert.throws(()=>another.acquire(),e=>e.code==='BOT_BUSY');
  const state=store.load();state.jobs.push({id:'saved',date:'2026-11-13',status:'ready'});store.save(state);
  store.release();store.close();another.close();
  const module=pathToFileURL(path.join(here,'store.mjs')).href;
  const child=await runNode("import {Store} from "+JSON.stringify(module)+";const s=new Store("+JSON.stringify(path.join(f.directory,'bot.sqlite'))+");s.acquire();s.db.exec('BEGIN IMMEDIATE');s.db.prepare('UPDATE jobs SET status=? WHERE id=?').run('lost','saved');process.exit(0);");
  assert.equal(child.code,0,child.output);
  const recovered=await f.open();
  assert.equal(recovered.db.prepare('SELECT status FROM jobs WHERE id=?').get('saved').status,'ready');
  recovered.save(recovered.load());
});
test('online backup includes committed data and missing authoritative DB is never recreated from stale JSON',async t=>{
  const f=await fixture(t),store=await f.open(),state=store.load();
  state.jobs.push({id:'saved',date:'2026-11-13',status:'uploaded',youtube:{videoId:'abcdefghijk'}});store.save(state);
  const backup=await store.backup(path.join(f.directory,'backups'),'2026-11-13');
  const copy=new Store(backup);f.stores.push(copy);assert.equal(copy.stats().publications,1);copy.close();
  store.release();store.close();
  await fs.unlink(path.join(f.directory,'bot.sqlite'));
  await assert.rejects(openStore(f.directory),/Refusing to recreate/);
});
test('a full year of repeated worker cycles survives temporary API failures and lost final upload replies without duplicate publications',async()=>{
  const cfg=config(),state={version:1,jobs:[],requests:{},controls:{}};
  const server=new Map(),generations=new Map(),uploadStarts=new Map();
  let saves=0,now=new Date();
  for(let day=0;day<365;day++) {
    const date=addDays('2026-01-01',day);now=new Date(date+'T00:00:00Z');
    const generate=async job=>{
      const n=(generations.get(job.id)||0)+1;generations.set(job.id,n);
      if(day%7===0&&job.slot==='morning'&&n===1)throw Object.assign(new Error('temporary'),{status:503});
      job.status='ready';job.outputDir='virtual/'+job.id;
    };
    const publish=async(job,mode)=>{
      if(server.has(job.id)){job.youtube.videoId=server.get(job.id);return;}
      uploadStarts.set(job.id,(uploadStarts.get(job.id)||0)+1);
      job.youtube={sessionUrl:'session-'+job.id};server.set(job.id,fakeId(job.id));
      if(day%10===0&&job.slot==='evening')throw new Error('Final response lost');
      job.youtube.videoId=server.get(job.id);
    };
    for(let cycle=0;cycle<4;cycle++) {
      now=new Date(Date.parse(date+'T00:00:00Z')+cycle*3600000);
      await runCycle({state,config:cfg,date,save:async()=>saves++,generate,publish,now:()=>now});
      // Simulate serialized state reloaded by a fresh worker between cycles.
      Object.assign(state,JSON.parse(JSON.stringify(state)));
    }
    assert.equal(state.jobs.filter(j=>j.date===date&&j.status==='uploaded').length,3,date);
  }
  assert.equal(server.size,1095);assert.equal(state.jobs.length,1095);
  assert([...uploadStarts.values()].every(count=>count===1));
  assert([...generations.values()].every(count=>count<=2));
  assert(saves>1095);
});
test('a previous-day ambiguous completion is reconciled, but an incomplete late upload sends no new video bytes',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'video.mp4');await fs.writeFile(file,'abc');
  const session='https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test';
  let calls=[];
  const record={sessionUrl:session,size:3,sha256:await fileDigest(file)};
  const fetchIncomplete=async(_,opts)=>{calls.push(opts);return new Response(null,{status:308});};
  await assert.rejects(resumableUpload({file,body:{},record,save:async()=>{},token:'test',reconcileOnly:true,fetchImpl:fetchIncomplete}),e=>e.code==='PUBLICATION_MISSED');
  assert.equal(calls.length,1);assert.equal(calls[0].headers['Content-Range'],'bytes */3');assert.equal(calls[0].body,undefined);
  const cfg=config(),date='2026-11-14',old={id:'old',date:'2026-11-13',slot:'morning',status:'ready',language:'kk',format:'tip',publishAt:'2026-11-13T05:00:00Z',youtube:record};
  const state={jobs:[old],requests:{},controls:{}};
  await runCycle({state,config:cfg,date,now:()=>new Date('2026-11-14T00:00:00Z'),save:async()=>{},generate:async j=>{j.status='ready';},
    publish:async(j,mode)=>{if(j.id==='old'){assert.equal(mode,'reconcile');j.youtube.videoId='abcdefghijk';}else{j.youtube={videoId:fakeId(j.id)};}}});
  assert.equal(old.status,'uploaded');
});
test('persisted retries respect quota rollover, attempt limits and changed credentials',()=>{
  const cfg=config(),job={id:'job'},state={controls:{}},now=new Date('2026-11-13T18:59:00Z');
  const record=recordFailure(state,job,'generate',Object.assign(new Error('Daily budget'),{code:'DAILY_BUDGET'}),cfg,'identity',now);
  assert.equal(record.nextAt,'2026-11-13T19:03:00.000Z');
  assert.equal(eligible(job,'generate',cfg,new Date('2026-11-13T19:02:00Z'),'identity'),false);
  assert.equal(eligible(job,'generate',cfg,new Date('2026-11-13T19:03:00Z'),'identity'),true);
  assert.equal(eligible(job,'generate',cfg,now,'changed-key'),true);
  for(let n=1;n<=cfg.runtime.maxAttemptsPerDay;n++)recordFailure(state,job,'publish',new Error('network'),cfg,'identity',now);
  assert.equal(eligible(job,'publish',cfg,new Date('2026-11-13T18:59:59Z'),'identity'),false);
  assert.throws(()=>retryJob({status:'uploaded',youtube:{videoId:'abcdefghijk'}}),/already uploaded/);
  assert.throws(()=>retryJob({status:'ready',retries:{publish:{kind:'attention'}}}),/reconciliation/);
});
test('two years of original arithmetic examples remain unique and mathematically correct',()=>{
  const recent=[],seen=new Set();
  for(let i=0;i<730;i++) {
    const date=addDays('2026-01-01',i),job={id:date+'-evening-ru',date,language:'ru',format:'quiz'};
    const brief=makeBrief(job,knowledge,recent),q=brief.quiz,key=exerciseIdentity({language:'ru',scenes:[{quiz:q}]});
    assert(!seen.has(key));seen.add(key);
    assert(q.a>=1&&q.b>=1);assert(q.answer>=0);
    assert.equal(q.answer,q.operator==='+'?q.a+q.b:q.a-q.b);
    recent.push({exerciseKey:key});
  }
  assert.equal(seen.size,730);
  const t={language:'kk',id:'one',scenes:[{kind:'hook',narration:'Бір идея.',headline:'Сабақ',body:'Мәтін.'}]};
  assert.equal(textIdentity(t),textIdentity({...t,id:'another',scenes:t.scenes.map(s=>({...s,duration:15}))}));
});
test('maintenance removes only old unneeded cache files and retains pending audio, MP4 files and receipt history',async t=>{
  const f=await fixture(t),store=await f.open(),state=store.load(),now=new Date('2026-11-13T10:00:00Z');
  const audioDir=path.join(f.directory,'audio');await fs.mkdir(audioDir);
  const active='a'.repeat(64)+'.wav',old='b'.repeat(64)+'.wav';
  for(const name of [active,old,'keep.mp4']){const file=path.join(audioDir,name);await fs.writeFile(file,'test');await fs.utimes(file,new Date('2026-08-01'),new Date('2026-08-01'));}
  state.jobs.push({id:'pending',date:'2026-11-13',status:'voiced',audioFiles:[path.join(audioDir,active)]});
  store.save(state);
  const result=await maintain({store,state,stateDir:f.directory,config:config(),now,date:'2026-11-13'});
  assert.equal(result.cache.removed,1);
  assert.equal(await fs.readFile(path.join(audioDir,active),'utf8'),'test');
  assert.equal(await fs.readFile(path.join(audioDir,'keep.mp4'),'utf8'),'test');
  await assert.rejects(removeOwnedFile(audioDir,path.join(f.directory,'outside.wav')),/outside/);
  assert.equal(store.stats().jobs,1);
});
test('logs redact keys, OAuth tokens and upload session URLs',async t=>{
  const f=await fixture(t);
  await logEvent(f.directory,'failure',{apiKey:'secret',sessionUrl:'https://secret-session',message:'failed my-api-secret',refresh_token:'refresh'},['my-api-secret'],config());
  const name=(await fs.readdir(path.join(f.directory,'logs')))[0],text=await fs.readFile(path.join(f.directory,'logs',name),'utf8');
  assert(!text.includes('my-api-secret'));assert(!text.includes('https://secret-session'));assert(!text.includes(':"refresh"'));assert(text.includes('REDACTED'));
});
test('a damaged completed MP4 is rebuilt from the saved script with no new Gemini calls',async t=>{
  const f=await fixture(t),project=await loadProject(path.join(here,'catalog.json'),path.join(here,'theme.json'));
  const job={id:'2026-11-14-morning-kk',date:'2026-11-14',language:'kk',format:'tip',status:'ready',topic:structuredClone(project.catalog.topics[0])};
  job.topic.id=job.id;job.topic.language='kk';job.outputDir=path.join(f.directory,'broken');await fs.mkdir(job.outputDir);
  await fs.writeFile(path.join(job.outputDir,'video.mp4'),'broken');
  await fs.writeFile(path.join(job.outputDir,'metadata.json'),JSON.stringify({topicId:job.id,status:'complete',draft:false,fps:8,durationSeconds:25}));
  assert.equal(await artifactReady(job),false);
  let requests=0;
  const cfg={...config(),gemini:{...baseConfig.gemini,voiceEnabled:false},video:{...baseConfig.video,width:180,fps:8}};
  await generateJob({job,state:{jobs:[job]},save:async()=>{},client:{generateJSON:async()=>{requests++;throw new Error('Unexpected Gemini request');}},
    config:cfg,project,knowledge,baseDir:f.directory,stateDir:f.directory,log:()=>{}});
  assert.equal(requests,0);assert.equal(job.status,'ready');assert.equal(await artifactReady(job),true);
  const bytes=await fs.readFile(path.join(job.outputDir,'video.mp4'));bytes[50]^=255;
  await fs.writeFile(path.join(job.outputDir,'video.mp4'),bytes);
  assert.equal(await artifactReady(job),false);
});

test('the supervisor restarts a crashed worker and the stop command leaves no running child',async t=>{
  const f=await fixture(t),worker=path.join(f.directory,'fake-worker.mjs'),counter=path.join(f.directory,'starts.txt');
  const code="import fs from 'node:fs/promises';const dir="+JSON.stringify(f.directory)+";const file=dir+'/starts.txt';let count=Number(await fs.readFile(file,'utf8').catch(()=> '0'))+1;await fs.writeFile(file,String(count));if(count===1)process.exit(1);setInterval(async()=>{try{await fs.access(dir+'/STOP');process.exit(0);}catch{}},30);";
  await fs.writeFile(worker,code);
  const controller=new AbortController();let pid,starts=0;
  const supervisor=supervise({stateDir:f.directory,workerFile:worker,restartMs:20,maxRestartMs:50,monitorMs:30,graceMs:500,staleMs:10000,stdio:'ignore',signal:controller.signal,
    onStart:child=>{starts++;pid=child.pid;}});
  const until=Date.now()+5000;
  while(Date.now()<until&&Number(await fs.readFile(counter,'utf8').catch(()=> '0'))<2)await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(Number(await fs.readFile(counter,'utf8')),2);
  await fs.writeFile(path.join(f.directory,'STOP'),'stop\n');
  await supervisor;
  assert.equal(starts,2);
  assert.throws(()=>process.kill(pid,0));
  const status=JSON.parse(await fs.readFile(path.join(f.directory,'supervisor.json'),'utf8'));
  assert.equal(status.status,'stopped');assert.equal(status.restarts,1);
});

test('moving the stopped bot from Windows to Linux preserves job IDs, checksums and upload sessions',()=>{
  const job={id:'2026-11-13-evening-ru',date:'2026-11-13',
    outputDir:'D:\\ustazon_bot\\ustazon\\output\\daily\\2026-11-13\\2026-11-13-evening-ru-abc123',
    outputSha256:'same-hash',audioFiles:['D:\\ustazon_bot\\ustazon\\.state\\audio\\'+'a'.repeat(64)+'.wav'],
    youtube:{sessionUrl:'same-upload',offset:12345}};
  const state={jobs:[job]},baseDir=path.resolve(os.tmpdir(),'ustazon-new-location'),stateDir=path.join(baseDir,'.state');
  assert.equal(relocatePaths(state,{baseDir,stateDir}),2);
  assert.equal(job.outputDir,path.join(baseDir,'output','daily','2026-11-13','2026-11-13-evening-ru-abc123'));
  assert.equal(job.outputSha256,'same-hash');assert.equal(job.youtube.sessionUrl,'same-upload');
  assert.equal(job.audioFiles[0],path.join(stateDir,'audio','a'.repeat(64)+'.wav'));
  assert.equal(relocatePaths(state,{baseDir,stateDir}),0);
});
