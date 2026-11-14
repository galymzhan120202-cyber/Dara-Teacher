import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequestGuard,budgetReport,quotaDay,nextQuotaReset} from '../budget.mjs';
import {GeminiClient} from '../gemini.mjs';
import {openStore} from '../store.mjs';
import {failurePolicy} from '../reliability.mjs';

const here=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=JSON.parse(await fs.readFile(path.join(here,'automation.json'),'utf8'));
const script='/models/gemini-3.8-flash:generateContent',speech='/models/gemini-3.8-flash-tts:generateContent';
const config=overrides=>({...structuredClone(base),gemini:{...structuredClone(base.gemini),freeTier:{...base.gemini.freeTier,confirmed:true,minIntervalMs:61000,...overrides}}});
function harness(cfg=config(),state={jobs:[],requests:{}},extra={}) {
  let time=Date.parse('2026-11-14T10:00:00Z'),saves=0;
  const waits=[];
  const guard=createRequestGuard({config:cfg,state,now:()=>new Date(time),
    sleep:async ms=>{waits.push(ms);time+=ms;},save:async()=>{saves++;},...extra});
  return {guard,state,waits,get saves(){return saves;},setTime:value=>{time=Date.parse(value);}};
}
test('unconfirmed free tier and unreviewed models never send a generation request',async()=>{
  let sends=0;
  const h=harness({...base,gemini:{...base.gemini,freeTier:{...base.gemini.freeTier,confirmed:false}}});
  const client=new GeminiClient({apiKey:'fake',beforeRequest:h.guard,fetchImpl:async()=>{sends++;throw new Error('must not send');}});
  await assert.rejects(client.generateJSON({model:'gemini-3.8-flash',prompt:'test',schema:{}}),{code:'FREE_TIER_UNCONFIRMED'});
  assert.equal(sends,0);assert.equal(h.saves,0);assert.deepEqual(h.state.requests,{});
  const approved=harness();
  await assert.rejects(approved.guard({endpoint:'/models/veo-paid-model:generateContent'}),{code:'FREE_MODEL_UNREVIEWED'});
  await assert.rejects(approved.guard({endpoint:'/models/gemini-3.8-flash:batchGenerateContent'}),{code:'FREE_MODEL_UNREVIEWED'});
  assert.equal(approved.saves,0);
});
test('report calculates the three-video budget without assuming account quotas',()=>{
  const report=budgetReport(base,{},new Date('2026-11-14T10:00:00Z'));
  assert.deepEqual(report.expectedRequestsWithoutRetriesOrCache,{script:0,speech:12,total:12});
  assert.equal(report.caps.total,16);assert.equal(report.freeTierConfirmed,false);
  assert.equal(report.providerQuotaKnown,true);assert.equal(report.providerRemainingQuotaKnown,false);assert.equal(report.capCoversExpectedRequests,false);
  const prepared=budgetReport(base,{},new Date('2026-11-14T10:00:00Z'),[{language:'kk',available:true},{language:'ru',available:true}]);
  assert.deepEqual(prepared.expectedRequestsWithoutRetriesOrCache,{script:0,speech:9,total:9});
  assert.equal(prepared.reusedCtaRequests,3);assert.equal(prepared.capCoversExpectedRequests,true);
  const six={...base,slots:[...base.slots,...base.slots]};
  assert.equal(budgetReport(six).capCoversExpectedRequests,false);
});
test('text, speech and combined budgets include all attempts and preserve unused roles',async()=>{
  const h=harness(config({scriptRequestsPerDay:2,speechRequestsPerDay:2}));
  await h.guard({endpoint:script});await h.guard({endpoint:script});
  await assert.rejects(h.guard({endpoint:script}),{code:'GEMINI_DAILY_BUDGET'});
  await h.guard({endpoint:speech});await h.guard({endpoint:speech});
  await assert.rejects(h.guard({endpoint:speech}),{code:'GEMINI_DAILY_BUDGET'});
  assert.equal(h.saves,4);assert.equal(h.state.requests['2026-11-14'],4);
  const cfg=config();cfg.gemini.maxDailyRequests=2;
  const combined=harness(cfg);
  await combined.guard({endpoint:script});await combined.guard({endpoint:speech});
  await assert.rejects(combined.guard({endpoint:speech}),{code:'DAILY_BUDGET'});
});
test('per-model pacing persists, does not delay another model and remains abortable',async()=>{
  const h=harness(config({minIntervalMs:61000}));
  await h.guard({endpoint:script});await h.guard({endpoint:speech});
  assert.deepEqual(h.waits,[]);
  await h.guard({endpoint:script});
  assert.equal(h.waits.reduce((a,b)=>a+b,0),61000);assert(h.waits.every(ms=>ms<=30000));
  const controller=new AbortController();
  const stopped=harness(config({minIntervalMs:61000}),h.state,{signal:controller.signal,
    sleep:async()=>{controller.abort();controller.signal.throwIfAborted();}});
  stopped.setTime('2026-11-14T10:01:01Z');
  await assert.rejects(stopped.guard({endpoint:script}),{name:'AbortError'});
  assert.equal(stopped.saves,0);
});
test('Pacific quotas survive Kazakhstan midnight and follow both DST transitions',async()=>{
  assert.equal(quotaDay(new Date('2026-11-14T07:59:59Z')),'2026-11-13');
  assert.equal(quotaDay(new Date('2026-11-14T08:00:00Z')),'2026-11-14');
  assert.equal(nextQuotaReset(new Date('2026-03-08T08:30:00Z')),'2026-03-09T07:03:00.000Z');
  assert.equal(nextQuotaReset(new Date('2026-11-01T07:30:00Z')),'2026-11-02T08:03:00.000Z');
  const h=harness(config({scriptRequestsPerDay:1}));
  h.setTime('2026-11-14T18:59:00Z');await h.guard({endpoint:script});
  h.setTime('2026-11-14T19:01:00Z');
  await assert.rejects(h.guard({endpoint:script}),{code:'GEMINI_DAILY_BUDGET',nextAt:'2026-11-15T08:03:00.000Z'});
  h.setTime('2026-11-15T08:03:00Z');await h.guard({endpoint:script});
  assert.equal(h.saves,2);
});
test('legacy counters are retained conservatively for the initial quota day only',async()=>{
  const h=harness(config(),{jobs:[],requests:{'2026-11-14':6}});
  await assert.rejects(h.guard({endpoint:script}),{code:'GEMINI_DAILY_BUDGET'});
  assert.equal(h.state.requests['2026-11-14'],6);
  h.setTime('2026-11-15T08:03:00Z');
  await h.guard({endpoint:script});assert.equal(h.state.requests['2026-11-15'],1);
});
test('failed persistence prevents HTTP even with confirmed free tier',async()=>{
  let sent=0;
  const h=harness(config(),{jobs:[],requests:{}},{save:async()=>{throw new Error('disk unavailable');}});
  const client=new GeminiClient({apiKey:'fake',beforeRequest:h.guard,fetchImpl:async()=>{sent++;}});
  await assert.rejects(client.generateJSON({model:'gemini-3.8-flash',prompt:'test',schema:{}}),/disk unavailable/);
  assert.equal(sent,0);
});
test('retry counters and pacing survive closing and reopening SQLite',async t=>{
  const parent=path.resolve(here,'..','.audit-work');
  await fs.mkdir(parent,{recursive:true});
  const dir=await fs.mkdtemp(path.join(parent,'free-quota-test-'));
  t.after(async()=>{assert(path.resolve(dir).startsWith(parent+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  let store=await openStore(dir),state=store.load();store.acquire();
  const cfg=config({scriptRequestsPerDay:2});
  let time=Date.parse('2026-11-14T10:00:00Z'),sent=0;
  const guard=createRequestGuard({state,config:cfg,save:async()=>store.save(state),assertOwner:()=>store.assertOwner(),
    now:()=>new Date(time),sleep:async ms=>{time+=ms;}});
  const client=new GeminiClient({apiKey:'fake',beforeRequest:guard,sleep:async ms=>{time+=ms;},fetchImpl:async()=>{
    sent++;return new Response(JSON.stringify(sent===1?{error:{message:'temporarily unavailable'}}:{candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]}),{status:sent===1?503:200});
  }});
  assert.deepEqual((await client.generateJSON({model:'gemini-3.8-flash',prompt:'test',schema:{}})).value,{ok:true});
  store.release();store.close();
  store=await openStore(dir);state=store.load();store.acquire();
  try {
    const again=createRequestGuard({state,config:cfg,save:async()=>store.save(state),assertOwner:()=>store.assertOwner(),now:()=>new Date(time)});
    await assert.rejects(again({endpoint:script}),{code:'GEMINI_DAILY_BUDGET'});
    assert.equal(state.geminiBudget.days['2026-11-14'].models['gemini-3.8-flash'],2);
    assert.equal(state.requests['2026-11-14'],2);assert.equal(sent,2);
  }finally{store.release();store.close();}
});
test('daily provider exhaustion waits for the Pacific reset and is not blindly retried',async()=>{
  let sent=0;
  const client=new GeminiClient({apiKey:'fake',sleep:async()=>{},fetchImpl:async()=>{
    sent++;return new Response(JSON.stringify({error:{message:'GenerateRequestsPerDay quota exceeded'}}),{status:429});
  }});
  let failure;
  try{await client.generateJSON({model:'gemini-3.8-flash',prompt:'test',schema:{}});}catch(e){failure=e;}
  assert.equal(sent,1);
  const policy=failurePolicy(failure,{stage:'generate',jobId:'test',attempt:1,config:base,now:new Date('2026-11-14T18:00:00Z')});
  assert.equal(policy.kind,'quota');assert.equal(policy.nextAt,'2026-11-15T08:03:00.000Z');
});

test('three bilingual videos use nine new speech calls even with empty caches',async t=>{
  const {narrateTopic,pcmToWav}=await import('../voice.mjs');
  const {callToAction}=await import('../localize.mjs');
  const {preparedNarrationStatus}=await import('../prepared-audio.mjs');
  const parent=path.resolve(here,'..','.audit-work');
  await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'prepared-audio-test-'));
  t.after(async()=>{assert(path.resolve(directory).startsWith(parent+path.sep));await fs.rm(directory,{recursive:true,force:true});});
  const prepared=await preparedNarrationStatus(base);
  assert(prepared.every(item=>item.available));
  assert.equal(budgetReport(base,{},new Date(),prepared).expectedRequestsWithoutRetriesOrCache.speech,9);
  let calls=0;
  const client={speech:async({text})=>{
    assert(!['kk','ru'].some(language=>text===callToAction(language)));
    calls++;return {data:pcmToWav(Buffer.alloc(48000)),mimeType:'audio/wav'};
  }};
  for(const [n,language] of ['kk','kk','ru'].entries()) {
    const scenes=[0,1,2].map(i=>({kind:i?'feature':'hook',duration:5,visual:'stack',label:'Материал',headline:'Сабақ '+n+' '+i,body:'Мысал',narration:'Материал '+n+' мысал '+i+'.'}));
    scenes.push({kind:'cta',duration:5,visual:'cta',narration:callToAction(language)});
    const topic={id:'prepared-test-'+n,title:'Материал '+n,description:'Материал',sourceRefs:['Synthetic test fixture'],tags:['test'],language,scenes};
    const args={client,config:base,topic,cacheDir:path.join(directory,'cache-'+n),outputFile:path.join(directory,'narration-'+n+'.wav')};
    await narrateTopic(args);
    assert.equal(calls,3*(n+1));
    await narrateTopic(args);
    assert.equal(calls,3*(n+1));
  }
  assert.equal(calls,9);
});
test('prepared audio matches the exact transcript and checksum; missing CTA stops before API',async t=>{
  const {preparedNarration}=await import('../prepared-audio.mjs');
  const {narrateTopic}=await import('../voice.mjs');
  const {callToAction}=await import('../localize.mjs');
  const parent=path.resolve(here,'..','.audit-work');
  await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'prepared-integrity-test-'));
  t.after(async()=>{assert(path.resolve(directory).startsWith(parent+path.sep));await fs.rm(directory,{recursive:true,force:true});});
  const original=path.join(here,'assets/narration');
  const manifest=JSON.parse(await fs.readFile(path.join(original,'manifest.json'),'utf8'));
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  const item=manifest.items.find(x=>x.language==='kk');
  await fs.copyFile(path.join(original,item.file),path.join(directory,item.file));
  const args={model:item.model,voice:item.voice,language:item.language,text:item.text,directory};
  assert(await preparedNarration(args));
  assert.equal(await preparedNarration({...args,text:item.text+' Changed'}),null);
  await fs.writeFile(path.join(directory,item.file),'damaged');
  await assert.rejects(preparedNarration(args),{code:'PREPARED_AUDIO_INVALID'});
  let requests=0;
  await assert.rejects(narrateTopic({
    client:{speech:async()=>{requests++;throw new Error('unexpected');}},
    config:base,topic:{language:'kk',scenes:[{kind:'feature',narration:'Материал'},{kind:'cta',narration:callToAction('kk')+' changed'}]},
    cacheDir:path.join(directory,'cache'),outputFile:path.join(directory,'voice.wav')
  }),{code:'PREPARED_AUDIO_MISSING'});
  assert.equal(requests,0);
});
