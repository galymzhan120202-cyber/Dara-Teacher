import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HERE} from './config.mjs';
import {openStore} from './store.mjs';
import {readJSON,writeJSON} from './state.mjs';
import {logEvent} from './maintenance.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stopped(file){return fs.access(file).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;});}
export async function supervise({stateDir=path.join(HERE,'.state'),workerFile=path.join(HERE,'daily.mjs'),
  restartMs=5000,maxRestartMs=60000,monitorMs=1000,staleMs=15*60000,graceMs=20000,signal,stdio='inherit',onStart=()=>{}}={}) {
  const store=await openStore(stateDir),stopFile=path.join(stateDir,'STOP'),statusFile=path.join(stateDir,'supervisor.json');
  let owns=false,child,stopping=false,restarts=0,delay=restartMs;
  const requestStop=()=>{stopping=true;void fs.writeFile(stopFile,'stop\n').catch(()=>{});};
  signal?.addEventListener('abort',requestStop,{once:true});
  try {
    store.acquire('supervisor');owns=true;
    if(signal?.aborted)return;
    await fs.unlink(stopFile).catch(e=>{if(e.code!=='ENOENT')throw e;});
    while(!stopping) {
      const started=Date.now();let lastLeaseBeat=0,monitorBusy=false,stopRequestedAt=0,watchdog=false;
      await writeJSON(statusFile,{status:'starting',pid:process.pid,restarts,updatedAt:new Date().toISOString()});
      child=spawn(process.execPath,[workerFile,'worker'],{cwd:path.dirname(HERE),windowsHide:true,stdio});
      const active=child;onStart(child);
      const completion=new Promise(resolve=>{
        child.once('error',error=>resolve({code:null,error:error.message}));
        child.once('close',code=>resolve({code}));
      });
      await writeJSON(statusFile,{status:'running',pid:process.pid,workerPid:child.pid,restarts,updatedAt:new Date().toISOString()});
      const monitor=setInterval(async()=>{
        if(monitorBusy)return;monitorBusy=true;
        try {
          if(Date.now()-lastLeaseBeat>10000){store.heartbeat('supervisor');lastLeaseBeat=Date.now();}
          if(await stopped(stopFile))stopping=true;
          const health=await readJSON(path.join(stateDir,'health.json'),null).catch(()=>null);
          const lastBeat=health?.pid===active.pid?Date.parse(health.heartbeat):started;
          if(!stopping&&Date.now()-lastBeat>staleMs){watchdog=true;stopping=false;await fs.writeFile(stopFile,'restart\n');stopRequestedAt ||= Date.now();}
          if(stopping||watchdog) {
            stopRequestedAt ||= Date.now();
            // Give the worker time to abort HTTP/FFmpeg and checkpoint before terminating our own child.
            if(Date.now()-stopRequestedAt>graceMs&&active.exitCode===null)active.kill();
          }
        }catch(error){await logEvent(stateDir,'supervisor-monitor-error',{error:error.message}).catch(()=>{});}
        finally{monitorBusy=false;}
      },monitorMs);
      const result=await completion;clearInterval(monitor);
      while(monitorBusy)await sleep(10);
      child=null;
      if(watchdog) {const requested=await fs.readFile(stopFile,'utf8').catch(()=> '');if(requested.trim()==='stop')stopping=true;else{stopping=false;await fs.unlink(stopFile).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
      if(stopping||signal?.aborted||await stopped(stopFile))break;
      restarts++;
      await logEvent(stateDir,'worker-restart',{code:result.code,error:result.error,restarts,watchdog}).catch(()=>{});
      if(Date.now()-started>5*60000)delay=restartMs;else delay=Math.min(maxRestartMs,delay*2);
      const until=Date.now()+delay;
      while(Date.now()<until&&!stopping) {if(await stopped(stopFile)){stopping=true;break;}await sleep(Math.min(500,Math.max(1,until-Date.now())));}
    }
  }finally {
    signal?.removeEventListener('abort',requestStop);
    if(child&&child.exitCode===null){await fs.writeFile(stopFile,'stop\n').catch(()=>{});child.kill();}
    if(owns){await writeJSON(statusFile,{status:'stopped',pid:process.pid,restarts,updatedAt:new Date().toISOString()}).catch(()=>{});store.release('supervisor');}
    store.close();
  }
}
async function main() {
  const stateDir=path.join(HERE,'.state');
  if(process.argv[2]==='stop'){await fs.mkdir(stateDir,{recursive:true});await fs.writeFile(path.join(stateDir,'STOP'),'stop\n');console.log('Stop requested. The worker will save progress and stop.');return;}
  if(process.argv[2]&&process.argv[2]!=='start')throw new Error('Use start or stop');
  const controller=new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{await supervise({signal:controller.signal});}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Ustazon supervisor: '+error.message);process.exitCode=1;});
