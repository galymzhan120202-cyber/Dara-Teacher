// Local pause-aware timing. This is not speech recognition or forced word alignment.
export function captionChunks(text) {
  const result=[];let words=[];
  for(const word of text.trim().split(/\s+/)) {
    if(words.length&&(words.length>=4||[...words,word].join(' ').length>42)){result.push(words.join(' '));words=[];}
    words.push(word);
    if(/[.!?;:]$/.test(word)){result.push(words.join(' '));words=[];}
  }
  if(words.length)result.push(words.join(' '));
  return result;
}
const weight=text=>Math.max(1,(text.match(/[аеёиоуыэюяәіөұүaeiou]/giu)||[]).length);

export function speechRegions(wav,duration) {
  if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')return [];
  let fmt,data;
  for(let pos=12;pos+8<=wav.length;) {
    const size=wav.readUInt32LE(pos+4),end=pos+8+size;
    if(end>wav.length)break;
    const id=wav.toString('ascii',pos,pos+4);
    if(id==='fmt '&&size>=16)fmt={format:wav.readUInt16LE(pos+8),channels:wav.readUInt16LE(pos+10),rate:wav.readUInt32LE(pos+12),bits:wav.readUInt16LE(pos+22)};
    if(id==='data')data=wav.subarray(pos+8,end);
    pos=end+(size%2);
  }
  if(!fmt||!data||fmt.format!==1||fmt.bits!==16||fmt.channels<1||fmt.channels>8||fmt.rate<8000)return [];
  const step=Math.max(1,Math.round(fmt.rate*.02)),samples=Math.floor(data.length/(fmt.channels*2)),energy=[];
  for(let offset=0;offset<samples;offset+=step){
    let sum=0,count=0;
    for(let i=offset;i<Math.min(samples,offset+step);i++)for(let ch=0;ch<fmt.channels;ch++){const n=data.readInt16LE((i*fmt.channels+ch)*2)/32768;sum+=n*n;count++;}
    energy.push(Math.sqrt(sum/count));
  }
  const peak=energy.reduce((a,b)=>Math.max(a,b),0),threshold=Math.max(.001,peak*.025);
  const regions=[];
  for(let i=0;i<energy.length;i++)if(energy[i]>=threshold){
    const start=Math.max(0,i*step/fmt.rate-.04),end=Math.min(duration,(i+1)*step/fmt.rate+.04);
    if(end<=start)continue;
    const prev=regions.at(-1);
    if(prev&&start-prev.end<.14)prev.end=end;else regions.push({start,end});
  }
  return regions.filter(r=>r.end-r.start>=.08);
}

export function makeCaptionTiming(text,duration,regions=[]) {
  const sentences=[];let sentence=[];
  for(const chunk of captionChunks(text)){
    sentence.push(chunk);
    if(/[.!?]$/.test(chunk)){sentences.push(sentence.join(' '));sentence=[];}
  }
  if(sentence.length)sentences.push(sentence.join(' '));
  // When acoustic phrases and sentences agree, keep sentence changes at real pauses.
  if(sentences.length>1&&sentences.length===regions.length){
    const cues=sentences.flatMap((sentence,i)=>{
      const region=regions[i];
      return makeCaptionTiming(sentence,region.end-region.start).cues.map(c=>({...c,start:c.start+region.start,end:c.end+region.start}));
    });
    return {version:1,method:'audio-pauses',cues};
  }
  const chunks=captionChunks(text),valid=regions.length?regions:[{start:0,end:duration}];
  const total=valid.reduce((sum,r)=>sum+r.end-r.start,0),weights=chunks.map(weight),sum=weights.reduce((a,b)=>a+b,0);
  const at=(position,isEnd)=>{
    let passed=0;
    for(const [i,r] of valid.entries()){
      const length=r.end-r.start;
      if(position<passed+length-1e-8 || (isEnd&&position<=passed+length+1e-8)||i===valid.length-1)return Math.min(r.end,r.start+Math.max(0,position-passed));
      passed+=length;
    }
  };
  let passed=0;
  const cues=chunks.map((text,i)=>{const start=at(total*passed/sum,false);passed+=weights[i];return {text,start,end:at(total*passed/sum,true)};});
  return {version:1,method:regions.length?'audio-pauses':'estimated',cues};
}

export function validateCaptionTiming(timing,text,duration) {
  if(!timing||timing.version!==1||!['audio-pauses','estimated'].includes(timing.method)||!Array.isArray(timing.cues)||!timing.cues.length)throw new Error('Invalid caption timing');
  if(timing.cues.map(c=>c.text).join(' ').replace(/\s+/g,' ')!==text.trim().replace(/\s+/g,' '))throw new Error('Caption transcript differs from narration');
  let end=0;
  for(const cue of timing.cues){
    if(typeof cue.text!=='string'||!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<end-1e-6||cue.end<=cue.start||cue.end>duration+.001)throw new Error('Invalid caption interval');
    end=cue.end;
  }
  return timing;
}
