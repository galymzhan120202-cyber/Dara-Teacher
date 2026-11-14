import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {uploadURL,uploadMetadata,verifyChannel,resumableUpload,checkConnection} from '../youtube.mjs';
const url='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=test';
const id='abcdefghijk';
const respond=(data,status=200,headers={})=>new Response(data===null?null:JSON.stringify(data),{status,headers});
async function connectedFixture(t,tokenOverrides={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ustazon-oauth-check-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('ustazon-oauth-check-'));
    await fs.rm(dir,{recursive:true,force:true});
  });
  const config={youtube:{expectedChannelId:'UC'+'a'.repeat(22),clientFile:path.join(dir,'client.json'),tokenFile:path.join(dir,'token.json')}};
  const stored={channelId:config.youtube.expectedChannelId,access_token:'old-access',refresh_token:'offline-secret',expiresAt:Date.now()+3600000,
    scope:'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',...tokenOverrides};
  await fs.writeFile(config.youtube.clientFile,JSON.stringify({installed:{client_id:'client-id',client_secret:'client-secret'}}));
  await fs.writeFile(config.youtube.tokenFile,JSON.stringify(stored));
  return {config,stored};
}
test('connection check proves refresh works and reads the pinned channel without uploading',async t=>{
  const {config}=await connectedFixture(t),calls=[];
  const result=await checkConnection(config,{fetchImpl:async(address,options)=>{
    calls.push(address);
    if(address==='https://oauth2.googleapis.com/token') {
      assert.equal(options.method,'POST');assert.equal(options.body.get('grant_type'),'refresh_token');
      return respond({access_token:'new-access',expires_in:3600});
    }
    assert.equal(address,'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true');
    assert.equal(options.headers.Authorization,'Bearer new-access');assert.equal(options.method,undefined);
    return respond({items:[{id:config.youtube.expectedChannelId,snippet:{title:'Test channel'}}]});
  }});
  assert.deepEqual(result,{id:config.youtube.expectedChannelId,title:'Test channel',offlineAccess:true,refreshVerified:true});
  assert.equal(calls.length,2);
  const saved=JSON.parse(await fs.readFile(config.youtube.tokenFile,'utf8'));
  assert.equal(saved.access_token,'new-access');assert.equal(saved.refresh_token,'offline-secret');
});
test('connection check rejects a missing upload grant before any network request',async t=>{
  const {config}=await connectedFixture(t,{scope:'https://www.googleapis.com/auth/youtube.readonly'});
  await assert.rejects(checkConnection(config,{fetchImpl:async()=>assert.fail('No API call should be made')}),/both required/);
});
test('connection check detects revoked credentials without logging secrets or replacing the stored token',async t=>{
  const {config,stored}=await connectedFixture(t);
  await assert.rejects(checkConnection(config,{fetchImpl:async()=>respond({error:'invalid_grant',error_description:'offline-secret client-secret'},400)}),error=>{
    assert.match(error.message,/invalid_grant/);assert.doesNotMatch(error.message,/offline-secret|client-secret/);return true;
  });
  assert.deepEqual(JSON.parse(await fs.readFile(config.youtube.tokenFile,'utf8')),stored);
});
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
