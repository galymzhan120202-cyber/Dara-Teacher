import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {writeJSON} from './state.mjs';
import {fileDigest} from './maintenance.mjs';
import ffmpegPath from 'ffmpeg-static';
import {contactSheet, makeRenderer} from './draw.mjs';
import {createTimeline, metadata, subtitles} from './model.mjs';

export const encoderPath = process.env.USTAZON_FFMPEG_PATH || ffmpegPath;

export async function runEncoder(args,{timeoutMs=120000,signal}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(encoderPath,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',timedOut=false,aborted=false;
    child.stdout.on('data',data=>{stdout=(stdout+data).slice(-200000);});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-200000);});
    const stop=()=>{aborted=true;child.kill();};
    signal?.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
    child.once('error',error=>{clean();reject(error);});
    child.once('close',code=>{clean();if(aborted)reject(signal.reason);else if(timedOut)reject(new Error('FFmpeg exceeded its timeout'));else resolve({code,stdout,stderr});});
  });
}
export async function verifyVideo(file,{expectedFrames,signal}={}) {
  const result=await runEncoder(['-v','error','-i',file,'-map','0:v:0','-map','0:a:0','-progress','pipe:1','-f','null','-'],{signal});
  const frames=Number([...result.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]||0);
  if(result.code!==0||frames<1||(expectedFrames&&Math.abs(frames-expectedFrames)>1))throw new Error('Video verification failed: '+result.stderr.slice(-500));
  return {frames,sha256:await fileDigest(file),bytes:(await fs.stat(file)).size};
}

export async function voiceDuration(filename) {
  const result = await runEncoder(['-hide_banner', '-i', filename]);
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(result.stderr);
  if (!match || !/Audio:/.test(result.stderr)) throw new Error('Cannot read narration audio');
  return +match[1] * 3600 + +match[2] * 60 + +match[3];
}

export function encoderArgs({width, height, fps, duration, musicPath, musicVolume = .16, narrationPath, outputPath}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
  let input = 1;
  const filters = [], audio = [];
  if (musicPath) {
    args.push('-stream_loop', '-1', '-i', musicPath);
    const volume = narrationPath ? musicVolume * .38 : musicVolume;
    filters.push(`[${input++}:a]aresample=48000,volume=${volume},atrim=duration=${duration},afade=t=in:st=0:d=0.4,afade=t=out:st=${Math.max(0, duration - .8)}:d=0.8[music]`);
    audio.push('[music]');
  }
  if (narrationPath) {
    args.push('-i', narrationPath);
    filters.push(`[${input++}:a]aresample=48000,apad,atrim=duration=${duration}[voice]`);
    audio.push('[voice]');
  }
  if (!audio.length) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    filters.push(`[${input}:a]atrim=duration=${duration}[silence]`);
    audio.push('[silence]');
  }
  if (audio.length > 1) filters.push(`${audio.join('')}amix=inputs=${audio.length}:duration=longest:normalize=0,alimiter=limit=0.95[audio]`);
  else filters.push(`${audio[0]}anull[audio]`);
  args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[audio]', '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
    '-ar', '48000', '-movflags', '+faststart', '-metadata', 'comment=Ustazon educational promotional video', outputPath);
  return args;
}

async function encodeFrames(renderer, timeline, args, onProgress, {signal,timeoutMs=600000}={}) {
  const child = spawn(encoderPath, args, {stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true});
  let stderr = '', spawnError, streamError;
  let timedOut=false;
  const stop=()=>{child.stdin.destroy();child.kill();};
  signal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  child.stderr.on('data', data => {stderr = (stderr + data.toString()).slice(-8000);});
  child.stdin.on('error', error => {streamError = error;});
  // Keep the exit promise handled while generating frames, including spawn failures.
  const exited = new Promise(resolve => {
    child.once('error', error => {spawnError = error;});
    child.once('close', code => resolve(code));
  });
  try {
    signal?.throwIfAborted();
    for (let frame = 0; frame < timeline.frames; frame++) {
      signal?.throwIfAborted();
      if(timedOut)throw new Error('FFmpeg render timeout');
      if (spawnError || streamError || child.exitCode !== null) throw spawnError || streamError || new Error('FFmpeg stopped before all frames were sent');
      renderer.draw(frame);
      const pixels = renderer.ctx.getImageData(0, 0, renderer.width, renderer.height).data;
      const buffer = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      if (!child.stdin.write(buffer)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {child.stdin.off('drain', drained); child.stdin.off('error', failed); child.off('close', closed);};
          const drained = () => {cleanup(); resolve();};
          const failed = error => {cleanup(); reject(error);};
          const closed = () => failed(new Error('Encoder closed its input'));
          child.stdin.once('drain', drained); child.stdin.once('error', failed); child.once('close', closed);
        });
      }
      if (frame % (timeline.fps * 5) === 0) onProgress?.(frame / timeline.frames);
    }
    child.stdin.end();
    const code = await exited;
    if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
    onProgress?.(1);
  } catch (error) {
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
    await exited;
    if(signal?.aborted)throw signal.reason;
    throw new Error(`Video encoding failed: ${stderr.trim() || spawnError?.message || error.message}`);
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',stop);}
}

export async function renderVideo(project, topic, {outputDir, width = 1080, fps = 30, previewOnly = false, draft = false, noMusic = false, narrationPath = null, captions = false, onProgress, signal, timeoutMs=600000} = {}) {
  const timeline = createTimeline(topic, fps), height = width * 16 / 9;
  const renderer = makeRenderer(project.theme, timeline, {width, height, fontPath: project.fontPath, captions, assets:project.visualAssets});
  const musicPath = noMusic || previewOnly ? null : project.musicPath;
  if (musicPath) await fs.access(musicPath);
  if (narrationPath) {
    await fs.access(narrationPath);
    const length = await voiceDuration(narrationPath);
    if (length > timeline.duration + .2) throw new Error(`Narration is ${length.toFixed(1)}s; video is ${timeline.duration}s. Shorten the narration or extend scene durations.`);
  }
  // A run always owns a new directory. Never overwrite a previous render.
  await fs.mkdir(outputDir, {recursive: false});
  const outputPath = path.join(outputDir, 'video.mp4');
  const partialPath=path.join(outputDir,'video.partial.mp4');
  await fs.writeFile(path.join(outputDir, 'storyboard.png'), contactSheet(renderer, timeline));
  renderer.draw(Math.min(timeline.frames - 1, timeline.fps));
  await fs.writeFile(path.join(outputDir, 'thumbnail.png'), renderer.canvas.toBuffer('image/png'));
  await fs.writeFile(path.join(outputDir, 'captions.srt'), subtitles(timeline), 'utf8');
  await fs.writeFile(path.join(outputDir, 'narration.txt'), timeline.scenes.map(scene => `[${scene.start.toFixed(1)}–${scene.end.toFixed(1)} s]\n${scene.narration}`).join('\n\n') + '\n', 'utf8');
  let musicAttribution = null;
  if (musicPath && project.attributionPath) {
    const records = JSON.parse(await fs.readFile(project.attributionPath, 'utf8'));
    musicAttribution = records.find(record => record.file === path.basename(musicPath)) ?? null;
  }
  const info = metadata(topic, project.theme, timeline, {
    width, height, narration: narrationPath ? 'provided-audio' : 'text-and-music',
    subtitles: captions ? 'Burned-in phrase captions, timed approximately within each scene audio.' : 'Scene-timed narration script; visible video text is typeset separately.',
    musicAttribution, draft, sourceDate: project.catalog.sourceDate,
    status: previewOnly ? 'storyboard' : 'rendering', createdAt: new Date().toISOString(),
  });
  const infoFile = path.join(outputDir, 'metadata.json');
  await writeJSON(infoFile,info);
  if (!previewOnly) {
    try {
      const args = encoderArgs({width, height, fps, duration: timeline.duration, musicPath, musicVolume: project.theme.music?.volume, narrationPath, outputPath:partialPath});
      await encodeFrames(renderer, timeline, args, onProgress,{signal,timeoutMs});
      const checked=await verifyVideo(partialPath,{expectedFrames:timeline.frames,signal});
      await fs.rename(partialPath,outputPath);
      info.sha256=checked.sha256;
      info.verifiedAt=new Date().toISOString();
      info.status = 'complete';
      info.bytes = (await fs.stat(outputPath)).size;
    } catch (error) {
      info.status = 'failed';
      await writeJSON(infoFile,info);
      throw error;
    }
    await writeJSON(infoFile,info);
  }
  return {outputPath, outputDir, info, timeline};
}
