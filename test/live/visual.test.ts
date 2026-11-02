import { it, expect } from "vitest";
import { LiveFrameRequests, needsCurrentFrame } from "../../src/live/visual.js";
it("does not photograph a visual question that the user only asked to read aloud", () => {
 expect(needsCurrentFrame("请完整朗读这句话：我现在在看什么？")).toBe(false);
 expect(needsCurrentFrame("小策原样朗读：镜头在看什么？", "小策")).toBe(false);
 expect(needsCurrentFrame("小策，我现在在看什么？", "小策")).toBe(true);
});
it("binds a fresh frame to one question and rejects replay or old capture", async () => {
 let id = ""; const frames = new LiveFrameRequests(request => { id = request; }, 100);
 const pending = frames.request(new AbortController().signal);
 frames.accept({ requestId: id, jpeg: Buffer.from([255,216,0,255,217]).toString("base64"), capturedAt: Date.now(), ageMs: 12 });
 expect((await pending).ageMs).toBe(12);
 expect(() => frames.accept({ requestId: id })).toThrow("frame_request_expired");
 const expired = frames.request(new AbortController().signal);
 frames.accept({ requestId: id, capturedAt: Date.now()-3000, ageMs: 3000 });
 await expect(expired).rejects.toThrow("current_frame_expired");
});
it("cancellation and a timeout never fall back to an old frame", async () => {
 const frames = new LiveFrameRequests(() => {}, 15), controller = new AbortController();
 const aborted = frames.request(controller.signal); controller.abort(); await expect(aborted).rejects.toThrow("aborted");
 await expect(frames.request(new AbortController().signal)).rejects.toThrow("current_frame_unavailable");
});
it("does not open a camera for an ordinary time or customer question", () => {
 expect(needsCurrentFrame("现在几点？")).toBe(false); expect(needsCurrentFrame("这个客户预算是多少？")).toBe(false);
 expect(needsCurrentFrame("我现在在看什么？")).toBe(true); expect(needsCurrentFrame("画面有什么变化？")).toBe(true);
});
it("routes natural spoken current-view variants to a fresh frame, excluding quoted text tasks", () => {
 for (const query of ["小伴，我现在正在看什么？", "那我现在正在看什么？", "现在看什么？", "请问我现在正在看的是是什么？", "我看到的是什么？"]) expect(needsCurrentFrame(query)).toBe(true);
 for (const query of ["把“我现在正在看什么”翻译成英语", "我昨天在看什么？", "你怎么看待这个方案？"]) expect(needsCurrentFrame(query)).toBe(false);
});
