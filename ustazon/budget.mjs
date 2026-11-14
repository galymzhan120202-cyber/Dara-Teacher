import {setTimeout as wait} from 'node:timers/promises';
import {localDate,zonedTime} from './schedule.mjs';

// These exact Standard models had a free tier in the official pricing table
// reviewed on 2026-11-14. This is not a check of the account's billing status.
export const REVIEWED_FREE_MODELS=Object.freeze({
  'gemini-3.8-flash':'script',
  'gemini-3.8-flash-tts':'speech'
});
export const QUOTA_TIMEZONE='America/Los_Angeles';
export const DEFAULT_FREE_TIER=Object.freeze({
  mode:'free-only',confirmed:false,scriptRequestsPerDay:6,speechRequestsPerDay:10,minIntervalMs:61000
});
export const freeTierPolicy=config=>({...DEFAULT_FREE_TIER,...config.gemini?.freeTier});
const dayAfter=day=>new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export const quotaDay=now=>localDate(now,QUOTA_TIMEZONE);
export const nextQuotaReset=now=>zonedTime(dayAfter(quotaDay(now)),'00:03',QUOTA_TIMEZONE);
function fail(code,message,nextAt){const error=new Error(message);error.code=code;if(nextAt)error.nextAt=nextAt;throw error;}
export function validateFreeTier(config) {
  const p=freeTierPolicy(config);
  if(p.mode!=='free-only'||typeof p.confirmed!=='boolean')throw new Error('Invalid free-tier policy');
  for(const key of ['scriptRequestsPerDay','speechRequestsPerDay']) {
    if(!Number.isInteger(p[key])||p[key]<1||p[key]>100)throw new Error('Invalid free-tier request limit: '+key);
  }
  if(!Number.isInteger(p.minIntervalMs)||p.minIntervalMs<1000||p.minIntervalMs>300000)throw new Error('Invalid Gemini request interval');
  const observed=p.observedLimits?.models;
  if(observed)for(const [role,model] of [['script',config.gemini.model],['speech',config.gemini.ttsModel]]) {
    const limit=observed[model];
    if(!limit||!Number.isInteger(limit.rpd)||limit.rpd<1||!Number.isInteger(limit.rpm)||limit.rpm<1)throw new Error('Missing observed Gemini limits for '+model);
    if(p[role+'RequestsPerDay']>limit.rpd||p.minIntervalMs<Math.ceil(60000/limit.rpm))throw new Error('Configured Gemini budget exceeds observed provider limits for '+model);
  }
  return p;
}
export function assertFreeTier(config,model) {
  const p=validateFreeTier(config);
  if(!p.confirmed)fail('FREE_TIER_UNCONFIRMED','Gemini generation is paused. Confirm that this API key belongs to a Free Tier project with billing disabled before setting GEMINI_FREE_TIER_CONFIRMED=true. A request cap cannot make a paid project free.');
  const role=REVIEWED_FREE_MODELS[model];
  if(!role||model!==(role==='script'?config.gemini.model:config.gemini.ttsModel)) {
    fail('FREE_MODEL_UNREVIEWED','Gemini generation is paused: this model has not been approved for the free-only configuration. No automatic model switch is allowed.');
  }
  return role;
}
function legacyUpperBound(state,config,now) {
  const start=zonedTime(quotaDay(now),'00:00',QUOTA_TIMEZONE);
  const end=zonedTime(dayAfter(quotaDay(now)),'00:00',QUOTA_TIMEZONE);
  let day=localDate(new Date(start),config.timezone),last=localDate(new Date(Date.parse(end)-1),config.timezone),total=0;
  for(let i=0;i<4&&day<=last;i++,day=dayAfter(day))total+=state.requests?.[day]||0;
  // Old counters have neither model nor timestamps. Conservatively charge all
  // overlapping local dates to each role for the migration day, then reset.
  return total;
}
function ledgerFor(state,config,now) {
  if(!state.geminiBudget) {
    state.geminiBudget={version:1,initializedAt:now.toISOString(),days:{},lastRequests:{}};
    state.geminiBudget.days[quotaDay(now)]={legacyUpperBound:legacyUpperBound(state,config,now),models:{}};
  }
  const ledger=state.geminiBudget;
  if(ledger.version!==1||!ledger.days||!ledger.lastRequests)fail('BUDGET_STATE_INVALID','Invalid Gemini quota state. Restore its database backup before generating.');
  ledger.days[quotaDay(now)]||={legacyUpperBound:0,models:{}};
  return ledger;
}
function usedToday(day,model) {
  const legacy=day?.legacyUpperBound||0,models=day?.models||{};
  return {model:legacy+(models[model]||0),total:legacy+Object.values(models).reduce((a,b)=>a+b,0)};
}
function checkLimits({state,config,policy,ledger,model,role,now}) {
  const used=usedToday(ledger.days[quotaDay(now)],model);
  const localDay=localDate(now,config.timezone);
  if((state.requests?.[localDay]||0)>=config.gemini.maxDailyRequests) {
    fail('DAILY_BUDGET','Daily Gemini request limit reached. Unfinished jobs are preserved.',zonedTime(dayAfter(localDay),'00:03',config.timezone));
  }
  if(used.total>=config.gemini.maxDailyRequests||used.model>=policy[role+'RequestsPerDay']) {
    fail('GEMINI_DAILY_BUDGET','Gemini '+role+' request budget reached. Saved work will resume after the Pacific quota reset.',nextQuotaReset(now));
  }
}
export function createRequestGuard({state,config,save,assertOwner=()=>{},now=()=>new Date(),sleep=(ms,signal)=>wait(ms,undefined,{signal}),signal}) {
  return async ({endpoint})=>{
    if(endpoint==='/models')return; // Read-only model discovery; not generation.
    const match=/^\/models\/([a-z0-9.-]+):generateContent$/.exec(endpoint);
    if(!match)fail('FREE_MODEL_UNREVIEWED','Unsupported endpoint in free-only mode.');
    const model=match[1],role=assertFreeTier(config,model),policy=freeTierPolicy(config);
    while(true) {
      signal?.throwIfAborted();assertOwner();
      const current=now(),ledger=ledgerFor(state,config,current);
      checkLimits({state,config,policy,ledger,model,role,now:current});
      const previous=ledger.lastRequests[model];
      const delay=previous?Date.parse(previous)+policy.minIntervalMs-+current:0;
      if(delay>0){await sleep(Math.min(delay,30000),signal);continue;}
      const day=ledger.days[quotaDay(current)];
      day.models[model]=(day.models[model]||0)+1;
      ledger.lastRequests[model]=current.toISOString();
      state.requests||={};
      const localDay=localDate(current,config.timezone);
      state.requests[localDay]=(state.requests[localDay]||0)+1;
      // Persist before HTTP, including retries and ambiguous failed requests.
      // If saving fails no request leaves the machine.
      await save();signal?.throwIfAborted();assertOwner();
      return;
    }
  };
}
export function budgetReport(config,state={},now=new Date(),preparedAudio=[]) {
  const p=freeTierPolicy(config),videos=config.slots.length,scenesPerVideo=4;
  const readyLanguages=new Set(preparedAudio.filter(item=>item.available).map(item=>item.language));
  const reusableCtas=config.gemini.preparedCta?config.slots.filter(slot=>readyLanguages.has(slot.language)).length:0;
  const expectedScript=config.content?.mode==='verified'?0:videos,expectedSpeech=config.gemini.voiceEnabled?videos*scenesPerVideo-reusableCtas:0;
  const day=state.geminiBudget?.days?.[quotaDay(now)];
  const usage=Object.fromEntries([config.gemini.model,config.gemini.ttsModel].map(model=>[model,usedToday(day,model).model]));
  return {
    mode:p.mode,freeTierConfirmed:p.confirmed,providerBillingVerifiedAutomatically:false,
    providerQuotaKnown:Boolean(p.observedLimits),observedLimits:p.observedLimits||null,providerRemainingQuotaKnown:false,pricingReviewedAt:'2026-11-14',
    note:'Local caps are not Google quotas or a dollar cap. Zero Gemini charges require a Free Tier project with billing disabled. Other applications share its provider quota.',
    preparedAudio,reusedCtaRequests:config.gemini.voiceEnabled?reusableCtas:0,
    videosPerLocalDay:videos,expectedRequestsWithoutRetriesOrCache:{script:expectedScript,speech:expectedSpeech,total:expectedScript+expectedSpeech},
    caps:{total:config.gemini.maxDailyRequests,script:p.scriptRequestsPerDay,speech:p.speechRequestsPerDay,minIntervalMsPerModel:p.minIntervalMs},
    capCoversExpectedRequests:expectedScript+expectedSpeech<=config.gemini.maxDailyRequests&&expectedScript<=p.scriptRequestsPerDay&&expectedSpeech<=p.speechRequestsPerDay,
    localDay:localDate(now,config.timezone),localRequests:state.requests?.[localDate(now,config.timezone)]||0,
    quotaDay:quotaDay(now),quotaTimeZone:QUOTA_TIMEZONE,nextQuotaReset:nextQuotaReset(now),modelRequests:usage
  };
}
