import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadProject} from '../model.mjs';
import {renderVideo, runEncoder, encoderArgs} from '../encode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = await loadProject(path.join(root, 'catalog.json'), path.join(root, 'theme.json'));
const topic = structuredClone(project.catalog.topics[0]);
topic.scenes = [topic.scenes[0], topic.scenes.at(-1)].map(scene => ({...scene, duration:2}));

test('offline pipeline encodes a decodable H.264/AAC vertical video with the full final scene', async () => {
  const parent = path.join(root, '..', '.audit-work', 'ustazon-tests');
  await fs.mkdir(parent, {recursive:true});
  const workspace = await fs.mkdtemp(path.join(parent, 'encode-'));
  const outputDir = path.join(workspace, 'result');
  const result = await renderVideo(project, topic, {outputDir, width:180, fps:8});
  assert.equal(result.info.status, 'complete');
  assert.equal(result.timeline.duration, 4);
  assert.ok(result.info.bytes > 5000);
  const probe = await runEncoder(['-hide_banner', '-i', result.outputPath]);
  assert.match(probe.stderr, /Duration: 00:00:04\./);
  assert.match(probe.stderr, /Video: h264.*180x320/);
  assert.match(probe.stderr, /Audio: aac/);
  const decode = await runEncoder(['-v', 'error', '-i', result.outputPath, '-f', 'null', '-']);
  assert.equal(decode.code, 0, decode.stderr);
  const frameHashes = await runEncoder(['-v', 'error', '-i', result.outputPath, '-map', '0:v:0', '-f', 'framemd5', '-']);
  const frames = frameHashes.stdout.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  assert.equal(frames.length, 32);
  assert.notEqual(frames[0].split(',').at(-1), frames.at(-1).split(',').at(-1));
  for (const filename of ['storyboard.png', 'thumbnail.png', 'captions.srt', 'narration.txt', 'metadata.json']) assert.ok((await fs.stat(path.join(outputDir, filename))).size > 10);
  const saved = JSON.parse(await fs.readFile(path.join(outputDir, 'metadata.json'), 'utf8'));
  assert.equal(saved.status, 'complete');
  assert.equal(saved.musicAttribution.title, 'Soft Sparks');
  await assert.rejects(renderVideo(project, topic, {outputDir, width:180, fps:8}), /EEXIST/);
});

test('a storyboard does not require music and does not produce an MP4', async () => {
  const parent = path.join(root, '..', '.audit-work', 'ustazon-tests');
  await fs.mkdir(parent, {recursive:true});
  const workspace = await fs.mkdtemp(path.join(parent, 'preview-'));
  const outputDir = path.join(workspace, 'result');
  const result = await renderVideo({...project, musicPath:path.join(workspace, 'missing-music.wav')}, topic, {outputDir, width:180, fps:8, previewOnly:true});
  assert.equal(result.info.status, 'storyboard');
  await assert.rejects(fs.access(result.outputPath));
});

test('paths are passed as argv and narration ducks music without truncating video input', () => {
  const args = encoderArgs({width:1080, height:1920, fps:30, duration:25, musicPath:'music/a song.wav', narrationPath:'voice with spaces.wav', musicVolume:.2, outputPath:'output/video.mp4'});
  assert.ok(args.includes('voice with spaces.wav'));
  assert.ok(args.includes('music/a song.wav'));
  assert.match(args[args.indexOf('-filter_complex') + 1], /volume=0\.076/);
  assert.ok(!args.includes('-shortest'));
  assert.ok(args.includes('-n'));
});
