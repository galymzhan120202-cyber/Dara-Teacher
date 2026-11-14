import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as sqlite from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readJSON} from './state.mjs';

const Database=sqlite.Database || sqlite.DatabaseSync;
const inactiveOwners=new Set();
export function processAlive(pid) {
  if(!Number.isInteger(pid)||pid<1)return true;
  try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
export class Store {
  constructor(file,{isAlive=processAlive,hostname=os.hostname()}={}) {
    this.file=file;this.isAlive=isAlive;this.hostname=hostname;this.owner=randomUUID();this.cache=new Map();this.controlCache='';
    this.db=new Database(file,{timeout:5000});
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,date TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);"+
      "CREATE INDEX IF NOT EXISTS jobs_date ON jobs(date);"+
      "CREATE TABLE IF NOT EXISTS claims(kind TEXT NOT NULL,fingerprint TEXT NOT NULL,job_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(kind,fingerprint));"+
      "CREATE TABLE IF NOT EXISTS publications(job_id TEXT PRIMARY KEY,video_id TEXT UNIQUE NOT NULL,channel_id TEXT,completed_at TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,hostname TEXT NOT NULL,heartbeat TEXT NOT NULL);");
    const check=this.db.prepare('PRAGMA quick_check').get();
    if(Object.values(check)[0]!=='ok')throw new Error('Queue database integrity check failed. Publishing stopped; retain the database and backups for recovery.');
    const version=this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if(version&&version.value!=='1')throw new Error('Unsupported queue database version');
    this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('schema','1')").run();
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try{const result=action();this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  acquire(name='cycle') {
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM locks WHERE name=?').get(name);
      if(old&&old.owner!==this.owner&&!(old.pid===process.pid&&inactiveOwners.has(old.owner))&&(old.hostname!==this.hostname||this.isAlive(old.pid))) {
        const error=new Error('Another bot process is active (PID '+old.pid+').');error.code='BOT_BUSY';throw error;
      }
      this.db.prepare('INSERT OR REPLACE INTO locks VALUES(?,?,?,?,?)').run(name,this.owner,process.pid,this.hostname,new Date().toISOString());
    });
  }
  assertOwner(name='cycle') {
    if(this.db.prepare('SELECT owner FROM locks WHERE name=?').get(name)?.owner!==this.owner) {
      const error=new Error('Bot no longer owns the queue lock.');error.code='LOCK_LOST';throw error;
    }
  }
  heartbeat(name='cycle') {
    this.db.prepare('UPDATE locks SET heartbeat=? WHERE name=? AND owner=?').run(new Date().toISOString(),name,this.owner);
  }
  release(name='cycle'){this.db.prepare('DELETE FROM locks WHERE name=? AND owner=?').run(name,this.owner);}
  load() {
    const jobs=this.db.prepare('SELECT payload FROM jobs ORDER BY date,id').all().map(row=>JSON.parse(row.payload));
    for(const job of jobs)this.cache.set(job.id,JSON.stringify(job));
    const row=this.db.prepare("SELECT value FROM meta WHERE key='control'").get();
    const control=row?JSON.parse(row.value):{requests:{},controls:{},maintenance:{}};
    this.controlCache=JSON.stringify(control);
    return {version:1,jobs,requests:control.requests||{},controls:control.controls||{},maintenance:control.maintenance||{},geminiBudget:control.geminiBudget||null};
  }
  save(state) {
    this.assertOwner();
    const changes=state.jobs.map(job=>[job,JSON.stringify(job)]).filter(([job,value])=>this.cache.get(job.id)!==value);
    const control=JSON.stringify({requests:state.requests,controls:state.controls||{},maintenance:state.maintenance||{},geminiBudget:state.geminiBudget||null});
    if(!changes.length&&this.controlCache===control)return;
    this.transaction(()=>{
      const upsert=this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date,status=excluded.status,payload=excluded.payload');
      for(const [job,value] of changes) {
        const published=this.db.prepare('SELECT video_id FROM publications WHERE job_id=?').get(job.id);
        if(published&&job.youtube?.videoId!==published.video_id)throw new Error('Cannot erase or replace a completed publication receipt: '+job.id);
        if(job.youtube?.videoId) {
          this.db.prepare('INSERT OR IGNORE INTO publications VALUES(?,?,?,?)').run(job.id,job.youtube.videoId,job.youtube.channelId||null,job.youtube.completedAt||new Date().toISOString());
          const receipt=this.db.prepare('SELECT video_id FROM publications WHERE job_id=?').get(job.id);
          if(receipt?.video_id!==job.youtube.videoId)throw new Error('Conflicting publication receipt');
        }
        upsert.run(job.id,job.date,job.status,value);
      }
      if(this.controlCache!==control)this.db.prepare("INSERT INTO meta VALUES('control',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(control);
    });
    for(const [job,value] of changes)this.cache.set(job.id,value);
    this.controlCache=control;
  }
  claim(kind,fingerprint,jobId) {
    if(!fingerprint)return;
    this.assertOwner();
    this.transaction(()=>{
      const found=this.db.prepare('SELECT job_id FROM claims WHERE kind=? AND fingerprint=?').get(kind,fingerprint);
      if(found&&found.job_id!==jobId){const e=new Error('Duplicate '+kind+' already reserved by '+found.job_id);e.code='DUPLICATE';throw e;}
      this.db.prepare('INSERT OR IGNORE INTO claims VALUES(?,?,?,?)').run(kind,fingerprint,jobId,new Date().toISOString());
    });
  }
  ownerOf(kind,fingerprint){return this.db.prepare('SELECT job_id FROM claims WHERE kind=? AND fingerprint=?').get(kind,fingerprint)?.job_id;}
  async migrate(legacy) {
    if(this.db.prepare("SELECT value FROM meta WHERE key='migration'").get())return;
    const state=await readJSON(legacy,{version:1,jobs:[],requests:{}});
    if(state.version!==1||!Array.isArray(state.jobs)||!state.requests)throw new Error('Legacy queue is invalid; migration stopped without deleting it.');
    this.save({...state,controls:state.controls||{},maintenance:state.maintenance||{}});
    this.db.prepare("INSERT INTO meta VALUES('migration',?)").run(JSON.stringify({at:new Date().toISOString(),jobs:state.jobs.length,source:path.basename(legacy)}));
  }
  async backup(directory,date) {
    await fs.mkdir(directory,{recursive:true});
    const file=path.join(directory,'ustazon-'+date+'.sqlite');
    try{await fs.access(file);return file;}catch(e){if(e.code!=='ENOENT')throw e;}
    const temporary=file+'.'+randomUUID()+'.tmp';
    // SQLite's online backup includes committed WAL pages; never copy a live DB file directly.
    await sqlite.backup(this.db,temporary);
    const check=new Database(temporary);
    try{check.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; DELETE FROM locks;');if(Object.values(check.prepare('PRAGMA quick_check').get())[0]!=='ok')throw new Error('Backup failed integrity check');}
    finally{check.close();}
    await fs.rename(temporary,file);return file;
  }
  stats(){return {jobs:this.db.prepare('SELECT count(*) AS n FROM jobs').get().n,publications:this.db.prepare('SELECT count(*) AS n FROM publications').get().n,claims:this.db.prepare('SELECT count(*) AS n FROM claims').get().n};}
  close(){this.db.close();inactiveOwners.add(this.owner);}
}
export async function openStore(directory,options) {
  await fs.mkdir(directory,{recursive:true});
  // A receipt is never reconstructed from an older JSON snapshot automatically.
  const file=path.join(directory,'bot.sqlite'),marker=path.join(directory,'database-initialized.json');
  const hasMarker=await fs.access(marker).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;});
  const hasDB=await fs.access(file).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;});
  if(hasMarker&&!hasDB)throw new Error('Queue database is missing. Refusing to recreate it from an older snapshot because videos could be published twice.');
  const store=new Store(file,options);
  try {
    store.acquire();
    await store.migrate(path.join(directory,'daily.json'));
    if(!hasMarker)await fs.writeFile(marker,JSON.stringify({database:'bot.sqlite',createdAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
    store.release();return store;
  }catch(error){store.release();store.close();throw error;}
}
