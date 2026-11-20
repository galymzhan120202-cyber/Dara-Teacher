import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadVisualAssets} from './visual-assets.mjs';
import {makeCaptionTiming,validateCaptionTiming} from './caption-timing.mjs';

export const KINDS = new Set(['hook', 'feature', 'steps', 'cta']);
export const VISUALS = new Set(['stack', 'presentation', 'worksheet', 'games', 'triangle', 'file', 'counting', 'plan', 'comparison', 'cta', 'quiz', 'asset']);

function requireText(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}: invalid or empty text`);
}

export function validateCatalog(catalog) {
  if (catalog.version !== 1 || !Array.isArray(catalog.topics) || !catalog.topics.length) throw new Error('Catalog must have version 1 and at least one topic');
  requireText(catalog.source, 'Catalog source');
  const ids = new Set();
  for (const topic of catalog.topics) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic.id) || ids.has(topic.id)) throw new Error(`Invalid or duplicate topic id: ${topic.id}`);
    ids.add(topic.id);
    if(topic.language && !['kk','ru'].includes(topic.language)) throw new Error('Language must be kk or ru');
    requireText(topic.title, `${topic.id}.title`, 100);
    requireText(topic.description, `${topic.id}.description`, 4500);
    if (!Array.isArray(topic.sourceRefs) || !topic.sourceRefs.length) throw new Error(`${topic.id}: factual source references are required`);
    topic.sourceRefs.forEach(ref => requireText(ref, 'Source reference'));
    if (!Array.isArray(topic.tags) || topic.tags.some(tag => typeof tag !== 'string' || !tag.trim())) throw new Error(`${topic.id}: invalid tags`);
    if (!Array.isArray(topic.scenes) || topic.scenes.length < 2) throw new Error(`${topic.id}: at least two scenes are required`);
    if (topic.scenes.at(-1).kind !== 'cta') throw new Error(`${topic.id}: the final scene must be a call to action`);
    let duration = 0;
    for (const [index, scene] of topic.scenes.entries()) {
      const label = `${topic.id}.scenes[${index}]`;
      if (!KINDS.has(scene.kind)) throw new Error(`${label}: unknown scene kind`);
      if (!Number.isFinite(scene.duration) || scene.duration < 2 || scene.duration > 20) throw new Error(`${label}: duration must be 2–20 seconds`);
      duration += scene.duration;
      if(scene.visual === 'quiz' && (!scene.quiz || !Number.isInteger(scene.quiz.a) || !Number.isInteger(scene.quiz.b) || !['+','-'].includes(scene.quiz.operator||'+') || scene.quiz.answer !== ((scene.quiz.operator||'+')==='+'?scene.quiz.a + scene.quiz.b:scene.quiz.a - scene.quiz.b) || !['intro','question','answer'].includes(scene.quiz.phase))) throw new Error(label + ': invalid arithmetic exercise');
      if(scene.visual==='asset') {
        if(!/^[a-z0-9-]+$/.test(scene.assetId||''))throw new Error(label+': invalid source asset');
        requireText(scene.assetCaption,label+'.assetCaption',100);
        if(scene.crop&&(!Array.isArray(scene.crop)||scene.crop.length!==4||scene.crop.some(n=>!Number.isFinite(n)||n<0||n>1)||scene.crop[2]<=0||scene.crop[3]<=0||scene.crop[0]+scene.crop[2]>1||scene.crop[1]+scene.crop[3]>1))throw new Error(label+': invalid source crop');
      }
      requireText(scene.narration, `${label}.narration`, 500);
      if(scene.captionTiming)validateCaptionTiming(scene.captionTiming,scene.narration,Math.min(scene.duration,scene.speechDuration||scene.duration));
      if (scene.kind !== 'cta') {
        requireText(scene.label, `${label}.label`, 100);
        requireText(scene.headline, `${label}.headline`, 160);
      }
      if (scene.kind === 'steps') {
        if (!Array.isArray(scene.steps) || scene.steps.length !== 3) throw new Error(`${label}: exactly three steps are required`);
        scene.steps.forEach(step => requireText(step, `${label}.step`, 70));
      } else if (!VISUALS.has(scene.visual)) throw new Error(`${label}: unknown illustration`);
      if (scene.kind !== 'cta' && scene.kind !== 'steps') requireText(scene.body, `${label}.body`, 220);
    }
    if (duration > 90) throw new Error(`${topic.id}: this template supports videos up to 90 seconds`);
  }
  return catalog;
}

export function validateTheme(theme) {
  if (theme.version !== 1) throw new Error('Theme version must be 1');
  requireText(theme.brand, 'Brand', 40);
  requireText(theme.font?.file, 'Font file');
  requireText(theme.font?.family, 'Font family', 60);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(theme.font.family)) throw new Error('Use a simple alphanumeric font family name');
  for (const key of ['background', 'ink', 'primary', 'muted', 'line', 'white', 'accent']) {
    if (!/^#[0-9a-f]{6}$/i.test(theme.colors?.[key] ?? '')) throw new Error(`Invalid theme color: ${key}`);
  }
  if (!Number.isFinite(theme.cardRadius) || theme.cardRadius < 0 || theme.cardRadius > 80) throw new Error('Card radius must be between 0 and 80');
  for (const key of ['label', 'headline', 'body', 'action']) requireText(theme.cta?.[key], `CTA ${key}`, key === 'action' ? 60 : 180);
  if (theme.cta.destination && !/^https:\/\/[^\s]+$/.test(theme.cta.destination)) throw new Error('CTA destination must be an HTTPS URL');
  if (theme.music && (!Number.isFinite(theme.music.volume) || theme.music.volume < 0 || theme.music.volume > 1)) throw new Error('Music volume must be 0–1');
  return theme;
}

export async function loadProject(catalogFile, themeFile) {
  const [catalog, theme] = await Promise.all([
    fs.readFile(catalogFile, 'utf8').then(JSON.parse).then(validateCatalog),
    fs.readFile(themeFile, 'utf8').then(JSON.parse).then(validateTheme),
  ]);
  const base = path.dirname(path.resolve(themeFile));
  return {catalog, theme, visualAssets:await loadVisualAssets(), fontPath: path.resolve(base, theme.font.file), musicPath: theme.music?.file ? path.resolve(base, theme.music.file) : null,
    attributionPath: theme.music?.attributionFile ? path.resolve(base, theme.music.attributionFile) : null};
}

export function createTimeline(topic, fps = 30) {
  if (!Number.isInteger(fps) || fps < 8 || fps > 60) throw new Error('FPS must be an integer from 8 to 60');
  let frame = 0;
  const scenes = topic.scenes.map((scene, index) => {
    const count = Math.round(scene.duration * fps);
    const segment = {...scene, index, startFrame: frame, endFrame: frame + count, start: frame / fps, end: (frame + count) / fps};
    frame += count;
    return segment;
  });
  return {fps, frames: frame, duration: frame / fps, scenes};
}

export function sceneAt(timeline, frame) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= timeline.frames) throw new Error('Frame outside video timeline');
  return timeline.scenes.find(scene => frame >= scene.startFrame && frame < scene.endFrame);
}

export function fingerprint(topic, theme) {
  return createHash('sha256').update(JSON.stringify({topic, cta: theme.cta})).digest('hex');
}

export function nextTopic(catalog, theme, history) {
  const completed = new Set(history.filter(item => item.status === 'complete').map(item => item.fingerprint));
  return catalog.topics.find(topic => !completed.has(fingerprint(topic, theme))) ?? null;
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function captionCues(timeline) {
  const cues=[];
  for(const scene of timeline.scenes) {
    const duration=Math.min(scene.end-scene.start,scene.speechDuration || (scene.end-scene.start-(scene.pauseSeconds||0)));
    const timing=scene.captionTiming?validateCaptionTiming(scene.captionTiming,scene.narration,duration):makeCaptionTiming(scene.narration,duration);
    timing.cues.forEach(cue=>cues.push({...cue,start:scene.start+cue.start,end:scene.start+cue.end}));
  }
  return cues;
}
export function subtitles(timeline) {
  return captionCues(timeline).map((cue,i)=>String(i+1)+'\n'+srtTime(cue.start)+' --> '+srtTime(cue.end)+'\n'+cue.text+'\n').join('\n');
}

export function metadata(topic, theme, timeline, extra = {}) {
  const ru = topic.language === 'ru' || theme.language === 'ru';
  const destination = theme.cta.destination ? '\n\nСайт: '+theme.cta.destination+'\n'+(ru?'Ссылка доступна в профиле канала, если она там размещена.':'Сілтеме арна профилінде көрсетілгенде, сол жерден өтіңіз.') : '';
  return {
    title: topic.title,
    description: topic.description + destination + '\n\n#Ustazon ' + (ru ? '#учитель' : '#мұғалім') + ' #shorts',
    tags: topic.tags,
    categoryId: '27',
    language: ru ? 'ru' : 'kk',
    madeForKids: false,
    audience: ru ? 'Учителя' : 'Мұғалімдер',
    visualFormat: topic.scenes.some(s=>s.visual==='asset') ? (ru?'Фрагменты реальных материалов Ustazon; оригиналы на казахском языке':'Ustazon материалдарының нақты үзінділері; түпнұсқалары қазақша') : 'Авторлық инфографика',
    contentKey:topic.contentKey, materialId:topic.materialId, evidenceRevision:topic.evidenceRevision,
    sources: topic.sourceRefs,
    topicId: topic.id,
    fingerprint: fingerprint(topic, theme),
    durationSeconds: timeline.duration,
    fps: timeline.fps,
    scenes: timeline.scenes.map(({start, end, narration}) => ({start, end, narration})),
    ...extra,
  };
}
