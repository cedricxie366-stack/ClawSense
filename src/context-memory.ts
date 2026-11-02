import type { RecentContextPayload, AssistantAnswerPayload } from "./realtime-assistant.js";
import type { ClawSenseWorkflowStore, WorkflowCorrection } from "./workflow-store.js";
import { noteContextReads } from "./processing-context.js";

/** Only owner-confirmed, relevant assertions can override an older machine transcript. */
export async function answerFromConfirmedMemory(query: string, context: RecentContextPayload, workflows: ClawSenseWorkflowStore, fallback: AssistantAnswerPayload): Promise<AssistantAnswerPayload | undefined> {
  if (!/(什么时候|何时|哪天|几点|几时|几号|什么时间|多少|预算)/.test(query)) return undefined;
  const eventIds = new Set(context.recentTranscriptSpans.map((span) => span.eventId));
  const timeQuestion = /(什么时候|何时|哪天|几点|几时|几号|什么时间)/.test(query);
  const topic = query.replace(/刚才|刚刚|客户|希望|什么时候|什么时间|何时|哪天|几点|几时|几号|多少钱|多少|请问|收到|发送|是|的|呢|吗|[？?。，,\s]/g, "");
  const terms = [...new Set(Array.from({ length: Math.max(0, topic.length - 1) }, (_, i) => topic.slice(i, i + 2)))];
  const candidates: Array<{ fact: WorkflowCorrection; score: number }> = [];
  for (const session of await workflows.listSessions()) {
    const named = session.participants.some((person) => person.displayName.length >= 2 && query.includes(person.displayName));
    const inRange = session.startedAt <= context.timeRange.endAt && (session.endedAt ?? Date.now()) >= context.timeRange.startAt;
    for (const fact of session.facts) {
      if (fact.kind === "person") continue;
      const sourceMatches = fact.sourceEventIds.some((id) => eventIds.has(id));
      if (!sourceMatches && !named && !inRange) continue;
      if (fact.assertionState !== "confirmed" || fact.confirmationAuthority !== "owner-confirmation") continue;
      if (timeQuestion && !fact.deadlineLiteral && !/(周[一二三四五六日天]|星期|明天|后天|今天|点|时|日|号|月底)/.test(fact.text)) continue;
      if (!timeQuestion && /多少|预算/.test(query) && !/预算|金额|元|万|价格/.test(fact.text)) continue;
      const score = terms.filter((term) => `${fact.text} ${fact.action ?? ""}`.includes(term)).length + (named ? 2 : 0) + (sourceMatches ? 1 : 0);
      if (score || (!terms.length && sourceMatches)) candidates.push({ fact, score });
    }
  }
  const maximum = Math.max(0, ...candidates.map((candidate) => candidate.score));
  const selected = candidates.filter((candidate) => candidate.score === maximum);
  if (!selected.length) return undefined;
  const values = [...new Set(selected.map(({ fact }) => fact.deadlineLiteral ?? fact.text))];
  if (values.length > 1) return { ...fallback, answerSource: "template", answerText: "相关的已确认记录存在不同说法，我不能确定唯一的最终约定。请先核对并纠正相关面谈。", answerSpokenText: "已确认记录仍有不同说法，需要先核对。" };
  const fact = selected[0].fact;
  noteContextReads(selected.map(({ fact }) => ({ kind: "assertion", id: fact.correctionId })));
  const answerText = `已确认的最新约定是：${fact.text}。这条用户确认优先于较早的机器转写，原件和更正历史仍保留。`;
  const short = /(什么时候|何时|哪天|几点|几时|几号|什么时间)/.test(query) && fact.deadlineLiteral ? fact.deadlineLiteral : fact.text;
  return { ...fallback, answerSource: "template", answerText, memoryCorrectionRefs: selected.map(({ fact }) => ({ kind: "assertion", id: fact.correctionId })), answerSpokenText: short.length <= 180 ? `${short}。更正依据已显示在屏幕上。` : "已有新的用户确认，更正依据已显示在屏幕上。" };
}
