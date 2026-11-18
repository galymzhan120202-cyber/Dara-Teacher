import test from 'node:test';
import {legacySlots} from './legacy-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv,validateSettings} from '../config.mjs';
import {GeminiClient,redact} from '../gemini.mjs';
import {localDate,zonedTime,planDay,publicationDecision,slotsForDate} from '../schedule.mjs';
import {bank,selectVerifiedTopic,contentInventory} from '../verified-content.mjs';
import {makeBrief,topicFromDraft,generateTopic,validateDraft} from '../content.mjs';
import {localizedTheme} from '../localize.mjs';
import {loadProject,createTimeline,captionCues,metadata} from '../model.mjs';
import {makeRenderer} from '../draw.mjs';
import {pcmToWav,asWav,narrateTopic} from '../voice.mjs';
import {voiceDuration,runEncoder} from '../encode.mjs';
import {generateJob} from '../daily.mjs';

const here=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await fs.readFile(path.join(here,'automation.json'),'utf8'));
legacySlots(config);
config.content={mode:'generated'}; // Exercise the optional Gemini adapter separately from verified production mode.
const knowledge=JSON.parse(await fs.readFile(path.join(here,'knowledge.json'),'utf8'));
const project=await loadProject(path.join(here,'catalog.json'),path.join(here,'theme.json'));
const kk={title:'Сабақта жауапты бірге талқылау',description:'Мұғалімге сабақта қолдануға арналған шағын әдіс.',
scenes:[
{label:'Сабаққа идея',headline:'Оқушы қалай ойлайды?',body:'Шешу жолын бірге талқылаңыз.',narration:'Оқушыдан тек жауапты емес, оған қалай келгенін де түсіндіруді сұраңыз.'},
{label:'Қолдану',headline:'Бір сұрақтан бастаңыз',body:'Балалар өз тәсілін түсіндірсін.',narration:'Бір мысалды бірге талқылап, оқушылардың әртүрлі шешу жолдарын тыңдаңыз.'},
{label:'Материал',headline:'Сабаққа дайындық',body:'Ustazon материалдары сабаққа идея береді.',narration:'Сабаққа дайындалғанда Ustazon кітапханасындағы материал түрлерін де ескеріңіз.'}
]};
const ru={title:'Обсудите способ решения с классом',description:'Оригинальный пример для обсуждения на уроке.',
scenes:[
{label:'ИДЕЯ',headline:'Как рассуждают ученики?',body:'Предложите им объяснить решение.',narration:'Предложите классу короткий пример и попросите учеников объяснить свой ход мысли.'},
{label:'ПРИМЕР',headline:'Начните с одного вопроса',body:'Выслушайте разные варианты.',narration:'Обсудите вместе разные способы решения и дайте ученикам время подумать.'},
{label:'МАТЕРИАЛЫ',headline:'Идея для следующего урока',body:'Подготовьте пример заранее.',narration:'В библиотеке Ustazon есть материалы, которые могут помочь при подготовке к уроку.'}
]};
const job=(lang='kk',format='tip')=>({id:'2026-11-14-test-'+lang,date:'2026-11-14',slot:'test',language:lang,format,status:'planned'});
function response(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers});}

test('environment parsing supports auth keys without exposing or evaluating their contents',()=>{
  const env=parseEnv('#comment\nGEMINI_API_KEY="AQ.secret"\nGEMINI_MODEL=model # note\nBAD=$(anything)');
  assert.equal(env.GEMINI_API_KEY,'AQ.secret');assert.equal(env.GEMINI_MODEL,'model');assert.equal(env.BAD,'$(anything)');
  assert.equal(redact('bad AQ.secret',['AQ.secret']),'bad [REDACTED]');
});
test('Gemini uses the key header, JSON response schema and bounded retries',async()=>{
  const calls=[],pauses=[];let count=0;
  const client=new GeminiClient({apiKey:'private-test-value',sleep:async n=>pauses.push(n),beforeRequest:async()=>count++,
    fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?response({error:{message:'busy'}},503):response({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]});}});
  assert.deepEqual((await client.generateJSON({model:'gemini-test',prompt:'hello',schema:{type:'object'}})).value,{ok:true});
  assert.equal(count,2);assert.equal(pauses.length,1);
  assert(!calls[0].url.includes('private-test-value'));
  assert.equal(calls[0].options.headers['x-goog-api-key'],'private-test-value');
  assert.equal(JSON.parse(calls[0].options.body).generationConfig.responseFormat.text.mimeType,'APPLICATION_JSON');
});
test('zero quota, invalid JSON and network ambiguity fail without leaking credentials',async()=>{
  let attempts=0;
  const client=new GeminiClient({apiKey:'private-value',fetchImpl:async()=>{attempts++;return response({error:{message:'limit: 0 private-value'}},429);}});
  await assert.rejects(client.generateJSON({model:'gemini-test',prompt:'x',schema:{}}),e=>!e.message.includes('private-value')&&e.status===429);
  assert.equal(attempts,1);
  const invalid=new GeminiClient({apiKey:'x',fetchImpl:async()=>response({candidates:[{content:{parts:[{text:'not JSON'}]}}]})});
  await assert.rejects(invalid.generateJSON({model:'gemini-test',prompt:'x',schema:{}}),/invalid JSON/);
  const network=new GeminiClient({apiKey:'x',fetchImpl:async()=>{throw new Error('secret');}});
  await assert.rejects(network.models(),/network request/);
});
test('Gemini TTS uses Russian pronunciation and keeps transcript separate from delivery instructions',async()=>{
  let body;
  const wav=pcmToWav(Buffer.alloc(4800));
  const client=new GeminiClient({apiKey:'test',fetchImpl:async(_,options)=>{body=JSON.parse(options.body);return response({candidates:[{content:{parts:[{inlineData:{mimeType:'audio/wav',data:wav.toString('base64')}}]}}]});}});
  const audio=await client.speech({model:'gemini-3.8-flash-tts',voice:'Kore',text:'Здравствуйте.',language:'ru'});
  assert.equal(body.contents[0].parts[0].text,'Здравствуйте.');
  assert.match(body.contents[0].parts[0].speech_metadata.style,/Russian/);
  assert.deepEqual(asWav(audio),wav);
});
test('daily planning respects Qyzylorda midnight, preserves jobs and ignores separate samples',()=>{
  assert.equal(localDate(new Date('2026-11-13T20:01:00Z'),config.timezone),'2026-11-14');
  assert.equal(zonedTime('2026-11-14','10:00',config.timezone),'2026-11-14T05:00:00.000Z');
  const state={jobs:[{date:'2026-11-14',slot:'sample'}]};
  const first=planDay(state,'2026-11-14',config);
  assert.equal(first.length,config.slots.length);
  const second=planDay(state,'2026-11-14',{...config,slots:config.slots.map(s=>({...s,language:'ru'}))});
  assert.deepEqual(first,second);assert.equal(state.jobs.length,config.slots.length+1);
  assert.equal(new Set(first.map(j=>j.id)).size,first.length);
  assert.throws(()=>validateSettings({...config,gemini:{...config.gemini,maxDailyRequests:Infinity}}),/request limits/);
});
test('publishing stays disabled until connected and does not flood missed slots',()=>{
  const j={publishAt:'2026-11-14T05:00:00Z',youtube:{sessionUrl:'session'}};
  assert.equal(publicationDecision(j,config),'disabled');
  const enabled={...config,youtube:{...config.youtube,enabled:true}};
  assert.equal(publicationDecision({...j,youtube:{}},enabled,new Date('2026-11-14T06:00:00Z')),'missed');
  assert.equal(publicationDecision({...j,youtube:{}},enabled,new Date('2026-11-14T04:00:00Z')),'schedule');
  assert.equal(publicationDecision(j,enabled,new Date('2026-11-14T06:00:00Z')),'reconcile');
});
test('alternating languages uses every bilingual story once over eight three-video days',()=>{
  const rotating={...config,languageRotation:{mode:'alternate-days',startDate:'2026-11-15'}},state={jobs:[]},keys=[];
  assert.equal(slotsForDate('2026-11-14',rotating),rotating.slots);
  for(let day=0;day<8;day++) {
    const date=new Date(Date.UTC(2026,10,15+day)).toISOString().slice(0,10);
    const jobs=planDay(state,date,rotating);
    assert.deepEqual(jobs.map(j=>j.language),day%2?['ru','ru','kk']:['kk','kk','ru']);
    assert.deepEqual(jobs.map(j=>j.publishAt.slice(11,16)),['05:00','10:00','15:00']);
    for(const job of jobs) {
      job.topic=selectVerifiedTopic(job,state.jobs.filter(j=>j.topic).map(j=>j.topic));
      keys.push(job.topic.contentKey);job.status='uploaded';job.youtube={videoId:'simulated-'+keys.length};
    }
  }
  assert.equal(keys.length,24);assert.equal(new Set(keys).size,24);
  for(const story of bank.stories)for(const language of ['kk','ru'])assert(keys.includes(story.id+':'+language));
  assert.equal(contentInventory(state.jobs).languages.kk.remaining,0);assert.equal(contentInventory(state.jobs).languages.ru.remaining,0);
  const ninth=planDay(state,'2026-11-23',rotating)[0];
  assert.throws(()=>selectVerifiedTopic(ninth,state.jobs.filter(j=>j.topic).map(j=>j.topic)),e=>e.code==='CONTENT_EXHAUSTED');
});
test('language rotation preserves planned uploads, retry history and the language of carried work',()=>{
  const rotating={...config,languageRotation:{mode:'alternate-days',startDate:'2026-11-15'},runtime:{...config.runtime,carryUnfinished:true}};
  const state={jobs:[]},today=planDay(state,'2026-11-15',rotating);
  today[0].status='uploaded';today[0].youtube={videoId:'existing'};
  today[1].status='uploaded';today[1].youtube={videoId:'existing-2'};
  today[2].status='failed';today[2].retries={generate:{kind:'quota',nextAt:'2026-11-16T08:03:00Z'}};
  const before=JSON.stringify(today);
  assert.deepEqual(planDay(state,'2026-11-15',{...rotating,languageRotation:{...rotating.languageRotation,startDate:'2026-11-14'}}),today);
  assert.equal(JSON.stringify(today),before);
  const tomorrow=planDay(state,'2026-11-16',rotating),carried=tomorrow.find(j=>j.id===today[2].id);
  assert.equal(carried.language,'ru');assert.equal(carried.retries.generate.nextAt,'2026-11-16T08:03:00Z');
  assert.equal(state.jobs.filter(j=>j.id===carried.id).length,1);
  assert.equal(today[0].youtube.videoId,'existing');assert.equal(today[0].publishAt,'2026-11-15T05:00:00.000Z');
  assert.throws(()=>validateSettings({...rotating,languageRotation:{mode:'unknown',startDate:'2026-11-15'}}),/Language rotation/);
  assert.throws(()=>validateSettings({...rotating,languageRotation:{mode:'alternate-days',startDate:'2026-02-30'}}),/valid date/);
});
test('both languages fit all three formats and arithmetic is computed rather than generated',()=>{
  for(const language of ['kk','ru'])for(const format of ['tip','material','quiz']) {
    const j=job(language,format),brief=makeBrief(j,knowledge);
    const topic=topicFromDraft(language==='ru'?ru:kk,j,brief);
    const theme=localizedTheme(project.theme,language),timeline=createTimeline(topic,8);
    const renderer=makeRenderer(theme,timeline,{width:180,height:320,fontPath:project.fontPath,captions:true});
    for(const scene of timeline.scenes)renderer.draw(scene.startFrame+8);
    assert.equal(metadata(topic,theme,timeline).language,language);
    if(language==='ru')assert(!/[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(JSON.stringify([theme.cta,topic.title,topic.scenes])));
    if(format==='quiz')assert.equal(topic.scenes[2].quiz.answer,brief.quiz.operator==='-'?brief.quiz.a-brief.quiz.b:brief.quiz.a+brief.quiz.b);
  }
});
test('unsupported claims and repeated scripts are rejected before paid narration',async()=>{
  assert.throws(()=>validateDraft({...kk,title:'Тегін материалдар'},'kk'),/unsupported/);
  assert.throws(()=>validateDraft({...ru,title:'Сабаққа идея'},'ru'),/Russian/);
  let n=0;
  const client={generateJSON:async()=>{n++;return {value:kk};}};
  await assert.rejects(generateTopic({client,config,job:job(),knowledge,recent:[{title:kk.title,language:'kk',text:''}]}),/similar/);
  assert.equal(n,config.gemini.maxScriptAttempts);
});
test('scene audio is cached and padded; captions stop with narration before the quiz pause',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-voice-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const topic=topicFromDraft(ru,job('ru','quiz'),makeBrief(job('ru','quiz'),knowledge));
  let requests=0;
  const client={speech:async()=>{requests++;return {data:pcmToWav(Buffer.alloc(24000*2*2)),mimeType:'audio/wav'};}};
  const settings={...config,video:{...config.video,fps:8}};
  const args={client,config:settings,topic,cacheDir:path.join(dir,'cache'),outputFile:path.join(dir,'voice.wav')};
  const result=await narrateTopic(args);
  assert.equal(requests,3);
  await narrateTopic(args);assert.equal(requests,3);
  const timeline=createTimeline(result.topic,8);
  assert(Math.abs(await voiceDuration(result.narrationPath)-timeline.duration)<.02);
  const cues=captionCues(timeline),question=timeline.scenes[1];
  assert(cues.filter(c=>c.start>=question.start&&c.start<question.end).at(-1).end<=question.start+2.01);
  assert.equal((await runEncoder(['-v','error','-i',result.narrationPath,'-f','null','-'])).code,0);
});
test('completed generation resumes without another API request or duplicate output',async t=>{
  const j=job();j.outputDir=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-ready-'));
  t.after(()=>fs.rm(j.outputDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(j.outputDir,'metadata.json'),JSON.stringify({status:'complete',draft:false,topicId:j.id,durationSeconds:1,fps:8}));
  const encoded=await runEncoder(['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=white:s=180x320:r=8:d=1','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','1','-c:v','libx264','-c:a','aac',path.join(j.outputDir,'video.mp4')]);assert.equal(encoded.code,0,encoded.stderr);
  let calls=0,saves=0;
  await generateJob({job:j,state:{jobs:[j]},save:async()=>saves++,client:{generateJSON:()=>calls++},config,project,knowledge,log:()=>{}});
  assert.equal(j.status,'ready');assert.equal(calls,0);assert.equal(saves,1);
});

test('only upstream 5xx failures use the declared template fallback; quota and local failures stay errors',async()=>{
  const error=Object.assign(new Error('busy'),{status:503});
  const settings={...config,gemini:{...config.gemini,templateFallback:true}};
  const result=await generateTopic({client:{generateJSON:async()=>{throw error;}},config:settings,job:job('ru','quiz'),knowledge});
  assert.equal(result.origin,'verified-template');assert.equal(result.fallbackReason,'Gemini HTTP 503');
  assert.equal(result.topic.language,'ru');
  for(const failure of [new Error('Daily limit'),Object.assign(new Error('Quota'),{status:429})]) {
    await assert.rejects(generateTopic({client:{generateJSON:async()=>{throw failure;}},config:settings,job:job(),knowledge}),e=>e===failure);
  }
});
test('a slot less than two minutes away waits instead of publishing early',()=>{
  const enabled={...config,youtube:{...config.youtube,enabled:true}};
  const j={publishAt:'2026-11-14T05:00:00Z'};
  assert.equal(publicationDecision(j,enabled,new Date('2026-11-14T04:59:00Z')),'wait');
  assert.equal(publicationDecision(j,enabled,new Date('2026-11-14T05:00:00Z')),'now');
});
