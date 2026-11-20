import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateCatalog} from './model.mjs';
import {callToAction} from './localize.mjs';
import {PRESENTATION_REVISION} from './presentation.mjs';
export const bank=JSON.parse(await fs.readFile(new URL('./stories.json',import.meta.url),'utf8'));
const manifest=JSON.parse(await fs.readFile(new URL('./assets/materials/manifest.json',import.meta.url),'utf8'));
const assets=new Map(manifest.assets.map(a=>[a.id,a]));
export const evidenceRevision=createHash('sha256').update(JSON.stringify({bank,manifest,presentation:PRESENTATION_REVISION})).digest('hex');
function contentError(message,code='CONTENT_REVIEW_REQUIRED'){return Object.assign(new Error(message),{code});}
export function makeVerifiedTopic(job,story) {
  const text=story[job.language];if(!text)throw contentError('Unsupported content language');
  const scenes=structuredClone(text.scenes);
  scenes.push({kind:'cta',duration:5,visual:'cta',narration:callToAction(job.language)});
  return {id:job.id,title:text.title,description:text.description,language:job.language,format:story.format,
    storyId:story.id,materialId:story.material,contentKey:story.id+':'+job.language,evidenceRevision,
    tags:['Ustazon',job.language==='kk'?'мұғалім':'учитель',job.language==='kk'?'биология':'биология','shorts'],
    sourceRefs:['Ustazon export 2026-11-13: card '+story.material,...new Set(scenes.filter(s=>s.assetId).map(s=>assets.get(s.assetId)?.sourcePath))],scenes};
}
export function validateStoryBank() {
  if(bank.version!==1||!bank.stories?.length)throw contentError('Empty verified content bank');
  const ids=new Set();
  for(const story of bank.stories) {
    if(ids.has(story.id)||!['tip','material','quiz'].includes(story.format))throw contentError('Invalid story: '+story.id);
    ids.add(story.id);
    for(const language of ['kk','ru']) {
      const topic=makeVerifiedTopic({id:'check-'+story.id+'-'+language,language},story);
      if(topic.scenes.length!==4)throw contentError('A verified story must have three source scenes');
      for(const s of topic.scenes.slice(0,-1)) {
        if(!assets.has(s.assetId)||assets.get(s.assetId).cardId!==story.material)throw contentError('Source does not belong to material: '+story.id);
        if(language==='kk'&&!/[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(s.narration))throw contentError('Kazakh narration requires language review: '+story.id);
        if(language==='ru'&&/[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(s.narration))throw contentError('Mixed language in Russian narration: '+story.id);
        if(!s.shortNarration||s.shortNarration.length>160||s.narration.length>200)throw contentError('Narration needs editing: '+story.id);
      }
      validateCatalog({version:1,source:bank.source,topics:[topic]});
    }
  }
  return bank;
}
export function assertVerifiedTopic(topic) {
  const story=bank.stories.find(s=>s.id===topic?.storyId);
  if(!story||topic.evidenceRevision!==evidenceRevision)throw contentError('This video uses outdated or unverified material. Regenerate it from the current content bank.');
  const expected=makeVerifiedTopic({id:topic.id,language:topic.language},story);
  for(const key of ['title','description','language','format','materialId','contentKey','sourceRefs','tags'])if(JSON.stringify(topic[key])!==JSON.stringify(expected[key]))throw contentError('Unverified field: '+key);
  if(topic.scenes?.length!==expected.scenes.length)throw contentError('Unverified scene count');
  topic.scenes.forEach((scene,i)=>{
    const canonical=expected.scenes[i],actual={...scene};
    delete actual.speechDuration;
    delete actual.captionTiming;
    actual.duration=canonical.duration;
    if(canonical.shortNarration&&actual.narration===canonical.shortNarration)actual.narration=canonical.narration;
    if(JSON.stringify(actual)!==JSON.stringify(canonical))throw contentError('Unverified scene '+(i+1));
  });
  validateCatalog({version:1,source:bank.source,topics:[topic]});return topic;
}
export function selectVerifiedTopic(job,recent=[]) {
  const used=new Set(recent.map(r=>r.contentKey).filter(Boolean));
  const available=bank.stories.filter(s=>!used.has(s.id+':'+job.language));
  // Alternate source materials; prefer the slot's requested format, then use remaining stories.
  const last=recent.filter(r=>r.language===job.language&&r.materialId).at(-1)?.materialId;
  const preferred=available.filter(s=>s.format===job.format);
  const pool=preferred.length?preferred:available;
  const story=pool.find(s=>s.material!==last)||pool[0];
  if(!story)throw contentError('Verified content is exhausted for '+job.language+'. Add reviewed material and stories; previous videos will not be repeated.','CONTENT_EXHAUSTED');
  return assertVerifiedTopic(makeVerifiedTopic(job,story));
}
export function contentInventory(jobs=[]) {
  const used=new Set(jobs.filter(j=>j.topic).map(j=>j.topic.contentKey));
  return {revision:bank.revision,materials:new Set(bank.stories.map(s=>s.material)).size,
    languages:Object.fromEntries(['kk','ru'].map(language=>[language,{total:bank.stories.length,remaining:bank.stories.filter(s=>!used.has(s.id+':'+language)).length}]))};
}
validateStoryBank();
