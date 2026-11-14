import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {bank,makeVerifiedTopic,assertVerifiedTopic,selectVerifiedTopic,contentInventory} from '../verified-content.mjs';
import {generateTopic,validateDraft,templateDraft} from '../content.mjs';
import {runCycle} from '../runner.mjs';
import {failurePolicy} from '../reliability.mjs';
import {refreshVerifiedJob} from '../production.mjs';
import {narrateTopic,pcmToWav} from '../voice.mjs';
import {loadVisualAssets,MATERIAL_DIR} from '../visual-assets.mjs';
const config=JSON.parse(await fs.readFile(new URL('../automation.json',import.meta.url),'utf8'));
const knowledge=JSON.parse(await fs.readFile(new URL('../knowledge.json',import.meta.url),'utf8'));
const job=(language='kk')=>({id:'quality-'+language,date:'2026-11-14',slot:'morning',language,format:'tip'});
async function temp(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-quality-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
test('verified production uses real sources in both languages without calling the script API',async()=>{
  for(const language of ['kk','ru']) {
    const result=await generateTopic({client:{generateJSON:()=>{throw new Error('Unnecessary API call')}},config,job:job(language),knowledge});
    assert.equal(result.origin,'verified-material');assertVerifiedTopic(result.topic);
    assert(result.topic.scenes.slice(0,-1).every(s=>s.assetId));
    assert(result.topic.sourceRefs.some(s=>/47632|47471/.test(s)));
    assert(!JSON.stringify(result.topic).includes('34536'));
  }
});
test('unapproved claims, mixed scripts and changed source assets cannot pass publication validation',()=>{
  const topic=makeVerifiedTopic(job(),bank.stories[0]);
  for(const change of [t=>t.title='Жоспарды бір басқанда жасап береді',t=>t.scenes[0].narration='Этот текст полностью на русском языке.',t=>t.scenes[1].assetId='diffusion-diagram',t=>t.scenes[0].crop=[0,0,1,1],t=>t.evidenceRevision='old']) {
    const changed=structuredClone(topic);change(changed);assert.throws(()=>assertVerifiedTopic(changed),{code:'CONTENT_REVIEW_REQUIRED'});
  }
  const russian=templateDraft({language:'ru',format:'tip',fact:knowledge.facts[0]});assert.throws(()=>validateDraft(russian,'kk'),/Kazakh/);
});
test('verified bank consumes each story once per language and explicitly stops on exhaustion',()=>{
  const recent=[];
  for(const language of ['kk','ru'])for(let i=0;i<bank.stories.length;i++) {
    const topic=selectVerifiedTopic({...job(language),id:'quality-'+language+'-'+i},recent);
    assert(!recent.some(r=>r.contentKey===topic.contentKey));recent.push(topic);
  }
  for(const language of ['kk','ru'])assert.throws(()=>selectVerifiedTopic(job(language),recent),{code:'CONTENT_EXHAUSTED'});
  const inventory=contentInventory(recent.map(topic=>({topic})));assert.equal(inventory.languages.kk.remaining,0);assert.equal(inventory.languages.ru.remaining,0);
});
test('altered or missing imported images fail before narration or rendering',async t=>{
  const dir=await temp(t);await fs.cp(MATERIAL_DIR,dir,{recursive:true});
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
  await fs.writeFile(path.join(dir,manifest.assets[0].file),'damaged');
  await assert.rejects(loadVisualAssets(dir),/checksum mismatch/);
});
test('outdated unuploaded jobs are regenerated while publication receipts and in-flight uploads remain immutable',()=>{
  const old={...job(),topic:{title:'old'},status:'ready',outputDir:'old-output'};
  assert.equal(refreshVerifiedJob(old,config),true);assert.equal(old.status,'planned');assert.equal(old.topic,undefined);assert.equal(old.replacedArtifacts[0].outputDir,'old-output');
  for(const youtube of [{videoId:'already-done'},{sessionUrl:'pending'}]) {
    const untouched={...job(),topic:{title:'old'},youtube};assert.equal(refreshVerifiedJob(untouched,config),false);assert.deepEqual(untouched.youtube,youtube);
  }
});
test('a quota-interrupted job keeps identity and cached work when it moves to tomorrow',async()=>{
  const cfg={...structuredClone(config),slots:[config.slots[0]]};const state={jobs:[]};let generated=0;
  const save=async()=>{},publish=async()=>assert.fail('YouTube is disabled');
  await runCycle({state,config:cfg,now:()=>new Date('2026-11-14T00:00:00Z'),save,publish,generate:async j=>{j.audioFiles=['saved.wav'];throw Object.assign(new Error('quota'),{code:'GEMINI_DAILY_BUDGET',nextAt:'2026-11-15T00:00:00Z'});}});
  const id=state.jobs[0].id;
  await runCycle({state,config:cfg,now:()=>new Date('2026-11-15T00:01:00Z'),save,publish,generate:async j=>{generated++;assert.equal(j.id,id);assert.deepEqual(j.audioFiles,['saved.wav']);}});
  assert.equal(state.jobs.length,1);assert.equal(generated,1);assert.equal(state.jobs[0].date,'2026-11-15');assert.equal(state.jobs[0].status,'ready');
});
test('overlong audio uses the approved short script and persists it before retrying',async t=>{
  const dir=await temp(t),topic=makeVerifiedTopic(job(),bank.stories[0]);let calls=0,repairs=0;
  const client={speech:async()=>{calls++;if(calls===2)assert.equal(repairs,1);return {data:pcmToWav(Buffer.alloc((calls===1?21:1)*24000*2)),mimeType:'audio/wav'};}};
  const result=await narrateTopic({client,config,topic,cacheDir:path.join(dir,'cache'),outputFile:path.join(dir,'voice.wav'),onRepair:async()=>{repairs++;assert.equal(topic.scenes[0].narration,topic.scenes[0].shortNarration);}});
  assert.equal(repairs,1);assert.equal(calls,4);assertVerifiedTopic(result.topic);
  await narrateTopic({client,config,topic,cacheDir:path.join(dir,'cache'),outputFile:path.join(dir,'voice.wav')});assert.equal(calls,4);
  const policy=failurePolicy(Object.assign(new Error('too long'),{code:'NARRATION_TOO_LONG'}),{stage:'generate',jobId:'x',attempt:1,config});assert.equal(policy.kind,'attention');
});

test('moving an already-ready video persists its new date even without a new generation or upload',async()=>{
  const cfg={...structuredClone(config),slots:[config.slots[0]]};
  const state={jobs:[{id:'old-ready',date:'2026-11-13',slot:'morning',language:'kk',format:'tip',status:'ready',publishAt:'2026-11-13T05:00:00Z'}]};let saved;
  await runCycle({state,config:cfg,now:()=>new Date('2026-11-14T00:00:00Z'),save:async()=>{saved=structuredClone(state);},generate:async()=>assert.fail('Already ready'),publish:async()=>assert.fail('Disabled')});
  assert.equal(saved.jobs[0].date,'2026-11-14');assert.equal(saved.jobs[0].id,'old-ready');
});
