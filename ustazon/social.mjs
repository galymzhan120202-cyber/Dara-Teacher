import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import socialLinks from './social-links.json' with {type:'json'};

const fields='id channelId status text dueAt externalLink sentAt schedulingType';
export class BufferClient {
  constructor(token,fetcher=fetch){this.token=token;this.fetcher=fetcher;}
  async query(query,variables={}) {
    if(!this.token)throw new Error('BUFFER_API_TOKEN is missing');
    // Mutations are deliberately never retried: a lost response may still mean success.
    const response=await this.fetcher('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error('Buffer HTTP '+response.status);
    const result=await response.json();
    if(result.errors?.length)throw new Error('Buffer rejected GraphQL request');
    return result.data;
  }
  async channels(){return (await this.query('{account {organizations {id name}}}')).account.organizations;}
  async channel(id){return (await this.query('query($input:ChannelInput!){channel(input:$input){id name service organizationId isDisconnected isLocked isQueuePaused}}',{input:{id}})).channel;}
  async get(id){return (await this.query(`query($input:PostInput!){post(input:$input){${fields}}}`,{input:{id}})).post;}
  async create(input){
    const result=(await this.query(`mutation($input:CreatePostInput!){createPost(input:$input){__typename ... on PostActionSuccess {post {${fields}}} ... on MutationError {message}}}`,{input})).createPost;
    if(!result.post)throw new Error('Buffer createPost rejected: '+result.__typename);
    return result.post;
  }
}

export function uploadSignature(params,secret){return createHash('sha1').update(Object.keys(params).sort().map(k=>k+'='+params[k]).join('&')+secret).digest('hex');}
export async function uploadVideo(file,credentials,{fetcher=fetch,expectedHash}={}) {
  const {cloudName,cloudKey,cloudSecret}=credentials;
  if(!/^[a-z0-9_-]+$/i.test(cloudName||'')||!cloudKey||!cloudSecret)throw new Error('Cloudinary credentials are missing');
  const bytes=await fs.readFile(file),sha256=createHash('sha256').update(bytes).digest('hex');
  if(expectedHash&&expectedHash!==sha256)throw new Error('Video checksum mismatch');
  if(bytes.length>100*1024*1024)throw new Error('Video exceeds the configured 100 MB limit');
  const publicId='ustazon/'+sha256;
  const params={public_id:publicId,timestamp:String(Math.floor(Date.now()/1000)),overwrite:'false'};
  const body=new FormData();for(const [key,value] of Object.entries(params))body.set(key,value);
  body.set('api_key',cloudKey);body.set('signature',uploadSignature(params,cloudSecret));body.set('file',new Blob([bytes],{type:'video/mp4'}),'video.mp4');
  const response=await fetcher('https://api.cloudinary.com/v1_1/'+cloudName+'/video/upload',{method:'POST',body,signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error('Cloudinary upload HTTP '+response.status);
  const result=await response.json();
  if(result.public_id!==publicId||!result.secure_url?.startsWith('https://res.cloudinary.com/'+cloudName+'/video/upload/'))throw new Error('Unexpected Cloudinary upload receipt');
  return {url:result.secure_url,publicId,sha256,bytes:bytes.length};
}

export function postInput(job,platform,channelId,url,{draft=false}={}) {
  if(!['instagram','tiktok'].includes(platform))throw new Error('Unsupported platform');
  if(!url?.startsWith('https://res.cloudinary.com/'))throw new Error('Verified HTTPS media URL required');
  const topic=job.voicedTopic||job.topic;
  const other=platform==='tiktok'?'instagram':'tiktok';
  const heading=(job.language||topic.language)==='ru'?'Мы также здесь:':'Біз басқа желілерде:';
  const links=[heading,(other==='instagram'?'Instagram':'TikTok')+': '+socialLinks[other],'YouTube: '+socialLinks.youtube].join('\n');
  const text=[topic.title,topic.description,links].filter(Boolean).join('\n\n');
  if(!text||text.length>2200)throw new Error('Invalid social caption');
  return {channelId,text,assets:[{video:{url}}],schedulingType:'automatic',mode:'customScheduled',dueAt:job.publishAt,saveToDraft:draft,aiAssisted:true,
    metadata:platform==='instagram'?{instagram:{type:'reel',shouldShareToFeed:true,isAiGenerated:true}}:{tiktok:{isAiGenerated:true}},source:'ustazon'};
}

export async function checkSocial(config,credentials,client=new BufferClient(credentials.bufferToken)) {
  const channels=[];
  for(const [platform,id] of Object.entries(config.buffer.channels)){
    const channel=await client.channel(id);
    if(channel.service!==platform||channel.isDisconnected||channel.isLocked)throw new Error('Buffer channel is not ready: '+platform);
    channels.push(channel);
  }
  return {publishingEnabled:config.buffer.enabled,channels,cloudinaryConfigured:Boolean(credentials.cloudName&&credentials.cloudKey&&credentials.cloudSecret)};
}

// Each intent is durably checkpointed before the external write. Uncertain writes
// require manual reconciliation, never automatic re-creation.
export async function runSocial({state,date,config,credentials,save,claim=()=>{},ready=async()=>true,validate=()=>{},client=new BufferClient(credentials.bufferToken),upload=uploadVideo,now=()=>new Date(),stopped=async()=>false}) {
  if(!config.buffer?.enabled||await stopped())return;
  for(const job of state.jobs){
    if(job.slot==='sample'||job.draft||job.superseded)continue;
    for(const receipt of Object.values(job.social||{})){
      if(receipt.postId&&!['sent','error','draft'].includes(receipt.status)){
        try{const post=await client.get(receipt.postId);Object.assign(receipt,{status:post.status,externalLink:post.externalLink,sentAt:post.sentAt});await save();}
        catch{receipt.checkFailedAt=now().toISOString();await save();}
      }
    }
    if(job.date!==date||job.socialEligible!==true||!job.outputDir||!job.outputSha256)continue;
    if(+now()-Date.parse(job.publishAt)>config.maxLatenessMinutes*60000)continue;
    if(Date.parse(job.publishAt)-+now()<120000)continue; // Buffer needs time to fetch/process the video; no late flood.
    if(!await ready(job))continue;
    validate(job);
    job.social||={};
    for(const [platform,channelId] of Object.entries(config.buffer.channels)){
      if(job.social[platform]?.intent||job.social[platform]?.postId)continue;
      if(await stopped())return;
      // Readiness failures happen before intent and can be retried independently.
      try{
        const channel=await client.channel(channelId);
        if(channel.service!==platform||channel.isDisconnected||channel.isLocked||channel.isQueuePaused)throw new Error('Channel unavailable');
        if(!job.hostedMedia){job.hostedMedia=await upload(path.join(job.outputDir,'video.mp4'),credentials,{expectedHash:job.outputSha256});await save();}
        if(job.hostedMedia.sha256!==job.outputSha256)throw new Error('Hosted video checksum mismatch');
      }catch{job.socialErrors||={};job.socialErrors[platform]='Media upload or channel check failed';await save();continue;}
      await claim('buffer:'+channelId,job.outputSha256,job.id);
      const receipt=job.social[platform]={intent:true,channelId,startedAt:now().toISOString(),status:'uncertain'};
      await save(); // Never issue a mutation if durable checkpointing failed.
      if(await stopped())return;
      try{
        const post=await client.create(postInput(job,platform,channelId,job.hostedMedia.url));
        Object.assign(receipt,{postId:post.id,status:post.status,externalLink:post.externalLink});
        if(post.schedulingType!=='automatic')receipt.status='attention';
      }catch{receipt.status='uncertain';}
      await save();
    }
  }
}
