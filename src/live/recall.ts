import type { ReplyInput } from "./types.js";
import { needsHarness } from "./session.js";
import { explicitTextTransform, literalReading, stripCompanionAddress } from "./dialogue.js";

/** Only an explicit named budget can replace an older unconfirmed statement.
 * An unscoped, negated or compound change blocks the shortcut instead of guessing. */
function latestNamedBudget(texts: string[], requestedPerson: string): { value?: string; unresolved?: true } {
  let result: { value?: string; unresolved?: true } = {};
  for (const text of texts) {
    if (/[？?]|预算.*多少|假设|假如|如果|举例/.test(text)) continue;
    const relevant = /预算/.test(text) || /(?:改[为成到]|调整[为到]|变更).{0,20}[零一二两三四五六七八九十百千万0-9]+(?:万元|元|万)/.test(text);
    if (!relevant) continue;
    const people = [...new Set([...text.matchAll(/小[\p{Script=Han}]{1,2}?(?=的|希望|需要|要求|预算|和|与|及|[：:，,、\s]|周|星期|上午|下午|明天|今天)/gu)].map(m=>m[0]))];
    if (people.length && !people.includes(requestedPerson)) continue;
    if (people.length !== 1 || /不是|取消|撤回|作废|不再|未定|待定|不知道|不确定/.test(text)) { result = { unresolved: true }; continue; }
    const values = [...text.matchAll(/预算(?:更正为|改[为成到]|调整[为到]|变更[为到]|是|为)?\s*([0-9零〇一二两三四五六七八九十百千万.,]+(?:万元|元|万))/g)].map(m=>m[1]!);
    result = values.length === 1 ? { value: values[0] } : { unresolved: true };
  }
  return result;
}

/** Conservative factual recall. Assistant prose and tool instructions are never source facts. */
export function recallLiveFact(input: ReplyInput): string | undefined {
  // A statement that changes a concrete arrangement is new input, not a lookup
  // of the previous arrangement (e.g. “会议时间改为两点，请确认”).
  if (/(?:更正|改[为成到]|调整[为到]|变更[为到]|推迟到|提前到|时间[是为]).{0,30}(?:周[一二三四五六日天]|[零一二两三四五六七八九十百千万0-9]+(?:点|元|万|日|号))/.test(input.query)) return;
  const query = input.query.replace(/[？?。！!\s]/g, "");
  const field = /预算.*多少|多少钱|多少金额/.test(query) ? "budget" : /会议|开会/.test(query) && /几点|时间|几时/.test(query) ? "meeting" : /给谁|接收方|接收人/.test(query) ? "recipient" : /什么时候|哪天|日期|何时/.test(query) && /收到|方案|报价|合同|材料/.test(query) ? "deadline" : undefined;
  if (!field) return;
  const statements = input.history.filter(m => {
    if (m.role !== "user" || needsHarness(m.content, input.persona.name)) return false;
    const request = stripCompanionAddress(m.content, input.persona.name);
    if (literalReading(request) !== undefined || explicitTextTransform(request)) return false;
    const changesFacts = /更正|改[为成到]|调整[为到]|变更[为到]|撤回|作废|不再|别用/.test(request);
    if (!changesFacts && /^(?:请|帮我|麻烦|复述|重述|总结|汇总|概括|继续|读全文|朗读|解释|用.{0,8}(?:复述|总结|汇总|概括|说出))/.test(request) && !/^(?:请|帮我)?(?:记住|记一下|记录一下)/.test(request)) return false;
    return true;
  });
  // Elliptical corrections need dialogue context. A parser that cannot resolve
  // “改为周四四万元，现在是什么安排？” must not return the older parsed amount.
  const hasConversationalCorrection = statements.some(m => /更正|改[为成到]|调整[为到]|变更[为到]/.test(m.content));
  const object = ["方案", "报价", "合同", "材料", "资料"].find(s => query.includes(s));
  const requestedPerson = query.match(/小[\p{Script=Han}]{1,2}?(?=希望|想|什么时候|的|要|何时|预算)/u)?.[0];
  const sources = (input.context.confirmed as Array<{text?:string}> | undefined);
  const confirmed = Array.isArray(sources) ? sources.flatMap(s=>typeof s?.text === "string" ? [s.text] : []) : [];
  const scene = input.context.scene as {transcript?: Array<{text?:string}> | string} | undefined;
  const evidence = typeof scene?.transcript === "string" ? [scene.transcript] : (scene?.transcript ?? []).flatMap(s=>typeof s?.text === "string" ? [s.text] : []);
  const utterances = statements.filter(m=>!/[？?]|什么时候|预算.*多少|几点|给谁|叫什么/.test(m.content)).map(m=>m.content);
  function values(texts: string[]) {
    const out: Array<{value:string;who?:string}> = [];
    for (const text of texts) {
      const receives = [...text.matchAll(/(?:测试)?(?:客户)?(小[\p{Script=Han}]{1,2}|[A-Za-z]{2,20})(?:希望|需要|要求)([^。；\n]{0,60}?)(?:收到|拿到)(方案|报价|合同|材料|资料)/gu)];
      const people = [...new Set(receives.map(m=>m[1]!))];
      const relevant = receives.filter(m=>!object || m[3] === object);
      if (field === "recipient") for (const m of relevant) out.push({value:m[1]!,who:m[1]});
      if (field === "deadline") for (const m of relevant) {
        const value = m[2]!.match(/(?:下周|本周|周|星期)[一二三四五六日天]|(?:今天|明天|后天)|\d{1,2}月\d{1,2}[日号]/)?.[0];
        if (value) out.push({value,who:m[1]});
      }
      if (field === "budget" && people.length <= 1) {
        const value=text.match(/预算(?:更正为|改为|调整为|是|为)?\s*([0-9零〇一二两三四五六七八九十百千万.,]+(?:万元|元|万))/)?.[1];
        if(value)out.push({value,who:people[0]});
      }
      if (field === "meeting") for (const clause of text.split(/[。；\n]/)) {
        if(!/会议|开会/.test(clause))continue;
        const value=clause.match(/(?:今天|明天|后天)?(?:上午|下午|中午|晚上)?[0-9一二两三四五六七八九十]+点(?:半)?/)?.[0];
        if(value)out.push({value});
      }
    }
    // An explicit name narrows the question; without a name, ambiguity is preserved.
    const named=out.filter(v=>v.who && query.includes(v.who));
    if (requestedPerson && !named.length) return [];
    return [...new Set((named.length ? named : out).map(v=>v.value))];
  }
  const originalRequested = /原话|(?:录音|音频).{0,8}(?:里|中|识别|说|提到)/.test(query);
  if (originalRequested && /当前|现在|最新|对比|区别|差别/.test(query)) return;
  const original = originalRequested ? values(evidence) : undefined;
  if (original && original.length !== 1) return;
  const result=original ?? values(confirmed);
  // An unparsed confirmed correction must never be replaced by older conversational text.
  const relatedConfirmed=confirmed.some(t=>field === "budget" ? t.includes("预算") : field === "meeting" ? /会议|开会/.test(t) : object ? t.includes(object) : /收到|接收/.test(t));
  if (!originalRequested && !result.length && relatedConfirmed) return;
  if (!originalRequested && !result.length && field === "budget" && requestedPerson && !evidence.some(t=>t.includes("预算"))) {
    const latest = latestNamedBudget(utterances, requestedPerson);
    if (latest.unresolved) return;
    if (latest.value) return `${requestedPerson}的预算是${latest.value}。`;
  }
  if (!originalRequested && !result.length && hasConversationalCorrection) return;
  const remaining=result.length ? result : values([...evidence,...utterances]);
  if(remaining.length !== 1)return;
  const value=remaining[0]!;
  const answer = field === "budget" ? `预算是${value}。` : field === "meeting" ? `会议安排在${value}。` : field === "recipient" ? `接收人是${value}。` : `希望${value}收到${object ?? "材料"}。`;
  return originalRequested ? `录音识别文本中，${answer}` : answer;
}
