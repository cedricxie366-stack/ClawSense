import {it,expect} from "vitest";
import {recallLiveFact} from "../../src/live/recall.js";
import {PERSONAS} from "../../src/live/persona.js";
import type {ReplyInput} from "../../src/live/types.js";
const base:ReplyInput={sessionId:"test",query:"",persona:PERSONAS[0]!,context:{scene:{},confirmed:[],work:[]},history:[{role:"user",content:"测试客户小陈希望周四收到方案，预算三万元。明天下午三点开会。"},{role:"user",content:"交给DSH写文件，预算四万元。"},{role:"assistant",content:"接收人是DSH。"}]};
it("does not shortcut to a stale amount after an elliptical compound correction",()=>{
 expect(recallLiveFact({...base,query:"改为四万元，现在预算是多少？"})).toBeUndefined();
 expect(recallLiveFact({...base,query:"现在预算多少？",history:[...base.history,{role:"user",content:"改为周四4万元，现在是什么安排？"}]})).toBeUndefined();
});
it("does not answer a new meeting correction with the previous meeting time",()=>{
 for (const query of ["会议时间改为明天下午2点，请简短确认。", "预会议时间改为明天下午2点，请简短确认。", "会议时间是明天下午两点，请确认。", "会议时间改到明天下午两点，请简短确认。"]) expect(recallLiveFact({...base,query})).toBeUndefined();
 expect(recallLiveFact({...base,query:"会议时间是几点？"})).toBe("会议安排在明天下午三点。");
});
it("uses direct source facts rather than tool routing, assistant mistakes or retrieval times",()=>{
 expect(recallLiveFact({...base,query:"方案给谁？"})).toBe("接收人是小陈。");
 expect(recallLiveFact({...base,query:"预算是多少？"})).toBe("预算是三万元。");
 expect(recallLiveFact({...base,query:"小陈什么时候收到方案？"})).toBe("希望周四收到方案。");
 expect(recallLiveFact({...base,query:"会议原时间怎么说？"})).toBe("会议安排在明天下午三点。");
});
it("does not turn read-aloud or translation materials into a new budget or correction",()=>{
 const history=[...base.history,{role:"user" as const,content:"原样朗读：小陈预算改为五万元。"},{role:"user" as const,content:"把“小陈预算八万元”翻译成英语。"}];
 expect(recallLiveFact({...base,history,query:"预算是多少？"})).toBe("预算是三万元。");
});
it("uses the latest explicit named statement, even without a correction word, while preserving uncertainty and confirmed priority",()=>{
 const query="现在小叶的预算是多少？";
 const history:ReplyInput["history"]=[{role:"user",content:"小叶：预算八万元。"},{role:"assistant",content:"小叶预算八万元。"},{role:"user",content:"测试客户小叶：周三两点开会，预算六万元，方案周五交付。请复述安排。"}];
 expect(recallLiveFact({...base,query,history})).toBe("小叶的预算是六万元。");
 expect(recallLiveFact({...base,query,history:[...history,{role:"user",content:"请原样朗读：小叶预算十万元。"}]})).toBe("小叶的预算是六万元。");
 expect(recallLiveFact({...base,query,history:[...history,{role:"user",content:"小王：预算九万元。"}]})).toBe("小叶的预算是六万元。");
 expect(recallLiveFact({...base,query,history:[...history,{role:"user",content:"用两句话汇总小叶的预算和方案安排。"}]})).toBe("小叶的预算是六万元。");
 expect(recallLiveFact({...base,query,history:[...history,{role:"user",content:"请把小叶的预算改为七万元。"}]})).toBe("小叶的预算是七万元。");
 for(const content of ["预算改为七万元。","小叶的预算不是六万元，暂时未定。","小叶和小王的预算分别是七万元和九万元。"])
   expect(recallLiveFact({...base,query,history:[...history,{role:"user",content}]}),content).toBeUndefined();
 const context={scene:{},work:[],confirmed:[{text:"小叶希望周四收到方案，预算四万元。"}]};
 expect(recallLiveFact({...base,query,history,context})).toBe("预算是四万元。");
});
it("owner-confirmed correction takes precedence and conflicting recipients require disambiguation",()=>{
 expect(recallLiveFact({...base,query:"预算多少？",context:{...base.context,confirmed:[{text:"小陈希望周四收到方案，预算四万元。"}]}})).toBe("预算是四万元。");
 const history=[...base.history,{role:"user" as const,content:"客户小李希望周六收到方案，预算两万元。"}];
 expect(recallLiveFact({...base,query:"方案给谁？",history})).toBeUndefined();
 expect(recallLiveFact({...base,query:"小李什么时候收到方案？",history})).toBe("希望周六收到方案。");
 expect(recallLiveFact({...base,query:"小张什么时候收到方案？",history})).toBeUndefined();
});
it("keeps the original recording separate from the current confirmed arrangement",()=>{
 const context={scene:{transcript:[{text:"小陈希望周五收到方案，预算三万元。"}]},confirmed:[{text:"小陈希望周四收到方案，预算四万元。"}],work:[]};
 expect(recallLiveFact({...base,context,query:"现在预算多少？"})).toBe("预算是四万元。");
 expect(recallLiveFact({...base,context,query:"录音里预算是多少？"})).toBe("录音识别文本中，预算是三万元。");
 expect(recallLiveFact({...base,context:{...context,scene:{}},query:"录音原话预算多少？"})).toBeUndefined();
 expect(recallLiveFact({...base,context,query:"录音里和当前预算有什么区别？"})).toBeUndefined();
});
