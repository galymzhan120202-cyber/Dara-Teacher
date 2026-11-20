export function localDate(now,timezone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const value=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return value.year+'-'+value.month+'-'+value.day;
}
export function validateDate(date) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new Error('Use a valid date in YYYY-MM-DD format');
  return date;
}
export function zonedTime(date,time,timezone) {
  validateDate(date);
  const target=Date.parse(date+'T'+time+':00Z');
  if(!Number.isFinite(target))throw new Error('Invalid slot time');
  let instant=target;
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<4;i++) {
    const p=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(item=>[item.type,item.value]));
    const local=Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':'+p.second+'Z');
    const delta=target-local; instant+=delta;
    if(!delta)return new Date(instant).toISOString();
  }
  throw new Error('Could not resolve slot in configured timezone');
}
export function slotsForDate(date,config) {
  validateDate(date);
  let slots=config.slots;
  if(config.formatRotation&&config.slots.length===1){const n=Math.floor((Date.parse(date)-Date.parse(config.formatRotation.startDate))/86400000);slots=config.slots.map(s=>({...s,format:config.formatRotation.formats[((n%3)+3)%3]}));}
  if(!config.languageRotation)return slots;
  const {mode,startDate}=config.languageRotation;
  if(mode!=='alternate-days')throw new Error('Unknown language rotation mode');
  validateDate(startDate);
  const days=(Date.parse(date+'T00:00:00Z')-Date.parse(startDate+'T00:00:00Z'))/86400000;
  if(days<0||days%2===0)return slots;
  return slots.map(slot=>({...slot,language:slot.language==='kk'?'ru':'kk'}));
}
export function planDay(state,date,config) {
  validateDate(date);
  const existing=state.jobs.filter(job=>job.date===date && job.slot!=='sample'&&!job.superseded&&!job.manualTest);
  if(config.slots.length===1&&existing.length>1){
    // Never silently migrate a day with an external publication in progress.
    if(existing.some(j=>j.youtube?.videoId||j.youtube?.sessionUrl||j.youtube?.initiating||Object.values(j.social||{}).some(r=>r.intent)))throw new Error('Review legacy multi-slot day before publishing with the daily limit');
    const target=slotsForDate(date,config)[0];
    const keep=existing.find(j=>j.language===target.language);
    for(const job of existing)if(job!==keep)job.superseded=true;
    if(keep){keep.slot=target.id;keep.publishAt=zonedTime(date,target.time,config.timezone);keep.socialEligible=true;return [keep];}
    return planDay(state,date,config);
  }
  // Once planned, a day keeps its identities and languages across config changes/restarts.
  if(existing.length)return existing;
  const carry=config.runtime?.carryUnfinished?state.jobs.filter(j=>j.date<date&&j.slot!=='sample'&&!j.superseded&&!j.manualTest&&!Object.values(j.social||{}).some(r=>r.intent||r.postId)&&!j.youtube?.videoId&&!j.youtube?.sessionUrl&&!j.youtube?.initiating&&j.status!=='uploaded'&&!Object.values(j.retries||{}).some(r=>r.kind==='attention')).sort((a,b)=>a.date.localeCompare(b.date)):[];
  const used=new Set(),jobs=[];
  for(const slot of slotsForDate(date,config)) {
    const candidates=carry.filter(j=>!used.has(j.id)&&j.language===slot.language);
    const previous=candidates.find(j=>j.format===slot.format)||candidates[0];
    if(previous) {
      used.add(previous.id);previous.originDate||=previous.date;
      previous.rescheduled||=[];previous.rescheduled.push({from:previous.publishAt,to:zonedTime(date,slot.time,config.timezone)});
      previous.date=date;previous.slot=slot.id;previous.publishAt=zonedTime(date,slot.time,config.timezone);
      delete previous.publication;if(previous.status==='expired')previous.status=previous.topic?'scripted':'planned';
      previous.socialEligible=Boolean(config.buffer);jobs.push(previous);
    }else {
      const job={id:date+'-'+slot.id+'-'+slot.language,date,slot:slot.id,language:slot.language,format:slot.format,publishAt:zonedTime(date,slot.time,config.timezone),status:'planned',attempts:0};
      job.socialEligible=Boolean(config.buffer);state.jobs.push(job);jobs.push(job);
    }
  }
  return jobs;
}
export function publicationDecision(job,config,now=new Date()) {
  if(job.youtube?.videoId)return 'uploaded';
  if(!config.youtube.enabled)return 'disabled';
  const delay=now.getTime()-Date.parse(job.publishAt);
  if(job.youtube?.initiating)return 'reconcile';
  if(job.youtube?.sessionUrl)return delay>config.maxLatenessMinutes*60000?'reconcile':'resume';
  if(delay>config.maxLatenessMinutes*60000)return 'missed';
  return delay>=0?'now':delay>=-120000?'wait':'schedule';
}
