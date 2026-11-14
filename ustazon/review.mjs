import fs from 'node:fs/promises';
import path from 'node:path';
import {HERE,loadSettings} from './config.mjs';
import {openStore} from './store.mjs';
import {contentInventory} from './verified-content.mjs';
const store=await openStore(path.join(HERE,'.state'));
try {
  const state=store.load(),{config}=await loadSettings(),directory=path.join(HERE,'review');
  await fs.mkdir(directory,{recursive:true});
  const ready=state.jobs.filter(j=>j.outputDir&&['ready','uploaded'].includes(j.status)).sort((a,b)=>(b.completedAt||'').localeCompare(a.completedAt||'')).slice(0,3);
  for(const job of ready)for(const name of ['video.mp4','storyboard.png','captions.srt','narration.txt','metadata.json']) {
    const source=path.join(job.outputDir,name),dest=path.join(directory,job.id,name);await fs.mkdir(path.dirname(dest),{recursive:true});
    await fs.copyFile(source,dest).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
  const report={createdAt:new Date().toISOString(),youtubeEnabled:config.youtube.enabled,content:contentInventory(state.jobs),jobs:state.jobs.slice(-30).map(j=>({id:j.id,date:j.date,status:j.status,story:j.topic?.storyId,language:j.language,error:j.error,videoId:j.youtube?.videoId}))};
  await fs.writeFile(path.join(directory,'status.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Prepared '+ready.length+' recent videos; no OAuth credentials or upload sessions included.');
}finally{store.close();}
