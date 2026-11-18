import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HERE} from './config.mjs';
import {readJSON,writeJSON} from './state.mjs';
import {generateTopic} from './content.mjs';
import {localizedTheme} from './localize.mjs';
import {createTimeline} from './model.mjs';
import {makeRenderer} from './draw.mjs';
import {narrateTopic} from './voice.mjs';
import {renderVideo,verifyVideo} from './encode.mjs';
import {fileDigest} from './maintenance.mjs';
import {assertVerifiedTopic} from './verified-content.mjs';
import {runtime,textIdentity,narrationIdentity,exerciseIdentity} from './reliability.mjs';

export async function artifactReady(job) {
  if(!job.outputDir||job.mediaRemoved)return false;
  try {
    const file=path.join(job.outputDir,'video.mp4'),stat=await fs.stat(file);
    if(!stat.isFile()||stat.size<100)return false;
    if(job.outputSha256&&job.verifiedSize===stat.size&&job.verifiedMtimeMs===stat.mtimeMs)return true;
    const info=await readJSON(path.join(job.outputDir,'metadata.json'),null);
    if(info?.status!=='complete'||info.topicId!==job.id)return false;
    const expected=job.outputSha256||info.sha256;
    if(!expected)return false; // Legacy files are fully checked by generateJob before adoption.
    return await fileDigest(file)===expected;
  }catch(error){if(['ENOENT'].includes(error.code)||error instanceof SyntaxError)return false;throw error;}
}
function recentContent(state,job) {
  return state.jobs.filter(j=>j.topic&&j.id!==job.id).map(j=>({
    title:j.topic.title,language:j.language,text:j.topic.scenes.filter(s=>s.kind!=='cta').map(s=>s.narration).join(' '),
    exerciseKey:exerciseIdentity(j.topic),date:j.date,contentKey:j.topic.contentKey,materialId:j.topic.materialId
  }));
}
export function reserveContent(store,job,topic) {
  if(!store)return;
  if(topic.contentKey)store.claim('story',topic.contentKey,job.id);
  store.claim('content',textIdentity(topic),job.id);
  store.claim('narration',narrationIdentity(topic),job.id);
  store.claim('exercise',exerciseIdentity(topic),job.id);
}
export function refreshVerifiedJob(job,config) {
  if(config.content?.mode!=='verified'||job.youtube?.videoId||job.status==='uploaded'||job.youtube?.sessionUrl||job.youtube?.initiating||Object.values(job.social||{}).some(r=>r.intent||r.postId))return false;
  if(!job.topic&&!job.outputDir)return false;
  try{assertVerifiedTopic(job.topic);return false;}catch(error){
    if(job.outputDir){job.replacedArtifacts||=[];job.replacedArtifacts.push({outputDir:job.outputDir,reason:'outdated-content'});}
    for(const key of ['topic','voicedTopic','outputDir','outputSha256','verifiedSize','verifiedMtimeMs','audioFiles','completedAt','error','scriptOrigin','scriptModel','fallbackReason'])delete job[key];
    job.status='planned';job.retries={};return true;
  }
}
export async function generateJob({job,state,save,client,config,project,knowledge,draft=false,log=console.log,store=null,
  stateDir=path.join(HERE,'.state'),baseDir=HERE,signal}) {
  if(refreshVerifiedJob(job,config))await save();
  const width=draft?540:config.video.width,fps=draft?24:config.video.fps;
  const renderConfig={...config,video:{...config.video,width,fps}};
  if(job.outputDir) {
    let info;
    try{info=await readJSON(path.join(job.outputDir,'metadata.json'),null);}
    catch(error){if(!(error instanceof SyntaxError))throw error;}
    if(info?.status==='complete'&&info.topicId===job.id&&(!info.draft||draft)) {
      try {
        const file=path.join(job.outputDir,'video.mp4');
        const checked=await verifyVideo(file,{expectedFrames:Math.round(info.durationSeconds*info.fps),signal});
        if(info.sha256&&info.sha256!==checked.sha256)throw new Error('Stored video checksum does not match');
        if(job.topic)reserveContent(store,job,job.topic);
        const stat=await fs.stat(file);
        info.sha256=checked.sha256;info.verifiedAt=new Date().toISOString();
        await writeJSON(path.join(job.outputDir,'metadata.json'),info);
        Object.assign(job,{status:'ready',draft:Boolean(info.draft),outputSha256:checked.sha256,verifiedSize:stat.size,verifiedMtimeMs:stat.mtimeMs});
        delete job.error;await save();return job;
      }catch(error) {
        if(signal?.aborted||error.code==='DUPLICATE')throw error;
        log(job.id+': rebuilding an incomplete or damaged artifact');
      }
    }
  }
  const localized={...project,theme:localizedTheme(project.theme,job.language)};
  if(!job.topic) {
    log(job.id+': script');
    const result=await generateTopic({client,config:renderConfig,job,knowledge,recent:recentContent(state,job),
      validateLayout:topic=>{
        makeRenderer(localized.theme,createTimeline(topic,fps),{width,height:width*16/9,fontPath:project.fontPath,captions:config.video.captions,assets:project.visualAssets});
        reserveContent(store,job,topic);
      }});
    Object.assign(job,{topic:result.topic,scriptUsage:result.usage,scriptModel:result.origin==='gemini'?config.gemini.model:null,
      scriptOrigin:result.origin,fallbackReason:result.fallbackReason,status:'scripted'});
    await save();
  }else reserveContent(store,job,job.topic);
  let narrationPath=null,topic=job.topic;
  if(config.gemini.voiceEnabled) {
    const result=await narrateTopic({client,config:renderConfig,topic,cacheDir:path.join(stateDir,'audio'),
      outputFile:path.join(stateDir,'narration',job.id+'.wav'),signal,
      onRepair:async()=>{reserveContent(store,job,job.topic);await save();},
      onScene:async(n,total,cached,files)=>{job.audioFiles=files;await save();log(job.id+': voice '+n+'/'+total+(cached?' (cached)':''));}});
    topic=result.topic;narrationPath=result.narrationPath;
    job.voicedTopic=topic;job.status='voiced';await save();
  }
  if(config.content?.mode==='verified')assertVerifiedTopic(topic);
  signal?.throwIfAborted();
  const parent=path.join(baseDir,'output','daily',job.date);await fs.mkdir(parent,{recursive:true});
  job.outputDir=path.join(parent,job.id+'-'+randomUUID().slice(0,6));job.status='rendering';job.draft=draft;await save();
  log(job.id+': rendering '+width+'x'+width*16/9);
  const result=await renderVideo(localized,topic,{outputDir:job.outputDir,width,fps,draft,narrationPath,captions:config.video.captions,signal,
    timeoutMs:runtime(config).renderTimeoutMinutes*60000,onProgress:value=>log(job.id+': '+Math.round(value*100)+'%')});
  Object.assign(result.info,{narration:config.gemini.voiceEnabled?'Gemini TTS ('+config.gemini.ttsModel+', '+config.gemini.voice+')':'text-and-music',
    scriptOrigin:job.scriptOrigin||'gemini',scriptModel:job.scriptOrigin==='gemini'?(job.scriptModel||config.gemini.model):null});
  if(job.fallbackReason)result.info.fallbackReason=job.fallbackReason;
  await writeJSON(path.join(job.outputDir,'metadata.json'),result.info);
  const stat=await fs.stat(result.outputPath);
  Object.assign(job,{status:'ready',completedAt:new Date().toISOString(),outputSha256:result.info.sha256,verifiedSize:stat.size,verifiedMtimeMs:stat.mtimeMs});
  delete job.error;await save();return job;
}
