import path from 'node:path';
import {createHash} from 'node:crypto';
import {localDate,zonedTime} from './schedule.mjs';
import {nextQuotaReset} from './budget.mjs';

export const DEFAULT_RUNTIME={pollSeconds:30,maxAttemptsPerDay:6,retryBaseSeconds:60,retryMaxMinutes:60,
  minFreeMB:512,cacheDays:30,backupDays:14,logDays:14,logMaxMB:5,renderTimeoutMinutes:10};
export const runtime=config=>({...DEFAULT_RUNTIME,...config.runtime});
export function addDays(date,days){return new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);}
export function configIdentity(config,apiKey) {
  return createHash('sha256').update(JSON.stringify({key:apiKey,gemini:config.gemini,youtube:config.youtube,content:config.content})).digest('hex');
}
export function textIdentity(topic) {
  const normalize=text=>String(text||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const texts=topic.scenes.filter(scene=>scene.kind!=='cta').map(s=>[s.headline,s.body,s.narration,s.steps?.join(' ')].map(normalize).join('|'));
  return createHash('sha256').update(JSON.stringify({language:topic.language||'kk',texts})).digest('hex');
}
export function narrationIdentity(topic) {
  return createHash('sha256').update((topic.language||'kk')+'|'+topic.scenes.filter(s=>s.kind!=='cta').map(s=>s.narration).join(' ').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()).digest('hex');
}
export function exerciseIdentity(topic) {
  const q=topic.scenes.find(s=>s.quiz)?.quiz;
  if(!q)return null;
  const op=q.operator||'+';
  const pair=op==='+'?[q.a,q.b].sort((a,b)=>a-b):[q.a,q.b];
  return (topic.language||'kk')+':'+op+':'+pair.join(':');
}
export function alreadyPublished(job){return Boolean(job.youtube?.videoId)||job.status==='uploaded';}
export function remainingUpload(job){return Boolean(!job.youtube?.videoId&&(job.youtube?.sessionUrl||job.youtube?.initiating));}
export function failurePolicy(error,{stage,jobId,attempt,config,now=new Date()}) {
  const cfg=runtime(config),text=error.message||'Unknown failure';
  const nextDay=zonedTime(addDays(localDate(now,config.timezone),1),'00:03',config.timezone);
  if(error.name==='AbortError'||error.code==='ABORT_ERR')return {kind:'stopped',nextAt:now.toISOString()};
  if(error.code==='REMOTE_STATE_FAILED')return {kind:'configuration',nextAt:new Date(+now+60*60000).toISOString(),global:true};
  if(error.code==='FREE_TIER_UNCONFIRMED'||error.code==='FREE_MODEL_UNREVIEWED'||error.code==='BUDGET_STATE_INVALID'||error.code==='PREPARED_AUDIO_MISSING'||error.code==='PREPARED_AUDIO_INVALID')return {kind:'configuration',nextAt:new Date(+now+60*60000).toISOString(),global:true};
  if(error.code==='GEMINI_DAILY_BUDGET'||error.code==='DAILY_BUDGET'||/Daily Gemini request limit/.test(text))return {kind:'daily-limit',nextAt:error.nextAt||nextDay,global:true};
  if(['CONTENT_EXHAUSTED','CONTENT_REVIEW_REQUIRED','NARRATION_TOO_LONG'].includes(error.code))return {kind:'attention',nextAt:null};
  if(error.code==='DUPLICATE'||error.code==='UPLOAD_UNCERTAIN'||error.code==='UPLOAD_EXPIRED'||error.code==='PUBLICATION_MISSED')return {kind:'attention',nextAt:null};
  if(error.code==='ENOSPC'||error.code==='LOW_DISK')return {kind:'disk',nextAt:new Date(+now+10*60000).toISOString(),global:true};
  if([401,403,404].includes(error.status)&&error.reason!=='quotaExceeded')return {kind:'configuration',nextAt:new Date(+now+60*60000).toISOString(),global:true};
  if(stage==='generate'&&error.status===429&&/per[ _-]?day|daily/i.test(text))return {kind:'quota',nextAt:nextQuotaReset(now),global:true};
  if(error.reason==='quotaExceeded'||error.status===429&&/limit:\s*0/i.test(text))return {kind:'quota',nextAt:new Date(+now+60*60000).toISOString(),global:true};
  if(stage==='publish'&&/not connected|expectedChannelId|does not match|different channel|client_secrets|offline access|invalid_grant/i.test(text))return {kind:'configuration',nextAt:new Date(+now+60*60000).toISOString(),global:true};
  const seed=parseInt(createHash('sha256').update(jobId+stage+attempt).digest('hex').slice(0,8),16)/0xffffffff;
  const exponential=Math.min(cfg.retryMaxMinutes*60,cfg.retryBaseSeconds*2**Math.min(attempt-1,12));
  const delay=Math.max(exponential*(1+seed*.2),Number(error.retryAfterMs||0)/1000);
  return {kind:'retry',nextAt:new Date(+now+delay*1000).toISOString(),global:stage==='generate'&&(error.status===429||error.status>=500)};
}
export function eligible(job,stage,config,now=new Date(),identity='') {
  const r=job.retries?.[stage];
  if(!r)return true;
  if(r.kind==='attention')return false;
  if(r.identity&&identity&&r.identity!==identity)return true;
  const today=localDate(now,config.timezone);
  if(r.day===today&&r.attempts>=runtime(config).maxAttemptsPerDay)return false;
  return !r.nextAt||Date.parse(r.nextAt)<=+now;
}
export function stageBlocked(state,stage,identity,now=new Date()) {
  const block=state.controls?.[stage];
  if(!block||block.identity!==identity)return false;
  return Boolean(block.nextAt&&Date.parse(block.nextAt)>+now);
}
export function recordFailure(state,job,stage,error,config,identity,now=new Date()) {
  job.retries ||= {};
  const today=localDate(now,config.timezone),old=job.retries[stage];
  const attempts=old?.day===today?(old.attempts||0)+1:1;
  const policy=failurePolicy(error,{stage,jobId:job.id,attempt:attempts,config,now});
  const record={...policy,attempts,day:today,identity,lastAt:now.toISOString()};
  job.retries[stage]=record;
  if(policy.global){state.controls ||= {};state.controls[stage]={kind:policy.kind,nextAt:policy.nextAt,identity};}
  return record;
}
export function clearFailure(state,job,stage) {
  if(job.retries)delete job.retries[stage];
  if(state.controls)delete state.controls[stage];
  if(stage==='generate')delete job.error;else delete job.uploadError;
}
export function retryJob(job) {
  if(alreadyPublished(job))throw new Error('This video is already uploaded; it will not be uploaded again.');
  if(job.retries?.publish?.kind==='attention')throw new Error('This upload needs reconciliation in YouTube first. Retry will not erase its session or receipt.');
  job.retries={};delete job.error;delete job.uploadError;
  if(job.status==='failed')job.status=job.outputDir?'rendering':job.topic?'scripted':'planned';
}
export function selectWorkerJobs(state,date,config) {
  const current=state.jobs.filter(job=>job.date===date&&job.slot!=='sample'&&!job.manualTest);
  const unfinished=state.jobs.filter(job=>job.date!==date&&!job.manualTest&&remainingUpload(job));
  return [...current,...unfinished].sort((a,b)=>(a.publishAt||'').localeCompare(b.publishAt||''));
}

export function relocatePaths(state,{baseDir,stateDir}) {
  let changes=0;
  for(const job of state.jobs) {
    if(job.outputDir) {
      const normalized=job.outputDir.replace(/\\/g,'/'),parts=normalized.split('/');
      const folder=parts.at(-1),date=parts.at(-2);
      if((date===job.date||date===job.originDate)&&parts.at(-3)==='daily'&&parts.at(-4)==='output'&&folder.startsWith(job.id+'-')&&/^[a-f0-9]{6}$/.test(folder.slice(job.id.length+1))) {
        const destination=path.join(baseDir,'output','daily',date,folder);
        if(job.outputDir!==destination){job.outputDir=destination;delete job.verifiedMtimeMs;changes++;}
      }
    }
    if(job.audioFiles)job.audioFiles=job.audioFiles.map(file=>{
      const name=file.replace(/\\/g,'/').split('/').at(-1);
      if(!/^[a-f0-9]{64}\.wav$/.test(name))return file;
      const destination=path.join(stateDir,'audio',name);if(destination!==file)changes++;return destination;
    });
  }
  return changes;
}
