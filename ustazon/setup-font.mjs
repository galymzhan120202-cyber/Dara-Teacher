import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [name, url] of [
  ['InterVariable.ttf', 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf'],
  ['Inter-OFL.txt', 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt'],
]) {
  const output = path.join(root, 'fonts', name);
  try { await fs.access(output); continue; } catch {}
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Font download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (name.endsWith('.ttf') && bytes.readUInt32BE(0) !== 0x00010000) throw new Error('Invalid TrueType download');
  await fs.writeFile(output, bytes, {flag:'wx'});
  console.log(`Saved fonts/${name}`);
}
