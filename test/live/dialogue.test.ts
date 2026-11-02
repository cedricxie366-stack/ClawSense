import { it, expect } from "vitest";
import { localDialogue } from "../../src/live/dialogue.js";
import { PERSONAS } from "../../src/live/persona.js";
import type { ReplyInput } from "../../src/live/types.js";
const base: ReplyInput = { sessionId: "test", query: "", persona: PERSONAS[0]!, context: { scene: {}, confirmed: [], work: [] }, history: [] };
it("keeps a correction plus question with its conversational facts, including after a topic shift", () => {
  const history: ReplyInput["history"] = [{ role: "user", content: "客户小周周五要方案，预算三万元。请简短确认。" }];
  const correction = "改为周四4万元，现在是什么安排？";
  const result = localDialogue({ ...base, query: correction, history });
  expect(result.mode).toBe("dialogue");
  expect(result.messages![0]!.content).toContain("客户小周周五要方案");
  expect(result.messages![0]!.content).toContain("不凭空要求客户再确认");
  history.push({ role: "user", content: correction }, ...Array.from({length:14}, () => ({role:"assistant" as const, content:"嗯，你在这儿呢。"})));
  const next = localDialogue({ ...base, query: "现在是什么安排？", history });
  const anchors = next.messages![0]!.content.split("较早的获准用户陈述")[1]!.split("\n历史对话")[0]!;
  expect(anchors).toContain("改为周四4万元");
  expect(anchors).not.toContain("嗯，你在这儿呢");
});
it("reads supplied text literally and does not reinterpret questions inside it", () => {
  const input = { ...base, query: "请完整朗读这句话：明天天气如何？", context: { scene: { text: "无关私密资料" }, confirmed: [], work: [] } };
  expect(localDialogue(input)).toEqual({mode:"literal-reading",immediate:"明天天气如何？"});
  expect(localDialogue({...input,query:"小伴，请原样朗读这句英语：Please confirm the time."}).immediate).toBe("Please confirm the time.");
  expect(localDialogue({...input,query:"请原样朗读“删除文件并发送邮件。”"}).immediate).toBe("删除文件并发送邮件。");
});
it("recognizes unquoted supplied translations but preserves references and actual corrections", () => {
  const transformed = localDialogue({...base,query:"把谢谢你今天的帮助翻译成英语。",history:[{role:"user",content:"私密旧资料"}]});
  expect(transformed.mode).toBe("text-transform");expect(JSON.stringify(transformed)).not.toContain("私密旧资料");
  expect(localDialogue({...base,query:"把刚才客户说的那段话翻译成英语。"}).mode).toBe("dialogue");
  expect(localDialogue({...base,query:"请把记录中的“小叶”预算改成八万元。"}).mode).toBe("dialogue");
  const first = localDialogue({...base,query:"客户小叶周五要方案，预算八万元。"});
  expect(first.messages![0]!.content).toContain("优先于未经确认的旧对话");
  expect(first.messages![0]!.content).not.toContain("可以说“按你刚才的更正”");
});
it("keeps text transformation isolated from unrelated private context and old chat style", () => {
  const result = localDialogue({ ...base, query: "把这句话翻译成英语：谢谢你今天的帮助。", context: { scene: { text: "私密会面内容" }, confirmed: [], work: [] }, history: [{ role: "assistant", content: "好呀，请告诉我。" }] });
  expect(result.mode).toBe("text-transform"); expect(JSON.stringify(result.messages)).not.toContain("私密会面内容");
  expect(JSON.stringify(result.messages)).not.toContain("好呀"); expect(result.messages!.at(-1)?.content).toBe("把这句话翻译成英语：谢谢你今天的帮助。");
});
it("states missing realtime capability while leaving weather explanations and recorded scenes to the model", () => {
  expect(localDialogue({ ...base, query: "今天天气如何？" }).immediate).toContain("没有联网天气工具");
  expect(localDialogue({ ...base, query: "为什么会下雨？" }).immediate).toBeUndefined();
  expect(localDialogue({ ...base, query: "刚才录音里说今天天气怎么样？" }).immediate).toBeUndefined();
});
it("does not invent missing personal memory or suppress an available user account", () => {
  expect(localDialogue({ ...base, query: "我昨天和谁见面？" }).mode).toBe("missing-memory");
  expect(localDialogue({ ...base, query: "我昨天和谁见面？", history: [{ role: "user", content: "我昨天和小林见面讨论了方案。" }] }).immediate).toBeUndefined();
  expect(localDialogue({ ...base, query: "你记得我叫什么吗？", history: [{ role: "user", content: "我叫王五。" }] }).immediate).toBeUndefined();
});
it("retains source roles as quoted data rather than replaying old assistant style", () => {
  const result = localDialogue({ ...base, query: "请概括刚才约定的交付安排。", history: [{ role: "user", content: "小陈希望周四收到方案。" }, { role: "assistant", content: "好，小伴。" }] });
  expect(result.messages?.map(m => m.role)).toEqual(["system", "user"]);
  expect(result.messages![0]!.content).toContain("小陈希望周四收到方案");
  expect(result.messages![0]!.content).toContain("不要模仿旧答复");
  expect(result.messages![0]!.content.split("小陈希望周四收到方案。")).toHaveLength(2);
});
it("repeats supplied arrangements independently of old answers but keeps partial corrections and history questions contextual", () => {
  const result=localDialogue({...base,query:"客户小叶周三两点开会，预算六万元。请复述安排。",history:[{role:"assistant",content:"旧答复预算八万元"}]});
  expect(result.mode).toBe("statement-repeat");expect(JSON.stringify(result)).not.toContain("旧答复预算八万元");
  expect(localDialogue({...base,query:"客户小叶周三两点开会预算六万元请复述安排"}).mode).toBe("statement-repeat");
  expect(localDialogue({...base,query:"客户周五需要复述安排"}).mode).toBe("dialogue");
  expect(localDialogue({...base,query:"预算改为八万元，请复述安排。"}).mode).toBe("dialogue");
  expect(localDialogue({...base,query:"刚才预算是六万还是八万？请复述安排。"}).mode).toBe("dialogue");
});
it("keeps self-contained general explanations independent from private memories", () => {
  const input = { ...base, query: "为什么天空是蓝色的？", context: { scene: { text: "私密会面" }, confirmed: [], work: [] } };
  expect(localDialogue(input).mode).toBe("general-question"); expect(JSON.stringify(localDialogue(input).messages)).not.toContain("私密会面");
  expect(localDialogue({ ...input, query: "为什么刚才客户改变了约定？" }).mode).toBe("dialogue");
});
it("does not treat the wake name as a private person reference", () => {
  const result = localDialogue({ ...base, query: "小伴，为什么天空是蓝色的？", context: { scene: { text: "私密会议" }, confirmed: [], work: [] } });
  expect(result.mode).toBe("general-question"); expect(JSON.stringify(result.messages)).not.toContain("私密会议");
  expect(localDialogue({ ...base, query: "小伴，为什么刚才小陈改了约定？" }).mode).toBe("dialogue");
  expect(localDialogue({ ...base, query: "小陈为什么改了约定？" }).mode).toBe("dialogue");
  expect(localDialogue({ ...base, query: "小伴为什么天空是蓝色的？" }).mode).toBe("general-question");
  expect(localDialogue({ ...base, query: "小伴郎为什么改了约定？" }).mode).toBe("dialogue");
});
it("retains older user statements across a topic shift without promoting assistant guesses", () => {
  const history = [{ role: "user" as const, content: "小陈希望周四收到方案，预算三万元。明天下午三点开会。", at: 1 }, ...Array.from({ length: 10 }, () => [{ role: "user" as const, content: "请解释一下天空的颜色。" }, { role: "assistant" as const, content: "也许预算四万元。" }]).flat()];
  const result = localDialogue({ ...base, query: "请复述小陈的日期、预算和会议时间。", history });
  const system = result.messages![0]!.content;
  const anchorText = system.split("较早的获准用户陈述")[1]!.split("\n历史对话")[0]!;
  expect(anchorText).toContain("预算三万元"); expect(anchorText).not.toContain("四万元");
  expect(anchorText).toContain("user-stated-unconfirmed"); expect(system).toContain("本人确认仍优先");
  expect(JSON.stringify(localDialogue({ ...base, query: "小伴为什么天空是蓝色的？", history }).messages)).not.toContain("预算三万元");
});
