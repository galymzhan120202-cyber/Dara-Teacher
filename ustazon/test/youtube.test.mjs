import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {uploadURL,uploadMetadata,verifyChannel,resumableUpload} from '../youtube.mjs';
const url='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=test';
const id='abcdefghijk';
const respond=(data,status=200,headers={})=>new Response(data===null?null:JSON.stringify(data),{status,headers});
test('channel pin and upload host prevent posting to an unintended destination',async()=>{
  assert.throws(()=>uploadURL('https://example.org/upload'),/Untrusted/);
  assert.throws(()=>uploadURL('https://www.googleapis.com.evil.example/upload/youtube/v3/videos'),/Untrusted/);
  await assert.rejects(verifyChannel('token','expected',async()=>respond({items:[{id:'another',snippet:{title:'Other'}}]})),/does not match/);
});
test('scheduled uploads start private with the correct language and never use a past schedule',()=>{
  const info={status:'complete',draft:false,title:'Пример',description:'Описание',language:'ru',tags:['Ustazon']};
  const body=uploadMetadata(info,'2026-11-14T10:00:00Z','schedule',new Date('2026-11-14T09:00:00Z'));
  assert.equal(body.status.privacyStatus,'private');assert.equal(body.snippet.defaultLanguage,'ru');
  assert.equal(body.status.selfDeclaredMadeForKids,false);
  assert.throws(()=>uploadMetadata({...info,draft:true},null,'now'),/production/);
  assert.throws(()=>uploadMetadata(info,'2026-11-14T08:00:00Z','schedule',new Date('2026-11-14T09:00:00Z')),/future/);
});
test('ambiguous final upload resumes the same session without creating a duplicate',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-upload-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'video.mp4');await fs.writeFile(file,Buffer.from('example video'));
  const record={},requests=[];let saves=0;
  const fetchImpl=async(address,options)=>{
    requests.push({address,method:options.method,range:options.headers['Content-Range']});
    if(options.method==='POST')return respond(null,200,{location:url});
    if(requests.length===2)return respond(null,308);
    if(requests.length===3)throw new Error('response lost after server accepted all bytes');
    return respond({id,status:{privacyStatus:'private'}},201);
  };
  const args={file,body:{status:{privacyStatus:'private'}},record,save:async()=>saves++,token:'test',fetchImpl};
  await assert.rejects(resumableUpload(args),/connection interrupted/);
  assert.equal(record.sessionUrl,url);assert.equal(record.videoId,undefined);
  assert.equal(await resumableUpload(args),id);
  assert.equal(requests.filter(r=>r.method==='POST').length,1);
  assert.equal(requests.at(-1).range,'bytes */13');assert(saves>=4);
  const count=requests.length;assert.equal(await resumableUpload(args),id);assert.equal(requests.length,count);
});
test('an expired upload is not silently recreated, and changed video bytes cannot reuse a session',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-expired-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'video.mp4');await fs.writeFile(file,'abc');
  const args={file,body:{},record:{sessionUrl:url},save:async()=>{},token:'test',fetchImpl:async()=>respond(null,404)};
  await assert.rejects(resumableUpload(args),/expired/);
  await fs.writeFile(file,'different');
  await assert.rejects(resumableUpload(args),/changed/);
});
