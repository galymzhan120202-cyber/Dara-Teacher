import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCanvas} from '@napi-rs/canvas';
import {loadProject, validateCatalog, validateTheme, createTimeline, sceneAt, nextTopic, fingerprint, subtitles, metadata} from '../model.mjs';
import {localizedTheme} from '../localize.mjs';
import {makeRenderer, fitText} from '../draw.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = await loadProject(path.join(root, 'catalog.json'), path.join(root, 'theme.json'));

test('all frame rates cover the complete timeline without a missing or repeated boundary', () => {
  for (const fps of [8, 24, 30, 60]) {
    const topic = structuredClone(project.catalog.topics[0]);
    topic.scenes[0].duration = 3.33;
    const timeline = createTimeline(topic, fps);
    for (let frame = 0; frame < timeline.frames; frame++) {
      const scene = sceneAt(timeline, frame);
      assert.ok(frame >= scene.startFrame && frame < scene.endFrame);
    }
    timeline.scenes.forEach((scene, i) => {
      assert.equal(sceneAt(timeline, scene.startFrame).index, i);
      assert.equal(sceneAt(timeline, scene.endFrame - 1).index, i);
      if (i) assert.equal(timeline.scenes[i - 1].endFrame, scene.startFrame);
    });
    assert.throws(() => sceneAt(timeline, timeline.frames));
    assert.equal(timeline.scenes.at(-1).end, timeline.duration);
  }
});

test('next skips only completed content, retries failures and recognises corrected scripts', () => {
  const {catalog, theme} = project;
  const first = catalog.topics[0];
  assert.equal(nextTopic(catalog, theme, [{fingerprint:fingerprint(first, theme), status:'failed'}]).id, first.id);
  assert.equal(nextTopic(catalog, theme, [{fingerprint:fingerprint(first, theme), status:'draft'}]).id, first.id);
  const history = catalog.topics.map(topic => ({fingerprint:fingerprint(topic, theme), status:'complete'}));
  assert.equal(nextTopic(catalog, theme, history), null);
  const revised = structuredClone(catalog);
  revised.topics[0].scenes[0].body += ' Жаңа мазмұн.';
  assert.equal(nextTopic(revised, theme, history).id, first.id);
  const recolored = structuredClone(theme); recolored.colors.primary = '#24633b';
  assert.equal(nextTopic(catalog, recolored, history), null, 'color changes alone must not flood the queue with repeats');
});

test('malformed input fails before rendering or running external tools', () => {
  for (const modify of [
    data => data.topics[0].sourceRefs = [],
    data => data.topics[0].scenes[0].duration = NaN,
    data => data.topics[1].id = data.topics[0].id,
    data => data.topics[0].scenes[0].visual = 'unknown',
    data => data.topics[0].id = '../escape',
  ]) {
    const bad = structuredClone(project.catalog); modify(bad);
    assert.throws(() => validateCatalog(bad));
  }
  const theme = structuredClone(project.theme); theme.music.volume = 4;
  assert.throws(() => validateTheme(theme));
  assert.throws(() => createTimeline(project.catalog.topics[0], 0));
});

test('SRT cues cover each complete script with ordered millisecond timestamps', () => {
  const topic = project.catalog.topics[0], timeline = createTimeline(topic);
  const srt = subtitles(timeline);
  const cues = srt.trim().split(/\n\n/);
  const parseTime = text => {
    const [h, m, s, ms] = text.split(/[:,]/).map(Number);
    return h * 3600000 + m * 60000 + s * 1000 + ms;
  };
  let end = 0;
  cues.forEach((cue, i) => {
    const lines = cue.split('\n');
    assert.equal(+lines[0], i + 1);
    const [from, to] = lines[1].split(' --> ').map(parseTime);
    assert.equal(from, end); assert.ok(to > from); end = to;
    assert.ok(lines.slice(2).length <= 2);
  });
  assert.equal(end, timeline.duration * 1000);
  const combined = cues.flatMap(cue => cue.split('\n').slice(2)).join(' ').replace(/\s+/g, ' ');
  assert.equal(combined, topic.scenes.map(scene => scene.narration).join(' '));
});

test('all shipped Kazakh headlines, descriptions and steps fit their drawing regions', () => {
  for (const topic of project.catalog.topics) {
    const timeline = createTimeline(topic);
    const renderer = makeRenderer(localizedTheme(project.theme,topic.language||'kk'), timeline, {width:270 * 2, height:480 * 2, fontPath:project.fontPath,assets:project.visualAssets});
    for (const [i, layout] of renderer.layouts.entries()) {
      const scene = timeline.scenes[i];
      const end = 400 + layout.headline.height + (layout.body?.height ?? 0);
      assert.ok(end <= (scene.kind === 'cta' ? 830 : scene.visual==='asset'?750:910), `${topic.id}/${i}: text overlaps illustration at ${end}`);
      renderer.draw(scene.startFrame + timeline.fps);
    }
    const a = renderer.draw(31).toBuffer('image/png');
    renderer.draw(timeline.frames - 1);
    const b = renderer.draw(31).toBuffer('image/png');
    assert.deepEqual(a, b, 'out-of-order sampling must not change a rendered frame');
  }
});

test('unrenderable text and invalid frame sizes fail instead of silently clipping', () => {
  const ctx = createCanvas(100, 100).getContext('2d');
  assert.throws(() => fitText(ctx, 'W'.repeat(400), {width:100, height:80, size:40, min:30, family:project.theme.font.family}));
  assert.throws(() => makeRenderer(project.theme, createTimeline(project.catalog.topics[0]), {width:541, height:960, fontPath:project.fontPath}));
});

test('metadata keeps source references separate and includes the approved website', () => {
  const topic = project.catalog.topics[0];
  const result = metadata(topic, project.theme, createTimeline(topic));
  assert.equal(result.categoryId, '27');
  assert.equal(result.language, 'kk');
  assert.equal(result.madeForKids, false);
  assert.deepEqual(result.sources, topic.sourceRefs);
  assert.doesNotMatch(result.description, /USTAZON_CONTEXT|card \d+|\/opt\//);
  assert(result.description.includes('Сайт: https://ustaz.daralearn.kz/'));
  assert.equal(result.durationSeconds, 20);
});
