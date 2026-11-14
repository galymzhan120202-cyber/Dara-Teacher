import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {speechCacheKey,preparedNarration} from './prepared-audio.mjs';
import {runEncoder,voiceDuration} from './encode.mjs';
import {createTimeline,validateCatalog} from './model.mjs';
export function pcmToWav(pcm,rate=24000) {
  const wav=Buffer.alloc(44+pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(36+pcm.length,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
  wav.write('data',36); wav.writeUInt32LE(pcm.length,40); pcm.copy(wav,44);
  return wav;
}
export function asWav({data,mimeType}) {
  if(data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WAVE') return data;
  if(/^audio\/(?:L16|pcm)/i.test(mimeType)) return pcmToWav(data,Number(/rate=(\d+)/.exec(mimeType)?.[1]||24000));
  throw new Error('Gemini did not return WAV or supported PCM audio');
}
export async function narrateTopic({client,config,topic,cacheDir,outputFile,onScene=()=>{},onRepair=()=>{},signal}) {
  await fs.mkdir(cacheDir,{recursive:true});
  await fs.mkdir(path.dirname(outputFile),{recursive:true});
  const voiced=structuredClone(topic), files=[],prepared=new Map();
  if(config.gemini.preparedCta)for(const scene of voiced.scenes.filter(s=>s.kind==='cta')) {
    const asset=await preparedNarration({model:config.gemini.ttsModel,voice:config.gemini.voice,language:topic.language,text:scene.narration});
    if(!asset){const error=new Error('Prepared CTA audio is missing or does not match the selected voice and transcript. Restore ustazon/assets/narration before generating.');error.code='PREPARED_AUDIO_MISSING';throw error;}
    prepared.set(asset.key,asset.data);
  }
  for(const [i,scene] of voiced.scenes.entries()) {
    signal?.throwIfAborted();
    let file,duration,cached;
    for(let attempt=0;attempt<2;attempt++) {
      const hash=speechCacheKey({model:config.gemini.ttsModel,voice:config.gemini.voice,language:topic.language,text:scene.narration});
      file=path.join(cacheDir,hash+'.wav');let exists=true;
      try{await fs.access(file);}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
      duration=0;
      if(exists)try{duration=await voiceDuration(file);if(duration<.1)throw new Error('Empty audio');}catch{await fs.rename(file,file+'.corrupt-'+randomUUID());exists=false;}
      cached=exists;
      if(!exists) {
        const reusable=prepared.get(hash);
        const audio=reusable||asWav(await client.speech({model:config.gemini.ttsModel,voice:config.gemini.voice,text:scene.narration,language:topic.language}));
        cached=Boolean(reusable);
        const temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,audio);await fs.rename(temp,file);
      }
      duration ||= await voiceDuration(file);await fs.utimes(file,new Date(),new Date());
      const tail=scene.pauseSeconds||(scene.quiz?.phase==='question'?3.5:.35);
      const planned=Math.ceil(Math.max(scene.duration,duration+tail)*config.video.fps)/config.video.fps;
      if(planned<=20){scene.duration=planned;break;}
      if(attempt===0&&scene.shortNarration&&scene.narration!==scene.shortNarration) {
        scene.narration=scene.shortNarration;
        topic.scenes[i].narration=scene.shortNarration;
        await onRepair(i,topic);
        continue;
      }
      throw Object.assign(new Error('Narration exceeds 20 seconds in scene '+(i+1)+'. Review the short narration before retrying.'),{code:'NARRATION_TOO_LONG'});
    }
    scene.speechDuration=duration;
    files.push(file);await onScene(i+1,voiced.scenes.length,cached,[...files]);
  }
  validateCatalog({version:1,source:'Voiced script',topics:[voiced]});
  const timeline=createTimeline(voiced,config.video.fps);
  const args=['-hide_banner','-loglevel','error','-nostdin','-y'];
  for(const file of files) args.push('-i',file);
  const filters=timeline.scenes.map((scene,i)=>'['+i+':a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,apad,atrim=duration='+(scene.end-scene.start)+'[s'+i+']');
  filters.push(files.map((_,i)=>'[s'+i+']').join('')+'concat=n='+files.length+':v=0:a=1,alimiter=limit=0.95:level=false[a]');
  const temp=outputFile+'.'+randomUUID()+'.wav';
  args.push('-filter_complex',filters.join(';'),'-map','[a]','-c:a','pcm_s16le','-ar','48000',temp);
  const result=await runEncoder(args,{signal});
  if(result.code!==0)throw new Error('Narration assembly failed: '+result.stderr.slice(-1000));
  await fs.rename(temp,outputFile);
  return {topic:voiced,narrationPath:outputFile,audioFiles:files};
}
