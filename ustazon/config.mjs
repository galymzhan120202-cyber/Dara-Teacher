import {DEFAULT_RUNTIME} from './reliability.mjs';
import {DEFAULT_FREE_TIER,validateFreeTier} from './budget.mjs';
import {validateDate} from './schedule.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);
export function parseEnv(text) {
  const values = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}
export async function loadSettings() {
  const local = parseEnv(await fs.readFile(path.join(ROOT, '.env.local'), 'utf8').catch(error => {if(error.code === 'ENOENT') return ''; throw error;}));
  const env = {...local, ...process.env};
  const config = JSON.parse(await fs.readFile(path.join(HERE, 'automation.json'), 'utf8'));
  if(env.USTAZON_YOUTUBE_ENABLED!==undefined) {if(!['true','false'].includes(env.USTAZON_YOUTUBE_ENABLED))throw new Error('USTAZON_YOUTUBE_ENABLED must be true or false');config.youtube.enabled=env.USTAZON_YOUTUBE_ENABLED==='true';}
  if(env.YOUTUBE_CHANNEL_ID)config.youtube.expectedChannelId=env.YOUTUBE_CHANNEL_ID;
  if (env.GEMINI_MODEL) config.gemini.model = env.GEMINI_MODEL;
  if (env.GEMINI_TTS_MODEL) config.gemini.ttsModel = env.GEMINI_TTS_MODEL;
  if (env.GEMINI_VOICE) config.gemini.voice = env.GEMINI_VOICE;
  config.gemini.freeTier={...DEFAULT_FREE_TIER,...config.gemini.freeTier};
  if(env.GEMINI_FREE_TIER_CONFIRMED!==undefined) {
    if(!['true','false'].includes(env.GEMINI_FREE_TIER_CONFIRMED))throw new Error('GEMINI_FREE_TIER_CONFIRMED must be true or false');
    config.gemini.freeTier.confirmed=env.GEMINI_FREE_TIER_CONFIRMED==='true';
  }
  config.runtime={...DEFAULT_RUNTIME,...config.runtime};
  if(env.USTAZON_BUFFER_ENABLED!==undefined){if(!['true','false'].includes(env.USTAZON_BUFFER_ENABLED))throw new Error('Invalid USTAZON_BUFFER_ENABLED');config.buffer.enabled=env.USTAZON_BUFFER_ENABLED==='true';}
  validateSettings(config);
  return {config, apiKey:env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',socialCredentials:{bufferToken:env.BUFFER_API_TOKEN,cloudName:env.CLOUDINARY_CLOUD_NAME,cloudKey:env.CLOUDINARY_API_KEY,cloudSecret:env.CLOUDINARY_API_SECRET}};
}
export function validateSettings(config) {
  if (config.version !== 1) throw new Error('Unknown automation configuration version');
  new Intl.DateTimeFormat('en', {timeZone:config.timezone}).format(new Date());
  if (!Array.isArray(config.slots) || ![1,3,6].includes(config.slots.length)) throw new Error('Configure one, three or six daily slots');
  const ids = new Set(), times = new Set();
  for (const slot of config.slots) {
    if (!/^[a-z]+$/.test(slot.id) || ids.has(slot.id) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time) || times.has(slot.time) || !['tip','material','quiz'].includes(slot.format) || !['kk','ru'].includes(slot.language)) throw new Error('Invalid or duplicate daily slot');
    ids.add(slot.id); times.add(slot.time);
  }
  if(config.languageRotation!==undefined) {
    const rotation=config.languageRotation,kk=config.slots.filter(s=>s.language==='kk').length;
    if(!rotation||rotation.mode!=='alternate-days'||!(config.slots.length===1||(config.slots.length===3&&[1,2].includes(kk))))throw new Error('Language rotation requires one slot or three mixed slots');
    validateDate(rotation.startDate);
  }
  const g = config.gemini;
  if(config.formatRotation){validateDate(config.formatRotation.startDate);if(config.formatRotation.formats?.length!==3||[...config.formatRotation.formats].sort().join(',')!=='material,quiz,tip')throw new Error('Invalid format rotation');}
  if(config.buffer){
    if(typeof config.buffer.enabled!=='boolean'||!config.buffer.channels||Object.keys(config.buffer.channels).sort().join(',')!=='instagram,tiktok'||Object.values(config.buffer.channels).some(id=>!/^[a-f0-9]{24}$/.test(id)))throw new Error('Invalid Buffer configuration');
  }
  if (!g || !/^[a-z0-9.-]+$/.test(g.model) || !/^[a-z0-9.-]+$/.test(g.ttsModel) || !/^[A-Za-z0-9_-]+$/.test(g.voice)) throw new Error('Invalid Gemini model or voice');
  if (!Number.isInteger(g.maxDailyRequests) || g.maxDailyRequests < 1 || g.maxDailyRequests > 100 || !Number.isInteger(g.maxScriptAttempts) || g.maxScriptAttempts < 1 || g.maxScriptAttempts > 3) throw new Error('Invalid Gemini request limits');
  if (g.templateFallback !== undefined && typeof g.templateFallback !== 'boolean') throw new Error('templateFallback must be a boolean');
  if (typeof g.voiceEnabled !== 'boolean') throw new Error('voiceEnabled must be a boolean');
  if(g.preparedCta!==undefined&&typeof g.preparedCta!=='boolean')throw new Error('preparedCta must be a boolean');
  validateFreeTier(config);
  const v = config.video;
  if (!Number.isInteger(v.width) || v.width < 180 || v.width > 2160 || v.width % 18 || !Number.isInteger(v.fps) || v.fps < 8 || v.fps > 60 || typeof v.captions !== 'boolean') throw new Error('Invalid video settings');
  if (!Number.isFinite(config.maxLatenessMinutes) || config.maxLatenessMinutes < 0 || config.maxLatenessMinutes > 120) throw new Error('Invalid lateness limit');
  const y = config.youtube;
  if (!y || typeof y.enabled !== 'boolean' || typeof y.tokenFile !== 'string' || typeof y.clientFile !== 'string') throw new Error('Invalid YouTube configuration');
  if (y.expectedChannelId && !/^UC[A-Za-z0-9_-]{22}$/.test(y.expectedChannelId)) throw new Error('YouTube expectedChannelId must be a channel ID beginning with UC');
  if (y.enabled && !y.expectedChannelId) throw new Error('Set expectedChannelId before enabling YouTube');
  if(config.content&&!['verified','generated'].includes(config.content.mode))throw new Error('Unknown content mode');
  if(config.runtime?.carryUnfinished!==undefined&&typeof config.runtime.carryUnfinished!=='boolean')throw new Error('carryUnfinished must be boolean');
  const r={...DEFAULT_RUNTIME,...config.runtime};
  for(const [name,min,max] of [['pollSeconds',5,300],['maxAttemptsPerDay',1,20],['retryBaseSeconds',1,3600],['retryMaxMinutes',1,1440],['minFreeMB',0,1048576],['cacheDays',1,365],['backupDays',2,365],['logDays',1,365],['logMaxMB',1,100],['renderTimeoutMinutes',1,60]]) {
    if(!Number.isInteger(r[name])||r[name]<min||r[name]>max)throw new Error('Invalid runtime setting: '+name);
  }
  return config;
}
