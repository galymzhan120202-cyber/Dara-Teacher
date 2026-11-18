import {createHash} from 'node:crypto';
import {localDate,planDay,publicationDecision} from './schedule.mjs';
import {runtime,configIdentity,eligible,stageBlocked,recordFailure,clearFailure,alreadyPublished,remainingUpload,selectWorkerJobs} from './reliability.mjs';
import {redact} from './gemini.mjs';

// All external effects are injectable: the same state machine is tested across hundreds of simulated days.
export async function runCycle({state,config,apiKey='',command='worker',date,only=null,draft=false,save,
  generate,publish,preflight=async()=>{},log=async()=>{},now=()=>new Date(),signal}) {
  const currentDate=date||localDate(now(),config.timezone),identity=configIdentity(config,apiKey);
  let changed=false;
  const beforePlan=JSON.stringify(state.jobs.map(j=>[j.id,j.date,j.slot,j.publishAt]));
  const dayJobs=planDay(state,currentDate,config);
  if(JSON.stringify(state.jobs.map(j=>[j.id,j.date,j.slot,j.publishAt]))!==beforePlan){await save();changed=true;}
  const selected=(command==='worker'?selectWorkerJobs(state,currentDate,config):dayJobs).filter(j=>!j.superseded&&(!only||j.slot===only));
  if(only&&!selected.length)throw new Error('No matching daily slot: '+only);
  for(const job of selected) {
    if(signal?.aborted)break;
    if(alreadyPublished(job)){if(job.status!=='uploaded'){job.status='uploaded';await save();}continue;}
    const late=job.publishAt&&+now()-Date.parse(job.publishAt)>config.maxLatenessMinutes*60000;
    if(command==='worker'&&config.youtube.enabled&&late&&!remainingUpload(job)) {
      if(job.publication!=='missed'){job.publication='missed';if(!job.outputDir)job.status='expired';await save();changed=true;}
      continue;
    }
    if(command!=='publish'&&!remainingUpload(job)&&!(job.status==='ready'&&(!job.draft||draft))) {
      if(!eligible(job,'generate',config,now(),identity)||stageBlocked(state,'generate',identity,now()))continue;
      try {
        await preflight(job);
        signal?.throwIfAborted();
        await generate(job);
        clearFailure(state,job,'generate');
        job.status='ready';await save();changed=true;
        await log('video-ready',{id:job.id});
      }catch(error) {
        if(signal?.aborted)break;
        job.status='failed';job.error=redact(error.message,[apiKey]);
        const retry=recordFailure(state,job,'generate',error,config,identity,now());
        await save();changed=true;
        await log('generation-failed',{id:job.id,error:job.error,nextAt:retry.nextAt,kind:retry.kind});
        continue;
      }
    }
    if(!['worker','publish'].includes(command)||job.slot==='sample'||job.draft||(!['ready','uploaded'].includes(job.status)&&!remainingUpload(job)))continue;
    if(!eligible(job,'publish',config,now(),identity)||stageBlocked(state,'publish',identity,now()))continue;
    const decision=publicationDecision(job,config,now());
    if(['disabled','uploaded','wait'].includes(decision))continue;
    if(decision==='missed'){if(job.publication!=='missed'){job.publication='missed';await save();changed=true;}continue;}
    try {
      signal?.throwIfAborted();
      await publish(job,decision);
      if(job.youtube?.videoId){job.status='uploaded';clearFailure(state,job,'publish');}
      await save();changed=true;await log('upload-confirmed',{id:job.id,videoId:job.youtube?.videoId});
    }catch(error) {
      if(signal?.aborted)break;
      job.uploadError=redact(error.message,[apiKey]);
      const retry=recordFailure(state,job,'publish',error,config,identity,now());
      await save();changed=true;
      await log('upload-failed',{id:job.id,error:job.uploadError,nextAt:retry.nextAt,kind:retry.kind});
    }
  }
  return {selected,changed};
}
