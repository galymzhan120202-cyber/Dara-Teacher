import path from 'node:path';
import fs from 'node:fs/promises';
import {HERE} from './config.mjs';
import {openStore} from './store.mjs';
import {GitHubState} from './remote-state.mjs';
await fs.access(path.join(HERE,'.state','bot.sqlite'));
const remote=new GitHubState(),store=await openStore(path.join(HERE,'.state'));
try{store.acquire();const id=await remote.seed(store,store.load(),HERE);console.log('Local history migrated into encrypted checkpoint '+id+'. Stop local workers and use initialize=false in Actions.');}
finally{store.release();store.close();}
