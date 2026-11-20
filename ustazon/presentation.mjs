import {captionCues} from './model.mjs';

export const PRESENTATION_REVISION='2026-11-20-daraustaz-site-cta-v2';

export function countdownState(scene,local) {
  if(!scene.pauseSeconds)return null;
  const start=Math.max(scene.speechDuration||0,scene.duration-scene.pauseSeconds);
  if(local<start||local>=scene.duration)return null;
  const remaining=scene.duration-local;
  return {remaining,seconds:Math.min(Math.ceil(scene.pauseSeconds),Math.ceil(remaining)),progress:Math.min(1,remaining/(scene.duration-start))};
}

export function materialCrop(scene) {
  // Trim decorative margins while keeping both kidneys, both ureters and the bladder.
  if(scene.assetId==='urinary-anatomy'&&!scene.crop)return [.37,.02,.39,.96];
  return scene.crop||[0,0,1,1];
}

export function activeEmphasis(scene,local) {
  const duration=scene.duration;
  const cues=captionCues({scenes:[{...scene,start:0,end:duration}]});
  const cue=cues.find(c=>local>=c.start&&local<c.end);
  if(!cue)return [];
  const text=cue.text.toLowerCase();
  if(scene.assetId==='diffusion-diagram') {
    // These boxes surround the actual horizontal transport arrows in the source.
    if(/бағыттауыш|стрел/.test(text))return [[.11,.58,.34,.19],[.62,.56,.33,.19]];
    if(/белгі|обознач|подпис/.test(text))return [[.02,.22,.15,.17],[.37,.22,.13,.17]];
  }
  if(scene.assetId==='urinary-anatomy') {
    if(/бүйрек|почки|почек/.test(text))return [[.42,.03,.13,.26],[.61,.03,.13,.26]];
    if(/қуық|пузыр/.test(text))return [[.49,.57,.17,.28]];
    if(/несепағар|мочеточник/.test(text))return [[.50,.25,.05,.36],[.64,.25,.05,.36]];
  }
  if(scene.assetId==='urinary-goal'&&/мақсат|цель|цели|сипат|опис|қызмет|функц/.test(text))return [[.27,.55,.54,.12]];
  return [];
}

export function projectRegion(region,crop,box) {
  const left=Math.max(region[0],crop[0]),top=Math.max(region[1],crop[1]);
  const right=Math.min(region[0]+region[2],crop[0]+crop[2]),bottom=Math.min(region[1]+region[3],crop[1]+crop[3]);
  if(right<=left||bottom<=top)return null;
  return {x:box.x+(left-crop[0])/crop[2]*box.w,y:box.y+(top-crop[1])/crop[3]*box.h,w:(right-left)/crop[2]*box.w,h:(bottom-top)/crop[3]*box.h};
}
