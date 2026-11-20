import test from 'node:test';
import assert from 'node:assert/strict';
import {pcmToWav} from '../voice.mjs';
import {captionChunks,speechRegions,makeCaptionTiming,validateCaptionTiming} from '../caption-timing.mjs';
import {captionCues,createTimeline} from '../model.mjs';
import {activeEmphasis,materialCrop,projectRegion,countdownState} from '../presentation.mjs';
import {bank,makeVerifiedTopic,assertVerifiedTopic,selectVerifiedTopic} from '../verified-content.mjs';
import {slotsForDate} from '../schedule.mjs';
import {callToAction} from '../localize.mjs';
import fs from 'node:fs/promises';

test('audio analysis excludes measured leading/trailing silence and preserves a long internal pause',()=>{
  const rate=24000,pcm=Buffer.alloc(rate*4*2);
  for(let i=0;i<rate*4;i++)if((i>=rate*.5&&i<rate*1.5)||(i>=rate*2.5&&i<rate*3.5))pcm.writeInt16LE(Math.round(9000*Math.sin(i*2*Math.PI*180/rate)),i*2);
  const regions=speechRegions(pcmToWav(pcm),4);
  assert.equal(regions.length,2);assert(Math.abs(regions[0].start-.5)<.06);assert(Math.abs(regions[1].end-3.5)<.06);
  const timing=makeCaptionTiming('Бір сұрақ. Бір жауап.',4,regions);
  validateCaptionTiming(timing,'Бір сұрақ. Бір жауап.',4);
  assert.equal(timing.method,'audio-pauses');assert(timing.cues[1].start-timing.cues[0].end>.8);
  const cues=captionCues({scenes:[{narration:'Бір сұрақ. Бір жауап.',start:5,end:10,speechDuration:4,captionTiming:timing}]});
  assert(cues[0].start>5.4);assert(cues.at(-1).end<8.6);
});

test('short bilingual phrases preserve every word and invalid runtime timings fail closed',()=>{
  for(const story of bank.stories)for(const language of ['kk','ru'])for(const scene of story[language].scenes){
    const chunks=captionChunks(scene.narration);assert(chunks.every(c=>c.split(/\s+/).length<=4));
    assert.equal(chunks.join(' '),scene.narration);
    validateCaptionTiming(makeCaptionTiming(scene.narration,5),scene.narration,5);
  }
  const topic=makeVerifiedTopic({id:'caption-validation',language:'kk'},bank.stories[0]);
  topic.scenes[0].captionTiming=makeCaptionTiming(topic.scenes[0].narration,5);assertVerifiedTopic(topic);
  for(const change of [t=>t.cues[0].text='Бөтен сөз',t=>t.cues[0].start=-1,t=>t.cues[1].start=0,t=>t.cues.at(-1).end=30]){
    const bad=structuredClone(topic);change(bad.scenes[0].captionTiming);assert.throws(()=>assertVerifiedTopic(bad));
  }
  assert.equal(makeCaptionTiming('Қысқа сөйлем.',2,speechRegions(pcmToWav(Buffer.alloc(96000)),2)).method,'estimated');
});

test('emphasis follows the spoken phrase and source crops never project a hidden arrow onto the image',()=>{
  const scene={assetId:'diffusion-diagram',narration:'Суретті қараңыз. Бағыттауышты салыстырыңыз.',duration:5,
    captionTiming:{version:1,method:'audio-pauses',cues:[{text:'Суретті қараңыз.',start:.2,end:1.8},{text:'Бағыттауышты салыстырыңыз.',start:2.4,end:4.6}]}};
  assert.deepEqual(activeEmphasis(scene,1),[]);assert.equal(activeEmphasis(scene,3).length,2);assert.deepEqual(activeEmphasis(scene,4.9),[]);
  const box={x:100,y:600,w:800,h:600},crop=[0,0,.51,1];
  const [left,right]=activeEmphasis(scene,3);
  assert.equal(projectRegion(right,crop,box),null);
  const visible=projectRegion(left,crop,box);assert(visible.x>=box.x&&visible.x+visible.w<=box.x+box.w);
  assert.deepEqual(materialCrop({assetId:'urinary-anatomy'}),[.37,.02,.39,.96]);
});

test('three-second countdown begins after speech and the answer is in the following scene',()=>{
  for(const language of ['kk','ru'])for(const story of bank.stories.filter(s=>s.format==='quiz')){
    const topic=makeVerifiedTopic({id:story.id+'-'+language,language},story),question=topic.scenes[1];
    assert.equal(question.pauseSeconds,3);
    question.speechDuration=6.23;question.duration=9.25;
    assert.equal(countdownState(question,6.2),null);
    assert.equal(countdownState(question,6.3).seconds,3);
    assert.equal(countdownState(question,7.3).seconds,2);
    assert.equal(countdownState(question,8.3).seconds,1);
    assert.equal(countdownState(question,9.25),null);
    const timeline=createTimeline(topic,24),cues=captionCues(timeline);
    const segment=timeline.scenes[1],answer=timeline.scenes[2];
    assert.equal(segment.end,answer.start);
    assert(cues.filter(c=>c.start>=segment.start&&c.start<segment.end).every(c=>c.end<=segment.start+6.23+.001));
    assert.match(topic.scenes[2].label,language==='kk'?/ДӘЛЕЛ/:/ДОКАЗАТЕЛЬСТВО/);
  }
});

test('daily rotation delivers comparison, error-finding and lesson tips in both languages without repeats',async()=>{
  const config=JSON.parse(await fs.readFile(new URL('../automation.json',import.meta.url),'utf8')),recent=[];
  for(let i=0;i<24;i++){
    const date=new Date(Date.parse(config.formatRotation.startDate)+i*86400000).toISOString().slice(0,10);
    const slot=slotsForDate(date,config)[0];
    const topic=selectVerifiedTopic({...slot,id:'format-'+i},recent);
    assert.equal(topic.format,slot.format);assert(!recent.some(t=>t.contentKey===topic.contentKey));
    const expected=slot.language==='kk'?{material:'САЛЫСТЫРАМЫЗ',quiz:'ҚАТЕНІ ТАП',tip:'САБАҚҚА БІР ӘДІС'}:{material:'СРАВНИВАЕМ',quiz:'НАЙДИТЕ ОШИБКУ',tip:'ОДИН ПРИЁМ ДЛЯ УРОКА'};
    assert.equal(topic.scenes[0].label,expected[slot.format]);
    assert.equal(topic.scenes.at(-1).narration,callToAction(slot.language));recent.push(topic);
  }
});
