import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {HERE} from './config.mjs';
import {readJSON,writeJSON} from './state.mjs';
import {fileDigest} from './maintenance.mjs';
import socialLinks,{withWebsite} from './social-links.mjs';

const SCOPES=['https://www.googleapis.com/auth/youtube.upload','https://www.googleapis.com/auth/youtube.readonly'];
const TOKEN='https://oauth2.googleapis.com/token';
function requireScopes(data) {
  const granted=new Set(String(data.scope||'').split(/\s+/));
  if(SCOPES.some(scope=>!granted.has(scope)))throw new Error('YouTube upload and channel-read permissions are both required. Reconnect with youtube-auth and allow both permissions.');
}
export function youtubeError(message,properties={}){return Object.assign(new Error(message),{name:'YouTubeError',...properties});}
function retryDelay(value){return value?(Number.isFinite(Number(value))?Number(value)*1000:Math.max(0,Date.parse(value)-Date.now())):0;}
async function request(url,options={},fetchImpl=fetch) {
  // YouTube uses HTTP 308 for upload progress. Return it to the uploader without
  // following redirects; redirect:'error' would reject this valid response.
  try {return await fetchImpl(url,{...options,redirect:'manual',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});}
  catch {options.signal?.throwIfAborted();throw youtubeError('YouTube connection interrupted. The existing upload session will be checked on retry.',{retryable:true});}
}
async function responseJSON(response,label) {
  const data=await response.json().catch(()=>null);
  if(!response.ok) {
    // Never include OAuth tokens, authorization codes, upload URLs or raw response bodies in logs.
    const code=String(data?.error?.errors?.[0]?.reason || data?.error?.status || (typeof data?.error==='string'?data.error:'')).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
    throw youtubeError(label+' HTTP '+response.status+(code?' ('+code+')':''),{status:response.status,reason:code,retryAfterMs:retryDelay(response.headers.get('retry-after'))});
  }
  return data;
}
async function clientSettings(config) {
  const data=await readJSON(path.resolve(HERE,config.youtube.clientFile),null);
  if(!data?.installed?.client_id)throw new Error('YouTube requires client_secrets.json from a Google OAuth Desktop app.');
  return data.installed;
}
function pinnedChannel(config) {
  if(!/^UC[A-Za-z0-9_-]{22}$/.test(config.youtube.expectedChannelId))throw new Error('Set youtube.expectedChannelId to your intended YouTube channel ID first.');
  return config.youtube.expectedChannelId;
}
export async function verifyChannel(token,expected,fetchImpl=fetch) {
  const response=await request('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',{headers:{Authorization:'Bearer '+token}},fetchImpl);
  const data=await responseJSON(response,'YouTube channel');
  if(data?.items?.length!==1 || data.items[0].id!==expected)throw new Error('The signed-in YouTube channel does not match expectedChannelId. Select the intended channel when connecting.');
  return {id:data.items[0].id,title:data.items[0].snippet?.title};
}
async function accessToken(config,{forceRefresh=false,fetchImpl=fetch}={}) {
  const tokenFile=path.resolve(HERE,config.youtube.tokenFile);
  const stored=await readJSON(tokenFile,null);
  if(!stored?.refresh_token)throw new Error('YouTube is not connected. Run node ustazon/daily.mjs youtube-auth.');
  if(stored.channelId!==pinnedChannel(config))throw new Error('Stored YouTube authorization belongs to a different channel.');
  requireScopes(stored);
  if(!forceRefresh && stored.access_token && stored.expiresAt>Date.now()+60000)return stored.access_token;
  const client=await clientSettings(config);
  const body=new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret||'',refresh_token:stored.refresh_token,grant_type:'refresh_token'});
  const response=await request(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body},fetchImpl);
  const data=await responseJSON(response,'Google token refresh');
  if(!data?.access_token)throw new Error('Google returned no access token');
  const updated={...stored,...data,expiresAt:Date.now()+Number(data.expires_in||3600)*1000};
  requireScopes(updated);
  await writeJSON(tokenFile,updated);return updated.access_token;
}
export async function checkConnection(config,{fetchImpl=fetch}={}) {
  const token=await accessToken(config,{forceRefresh:true,fetchImpl});
  const channel=await verifyChannel(token,pinnedChannel(config),fetchImpl);
  return {...channel,offlineAccess:true,refreshVerified:true};
}
export async function authorize(config) {
  const expected=pinnedChannel(config),client=await clientSettings(config);
  const verifier=randomBytes(48).toString('base64url'),state=randomBytes(24).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  let resolveCode,rejectCode;
  const codePromise=new Promise((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
  // Attach a rejection handler before waiting for browser input.
  codePromise.catch(()=>{});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method!=='GET'||url.pathname!=='/callback'){res.writeHead(404);res.end();return;}
    const supplied=Buffer.from(url.searchParams.get('state')||''),expectedState=Buffer.from(state);
    if(supplied.length!==expectedState.length || !timingSafeEqual(supplied,expectedState)){res.writeHead(400);res.end('Invalid OAuth state.');return;}
    if(url.searchParams.has('error')){res.writeHead(400);res.end('Connection was not authorized.');rejectCode(new Error('YouTube authorization was declined.'));return;}
    const code=url.searchParams.get('code');
    if(!code){res.writeHead(400);res.end('Missing code.');return;}
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
    res.end('Authorization received. You may close this tab and check the bot terminal.');resolveCode(code);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const redirect='http://127.0.0.1:'+server.address().port+'/callback';
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:SCOPES.join(' '),
    access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
  console.log('Open this link in your browser and choose the intended YouTube channel:\n'+url);
  const timeout=setTimeout(()=>rejectCode(new Error('YouTube connection timed out. Run youtube-auth again.')),600000);
  try {
    const code=await codePromise;
    const response=await request(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret||'',code,code_verifier:verifier,redirect_uri:redirect,grant_type:'authorization_code'})});
    const data=await responseJSON(response,'Google authorization');
    if(!data?.refresh_token||!data.access_token)throw new Error('Google did not grant offline access. Reconnect and allow the requested access.');
    requireScopes(data);
    const channel=await verifyChannel(data.access_token,expected);
    await writeJSON(path.resolve(HERE,config.youtube.tokenFile),{...data,channelId:channel.id,expiresAt:Date.now()+Number(data.expires_in||3600)*1000});
    console.log('Connected: '+channel.title+' ('+channel.id+'). Set youtube.enabled=true when you want scheduled publishing.');
  } finally {clearTimeout(timeout);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
export function uploadURL(value) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='www.googleapis.com'||url.port||url.username||url.password||url.pathname!=='/upload/youtube/v3/videos')throw new Error('Untrusted YouTube upload session URL');
  return url.toString();
}
export function uploadMetadata(info,publishAt,mode,now=new Date()) {
  if(info.status!=='complete'||info.draft)throw new Error('Only a completed production video can be uploaded');
  if(!['kk','ru'].includes(info.language))throw new Error('Video language is missing');
  const heading=info.language==='ru'?'Мы также здесь:':'Біз басқа желілерде:';
  const description=[withWebsite(info.description),[heading,'TikTok: '+socialLinks.tiktok,'Instagram: '+socialLinks.instagram].join('\n')].filter(Boolean).join('\n\n');
  if(!info.title||info.title.length>100||description.length>5000)throw new Error('Invalid video metadata');
  const status={privacyStatus:'public',selfDeclaredMadeForKids:false};
  if(mode==='schedule') {
    if(Date.parse(publishAt)<=now.getTime()+120000)throw new Error('Scheduled publication must be more than two minutes in the future');
    status.privacyStatus='private';status.publishAt=publishAt;
  }else if(mode!=='now')throw new Error('Invalid publication mode');
  return {snippet:{title:info.title,description,tags:[...(info.tags||[]),'ustazon_job_'+createHash('sha256').update(info.topicId||info.title).digest('hex').slice(0,20)],categoryId:info.categoryId||'27',
    defaultLanguage:info.language,defaultAudioLanguage:info.language},status};
}
export async function resumableUpload({file,body,record,save,token,fetchImpl=fetch,reserve=async()=>{},reconcileOnly=false,signal}) {
  if(record.videoId)return record.videoId;
  signal?.throwIfAborted();
  const stat=await fs.stat(file).catch(e=>{if(e.code==='ENOENT'&&record.sessionUrl)return null;throw e;});
  const size=record.size||stat?.size;
  if(!size)throw new Error('Video is empty or missing');
  let sha256=record.sha256;
  if(stat&&!reconcileOnly) {
    sha256=await fileDigest(file);
    if(record.sha256&&(record.sha256!==sha256||record.size!==stat.size))throw new Error('Video changed after upload started; do not reuse this session');
  }
  if(!record.sessionUrl) {
    if(record.initiating)throw youtubeError('Previous upload initiation has an uncertain outcome. Review the channel before any new upload.',{code:'UPLOAD_UNCERTAIN'});
    if(reconcileOnly)throw youtubeError('Publication time has passed; only an existing upload can be reconciled.',{code:'PUBLICATION_MISSED'});
    await reserve(sha256);
    record.sha256=sha256;record.size=size;record.initiating=true;await save();
    const response=await request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false',
      {method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Upload-Content-Type':'video/mp4','X-Upload-Content-Length':String(size)},body:JSON.stringify(body),signal},fetchImpl);
    if(!response.ok) {
      // A rejected initiation never sends any video bytes.
      record.initiating=false;await save();await responseJSON(response,'YouTube upload initiation');
    }
    record.sessionUrl=uploadURL(response.headers.get('location')||'');
    record.initiating=false;record.requestedStatus=body.status;await save();
  }else if(sha256) {await reserve(sha256);record.sha256=sha256;record.size=size;await save();}
  const session=uploadURL(record.sessionUrl);
  const headers={Authorization:'Bearer '+token,'Content-Type':'video/mp4'};
  const accept=async response=>{
    if(response.status===200||response.status===201) {
      const data=await responseJSON(response,'YouTube upload');
      if(!/^[A-Za-z0-9_-]{11}$/.test(data?.id||''))throw youtubeError('Completion lacks a video ID; keep the existing session.',{code:'UPLOAD_UNCERTAIN'});
      record.videoId=data.id;record.offset=size;record.resultStatus=data.status||null;record.completedAt=new Date().toISOString();await save();return {complete:true,offset:size};
    }
    if(response.status===308) {
      const range=response.headers.get('range'),match=range?/^bytes=0-(\d+)$/.exec(range):null;
      if(range&&!match)throw new Error('Invalid resumable upload offset');
      const offset=match?Number(match[1])+1:0;
      if(offset>size)throw new Error('Upload offset exceeds the video size');
      record.offset=offset;await save();
      const retryAfterMs=retryDelay(response.headers.get('retry-after'));
      if(retryAfterMs>0)throw youtubeError('YouTube asked to resume the upload later.',{status:503,retryAfterMs});
      return {complete:false,offset};
    }
    if(response.status===404||response.status===410)throw youtubeError('Upload session expired. Review YouTube Studio before starting another upload.',{code:'UPLOAD_EXPIRED',status:response.status});
    await responseJSON(response,'YouTube upload');throw new Error('Unexpected upload response');
  };
  let status=await accept(await request(session,{method:'PUT',headers:{...headers,'Content-Length':'0','Content-Range':'bytes */'+size},signal},fetchImpl));
  if(status.complete)return record.videoId;
  if(reconcileOnly)throw youtubeError('This late upload is incomplete. No additional bytes were sent; review it in YouTube Studio.',{code:'PUBLICATION_MISSED'});
  if(!stat)throw new Error('Local video is missing; incomplete upload was preserved.');
  const handle=await fs.open(file,'r'),chunkSize=8*1024*1024;
  try {
    while(status.offset<size) {
      signal?.throwIfAborted();
      const length=Math.min(chunkSize,size-status.offset),buffer=Buffer.allocUnsafe(length);
      const {bytesRead}=await handle.read(buffer,0,length,status.offset);
      if(bytesRead!==length)throw new Error('Could not read the complete upload chunk');
      const response=await request(session,{method:'PUT',headers:{...headers,'Content-Length':String(length),
        'Content-Range':'bytes '+status.offset+'-'+(status.offset+length-1)+'/'+size},body:buffer,signal},fetchImpl);
      const previous=status.offset;status=await accept(response);
      if(status.complete)return record.videoId;
      if(status.offset<=previous)throw new Error('Upload made no progress. Resume the existing session later.');
    }
  }finally{await handle.close();}
  throw youtubeError('All bytes received but completion is unconfirmed. Keep the existing session.',{code:'UPLOAD_UNCERTAIN'});
}
export async function publishJob({job,config,save,mode,reserve=async()=>{},signal}) {
  if(!config.youtube.enabled)throw new Error('YouTube publishing is disabled');
  if(job.draft||job.slot==='sample')throw new Error('Samples and drafts are not published');
  if(job.youtube?.videoId)return job.youtube.videoId;
  const expected=pinnedChannel(config);
  const late=Date.parse(job.publishAt)<Date.now()-config.maxLatenessMinutes*60000;
  if(!job.publishAt||late&&!job.youtube?.sessionUrl&&!job.youtube?.initiating)throw youtubeError('Publication slot has passed',{code:'PUBLICATION_MISSED'});
  const token=await accessToken(config);await verifyChannel(token,expected);
  const info=await readJSON(path.join(job.outputDir,'metadata.json'),null);
  job.youtube ||= {};
  if(job.youtube.channelId&&job.youtube.channelId!==expected)throw new Error('Existing upload targets another channel');
  job.youtube.channelId=expected;await save();
  const body=job.youtube.sessionUrl||job.youtube.initiating?{status:job.youtube.requestedStatus}:uploadMetadata(info,job.publishAt,mode);
  try {
    const videoId=await resumableUpload({file:path.join(job.outputDir,'video.mp4'),body,record:job.youtube,save,token,reserve,signal,reconcileOnly:late||mode==='reconcile'});
    job.publication=job.youtube.resultStatus?.publishAt?'scheduled':job.youtube.resultStatus?.privacyStatus||'uploaded';
    return videoId;
  }catch(error) {
    if(error.status===401) {
      const tokenFile=path.resolve(HERE,config.youtube.tokenFile),cached=await readJSON(tokenFile,null);
      if(cached){cached.expiresAt=0;await writeJSON(tokenFile,cached);}
      error.status=0;error.message='YouTube access token needs refreshing; the upload session was preserved.';
    }
    throw error;
  }
}
