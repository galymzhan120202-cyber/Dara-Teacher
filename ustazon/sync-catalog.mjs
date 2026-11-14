import fs from 'node:fs/promises';
import {bank,makeVerifiedTopic} from './verified-content.mjs';
const topics=bank.stories.flatMap(story=>['kk','ru'].map(language=>makeVerifiedTopic({id:story.id+'-'+language,language},story)));
await fs.writeFile(new URL('./catalog.json',import.meta.url),JSON.stringify({version:1,source:bank.source,topics},null,2)+'\n');
console.log('Synced '+topics.length+' verified language variants.');
