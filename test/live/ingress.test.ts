import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { atomicContextJson } from "../../src/context-coordinator.js";
import { LiveIngressAuthorization } from "../../src/live/ingress.js";
it("checks every frame's file identity, rejects rotated secrets/local-only and moved authority",async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"live-ingress-")));const physical=path.join(root,"plugins/clawsense/state.json"),policy=path.join(root,"plugins/clawsense/unified/context.json");
 const device=(secret:string)=>({deviceId:"phone",secretHash:createHash("sha256").update(secret).digest("hex")});
 try{await atomicContextJson(physical,{version:2,devices:[device("first")]});await atomicContextJson(policy,{version:1,devicePolicies:{phone:{projectIds:["live"],audience:"private",processingLocation:"owned-devices",allowedRecipients:[]}}});const ingress=new LiveIngressAuthorization(root);
  expect((await ingress.authenticate("Bearer first")).ok).toBe(true);await ingress.authorizeCapture("phone","live");
  await atomicContextJson(physical,{version:2,devices:[device("second")]});
  expect((await Promise.all(Array.from({length:20},()=>ingress.authenticate("Bearer first")))).every(r=>!r.ok)).toBe(true);
  expect((await ingress.authenticate("Bearer second")).ok).toBe(true);
  await atomicContextJson(policy,{version:1,devicePolicies:{phone:{projectIds:["live"],audience:"private",processingLocation:"local-only",allowedRecipients:[]}}});await expect(ingress.authorizeCapture("phone","live")).rejects.toThrow("phone_local_processing_required");
  await fs.writeFile(path.join(root,"context-authority-moved.json"),"{}");expect((await ingress.authenticate("Bearer second")).ok).toBe(false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
