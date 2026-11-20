import fs from 'node:fs/promises';
import path from 'node:path';
import {HERE,loadSettings} from './config.mjs';
import {openStore} from './store.mjs';
import {GitHubState} from './remote-state.mjs';
import {GeminiClient,redact} from './gemini.mjs';
import {createRequestGuard} from './budget.mjs';
import {localDate} from './schedule.mjs';
import {relocatePaths} from './reliability.mjs';
import {loadProject} from './model.mjs';
import {generateJob,artifactReady} from './production.mjs';
import {assertVerifiedTopic} from './verified-content.mjs';
import {checkSocial,runSocial,BufferClient} from './social.mjs';
import {checkConnection,publishJob,checkVideo} from './youtube.mjs';

// This entry point is deliberately separate from the recurring worker. A rerun
// reuses the GitHub run ID, durable intents and upload receipts for exactly one job.
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.USTAZON_MANUAL_TEST!=='true'||!/^\d+$/.test(process.env.GITHUB_RUN_ID||''))throw Error('Use the manual single-video GitHub workflow');
const {config,apiKey,socialCredentials}=await loadSettings();
if(!config.youtube.enabled||!config.buffer.enabled||config.content?.mode!=='verified')throw Error('Manual test requires verified content and all three connected channels');
const stateDir=path.join(HERE,'.state'),store=await openStore(stateDir),remote=new GitHubState();
const client=new BufferClient(socialCredentials.bufferToken);
let heartbeat,job,state;
const save=async()=>{store.assertOwner();store.save(state);await remote.checkpoint(store,state,HERE);};
const report=async()=>{
 const result={jobId:job.id,runId:process.env.GITHUB_RUN_ID,publishAt:job.publishAt,language:job.language,title:job.topic?.title,youtube:job.manualVerification?.youtube,
   instagram:job.social?.instagram,tiktok:job.social?.tiktok,socialErrors:job.socialErrors,error:job.manualError,confirmed:job.manualConfirmed===true};
 await fs.mkdir(path.join(HERE,'review'),{recursive:true});
 await fs.writeFile(path.join(HERE,'review','manual-test.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
};
try {
 store.acquire();heartbeat=setInterval(()=>store.heartbeat(),10000);state=store.load();
 relocatePaths(state,{baseDir:HERE,stateDir});
 const id='manual-'+process.env.GITHUB_RUN_ID+'-kk';
 job=state.jobs.find(j=>j.id===id);
 if(!job){job={id,date:localDate(new Date(),config.timezone),slot:'manual-test',manualTest:true,language:'kk',format:'quiz',status:'planned',socialEligible:true};state.jobs.push(job);}
 await save();
 console.log('Checking the three connected channels before generation');
 await checkSocial(config,socialCredentials,client);await checkConnection(config);await save();
 const hasReceipt=()=>Boolean(job.youtube?.videoId||job.youtube?.sessionUrl||job.youtube?.initiating||Object.values(job.social||{}).some(r=>r.intent||r.postId));
 if(!hasReceipt()) {
   const gemini=new GeminiClient({apiKey,retries:0,beforeRequest:createRequestGuard({state,config,save,assertOwner:()=>store.assertOwner()})});
   await generateJob({job,state,save,client:gemini,config,project:await loadProject(path.join(HERE,'catalog.json'),path.join(HERE,'theme.json')),knowledge:null,store});
   if(!await artifactReady(job))throw Error('Rendered video failed integrity check');
   job.publishAt=new Date(Date.now()+5*60000).toISOString();await save();
 }
 assertVerifiedTopic(job.voicedTopic||job.topic);
 await runSocial({state,date:job.date,config,credentials:socialCredentials,client,save,onlyJobId:job.id,claim:(...args)=>store.claim(...args),ready:artifactReady,validate:j=>assertVerifiedTopic(j.voicedTopic||j.topic)});
 try {
   await publishJob({job,config,save,mode:Date.parse(job.publishAt)>Date.now()+120000?'schedule':'now',reserve:async sha=>store.claim('video:'+config.youtube.expectedChannelId,sha,job.id)});
   if(job.youtube?.videoId)job.status='uploaded';
 }catch(error){job.manualError=redact(error.message,[apiKey,socialCredentials.bufferToken,socialCredentials.cloudSecret]);}
 await save();
 const deadline=Date.now()+15*60000;
 do {
   for(const platform of ['instagram','tiktok']){
     const receipt=job.social?.[platform];
     if(receipt?.postId)try{const post=await client.get(receipt.postId);Object.assign(receipt,{status:post.status,externalLink:post.externalLink,sentAt:post.sentAt});}catch{receipt.checkFailedAt=new Date().toISOString();}
   }
   if(job.youtube?.videoId)try{job.manualVerification||={};job.manualVerification.youtube=await checkVideo(config,job.youtube.videoId);}catch{job.manualVerification||={};job.manualVerification.youtubeCheckFailedAt=new Date().toISOString();}
   const youtube=job.manualVerification?.youtube;
   job.manualConfirmed=youtube?.privacyStatus==='public'&&youtube?.uploadStatus==='processed'&&['instagram','tiktok'].every(p=>job.social?.[p]?.status==='sent');
   await save();await report();
   if(job.manualConfirmed)break;
   const pending=['instagram','tiktok'].some(p=>job.social?.[p]?.postId&&!['sent','error','draft','attention'].includes(job.social[p].status))||job.youtube?.videoId&&(youtube?.privacyStatus!=='public'||youtube?.uploadStatus!=='processed');
   if(!pending)break;
   await new Promise(resolve=>setTimeout(resolve,30000));
 }while(Date.now()<deadline);
 if(!job.manualConfirmed)throw Error('Publication not confirmed on all three platforms; inspect manual-test.json. No posts were recreated.');
}catch(error){
 if(job){job.manualError=redact(error.message,[apiKey,socialCredentials.bufferToken,socialCredentials.cloudSecret]);await save();await report();}
 console.error('Manual test: '+redact(error.message,[apiKey,socialCredentials.bufferToken,socialCredentials.cloudSecret]));process.exitCode=1;
}finally{clearInterval(heartbeat);store.release();store.close();}
