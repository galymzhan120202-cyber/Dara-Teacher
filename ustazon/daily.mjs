import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {HERE,loadSettings} from './config.mjs';
import {GeminiClient,redact} from './gemini.mjs';
import {createRequestGuard,budgetReport} from './budget.mjs';
import {preparedNarrationStatus} from './prepared-audio.mjs';
import {readJSON} from './state.mjs';
import {openStore,processAlive} from './store.mjs';
import {localDate,planDay,validateDate} from './schedule.mjs';
import {runtime,retryJob,remainingUpload,relocatePaths} from './reliability.mjs';
import {loadProject} from './model.mjs';
import {generateJob,artifactReady,reserveContent,refreshVerifiedJob} from './production.mjs';
import {contentInventory,assertVerifiedTopic} from './verified-content.mjs';
import {runCycle} from './runner.mjs';
import {checkSocial,runSocial} from './social.mjs';
import {requireDisk,maintain,healthSnapshot,logEvent} from './maintenance.mjs';
export {generateJob} from './production.mjs';

const STATE_DIR=path.join(HERE,'.state');
const HELP='Ustazon reliable daily bot\n\n'+
'node ustazon/daily.mjs probe\n'+
'node ustazon/daily.mjs budget\n'+
'node ustazon/daily.mjs plan [--date YYYY-MM-DD]\n'+
'node ustazon/daily.mjs generate [--date YYYY-MM-DD] [--draft] [--only morning]\n'+
'node ustazon/daily.mjs sample --language kk|ru --format tip|material|quiz [--draft]\n'+
'node ustazon/daily.mjs status\n'+
'node ustazon/daily.mjs health\n'+
'node ustazon/daily.mjs retry --job JOB_ID\n'+
'node ustazon/daily.mjs worker [--once]\n'+
'node ustazon/daily.mjs youtube-auth\n'+
'node ustazon/daily.mjs youtube-check\n'+
'node ustazon/daily.mjs publish [--date YYYY-MM-DD]\n\n'+
'generate creates local MP4 only. YouTube must be linked and enabled to publish.\n';
export function parseOptions(argv) {
  const result={command:argv.shift()||'status'};
  if(!['probe','budget','plan','generate','sample','status','health','retry','worker','publish','youtube-auth','youtube-check','social-check','help'].includes(result.command))throw new Error('Unknown command');
  while(argv.length) {
    const arg=argv.shift();
    if(['--draft','--once','--help'].includes(arg))result[arg.slice(2)]=true;
    else if(['--date','--only','--language','--format','--job'].includes(arg)) {
      const value=argv.shift();if(!value||value.startsWith('--'))throw new Error('Missing '+arg);
      result[arg.slice(2)]=value;
    }else throw new Error('Unknown option: '+arg);
  }
  if(result.date)validateDate(result.date);
  if(result.language&&!['kk','ru'].includes(result.language))throw new Error('Language must be kk or ru');
  if(result.format&&!['tip','material','quiz'].includes(result.format))throw new Error('Unknown format');
  if((result.language||result.format)&&result.command!=='sample')throw new Error('Use --language and --format with sample; daily languages are set in automation.json.');
  if(result.command==='retry'&&!result.job)throw new Error('retry requires --job JOB_ID');
  if(result.command==='worker'&&result.draft)throw new Error('Use generate --draft for previews; the worker creates production videos.');
  return result;
}
async function legacyLockCheck() {
  const old=await readJSON(path.join(STATE_DIR,'daily.lock'),null);
  if(old&&(!old.pid||processAlive(old.pid)))throw new Error('An older bot process still owns daily.lock. Stop it before using the new worker.');
}
export async function execute(opts,{config,apiKey,socialCredentials},{signal}={}) {
  const stopped=()=>fs.access(path.join(STATE_DIR,'STOP')).then(()=>true,()=>false);
  if(['worker','publish'].includes(opts.command)&&await stopped())throw new Error('Bot is paused: STOP exists');
  await legacyLockCheck();
  const remote=process.env.USTAZON_REMOTE_STATE==='true'?new (await import('./remote-state.mjs')).GitHubState():null;
  const store=await openStore(STATE_DIR);
  let heartbeat,ticking=false,phase='idle',currentJob=null;
  const state=store.load(),save=async()=>{store.save(state);if(remote)await remote.checkpoint(store,state,HERE);};
  const log=async(event,details)=>{await logEvent(STATE_DIR,event,details,[apiKey],config).catch(()=>{});};
  try {
    if(opts.command==='budget'){console.log(JSON.stringify(budgetReport(config,state,new Date(),await preparedNarrationStatus(config)),null,2));return;}
    if(['status','health'].includes(opts.command)) {
      const worker=await readJSON(path.join(STATE_DIR,'health.json'),null);
      if(worker)worker.running=processAlive(worker.pid)&&Date.now()-Date.parse(worker.heartbeat)<Math.max(120,runtime(config).pollSeconds*3)*1000;
      console.log(JSON.stringify({timezone:config.timezone,youtubeEnabled:config.youtube.enabled,bufferEnabled:config.buffer?.enabled,database:store.stats(),
        contentInventory:contentInventory(state.jobs),
        requestsToday:state.requests[localDate(new Date(),config.timezone)]||0,requestLimit:config.gemini.maxDailyRequests,
        geminiBudget:budgetReport(config,state,new Date(),await preparedNarrationStatus(config)),
        jobs:state.jobs.slice(-30).map(j=>({id:j.id,date:j.date,language:j.language,publishAt:j.publishAt,status:j.status,publication:j.publication,videoId:j.youtube?.videoId,
          social:j.social,socialErrors:j.socialErrors,error:j.error||j.uploadError,nextAttempt:j.retries?.generate?.nextAt||j.retries?.publish?.nextAt,attention:Object.values(j.retries||{}).some(r=>r.kind==='attention')})),
        worker},null,2));return;
    }
    store.acquire();
    Object.assign(state,store.load()); // Reload under the lock; never overwrite a newer upload checkpoint.
    if(relocatePaths(state,{baseDir:HERE,stateDir:STATE_DIR}))await save();
    if(opts.command==='retry') {
      const job=state.jobs.find(j=>j.id===opts.job);if(!job)throw new Error('Unknown job');
      retryJob(job);state.controls={};await save();console.log('Queued again: '+job.id+'. Existing upload receipts and sessions were preserved.');return;
    }
    const date=opts.date||localDate(new Date(),config.timezone);
    if(opts.command==='plan') {const jobs=planDay(state,date,config);await save();for(const j of jobs)console.log(JSON.stringify({id:j.id,format:j.format,language:j.language,publishAt:j.publishAt,status:j.status}));return;}
    phase='working';
    const beat=async()=>{
      if(ticking)return;ticking=true;
      try{store.heartbeat();await healthSnapshot({stateDir:STATE_DIR,state,config,phase,currentJob});}catch{}finally{ticking=false;}
    };
    await beat();heartbeat=setInterval(()=>{void beat();},10000);
    let client,project,knowledge;
    const getClient=()=>{
      if(!client)client=new GeminiClient({apiKey,signal,beforeRequest:createRequestGuard({state,config,save,assertOwner:()=>store.assertOwner(),signal})});
      return client;
    };
    const proxyClient={generateJSON:args=>getClient().generateJSON(args),speech:args=>getClient().speech(args)};
    const generate=async job=>{
      currentJob=job.id;phase='generating';await beat();
      project ||= await loadProject(path.join(HERE,'catalog.json'),path.join(HERE,'theme.json'));
      knowledge ||= await readJSON(path.join(HERE,'knowledge.json'),null);
      await generateJob({job,state,save,client:proxyClient,config,project,knowledge,draft:Boolean(opts.draft),store,signal,
        log:message=>console.log(message)});
    };
    const publish=async(job,mode)=>{
      currentJob=job.id;phase='publishing';await beat();
      if(config.content?.mode==='verified')assertVerifiedTopic(job.voicedTopic||job.topic);
      reserveContent(store,job,job.topic);
      const {publishJob}=await import('./youtube.mjs');
      await publishJob({job,config,save,mode,signal,reserve:async sha=>store.claim('video:'+config.youtube.expectedChannelId,sha,job.id)});
    };
    for(const job of state.jobs)if(refreshVerifiedJob(job,config))await save();
    // Files can be removed or modified between runs; repair them before any new upload.
    for(const job of state.jobs.filter(j=>j.date===date&&j.status==='ready'&&!remainingUpload(j)&&!j.youtube?.videoId)) {
      if(!await artifactReady(job)){job.status='rendering';await save();}
    }
    let result;
    if(opts.command==='sample') {
      const job={id:date+'-sample-'+(opts.language||'kk')+'-'+randomUUID().replace(/-/g,'').slice(0,8),
        date,slot:'sample',language:opts.language||'kk',format:opts.format||'tip',status:'planned'};
      state.jobs.push(job);await save();
      await requireDisk(HERE,config);
      try{await generate(job);}
      catch(error){job.status='failed';job.error=redact(error.message,[apiKey]);await save();throw error;}
      result={selected:[job],changed:true};
    }else result=await runCycle({state,config,apiKey,command:opts.command,date,only:opts.only,draft:Boolean(opts.draft),save,generate,publish,
      preflight:()=>requireDisk(HERE,config),log,signal});
    phase='idle';currentJob=null;
    if(['worker','publish'].includes(opts.command)&&!signal?.aborted)await runSocial({state,date,config,credentials:socialCredentials,save,claim:(...args)=>store.claim(...args),ready:artifactReady,validate:job=>{if(config.content?.mode==='verified')assertVerifiedTopic(job.voicedTopic||job.topic);},stopped:async()=>signal?.aborted||await stopped()});
    if(!signal?.aborted) {
      try{const maintenance=await maintain({store,state,stateDir:STATE_DIR,config,date:localDate(new Date(),config.timezone)});if(!maintenance.skipped)await save();}
      catch(error){await log('maintenance-failed',{error:redact(error.message,[apiKey])});}
    }
    await beat();
    if(result.changed||opts.command!=='worker')for(const job of result.selected)console.log(job.id+' => '+job.status+(job.outputDir?' | '+job.outputDir:'')+(job.error||job.uploadError?' | '+(job.error||job.uploadError):''));
    return result;
  }catch(error) {
    await log('cycle-failed',{error:redact(error.message,[apiKey])});
    if(error.code!=='BOT_BUSY')await healthSnapshot({stateDir:STATE_DIR,state,config,phase:'error',error:redact(error.message,[apiKey]),currentJob}).catch(()=>{});
    throw error;
  }finally {
    clearInterval(heartbeat);
    // Finish an in-flight heartbeat before closing its database connection.
    while(ticking)await new Promise(resolve=>setTimeout(resolve,10));
    try{store.release();}finally{store.close();}
  }
}
function sleep(ms,signal) {
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
  });
}
export async function main(argv=process.argv.slice(2)) {
  const opts=parseOptions([...argv]);if(opts.help||opts.command==='help'){console.log(HELP);return;}
  let settings=await loadSettings();
  if(opts.command==='social-check'){console.log(JSON.stringify(await checkSocial(settings.config,settings.socialCredentials),null,2));return;}
  if(opts.command==='probe') {
    const client=new GeminiClient({apiKey:settings.apiKey,retries:0}),models=await client.models();
    for(const model of [settings.config.gemini.model,settings.config.gemini.ttsModel]){if(!models.includes(model))throw new Error('Model is not listed: '+model);console.log('Listed model: '+model);}
    console.log('API connection OK. Generation quotas are checked when used.');return;
  }
  if(opts.command==='youtube-auth'){const {authorize}=await import('./youtube.mjs');await authorize(settings.config);return;}
  if(opts.command==='youtube-check'){const {checkConnection}=await import('./youtube.mjs');console.log(JSON.stringify(await checkConnection(settings.config),null,2));return;}
  const controller=new AbortController(),stop=()=>controller.abort();
  let stopPoll;
  if(opts.command==='worker')stopPoll=setInterval(()=>{fs.access(path.join(STATE_DIR,'STOP')).then(stop).catch(()=>{});},1000);
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    if(opts.command==='worker'&&!opts.once) {
      console.log('Worker started. Queue and publication receipts are durable. Ctrl+C stops safely.');
      while(!controller.signal.aborted) {
        try{settings=await loadSettings();await execute(opts,settings,{signal:controller.signal});}
        catch(error){if(!controller.signal.aborted)console.error('Ustazon: '+redact(error.message,[settings.apiKey]));}
        if(process.memoryUsage().rss>1024*1024*1024){console.log('Recycling worker between cycles to release memory.');return;}
        await sleep(runtime(settings.config).pollSeconds*1000,controller.signal);
      }
    }else {
      const result=await execute(opts,settings,{signal:controller.signal});
      if(result?.selected.some(j=>j.status==='failed'||j.uploadError))process.exitCode=1;
    }
  }finally{clearInterval(stopPoll);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(async error=>{
  const {apiKey}=await loadSettings().catch(()=>({apiKey:''}));console.error('Ustazon: '+redact(error.message,[apiKey]));process.exitCode=1;
});
