import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStandaloneRuntime } from "../src/standalone-runtime.js";
it("only an authenticated primary phone can confirm a source and agents cannot forge that authority",async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"phone-authority-")));const runtime=createStandaloneRuntime({stateDir:root,port:0,pluginConfig:{retrievalEmbeddingBackend:"none",asrWorkerEnabled:false}});
 try{const address=await runtime.start(),admin=(await fs.readFile(runtime.adminTokenFile,"utf8")).trim();
  const post=async(route:string,body:any,token:string)=>{const r=await fetch(address.baseUrl+"/api/clawsense/"+route,{method:"POST",headers:{Authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};};
  const setup=(await post("setup",{deviceRole:"primary"},admin)).data;const code=JSON.parse(Buffer.from(setup.setupCode,"base64url").toString());const device=(await post("pair",{setupToken:code.token,deviceName:"fixture phone",platform:"fixture"},admin)).data;
  const token=device.deviceSecret;const encounter=(await post("digital/encounter",{title:"面谈",projectId:"expo"},token)).data.session;
  const event=(await post("digital/ingest",{clientEventId:"shared-1",sourceType:"shared_text",capturedAt:Date.now(),projectId:"expo",title:"选定片段",text:"周四收到报价"},token)).data.event;
  const body={sessionId:encounter.sessionId,text:"周四收到报价",expectedRevision:encounter.revision,sourceRefs:[{kind:"digital-evidence",id:event.eventId,revision:1}]};
  expect((await post("digital/confirm",body,admin)).status).toBe(401);
  const accepted=await post("digital/confirm",body,token);expect(accepted.status).toBe(200);expect(accepted.data.correction.confirmationAuthority).toBe("owner-confirmation");
  expect((await post("digital/correct",{eventId:event.eventId,expectedRevision:event.revision,text:"改成周五"},token)).status).toBe(200);
  expect((await post("digital/confirm",{...body,expectedRevision:accepted.data.correction.revision},token)).status).toBe(409);
  await runtime.invokeTool("clawsense_digital_device_access",{deviceId:device.deviceId,enabled:false,projectIds:[]});
  expect((await post("digital/bootstrap",{},token)).status).toBe(403);expect((await post("digital/confirm",{...body,expectedRevision:accepted.data.correction.revision},token)).status).toBe(403);
 }finally{await runtime.stop();await fs.rm(root,{recursive:true,force:true});}
});
