import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadImage} from '@napi-rs/canvas';
export const MATERIAL_DIR=fileURLToPath(new URL('./assets/materials/',import.meta.url));
export async function loadVisualAssets(dir=MATERIAL_DIR) {
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.assets))throw new Error('Invalid material manifest');
  const images=new Map();
  for(const asset of manifest.assets) {
    if(!/^[a-z0-9-]+$/.test(asset.id)||images.has(asset.id)||!/^[a-z0-9-]+\.(png|jpg)$/.test(asset.file))throw new Error('Invalid material asset');
    const data=await fs.readFile(path.join(dir,asset.file));
    if(createHash('sha256').update(data).digest('hex')!==asset.sha256)throw new Error('Material asset checksum mismatch: '+asset.id);
    images.set(asset.id,{...asset,image:await loadImage(data)});
  }
  return images;
}
