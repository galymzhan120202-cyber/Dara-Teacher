import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {runSocial,postInput,BufferClient,uploadSignature} from '../social.mjs';
import {planDay,slotsForDate} from '../schedule.mjs';
import {validateSettings} from '../config.mjs';
import {selectWorkerJobs} from '../reliability.mjs';
const production=JSON.parse(await fs.readFile(new URL('../automation.json',import.meta.url),'utf8'));
function fixture(){
 const config=structuredClone(production);config.buffer.enabled=true;
 const state={jobs:[]};const date='2026-11-19';const [job]=planDay(state,date,config);
 Object.assign(job,{outputDir:'fixture',outputSha256:'abc',topic:{title:'Тест',description:'Описание'}});
 let mutations=0,uploads=0,saves=0;
 const options={config,state,date,credentials:{},save:async()=>{saves++;},now:()=>new Date('2026-11-19T08:00:00Z'),upload:async()=>{uploads++;return {url:'https://res.cloudinary.com/test/video/upload/test.mp4',sha256:'abc'};},client:{channel:async id=>({service:id===config.buffer.channels.instagram?'instagram':'tiktok'}),create:async input=>{assert(saves>=2);mutations++;return {id:input.channelId,status:'scheduled',schedulingType:'automatic'};},get:async id=>({id,status:'sent',externalLink:'https://example.com/post'})}};
 return {options,job,counts:()=>({mutations,uploads,saves})};
}
test('one daily video alternates languages at 15:00 for a year, all formats rotate',()=>{
 validateSettings(production);assert.equal(production.buffer.enabled,false);assert.equal(production.youtube.enabled,false);
 const formats=new Set();
 for(let n=0;n<365;n++){
  const date=new Date(Date.UTC(2026,10,18+n)).toISOString().slice(0,10),state={jobs:[]};
  const jobs=planDay(state,date,production);assert.equal(jobs.length,1);assert.equal(jobs[0].language,n%2?'ru':'kk');assert.equal(jobs[0].publishAt,date+'T10:00:00.000Z');formats.add(jobs[0].format+jobs[0].language);
 }assert.equal(formats.size,6);
});
test('disabled publishing and STOP do not call external services',async()=>{
 const f=fixture();f.options.config.buffer.enabled=false;await runSocial(f.options);assert.equal(f.counts().mutations,0);assert.equal(f.counts().uploads,0);
 f.options.config.buffer.enabled=true;f.options.stopped=async()=>true;await runSocial(f.options);assert.equal(f.counts().uploads,0);
});
test('manual test is isolated from daily planning, carry-over, worker and default social publishing',async()=>{
 const f=fixture();f.job.manualTest=true;f.job.id='manual-test';
 assert.equal(selectWorkerJobs(f.options.state,f.options.date,f.options.config).length,0);
 await runSocial(f.options);assert.equal(f.counts().mutations,0);
 const [daily]=planDay(f.options.state,f.options.date,f.options.config);assert.notEqual(daily.id,f.job.id);
 const tomorrow=planDay({jobs:[f.job]},'2026-11-20',f.options.config);assert.notEqual(tomorrow[0],f.job);
 f.options.onlyJobId=f.job.id;await runSocial(f.options);assert.equal(f.counts().mutations,2);assert.equal(daily.social,undefined);
 f.job.date='2026-11-18';f.job.youtube={sessionUrl:'unfinished'};
 assert(!selectWorkerJobs(f.options.state,f.options.date,f.options.config).includes(f.job));
});
test('one upload, two independent posts; restarts reconcile without duplicates',async()=>{
 const f=fixture();await runSocial(f.options);assert.equal(f.counts().mutations,2);assert.equal(f.counts().uploads,1);
 await runSocial(f.options);assert.equal(f.counts().mutations,2);assert.equal(f.job.social.instagram.status,'sent');
});
test('lost create response cannot trigger duplicate on restart; other platform succeeds',async()=>{
 const f=fixture(),create=f.options.client.create;let failed=false;
 f.options.client.create=async input=>{if(!failed){failed=true;throw new Error('response lost');}return create(input);};
 await runSocial(f.options);assert.equal(f.job.social.instagram.status,'uncertain');assert.equal(f.job.social.tiktok.status,'scheduled');
 await runSocial(f.options);assert.equal(f.counts().mutations,1);
});
test('failed durable checkpoint prevents external mutation',async()=>{
 const f=fixture();f.options.save=async()=>{throw new Error('checkpoint unavailable');};await assert.rejects(runSocial(f.options));assert.equal(f.counts().mutations,0);
});
test('historical jobs and late videos are never backfilled',async()=>{
 const f=fixture();f.job.socialEligible=false;await runSocial(f.options);assert.equal(f.counts().uploads,0);
 f.job.socialEligible=true;f.options.now=()=>new Date('2026-11-19T11:00:00Z');await runSocial(f.options);assert.equal(f.counts().uploads,0);
});
test('draft API request cannot schedule or send; AI labels and automatic mode retained',()=>{
 const f=fixture();for(const p of ['instagram','tiktok']){const input=postInput(f.job,p,f.options.config.buffer.channels[p],'https://res.cloudinary.com/test/video/upload/test.mp4',{draft:true});assert.equal(input.saveToDraft,true);assert.equal(input.schedulingType,'automatic');assert.equal(input.metadata[p].isAiGenerated,true);}
});
test('both languages include the other social profile and YouTube in every caption',()=>{
 const f=fixture();
 for(const language of ['kk','ru'])for(const platform of ['instagram','tiktok']){
  f.job.language=language;
  const {text}=postInput(f.job,platform,f.options.config.buffer.channels[platform],'https://res.cloudinary.com/test/video/upload/test.mp4');
  assert(text.startsWith('Тест\n\nОписание\n\n'));
  assert.equal(text.split('https://ustaz.daralearn.kz/').length-1,1);
  assert(text.includes(language==='kk'?'Біз басқа желілерде:':'Мы также здесь:'));
  assert(text.includes('YouTube: https://www.youtube.com/@DaraUstaz'));
  assert.equal(text.includes('https://www.instagram.com/daraustaz/'),platform==='tiktok');
  assert.equal(text.includes('https://www.tiktok.com/@dara.ustaz'),platform==='instagram');
 }
});
test('GraphQL mutation network failures are not retried',async()=>{
 let calls=0;const client=new BufferClient('test',async()=>{calls++;throw new Error('timeout');});await assert.rejects(client.create({}));assert.equal(calls,1);
});
test('legacy multi-slot unpublished day migrates to one; published day fails closed',()=>{
 const state={jobs:[{id:'a',date:'2026-11-19',slot:'morning',language:'kk'},{id:'b',date:'2026-11-19',slot:'evening',language:'ru'}]};
 assert.equal(planDay(state,'2026-11-19',production).length,1);assert(state.jobs[0].superseded);
 const active={jobs:[{id:'a',date:'2026-11-19',slot:'morning',youtube:{videoId:'already'}},{id:'b',date:'2026-11-19',slot:'evening'}]};assert.throws(()=>planDay(active,'2026-11-19',production),/Review legacy/);
});
