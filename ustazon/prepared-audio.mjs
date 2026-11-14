import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {callToAction} from './localize.mjs';

export const PREPARED_AUDIO_DIR=fileURLToPath(new URL('./assets/narration/',import.meta.url));
export function speechCacheKey({model,voice,language,text}) {
  return createHash('sha256').update(JSON.stringify({model,voice,language,text,styleVersion:2})).digest('hex');
}
export async function preparedNarration({model,voice,language,text,directory=PREPARED_AUDIO_DIR}) {
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(manifest.version!==1||!Array.isArray(manifest.items))throw new Error('Invalid prepared narration manifest');
  const key=speechCacheKey({model,voice,language,text});
  const item=manifest.items.find(x=>x.cacheKey===key&&x.model===model&&x.voice===voice&&x.language===language&&x.text===text);
  if(!item)return null;
  if(!/^[a-z0-9-]+\.wav$/.test(item.file)||!/^([a-f0-9]{64})$/.test(item.sha256))throw new Error('Invalid prepared narration entry');
  let data;
  try{data=await fs.readFile(path.join(directory,item.file));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(createHash('sha256').update(data).digest('hex')!==item.sha256||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE') {
    const error=new Error('Prepared narration failed its integrity check: '+language);error.code='PREPARED_AUDIO_INVALID';throw error;
  }
  return {key,data,sha256:item.sha256};
}
export async function preparedNarrationStatus(config,{directory=PREPARED_AUDIO_DIR}={}) {
  if(!config.gemini.preparedCta)return [];
  const results=[];
  for(const language of new Set(config.slots.map(slot=>slot.language))) {
    try {
      const found=await preparedNarration({model:config.gemini.ttsModel,voice:config.gemini.voice,language,text:callToAction(language),directory});
      results.push({language,available:Boolean(found)});
    }catch(error){results.push({language,available:false,error:error.message});}
  }
  return results;
}
