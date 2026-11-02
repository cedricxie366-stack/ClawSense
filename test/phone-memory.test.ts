import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { unifiedContext } from "../src/context-store.js";
import { primaryContextAccess, phoneMemoryCheckpoint } from "../src/phone-memory.js";
const owner={actor:"local-owner",owner:true,processingLocation:"local-only" as const};
it("offline checkpoints retain provenance, expire, and cannot include another project",async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"phone-memory-")));const store=unifiedContext(root);
 try{await store.initialize();await store.setDevicePolicy("phone",{projectIds:["work"],audience:"private",processingLocation:"owned-devices",allowedRecipients:[]},owner);
  const access=primaryContextAccess("phone",{owner:false,actor:"device:phone",scopes:[{projectId:"work"}]});
  const ref=await store.recordLiveObservation("phone","work",{text:"测试现场原话",capturedAt:Date.now(),digest:"a".repeat(64),modality:"audio"},access);
  const checkpoint=await phoneMemoryCheckpoint(store,access);expect(checkpoint.entries).toHaveLength(1);expect(checkpoint.entries[0]?.state).toBe("unconfirmed");expect(checkpoint.expiresAt-checkpoint.checkedAt).toBeLessThanOrEqual(24*3600000+5);
  const other=await phoneMemoryCheckpoint(store,primaryContextAccess("phone",{owner:false,actor:"device:phone",scopes:[{projectId:"other"}]}));expect(other.entries).toEqual([]);
  await store.deleteEvidence(ref,"evidence-and-derived",owner);expect((await phoneMemoryCheckpoint(store,access)).entries).toEqual([]);
 }finally{await store.release();await fs.rm(root,{recursive:true,force:true});}
});
it("accepted work cannot be crowded out of a full checkpoint by recent Live notes",async()=>{
 let exported:any[]=[];
 const notes=Array.from({length:105},(_,i)=>({ref:{kind:"live-observation",id:"note-"+i},capturedAt:i+1}));
 const store={consistent:async(f:()=>any)=>f(),selectedResults:async()=>[{resultId:"accepted"}],listRecords:async()=>[...notes,{ref:{kind:"result",id:"accepted"}}],exportContext:async(refs:any[])=>{exported=refs;return {workspaceId:"fixture",snapshot:{snapshotId:"snapshot"},entries:refs.map(ref=>({ref,source:{},body:{text:ref.id}}))};}};
 const result=await phoneMemoryCheckpoint(store as any,{actor:"device:phone",owner:false,trustedDeviceId:"phone",processingLocation:"owned-devices"});
 expect(result.entries).toHaveLength(100);expect(result.entries[0]).toMatchObject({ref:{id:"accepted"},state:"accepted-current"});expect(exported).not.toContainEqual({kind:"live-observation",id:"note-0"});
});
