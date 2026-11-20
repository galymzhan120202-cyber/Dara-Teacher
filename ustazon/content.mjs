import {createHash} from 'node:crypto';
import {validateCatalog} from './model.mjs';
import {languageOf, callToAction} from './localize.mjs';
import {exerciseIdentity} from './reliability.mjs';
import {selectVerifiedTopic} from './verified-content.mjs';

const str = maxLength => ({type:'string', minLength:1, maxLength});
export const SCRIPT_SCHEMA = {
  type:'object', additionalProperties:false,
  properties:{
    title:str(90), description:str(600),
    scenes:{type:'array', minItems:3, maxItems:3, items:{
      type:'object', additionalProperties:false,
      properties:{label:str(35), headline:str(75), body:str(140), narration:str(200)},
      required:['label','headline','body','narration']
    }}
  }, required:['title','description','scenes']
};
const ANGLES=[
 'compare two solution methods','one question after a correct answer','let pupils find and explain an error',
 'a short exit ticket','think before discussing with a partner','connect the example to an everyday object',
 'ask pupils to explain the first step','use an example and a counterexample','show a diagram before the formula',
 'ask what changes when one number changes','give pupils a choice between two strategies','compare an estimate with the answer',
 'let pupils make a similar problem','ask which information is missing','explain why an answer cannot be correct',
 'use a short prediction before revealing the answer','ask pupils to write a question about the material','compare a spoken explanation with a diagram',
 'invite a second solution after the first one','use one example as a lesson warm-up','ask a pupil to explain to a partner',
 'use the same skill in a new context','briefly review an earlier lesson','ask pupils to explain what they would check',
 'build a question from a picture','let pupils sort examples by strategy','use a small formative check before moving on',
 'ask for a reason before evaluating an answer','compare two representations of the same idea','plan one follow-up question',
 'adapt one task to different readiness levels','give pupils time to revise an explanation','use a worked example with one missing step',
 'ask pupils to describe a pattern','help pupils choose useful information','reflect on which strategy was convenient'
];
export function makeBrief(job,knowledge,recent=[]) {
  const day=Math.floor(Date.parse(job.date+'T00:00:00Z')/86400000);
  const fact=knowledge.facts[(day+(job.format==='material'?2:0))%knowledge.facts.length];
  const seed=parseInt(createHash('sha256').update(job.id).digest('hex').slice(0,8),16);
  const used=new Set(recent.map(item=>item.exerciseKey).filter(Boolean));
  let quiz;
  for(let i=0;i<19602;i++) {
    const n=(seed+i)%19602,operator=n%2?'-':'+';
    let a=1+Math.floor(n/2)%99,b=1+Math.floor(n/198)%99;
    if(operator==='-'&&a<b)[a,b]=[b,a];
    const pair=operator==='+'?[a,b].sort((x,y)=>x-y):[a,b];
    const key=job.language+':'+operator+':'+pair.join(':');
    if(!used.has(key)){quiz={a,b,operator,answer:operator==='+'?a+b:a-b};break;}
  }
  if(!quiz)throw new Error('All arithmetic examples have been used. Add a new exercise type before continuing.');
  return {format:job.format,language:languageOf(job.language),fact,quiz,angle:ANGLES[Math.floor(day/knowledge.facts.length)%ANGLES.length]};
}

export function scriptPrompt(brief, knowledge, recent, correction = '') {
  const ru = brief.language === 'ru';
  return [
    'Create a short YouTube script for Ustazon, addressed to TEACHERS, not children. Return only the requested JSON.',
    'ALL generated fields must be in ' + (ru ? 'natural Russian' : 'natural Kazakh using Cyrillic') + '. Never mix languages. Ustazon and PPTX are allowed. If a source title is in another language, describe the material generically rather than quoting or translating its title as though an official translated file exists.',
    'The only verified product facts: ' + brief.fact[brief.language],
    'Product limitations: ' + knowledge.constraints[brief.language],
    'Format: ' + brief.format + '. Creative angle: ' + brief.angle + '.',
    brief.format === 'tip' ? 'Give ONE concrete classroom tip related to this material, a short example, then connect it naturally to Ustazon. The tip is our original teaching suggestion, not a claim about unseen file contents.' :
      brief.format === 'material' ? 'Introduce one verified material type, suggest a concrete classroom use, and explain what a teacher can prepare. Do not describe unseen screenshots or contents of the actual file.' :
      'Introduce an ORIGINAL arithmetic mini-exercise for a teacher to use in class: ' + brief.quiz.a + ' ' + brief.quiz.operator + ' ' + brief.quiz.b + ' = ' + brief.quiz.answer + '. State that the exercise is an original example, not a screenshot or extract from Ustazon. Do not promise this exact exercise is on the site.',
    'Exactly 3 short scenes: attention hook, useful example, practical takeaway. CTA is appended by our code; do not add CTA or links. No emojis, Markdown, SSML, quotations from websites, invented statistics or fabricated testimonials.',
    'Start scene 1 immediately with a concrete classroom question, a visible observation challenge, or a specific teacher problem. Its first spoken sentence should be 3–7 words; keep the complete hook narration to 8–14 words. No greeting, brand introduction, generic teaser, or promise of guaranteed results. Use a short matching headline and make scenes 2–3 answer the opening question with the verified material. The first sentence must still work as the hook if the narration is shortened.',
    'Headlines ideally 3–6 words (75 chars max); labels 1–3 words. Body 1 short sentence. Narration in scenes 2–3: 9–18 words; all scenes 200 chars max. Say more than the headline, avoid repeating identical headline and body.',
    'Title must be specific and accurate, 90 chars max. Description 1–3 sentences. Do not add hashtags, prices, IDs, or internal source paths.',
    'Recent titles to avoid repeating: ' + JSON.stringify(recent.filter(item=>item.title).slice(-30).map(item => item.title)),
    correction ? 'Previous draft failed validation: ' + correction + '. Write a corrected draft.' : ''
  ].filter(Boolean).join('\n');
}
function assertText(value, max, label) {
  if(typeof value !== 'string' || !value.trim() || value.length > max || /[<>]|https?:\/\/|www\./i.test(value)) throw new Error('Invalid ' + label);
}
export function validateDraft(value, language) {
  assertText(value?.title, 90, 'title'); assertText(value?.description,600,'description');
  if(!Array.isArray(value.scenes) || value.scenes.length !== 3) throw new Error('Expected exactly three generated scenes');
  for (const scene of value.scenes) {
    for (const [field,max] of Object.entries({label:35,headline:75,body:140,narration:200})) assertText(scene[field],max,field);
    const words = scene.narration.trim().split(/\s+/);
    if(words.length > 28) throw new Error('Narration is too long');
  }
  const all = [value.title,value.description,...value.scenes.flatMap(s=>[s.label,s.headline,s.body,s.narration])].join(' ');
  if(!/[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІіЁё]/.test(all)) throw new Error('Cyrillic text is required');
  if(language==='kk'&&value.scenes.some(s=>!/[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(s.narration)))throw new Error('Kazakh narration requires language review');
  if(language === 'ru' && /[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(all)) throw new Error('Russian videos must not contain Kazakh text');
  if(/тегін|бесплат|жеңілдік|скидк|миллион|2\s*000\s*000|теңге|рубл|₸|₽|100\s*%|кепіл|гарантир|конструктор\s+игр|ойын\s+құрастыр|толық\s+ҚМЖ|полный\s+(?:КСП|план)/iu.test(all)) throw new Error('Draft contains an unsupported promotional claim');
  return value;
}
const tokens = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
export function similarity(a,b) {
  const x=tokens(a), y=tokens(b); const common=[...x].filter(t=>y.has(t)).length;
  return common / Math.max(1,new Set([...x,...y]).size);
}
export function topicFromDraft(value, job, brief) {
  validateDraft(value, brief.language);
  const ru = brief.language === 'ru';
  let scenes = value.scenes.map((scene,i)=>({...scene, kind:i === 0 ? 'hook' : 'feature', duration:5, visual:brief.fact.visual}));
  if (job.format === 'quiz') {
    const {a,b,answer}=brief.quiz, operator=brief.quiz.operator||'+';
    const spoken=ru?(operator==='+'?' плюс ':' минус '):(operator==='+'?' қосу ':' азайту ');
    // Question and answer are deterministic; the LLM never supplies the arithmetic.
    scenes = [
      {...scenes[0],visual:'quiz',quiz:{a,b,answer,operator,phase:'intro'}, duration:5},
      {kind:'feature',duration:7,label:ru?'МИНИ-ЗАДАНИЕ':'ШАҒЫН ТАПСЫРМА',
       headline:ru?'Пауза на размышление':'Ойлануға уақыт беріңіз',
       body:ru?'Предложите ученикам объяснить свой способ решения.':'Оқушылардан шешу тәсілін түсіндіруді сұраңыз.',
       narration:ru?'Предложите классу пример: ' + a + spoken + b + '. Дайте время подумать.' : 'Сыныпқа мына мысалды ұсыныңыз: ' + a + spoken + b + '. Ойлануға уақыт беріңіз.',
       visual:'quiz',quiz:{a,b,answer,operator,phase:'question'}},
      {kind:'feature',duration:6,label:ru?'ОБСУЖДАЕМ':'ТАЛҚЫЛАЙМЫЗ',
       headline:ru?'Важен и способ решения':'Шешу тәсілі де маңызды',
       body:ru?'Это авторский пример для урока.':'Бұл — сабаққа арналған авторлық мысал.',
       narration:ru?'Ответ — ' + answer + '. Спросите, как ученики считали. Это поможет обсудить разные способы решения.' : 'Жауабы — ' + answer + '. Оқушылардан қалай есептегенін сұраңыз. Әртүрлі шешу тәсілдерін бірге талқылаңыз.',
       visual:'quiz',quiz:{a,b,answer,operator,phase:'answer'}}
    ];
  }
  scenes.push({kind:'cta',duration:5,visual:'cta',narration:callToAction(brief.language)});
  const topic = {
    id:job.id,title:value.title,description:value.description + (job.format === 'quiz' ? (ru?'\nЗадание — авторский пример для обсуждения на уроке.':'\nТапсырма — сабақта талқылауға арналған авторлық мысал.'):''),
    language:brief.language,format:job.format,tags:['Ustazon',ru?'учитель':'мұғалім',ru?'урок':'сабақ','shorts'],
    sourceRefs:job.format === 'quiz' ? ['Original classroom example; arithmetic computed by bot',brief.fact.ref] : [brief.fact.ref],
    scenes
  };
  validateCatalog({version:1,source:'Curated Ustazon knowledge',topics:[topic]});
  return topic;
}
export function templateDraft(brief) {
  const ru=brief.language==='ru';
  const texts={
    'presentation-triangles':{kk:'Ustazon-да геометрияға арналған PPTX презентациясы бар.',ru:'В Ustazon есть презентация по геометрии в формате PPTX.'},
    'worksheet-comparison':{kk:'Ustazon-да сандарды салыстыруға арналған PPTX жұмыс парағы бар.',ru:'В Ustazon есть рабочий лист для сравнения чисел в формате PPTX.'},
    'wordwall-counting':{kk:'Ustazon-да бірінші сыныпқа арналған Wordwall санау ойынының сілтемесі бар.',ru:'В Ustazon есть ссылка на игру Wordwall для счёта предметов в первом классе.'},
    'lesson-goal':{kk:'Ustazon-да бесінші сынып информатикасының тақырыбы мен оқу мақсаты бар.',ru:'В разделе планов Ustazon есть тема и цель обучения по информатике для пятого класса.'},
    'library-types':{kk:'Ustazon кітапханасында презентациялар, жұмыс парақтары және оқу ойындарына сілтемелер бар.',ru:'В библиотеке Ustazon есть презентации, рабочие листы и ссылки на учебные игры.'}
  };
  const material=texts[brief.fact.id]?.[brief.language]||brief.fact[brief.language];
  if(ru)return {
    title:brief.format==='quiz'?'Один пример — разные способы решения':brief.format==='material'?'Материал для обсуждения на уроке':'Один вопрос после правильного ответа',
    description:brief.format==='quiz'?'Авторский пример: предложите ученикам объяснить ход решения.':material,
    scenes:[
      {label:'ИДЕЯ ДЛЯ УРОКА',headline:'Ответ верный. А как решили?',body:'Попросите ученика объяснить ход мысли.',narration:'Ученик назвал правильный ответ? Спросите, как он рассуждал, и предложите классу другой способ.'},
      {label:'ПРИМЕНЯЕМ',headline:'Дайте время подумать',body:'Обсудите один пример вместе.',narration:'Дайте классу время подумать. Затем сравните два способа решения и обсудите, чем они отличаются.'},
      {label:'МАТЕРИАЛЫ',headline:'Идея для подготовки к уроку',body:material,narration:material}
    ]
  };
  return {
    title:brief.format==='quiz'?'Бір мысал — әртүрлі шешу тәсілі':brief.format==='material'?'Сабақта талқылауға арналған материал':'Дұрыс жауаптан кейін бір сұрақ қойыңыз',
    description:brief.format==='quiz'?'Авторлық мысал: оқушылардан шешу жолын түсіндіруді сұраңыз.':material,
    scenes:[
      {label:'САБАҚҚА ИДЕЯ',headline:'Жауабы дұрыс. Қалай шешті?',body:'Оқушыдан ойлау жолын түсіндіруді сұраңыз.',narration:'Оқушы дұрыс жауап айтты ма? Қалай ойлағанын сұрап, сыныпқа басқа тәсіл ұсынуды тапсырыңыз.'},
      {label:'ҚОЛДАНАМЫЗ',headline:'Ойлануға уақыт беріңіз',body:'Бір мысалды бірге талқылаңыз.',narration:'Сыныпқа ойлануға уақыт беріңіз. Содан соң екі шешу тәсілін салыстырып, айырмасын бірге талқылаңыз.'},
      {label:'МАТЕРИАЛДАР',headline:'Сабаққа дайындыққа бір идея',body:material,narration:material}
    ]
  };
}

export async function generateTopic({client,config,job,knowledge,recent=[],validateLayout=()=>{}}) {
  if(config.content?.mode==='verified') {const topic=selectVerifiedTopic(job,recent);validateLayout(topic);return {topic,origin:'verified-material'};}
  const brief=makeBrief(job,knowledge,recent);
  let correction='';
  for(let attempt=0;attempt<config.gemini.maxScriptAttempts;attempt++) {
    let result;
    try {result=await client.generateJSON({model:config.gemini.model,prompt:scriptPrompt(brief,knowledge,recent,correction),schema:SCRIPT_SCHEMA});}
    catch(error) {
      if(!config.gemini.templateFallback || !Number.isInteger(error.status) || error.status<500 || error.status>599)throw error;
      const topic=topicFromDraft(templateDraft(brief),job,brief);
      const text=topic.scenes.slice(0,-1).map(s=>s.narration).join(' ');
      if(recent.some(old=>old.language===job.language&&(old.title===topic.title||(!exerciseIdentity(topic)&&similarity(old.text||'',text)>.85)||old.exerciseKey&&old.exerciseKey===exerciseIdentity(topic))))throw new Error('Gemini is temporarily unavailable and this fallback was already used. Retry later.');
      validateLayout(topic);
      return {topic,origin:'verified-template',fallbackReason:'Gemini HTTP '+error.status};
    }
    try {
      const topic=topicFromDraft(result.value,job,brief);
      const text=topic.scenes.slice(0,-1).map(s=>s.narration).join(' ');
      if(recent.some(old=>old.language===job.language && (old.title?.toLowerCase()===topic.title.toLowerCase() || (!exerciseIdentity(topic)&&similarity(old.text || '',text)>.85) || old.exerciseKey&&old.exerciseKey===exerciseIdentity(topic)))) throw new Error('Too similar to a recent video');
      validateLayout(topic);
      return {topic,usage:result.usage,origin:'gemini'};
    } catch(error) {correction=error.message;}
  }
  throw new Error('Script validation failed: ' + correction);
}
