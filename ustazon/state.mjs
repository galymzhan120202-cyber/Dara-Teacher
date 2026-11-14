import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export async function readJSON(file, fallback) {
  try {return JSON.parse(await fs.readFile(file, 'utf8'));} catch(error) {if(error.code === 'ENOENT') return structuredClone(fallback); throw error;}
}
export async function writeJSON(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp';
  const handle=await fs.open(temporary,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}
  finally {await handle.close();}
  try {await fs.rename(temporary,file);}
  catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
}

export async function withLock(file, action) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  let handle;
  try {handle = await fs.open(file, 'wx', 0o600);}
  catch(error) {
    if(error.code !== 'EEXIST') throw error;
    const owner = await readJSON(file, null).catch(() => null);
    throw new Error('Another daily bot run owns ' + path.basename(file) + (owner?.pid ? ' (PID ' + owner.pid + ')' : '') + '. After a crash, verify the process has stopped before removing this lock.');
  }
  try {await handle.writeFile(JSON.stringify({pid:process.pid, startedAt:new Date().toISOString()})); return await action();}
  finally {await handle.close(); await fs.unlink(file);}
}
