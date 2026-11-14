import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadProject, createTimeline, nextTopic} from './model.mjs';
import {localizedTheme} from './localize.mjs';
import {makeRenderer} from './draw.mjs';
import {renderVideo} from './encode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELP = `Ustazon — логотипсіз Shorts генераторы

node ustazon/cli.mjs list
node ustazon/cli.mjs check
node ustazon/cli.mjs render --topic urinary-observe-kk
node ustazon/cli.mjs preview --topic diffusion-excerpt-ru
node ustazon/cli.mjs next

Options:
  --topic ID       Catalog topic (default: first verified topic)
  --draft          540×960, 24 FPS preview video
  --width NUMBER  Width in pixels; height is always 16/9 of width
  --fps NUMBER    8–60 (default: 30)
  --theme FILE    JSON theme (default: ustazon/theme.json)
  --catalog FILE  JSON catalog (default: ustazon/catalog.json)
  --output DIR    Parent output directory (default: ustazon/output)
  --narration FILE  Optional recorded narration, following narration.txt timings
  --no-music      Disable the local background track

render/next create MP4, storyboard, thumbnail, captions and YouTube metadata.
preview creates images and script only. No command publishes or sends messages.
next chooses a topic not yet successfully rendered; it stops when the queue is empty.
`;

function parse(argv) {
  const options = {};
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'render';
  if (!['render', 'preview', 'next', 'list', 'check'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const flags = new Set(['--draft', '--no-music', '--help']);
  const values = new Set(['--topic', '--width', '--fps', '--theme', '--catalog', '--output', '--narration']);
  while (argv.length) {
    const key = argv.shift();
    if (flags.has(key)) options[key.slice(2)] = true;
    else if (values.has(key)) {
      const value = argv.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key.slice(2)] = value;
    } else throw new Error(`Unknown option: ${key}`);
  }
  return {command, options};
}

async function readHistory(file) {
  try {
    const records = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(records)) throw new Error('History must be an array');
    return records;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function main() {
  const {command, options} = parse(process.argv.slice(2));
  if (options.help) {console.log(HELP); return;}
  const project = await loadProject(options.catalog ? path.resolve(options.catalog) : path.join(here, 'catalog.json'), options.theme ? path.resolve(options.theme) : path.join(here, 'theme.json'));
  if (command === 'list') {
    for (const topic of project.catalog.topics) console.log(`${topic.id.padEnd(17)} ${topic.title}`);
    return;
  }
  const width = options.width === undefined ? options.draft ? 540 : 1080 : Number(options.width);
  const fps = options.fps === undefined ? options.draft ? 24 : 30 : Number(options.fps);
  if (command === 'check') {
    for (const topic of project.catalog.topics) {
      const timeline = createTimeline(topic, fps);
      const renderer = makeRenderer(localizedTheme(project.theme,topic.language||'kk'), timeline, {width, height:width * 16 / 9, fontPath:project.fontPath, assets:project.visualAssets});
      for (const scene of timeline.scenes) renderer.draw(scene.startFrame + fps);
      console.log(`OK ${topic.id}: ${timeline.duration}s, ${topic.scenes.length} scenes`);
    }
    return;
  }
  const stateDir = path.join(here, '.state');
  const historyFile = path.join(stateDir, 'history.json');
  let lock;
  const lockPath = path.join(stateDir, 'render.lock');
  if (command !== 'preview') {
    await fs.mkdir(stateDir, {recursive:true});
    try {lock = await fs.open(lockPath, 'wx');}
    catch (error) {if (error.code === 'EEXIST') throw new Error('A render lock exists at ustazon/.state/render.lock. Wait for the active render; after a crashed process, remove only that stale lock.'); throw error;}
    await lock.writeFile(JSON.stringify({pid:process.pid, startedAt:new Date().toISOString()}));
  }
  try {
    const history = await readHistory(historyFile);
    const topic = command === 'next' ? nextTopic(project.catalog, project.theme, history) : project.catalog.topics.find(item => item.id === (options.topic || project.catalog.topics[0].id));
    if (!topic) {
      if (command === 'next') {console.log('No new topics. Add verified material to catalog.json to continue.'); return;}
      throw new Error(`Unknown topic: ${options.topic}`);
    }
    const parent = options.output ? path.resolve(options.output) : path.join(here, 'output');
    await fs.mkdir(parent, {recursive:true});
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${topic.id}_${randomUUID().slice(0, 6)}`;
    const outputDir = path.join(parent, name);
    console.log(`${command === 'preview' ? 'Storyboard' : 'Rendering'}: ${topic.title}`);
    const result = await renderVideo({...project,theme:localizedTheme(project.theme,topic.language||'kk')}, topic, {outputDir, width, fps, previewOnly:command === 'preview', draft:Boolean(options.draft), noMusic:options['no-music'],
      narrationPath:options.narration ? path.resolve(options.narration) : null,
      onProgress: value => console.log(`${Math.round(value * 100)}%`)});
    if (command !== 'preview') {
      history.push({topicId:topic.id, fingerprint:result.info.fingerprint, status:options.draft ? 'draft' : 'complete', outputDir, completedAt:new Date().toISOString()});
      const temporary = path.join(stateDir, `history.${process.pid}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(history, null, 2) + '\n');
      await fs.rename(temporary, historyFile);
    }
    console.log(`Ready: ${command === 'preview' ? path.join(outputDir, 'storyboard.png') : result.outputPath}`);
  } finally {
    if (lock) {await lock.close(); await fs.unlink(lockPath);}
  }
}

main().catch(error => {console.error(`Ustazon: ${error.message}`); process.exitCode = 1;});
