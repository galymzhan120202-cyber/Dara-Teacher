import {tr} from './localize.mjs';
import {captionCues} from './model.mjs';
import {createCanvas, GlobalFonts} from '@napi-rs/canvas';

const W = 1080, H = 1920;
const registeredFonts=new Set();
const clamp = n => Math.max(0, Math.min(1, n));
const ease = n => 1 - (1 - clamp(n)) ** 3;

export function wrapLines(ctx, text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      if (ctx.measureText(word).width > width) throw new Error(`Word cannot fit: ${word}`);
      const trial = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(trial).width > width) { lines.push(line); line = word; }
      else line = trial;
    }
    lines.push(line);
  }
  return lines;
}

export function fitText(ctx, text, {width, height, size, min = size, weight = 600, family}) {
  for (let candidate = size; candidate >= min; candidate -= 2) {
    ctx.font = `${weight} ${candidate}px ${family}`;
    let lines;
    try { lines = wrapLines(ctx, text, width); } catch { continue; }
    const lineHeight = candidate * 1.2;
    if (lines.length * lineHeight <= height) return {lines, size: candidate, lineHeight, height: lines.length * lineHeight, weight, family};
  }
  throw new Error(`Text does not fit the video safe area: ${text}`);
}

function paintText(ctx, layout, x, y, color) {
  ctx.font = `${layout.weight} ${layout.size}px ${layout.family}`;
  ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillStyle = color;
  layout.lines.forEach((line, i) => ctx.fillText(line, x, y + i * layout.lineHeight));
}

function roundRect(ctx, x, y, w, h, radius, fill, stroke) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}

function line(ctx, points, color, width = 6) {
  ctx.beginPath(); ctx.moveTo(...points[0]);
  points.slice(1).forEach(point => ctx.lineTo(...point));
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}

function circle(ctx, x, y, r, color) {ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();}

function smallText(ctx, text, x, y, size, color, family, weight = 600) {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = color; ctx.fillText(text, x, y);
}

function triangle(ctx, c, x = 240, y = 60, size = 300) {
  line(ctx, [[x, y + size], [x + size * .5, y], [x + size, y + size], [x, y + size]], c.primary, 10);
  for (const [px, py] of [[x, y + size], [x + size * .5, y], [x + size, y + size]]) circle(ctx, px, py, 13, c.primary);
  line(ctx, [[x + size * .5, y], [x + size * .5, y + size]], c.line, 4);
}

function illustration(ctx, visual, t, theme, scene) {
  const c = theme.colors, f = theme.font.family, r = theme.cardRadius;
  ctx.save();
  ctx.translate(96, 930 + Math.sin(t * 1.3) * 5);
  roundRect(ctx, 0, 0, 816, 470, r, c.white, c.line);
  if (visual === 'quiz') {
    const q=scene.quiz, answering=q.phase==='answer';
    smallText(ctx,tr(theme,answering?'ЖАУАБЫ':'АВТОРЛЫҚ МЫСАЛ'),48,42,28,c.muted,f);
    const equation=q.a+' '+(q.operator||'+')+' '+q.b+' = '+(answering?q.answer:'?');
    const eqLayout=fitText(ctx,equation,{width:720,height:130,size:100,min:72,weight:800,family:f});
    paintText(ctx,eqLayout,48,150,c.ink);
    if(q.phase==='question') {
      const remaining=Math.max(1,Math.ceil(scene.duration-t));
      const counting=t>=(scene.speechDuration || 3);
      const label=counting?String(Math.min(3,remaining))+' '+tr(theme,'СЕКУНД'):tr(theme,'ЖАУАБЫН ОЙЛАН');
      roundRect(ctx,48,330,720,88,26,c.primary);
      smallText(ctx,label,82,355,32,c.white,f,750);
    } else {
      line(ctx,[[48,355],[768,355]],c.line,7);
      if(answering)line(ctx,[[694,80],[715,101],[757,55]],c.primary,8);
    }
  } else if (visual === 'triangle' || visual === 'presentation') {
    roundRect(ctx, 28, 28, 760, 58, 14, c.background);
    smallText(ctx, visual === 'presentation' ? tr(theme, 'ПРЕЗЕНТАЦИЯ') : tr(theme, 'ГЕОМЕТРИЯ'), 52, 44, 24, c.muted, f);
    smallText(ctx, 'PPTX', 680, 44, 24, c.primary, f, 800);
    triangle(ctx, c, 282, 132, 235);
    line(ctx, [[74, 190], [220, 190]], c.line, 10);
    line(ctx, [[74, 226], [194, 226]], c.line, 10);
    line(ctx, [[74, 262], [204, 262]], c.line, 10);
    circle(ctx, 711, 382, 24, c.accent);
  } else if (visual === 'file') {
    roundRect(ctx, 252, 40, 290, 366, 18, c.background, c.line);
    smallText(ctx, 'PPTX', 289, 94, 62, c.primary, f, 800);
    for (let i = 0; i < 4; i++) line(ctx, [[293, 205 + i * 34], [490 - (i % 2) * 42, 205 + i * 34]], c.line, 9);
    circle(ctx, 546, 354, 62, c.primary);
    line(ctx, [[546, 318], [546, 372]], c.white, 8);
    line(ctx, [[520, 348], [546, 374], [572, 348]], c.white, 8);
  } else if (visual === 'counting' || visual === 'games') {
    smallText(ctx, visual === 'games' ? tr(theme, 'ОЙЫН АРҚЫЛЫ ҚАЙТАЛАУ') : tr(theme, 'ЗАТТАРДЫ САНАУ'), 48, 42, 28, c.muted, f);
    const number = 3;
    for (let i = 0; i < number; i++) {
      const x = 204 + i * 204, y = 222 + Math.sin(t * 1.7 + i) * 9;
      roundRect(ctx, x - 59, y - 59, 118, 118, 28, i === 1 ? c.accent : c.primary);
      smallText(ctx, String(i + 1), x - 21, y - 38, 70, i === 1 ? c.ink : c.white, f, 800);
    }
    roundRect(ctx, 225, 342, 366, 62, 31, c.background);
    smallText(ctx, tr(theme, 'Wordwall ойындары'), 264, 359, 27, c.primary, f);
  } else if (visual === 'worksheet' || visual === 'comparison') {
    smallText(ctx, tr(theme, 'САНДАРДЫ САЛЫСТЫРУ'), 48, 42, 28, c.muted, f);
    const rows = [['3', '<', '5'], ['8', '>', '6']];
    for (const [i, row] of rows.entries()) {
      row.forEach((value, j) => {
        const x = 126 + j * 200, y = 120 + i * 142;
        roundRect(ctx, x, y, 160, 110, 22, j === 1 ? c.primary : c.background);
        smallText(ctx, value, x + 57, y + 21, 64, j === 1 ? c.white : c.ink, f, 700);
      });
    }
  } else if (visual === 'plan') {
    smallText(ctx, tr(theme, 'САБАҚҚА ДАЙЫНДЫҚ'), 48, 42, 28, c.muted, f);
    [tr(theme, 'Пән мен сынып'), tr(theme, 'Сабақ тақырыбы'), tr(theme, 'Оқу мақсаты')].forEach((text, i) => {
      const y = 126 + i * 98;
      circle(ctx, 85, y + 19, 22, c.primary);
      line(ctx, [[75, y + 18], [82, y + 26], [97, y + 10]], c.white, 4);
      smallText(ctx, text, 135, y, 34, c.ink, f);
    });
  } else {
    const labels = visual === 'cta' ? [tr(theme, 'Сабаққа идея'), tr(theme, 'Мұғалімге көмек'), 'Ustazon'] : [tr(theme, 'Презентация'), tr(theme, 'Жұмыс парағы'), tr(theme, 'Ойындар')];
    labels.forEach((label, i) => {
      const y = 54 + i * 126, x = 50 + i * 28;
      roundRect(ctx, x, y, 660, 94, 24, i === 2 ? c.primary : c.background, i === 2 ? null : c.line);
      smallText(ctx, `0${i + 1}`, x + 26, y + 30, 27, i === 2 ? c.accent : c.muted, f, 800);
      smallText(ctx, label, x + 100, y + 25, 35, i === 2 ? c.white : c.ink, f, 700);
    });
  }
  ctx.restore();
}

function materialVisual(ctx,scene,asset,t,theme) {
  const c=theme.colors,f=theme.font.family,img=asset.image;
  const y=scene.layout==='takeaway'?820:760,h=scene.layout==='takeaway'?620:680;
  roundRect(ctx,96,y,816,h,28,c.white,c.line);
  roundRect(ctx,96,y,8,h,4,c.primary);
  const crop=scene.crop||[0,0,1,1];
  const sx=crop[0]*img.width,sy=crop[1]*img.height,sw=crop[2]*img.width,sh=crop[3]*img.height;
  const availableH=h-145,scale=Math.min(768/sw,availableH/sh);
  const w=sw*scale,ih=sh*scale,x=120+(768-w)/2,top=y+20+(availableH-ih)/2;
  ctx.save();ctx.beginPath();ctx.roundRect(118,y+18,772,availableH+4,16);ctx.clip();
  ctx.drawImage(img,sx,sy,sw,sh,x,top,w,ih);ctx.restore();
  const caption=fitText(ctx,scene.assetCaption,{width:740,height:70,size:28,min:24,weight:650,family:f});
  paintText(ctx,caption,126,y+h-116,c.ink);
  smallText(ctx,theme.language==='ru'?'Оригинал: казахский язык':'Түпнұсқа: қазақша',126,y+h-49,24,c.muted,f,500);
  if(scene.pauseSeconds&&t>=(scene.speechDuration||3)) {
    roundRect(ctx,792,y+22,86,72,20,c.primary);
    smallText(ctx,String(Math.max(1,Math.ceil(scene.duration-t))),822,y+39,36,c.white,f,750);
  }
}

export function makeRenderer(theme, timeline, {width = 1080, height = 1920, fontPath, captions = false, assets = new Map()} = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 180 || width > 2160 || width % 2 || height % 2 || width * 16 !== height * 9) throw new Error('Video size must be even pixels with a 9:16 aspect ratio (e.g. 1080×1920)');
  const fontKey=fontPath+'|'+theme.font.family;
  if(!registeredFonts.has(fontKey)){if(!GlobalFonts.registerFromPath(fontPath,theme.font.family))throw new Error('Cannot load font: '+fontPath);registeredFonts.add(fontKey);}
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.lang = theme.language === 'ru' ? 'ru' : 'kk';
  const c = theme.colors, f = theme.font.family;
  for(const scene of timeline.scenes)if(scene.visual==='asset'&&!assets.has(scene.assetId))throw new Error('Verified visual missing: '+scene.assetId);
  const layouts = timeline.scenes.map(scene => {
    const content = scene.kind === 'cta' ? theme.cta : scene;
    const headline = fitText(ctx, content.headline, {width: 816, height: scene.visual==='asset'?260:scene.kind === 'cta' ? 260 : 350, size: scene.visual==='asset'?86:scene.kind === 'cta' ? 94 : 96, min: 62, weight: 800, family: f});
    const body = content.body ? fitText(ctx, content.body, {width: 800, height: 210, size: 39, min: 32, weight: 450, family: f}) : null;
    const label = fitText(ctx, content.label, {width:816, height:48, size:27, min:23, weight:700, family:f});
    const action = scene.kind === 'cta' ? fitText(ctx, theme.cta.action, {width:680, height:100, size:40, min:30, weight:700, family:f}) : null;
    const steps = scene.steps?.map(text => fitText(ctx, text, {width:660, height:98, size:40, min:32, weight:650, family:f}));
    return {headline, body, label, action, steps};
  });

  const cues=captions?captionCues(timeline).map(cue=>({...cue,layout:fitText(ctx,cue.text,{width:764,height:100,size:34,min:28,weight:600,family:f})})):[];
  function draw(frame) {
    const scene = timeline.scenes.find(item => frame >= item.startFrame && frame < item.endFrame);
    if (!scene) throw new Error(`Invalid frame: ${frame}`);
    const local = (frame - scene.startFrame) / timeline.fps;
    const layout = layouts[scene.index], content = scene.kind === 'cta' ? theme.cta : scene;
    ctx.resetTransform(); ctx.globalAlpha = 1; ctx.clearRect(0, 0, width, height);
    ctx.scale(width / W, height / H);
    ctx.fillStyle = c.background; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = .45;
    circle(ctx, 1060, 420, 310, c.line);
    circle(ctx, -80, 1570, 270, c.line);
    ctx.globalAlpha = 1;
    smallText(ctx, theme.brand, 96, 126, 38, c.primary, f, 800);
    smallText(ctx, tr(theme, 'МҰҒАЛІМГЕ АРНАЛҒАН'), 559, 138, 22, c.muted, f);
    const gap = 10, segmentWidth = (816 - gap * (timeline.scenes.length - 1)) / timeline.scenes.length;
    timeline.scenes.forEach((item, i) => {
      roundRect(ctx, 96 + i * (segmentWidth + gap), 205, segmentWidth, 6, 3, c.line);
      const progress = clamp((frame - item.startFrame) / (item.endFrame - item.startFrame));
      if (progress) roundRect(ctx, 96 + i * (segmentWidth + gap), 205, segmentWidth * progress, 6, 3, c.primary);
    });
    const entry = ease(local / .7);
    ctx.save(); ctx.globalAlpha = .25 + entry * .75; ctx.translate(0, (1 - entry) * 38);
    paintText(ctx, layout.label, 96, 290, c.primary);
    paintText(ctx, layout.headline, 96, 368, c.ink);
    if (layout.body) paintText(ctx, layout.body, 96, 400 + layout.headline.height, c.muted);
    if (scene.kind === 'steps') {
      layout.steps.forEach((step, i) => {
        const reveal = ease((local - .25 * i) / .55);
        ctx.save(); ctx.globalAlpha *= .35 + reveal * .65;
        const y = 930 + i * 154;
        roundRect(ctx, 96 + (1 - reveal) * 24, y, 816, 124, theme.cardRadius, c.white, c.line);
        circle(ctx, 158, y + 62, 29, c.primary);
        smallText(ctx, String(i + 1), 148, y + 43, 32, c.white, f, 750);
        paintText(ctx, step, 218, y + (124 - step.height) / 2, c.ink);
        ctx.restore();
      });
    } else if (scene.kind === 'cta') {
      // Text brand only; no logo asset or screenshot is required.
      ctx.save(); ctx.translate(0, -100); illustration(ctx, 'cta', local, theme); ctx.restore();
      roundRect(ctx, 96, 1360, 816, 116, 32, c.primary);
      paintText(ctx, layout.action, 140, 1360 + (116 - layout.action.height) / 2, c.white);
      line(ctx, [[832, 1403], [850, 1418], [832, 1433]], c.white, 5);
    } else if(scene.visual==='asset') materialVisual(ctx,scene,assets.get(scene.assetId),local,theme);
    else illustration(ctx, scene.visual, local, theme, scene);
    ctx.restore();
    if(captions) {
      const cue=cues.find(item=>frame/timeline.fps>=item.start && frame/timeline.fps<item.end);
      if(cue) {
        roundRect(ctx,96,1510,816,140,24,c.ink);
        paintText(ctx,cue.layout,122,1510+(140-cue.layout.height)/2,c.white);
      }
    }
    smallText(ctx, scene.kind === 'cta' ? tr(theme, 'КЕЛЕСІ ВИДЕОДА КЕЗДЕСКЕНШЕ') : tr(theme, 'БІР САБАҚ. БІР ЖАҢА ИДЕЯ.'), 96, captions ? 1702 : 1607, 23, c.muted, f, 550);
    return canvas;
  }
  return {canvas, ctx, draw, layouts, width, height};
}

export function contactSheet(renderer, timeline) {
  const cellW = 270, cellH = 480, margin = 14;
  const sheet = createCanvas(timeline.scenes.length * (cellW + margin) + margin, cellH + margin * 2);
  const ctx = sheet.getContext('2d'); ctx.fillStyle = '#d6e7dc'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  timeline.scenes.forEach((scene, i) => {
    const sample = Math.min(scene.endFrame - 1, scene.startFrame + timeline.fps);
    ctx.drawImage(renderer.draw(sample), margin + i * (cellW + margin), margin, cellW, cellH);
  });
  return sheet.toBuffer('image/png');
}
