const API = 'https://generativelanguage.googleapis.com/v1beta';
export class GeminiError extends Error {
  constructor(message, {status = 0, retryable = false, retryAfterMs=0} = {}) {super(message); this.name = 'GeminiError'; this.status = status; this.retryable = retryable;this.retryAfterMs=retryAfterMs;}
}
export function redact(text, secrets = []) {
  let value = String(text);
  for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
  return value.replace(/(?:AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,})/g, '[REDACTED]').slice(0, 1000);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class GeminiClient {
  constructor({apiKey, fetchImpl = fetch, beforeRequest = async() => {}, sleep = pause, retries = 1, timeoutMs = 90000, signal}) {
    if (!apiKey) throw new GeminiError('GEMINI_API_KEY is missing. Set it in the project .env.local file.');
    this.apiKey = apiKey; this.fetch = fetchImpl; this.beforeRequest = beforeRequest; this.sleep = sleep; this.retries = retries; this.timeoutMs = timeoutMs;this.signal=signal;
  }
  async request(endpoint, body, {timeoutMs=this.timeoutMs}={}) {
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      await this.beforeRequest({endpoint, attempt});
      let response;
      try {
        response = await this.fetch(API + endpoint, {method:body ? 'POST' : 'GET', headers:{'x-goog-api-key':this.apiKey, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}), signal:this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs), redirect:'error'});
      } catch(error) {
        this.signal?.throwIfAborted();
        // A network timeout may already have consumed quota: do not blindly retry paid generation.
        throw new GeminiError(error?.name==='TimeoutError'?'Gemini request timed out. Saved audio will be reused on retry.':'Gemini network request failed. Retry the unfinished job later.',{retryable:true});
      }
      const data = await response.json().catch(() => null);
      if (response.ok) return data;
      const retryable = response.status === 429 || response.status >= 500;
      const message = redact(data?.error?.message || response.statusText, [this.apiKey]);
      if (retryable && attempt < this.retries) {
        const headerDelay = Number(response.headers.get('retry-after'));
        const detail = data?.error?.details?.find(item => typeof item.retryDelay === 'string')?.retryDelay;
        const delay = Math.max(1000 * (2 ** attempt), Number.isFinite(headerDelay) ? headerDelay * 1000 : 0, detail ? parseFloat(detail) * 1000 : 0);
        if (delay <= 30000 && !/limit:\s*0|billing|daily|per[ _-]?day/i.test(message)) {await this.sleep(delay); continue;}
      }
      const retryHeader=response.headers.get('retry-after');
      const retryAfterMs=retryHeader?(Number.isFinite(Number(retryHeader))?Number(retryHeader)*1000:Math.max(0,Date.parse(retryHeader)-Date.now())):0;
      throw new GeminiError('Gemini HTTP ' + response.status + ': ' + message,{status:response.status,retryable,retryAfterMs});
    }
  }
  async models() {return (await this.request('/models'))?.models?.map(item => item.name.replace(/^models\//, '')) || [];}
  async generateJSON({model, prompt, schema}) {
    if (!/^[a-z0-9.-]+$/.test(model)) throw new Error('Invalid model name');
    const result = await this.request('/models/' + model + ':generateContent', {
      contents:[{role:'user', parts:[{text:prompt}]}],
      generationConfig:{temperature:.8, maxOutputTokens:4096, responseFormat:{text:{mimeType:'APPLICATION_JSON', schema}}}
    });
    const candidate = result?.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new GeminiError('Gemini script was not completed: ' + candidate.finishReason);
    const text = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('');
    if (!text) throw new GeminiError('Gemini returned no script');
    try {return {value:JSON.parse(text), usage:result.usageMetadata};}
    catch {throw new GeminiError('Gemini returned invalid JSON');}
  }
  async speech({model, voice, text, language = 'kk'}) {
    if (!/^[a-z0-9.-]+$/.test(model)) throw new Error('Invalid TTS model name');
    const legacy = /^gemini-2\.5-/.test(model);
    const result = await this.request('/models/' + model + ':generateContent', {
      contents:[{role:'user', parts:[legacy ? {text:'Read only this ' + (language === 'ru' ? 'Russian' : 'Kazakh') + ' text naturally, clearly and at a lively conversational pace: ' + text} :
        {text, speech_metadata:{style:'Native ' + (language === 'ru' ? 'Russian' : 'Kazakh') + ' pronunciation, warm and confident teacher, lively but clear conversational pace. Read the exact transcript.'}}]}],
      generationConfig:{responseModalities:['AUDIO'], speechConfig:{voiceConfig:legacy ? {prebuiltVoiceConfig:{voiceName:voice}} : {voice}}}
    },{timeoutMs:Math.max(this.timeoutMs,180000)});
    const part = result?.candidates?.[0]?.content?.parts?.find(item => item.inlineData?.data)?.inlineData;
    if (!part) throw new GeminiError('Gemini returned no narration audio');
    const data = Buffer.from(part.data, 'base64');
    if (!data.length || data.length > 20 * 1024 * 1024) throw new GeminiError('Invalid narration audio size');
    return {data, mimeType:part.mimeType || '', usage:result.usageMetadata};
  }
}
