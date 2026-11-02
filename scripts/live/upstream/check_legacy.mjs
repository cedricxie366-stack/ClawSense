// Controlled old/new output orchestration comparison: identical model/context
// boundary, generated text, digital PCM sink, no physical playback or microphone.
import fs from 'node:fs/promises';
import path from 'node:path';
import {LiveSession} from '../../../dist/src/live/session.js';
import {PERSONAS} from '../../../dist/src/live/persona.js';
const root=path.resolve(process.argv[2]??'.local/live-upstream-2026-10-29');
const device=JSON.parse(await fs.readFile(root+'/fixture-device.json','utf8'));
const headers={'content-type':'application/json',authorization:'Bearer '+device.deviceSecret,'x-clawsense-bridge':(await fs.readFile(root+'/bridge-token','utf8')).trim()};
let sessionId,responseId;
async function request(op,data={}){const r=await fetch('http://127.0.0.1:19721/api/clawsense/live-upstream/model',{method:'POST',headers,body:JSON.stringify({op,sessionId,...data}),signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('model_boundary_'+r.status);return r;}
async function call(op,data){return(await request(op,data)).json();}
async function* stream(op,data,signal){const r=await fetch('http://127.0.0.1:19721/api/clawsense/live-upstream/model',{method:'POST',headers,body:JSON.stringify({op,sessionId,...data}),signal});if(!r.ok)throw Error('model_boundary_'+r.status);let pending='';const decode=new TextDecoder();for await(const raw of r.body){pending+=decode.decode(raw,{stream:true});let n;while((n=pending.indexOf('\n'))>=0){const v=JSON.parse(pending.slice(0,n));pending=pending.slice(n+1);if(v.type==='error')throw Error(v.code);yield v;}}}
const provider={async capabilities(){throw Error('unused');},async *reply(input,signal){for await(const item of stream('reply',{text:input.query},signal)){if(item.type==='response')responseId=item.responseId;else if(item.type==='text')yield item;}},async *synthesize(text,persona,signal){yield*stream('tts',{text,responseId},signal);},async recognize(){return'';},async resetRecognition(){},async close(){}};
const questions=['请原样朗读：会议安排在明天下午四点，预算五万元，方案周六交付。','请原样朗读：测试订单金额为1,234.50元，约在16:30核对。','请原样朗读：Please send the revised proposal before Friday afternoon and confirm the meeting time with the customer.'];
let audio=[],generationDone=false,failed,first,started;const rows=[];
const session=new LiveSession('legacy-comparator',structuredClone(PERSONAS[0]),provider,provider,undefined,async()=>({scene:{},confirmed:[],work:[]}),event=>{if(event.type==='audio')audio.push(Buffer.from(event.pcm,'base64'));if(event.type==='completed')generationDone=true;if(event.type==='error')failed=event.code;},root+'/legacy-fixture-state');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 sessionId=(await call('open')).sessionId;await call('prepare');
 for(const query of questions){audio=[];generationDone=false;failed=undefined;first=undefined;started=performance.now();let bytes=0;
  await session.text(query);
  while(!generationDone||audio.length){if(failed)throw Error(failed);if(performance.now()-started>90000)throw Error('turn_timeout');const chunk=audio.shift();if(chunk){first??=performance.now();bytes+=chunk.length;await sleep(chunk.length/48);}else await sleep(5);}
  const row={query,firstSinkMs:Math.round(first-started),completedMs:Math.round(performance.now()-started),pcmSeconds:bytes/48000,frames:bytes/2,physicalMicrophone:false,audibleOutput:false};rows.push(row);console.log(JSON.stringify(row));
 }
}finally{await session.close();if(sessionId)await call('close').catch(()=>{});await fs.writeFile(root+'/legacy-controlled.json',JSON.stringify({scope:'Old LiveSession output orchestration with the SAME new model/context boundary; not a historical full-stack benchmark',completed:rows.length===questions.length,rows},null,2));}
