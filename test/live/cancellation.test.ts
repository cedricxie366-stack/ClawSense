import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalLiveProvider } from '../../src/live/local-provider.js';
import { PERSONAS } from '../../src/live/persona.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clawsense-cancel-drain-'));
  const worker = path.join(root, 'worker.mjs');
  await fs.writeFile(worker, `
import fs from 'node:fs';import readline from 'node:readline';
const root=${JSON.stringify(root)}, role=process.argv[process.argv.indexOf('--role')+1], cancelled=new Set();
const emit=(id,type,fields={})=>process.stdout.write(JSON.stringify({id,type,...fields})+'\\n');
const input=readline.createInterface({input:process.stdin});let tail=Promise.resolve();
input.on('line',line=>{const m=JSON.parse(line);if(m.op==='cancel'){cancelled.add(m.target);return;}
 tail=tail.then(async()=>{try{
 if(m.op==='probe'){emit(m.id,'capabilities',{ready:true,voices:['Vivian'],styleControl:true});return;}
 if(m.op==='barrier'||m.op==='idle'||m.op==='reset')return;
 if(m.op==='generate'||m.op==='describe'){
  const peer=role==='llm'?'vision':'llm',overlap=fs.existsSync(root+'/'+peer+'-active');
  fs.writeFileSync(root+'/'+role+'-active','active');
  // Cancellation rejects the RPC immediately; this simulated native operation
  // remains busy until its safe completion boundary.
  try{if(m.op==='generate')emit(m.id,'text',{text:overlap?'overlap':'serial'});
   await new Promise(r=>setTimeout(r,250));
   if(m.op==='describe'&&!cancelled.has(m.id))emit(m.id,'description',{text:overlap?'overlap':'serial'});
  }finally{fs.rmSync(root+'/'+role+'-active',{force:true});}
 }
 }finally{cancelled.delete(m.id);emit(m.id,'done');}});
});input.on('close',()=>void tail.finally(()=>process.exit(0)));
`);
  const provider = new LocalLiveProvider({ enabled: true, host: '127.0.0.1', port: 19490, python: process.execPath, worker, llmModel: 'fixture', ttsModel: 'fixture', asrDir: 'fixture', visionModel: 'fixture' });
  await provider.capabilities();
  const frame = { jpeg: 'fixture', capturedAt: Date.now(), ageMs: 0, requestId: 'fixture', receivedAt: Date.now() };
  const input = { sessionId: 'cancel-drain', query: '解释一下光的散射。', persona: PERSONAS[0]!, context: { scene: {}, confirmed: [], work: [] }, history: [] };
  const waitActive = async (role: string) => { for (let i = 0; i < 100; i++) { try { await fs.access(path.join(root, role + '-active')); return; } catch {} await new Promise(r => setTimeout(r, 5)); } throw Error('native_operation_not_started'); };
  return { provider, frame, input, waitActive, async close() { await provider.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

it('drains cancelled visual computation before granting the heavy-analysis lease to language', async () => {
  const f = await fixture(), cancel = new AbortController();
  try {
    const vision = f.provider.describeFrames([f.frame], '颜色？', cancel.signal).catch(e => e.message);
    await f.waitActive('vision'); cancel.abort();
    let answer = '';
    for await (const chunk of f.provider.reply(f.input, new AbortController().signal)) if (chunk.type === 'text') answer += chunk.text;
    expect(await vision).toBe('aborted'); expect(answer).toBe('serial');
  } finally { await f.close(); }
});

it('drains an abandoned language iterator before granting the lease to vision', async () => {
  const f = await fixture();
  try {
    const iterator = f.provider.reply(f.input, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'text', text: 'serial' });
    const closed = iterator.return?.();
    const vision = f.provider.describeFrames([f.frame], '颜色？', new AbortController().signal);
    await closed; expect(await vision).toBe('serial');
  } finally { await f.close(); }
});
