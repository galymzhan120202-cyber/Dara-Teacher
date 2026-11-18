export function legacySlots(config){
  config.slots=[{id:'morning',time:'10:00',format:'tip',language:'kk'},{id:'afternoon',time:'15:00',format:'material',language:'kk'},{id:'evening',time:'20:00',format:'quiz',language:'ru'}];
  config.languageRotation={mode:'alternate-days',startDate:'2026-11-15'};
  delete config.formatRotation;delete config.buffer;
  return config;
}
