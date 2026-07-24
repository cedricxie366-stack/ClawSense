import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as openAiClient from "../src/openai-client.js";
import { resolveClawSenseConfig } from "../src/config.js";
import { ClawSenseReviewEngine } from "../src/review-engine.js";
import { ClawSenseStateStore, toLocalDateKey, type ClawSenseMemoryCard } from "../src/state-store.js";

const REVIEW_SECTION_TITLES = [
  "Today at a glance",
  "时间线回顾",
  "关键人物",
  "关键项目 / 主题",
  "值得注意的细节",
  "今天遗漏但值得追问的点",
  "明天建议关注的事情",
];

describe("ClawSenseReviewEngine", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-review-test-"));
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("returns a stable empty-day review with fixed sections", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 12, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const review = await engine.getOrGenerateDailyReview(toLocalDateKey(Date.now()));

    expect(review.mode).toBe("heuristic");
    expect(review.keyEventIds).toEqual([]);
    expect(review.sections.map((section) => section.title)).toEqual(REVIEW_SECTION_TITLES);
    expect(review.sections.every((section) => section.items.length > 0)).toBe(true);
  });

  it("renders library page with unified follow-up source and clickable follow-up actions", async () => {
    vi.setSystemTime(new Date(2026, 3, 20, 11, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const html = await engine.renderLibraryPage("2026-04-20", "/api/clawsense/artifacts", "/api/clawsense/library");

    expect(html).toContain("/api/clawsense/followups");
    expect(html).toContain("responseHints.evidenceFollowUpTargets");
    expect(html).toContain('id="followupsPanel"');
    expect(html).toContain('id="followupsList"');
    expect(html).toContain("继续追问（复制）");
    expect(html).toContain("data-followup-index");
    expect(html).toContain("parseVideoMarker");
    expect(html).toContain("video-insight");
    expect(html).toContain("视频线索");
    expect(html).toContain("关键帧 caption");
    expect(html).toContain("视频关键帧");
  });

  it("reuses cached reviews, refreshes on new events, and honors force recompute", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 12, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const date = toLocalDateKey(Date.now());

    await recordAudioEvent(store, {
      memoryId: "audio-review-1",
      deviceId: device.deviceId,
      summary: "standup sync",
      capturedAt: Date.now() - 60_000,
    });

    const first = await engine.getOrGenerateDailyReview(date);
    const cached = await engine.getOrGenerateDailyReview(date);

    expect(cached.reviewId).toBe(first.reviewId);

    vi.setSystemTime(new Date(2026, 2, 10, 12, 10, 0));
    await recordAudioEvent(store, {
      memoryId: "audio-review-2",
      deviceId: device.deviceId,
      summary: "follow-up action items",
      capturedAt: Date.now(),
    });

    const refreshed = await engine.getOrGenerateDailyReview(date);
    expect(refreshed.reviewId).not.toBe(first.reviewId);

    vi.setSystemTime(new Date(2026, 2, 10, 12, 20, 0));
    const forced = await engine.getOrGenerateDailyReview(date, { force: true });
    expect(forced.reviewId).not.toBe(refreshed.reviewId);
    expect(forced.sections.map((section) => section.title)).toEqual(REVIEW_SECTION_TITLES);
  });

  it("reuses cached consolidations and refreshes when new events arrive", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const date = toLocalDateKey(Date.now());

    await recordAudioEvent(store, {
      memoryId: "audio-consolidation-1",
      deviceId: device.deviceId,
      summary: "讨论明天先确认演示截图顺序。",
      transcript: "我们决定明天先确认演示截图顺序，然后再过一遍开场。",
      capturedAt: Date.now() - 60_000,
      projectRefs: ["demo_prep"],
      tags: ["office", "demo"],
    });

    const first = await engine.getOrGenerateDailyConsolidation(date);
    const cached = await engine.getOrGenerateDailyConsolidation(date);

    expect(cached.consolidationId).toBe(first.consolidationId);
    expect(first.projects.length).toBeGreaterThan(0);

    vi.setSystemTime(new Date(2026, 2, 10, 20, 10, 0));
    await recordAudioEvent(store, {
      memoryId: "audio-consolidation-2",
      deviceId: device.deviceId,
      summary: "补了一条新的待办。",
      transcript: "补了一条新的待办，需要今天确认负责人。",
      capturedAt: Date.now(),
      projectRefs: ["demo_prep"],
      tags: ["office", "demo"],
    });

    const refreshed = await engine.getOrGenerateDailyConsolidation(date);
    expect(refreshed.consolidationId).not.toBe(first.consolidationId);
    expect(refreshed.stats.eventCount).toBeGreaterThan(first.stats.eventCount);
  });

  it("extracts task/learning/attention candidates from key-window transcript signals", async () => {
    vi.setSystemTime(new Date(2026, 2, 11, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const date = toLocalDateKey(Date.now());

    await recordAudioEvent(store, {
      memoryId: "audio-consolidation-signal-1",
      deviceId: device.deviceId,
      summary: "会议里确认了报价单提交和复习安排。",
      transcript:
        "明天要先提交报价单，今天会后再确认 Amy 审批。这个概念题老师说考试必考，课后要复习。还有一个时间点待确认。",
      capturedAt: Date.now() - 30_000,
      projectRefs: ["quote_followup"],
      tags: ["office", "study"],
    });

    const consolidation = await engine.getOrGenerateDailyConsolidation(date);

    expect(consolidation.tasks.join(" ")).toContain("任务候选：");
    expect(consolidation.learningPoints.join(" ")).toContain("学习点：");
    expect(consolidation.attentionItems.join(" ")).toContain("待确认：");
  });

  it("keeps people, topics, details, and follow-ups assistant-like without changing schema", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 18, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const date = toLocalDateKey(Date.now());

    await recordAudioEvent(store, {
      memoryId: "audio-review-3",
      deviceId: device.deviceId,
      summary: "准备明天的产品演示脚本",
      transcript: "和小李确认明天的产品演示脚本，最后决定早上先过一遍开场和关键截图。",
      note: "画面里能看到桌面上的演示提纲和时间安排。",
      peopleRefs: ["person_li"],
      tags: ["product-demo"],
      capturedAt: Date.now() - 30_000,
    });

    await engine.annotatePerson({
      personRef: "person_li",
      displayName: "小李",
      relationship: "同事",
      nextWatchFor: "确认演示脚本是否定稿",
    });

    const review = await engine.getOrGenerateDailyReview(date);
    const peopleSection = review.sections.find((section) => section.title === "关键人物");
    const projectSection = review.sections.find((section) => section.title === "关键项目 / 主题");
    const detailSection = review.sections.find((section) => section.title === "值得注意的细节");
    const followUpSection = review.sections.find((section) => section.title === "今天遗漏但值得追问的点");

    expect(peopleSection?.items.join(" ")).toContain("小李");
    expect(projectSection?.items.join(" ")).toContain("演示");
    expect(projectSection?.items.join(" ")).not.toContain("audio-window");
    expect(detailSection?.items.join(" ")).toContain("语音片段");
    expect(followUpSection?.items.join(" ")).toMatch(/结论|人物|项目|主题/);
  });

  it("builds controlled assistant context for the last hour without exposing arbitrary files", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 18, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();

    await recordAudioEvent(store, {
      memoryId: "audio-context-1",
      deviceId: device.deviceId,
      summary: "讨论明天演示的开场和截图顺序",
      transcript: "我们刚才决定明天先讲价值主张，再切到关键截图。",
      capturedAt: now - 20 * 60_000,
    });
    await store.recordCapture({
      memoryId: "image-context-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "image",
      summary: "桌面上放着演示提纲和待办便签",
      createdAt: now - 10 * 60_000,
      capturedAt: now - 10 * 60_000,
      sourcePath: "/tmp/image-context-1.jpg",
      fileName: "image-context-1.jpg",
      mime: "image/jpeg",
      sizeBytes: 2048,
      storageRelPath: "2026/03/10/device/image-context-1.jpg",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "multimodal-preview",
      analysisProvider: "openai",
      analysisStatus: "succeeded",
    });
    await recordAudioEvent(store, {
      memoryId: "audio-context-old",
      deviceId: device.deviceId,
      summary: "早上的闲聊",
      transcript: "这个窗口应该被 last-hour 过滤掉。",
      capturedAt: now - 2 * 60 * 60 * 1000,
    });

    const context = await engine.buildAssistantContext({
      scope: "last-hour",
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });

    expect(context.scope).toBe("last-hour");
    expect(context.counts.events).toBe(2);
    expect(context.summary).toContain("过去一小时");
    expect(context.review).toBeUndefined();
    expect(context.windows.length).toBeGreaterThan(0);
    expect(context.highlights.recentImages[0]?.artifact?.url).toBe(
      "/api/clawsense/artifacts?id=" +
        encodeURIComponent(context.highlights.recentImages[0]?.artifact?.artifactId ?? ""),
    );
    expect(context.highlights.recentConversations[0]?.summary).toContain("讨论明天演示");
  });

  it("surfaces question-relevant older windows instead of only recent windows", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 23, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();

    await recordAudioEvent(store, {
      memoryId: "audio-older-amy",
      deviceId: device.deviceId,
      summary: "采集到一段连续对话，当前语义仍待补强。",
      transcript: "Amy 重点追问了报价区间和演示顺序。",
      capturedAt: new Date(2026, 2, 10, 9, 5, 0).getTime(),
    });

    for (let index = 0; index < 7; index += 1) {
      await recordAudioEvent(store, {
        memoryId: `audio-generic-${index + 1}`,
        deviceId: device.deviceId,
        summary: `普通对话窗口 ${index + 1}`,
        transcript: `这是一段常规记录 ${index + 1}`,
        capturedAt: now - (index + 1) * 20 * 60_000,
      });
    }

    const withoutQuestion = await engine.buildAssistantContext({
      scope: "today",
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });
    const withQuestion = await engine.buildAssistantContext({
      scope: "today",
      question: "Amy 今天关于报价都讲了什么？",
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });

    expect(withoutQuestion.windows.some((window) => window.transcriptText.includes("Amy"))).toBe(false);
    expect(withQuestion.windows.some((window) => window.transcriptText.includes("Amy"))).toBe(true);
  });

  it("keeps broad custom-range conversation context wider than six recent windows", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 22, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();
    const startAt = now - 4 * 60 * 60_000;

    for (let index = 0; index < 18; index += 1) {
      await recordAudioEvent(store, {
        memoryId: `audio-four-hour-${index + 1}`,
        deviceId: device.deviceId,
        summary: `第 ${index + 1} 段会议语音`,
        transcript:
          index === 0
            ? "第1段讨论数据口径和看板指标。"
            : index === 17
              ? "第18段讨论收尾行动项和明天谁来跟进。"
              : `第${index + 1}段讨论项目排期、风险和验证结果。`,
        capturedAt: startAt + index * 12 * 60_000,
      });
    }

    const context = await engine.buildAssistantContext({
      scope: "custom-range",
      startAt,
      endAt: now,
      question: "过去4个小时我们聊了什么？",
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });
    const transcriptText = context.windows.map((window) => window.transcriptText).join("\n");

    expect(context.windows.length).toBeGreaterThan(6);
    expect(context.windows.length).toBeLessThanOrEqual(14);
    expect(transcriptText).toContain("第1段讨论数据口径");
    expect(transcriptText).toContain("第18段讨论收尾行动项");
    expect(context.highlights.audioCoverage.transcriptReadyWindows).toBe(18);
  });

  it("persists rolling conversation digests while building assistant context", async () => {
    vi.setSystemTime(new Date(2026, 5, 25, 12, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();
    const startAt = now - 2 * 60 * 60_000;

    await recordAudioEvent(store, {
      memoryId: "rolling-digest-audio-1",
      deviceId: device.deviceId,
      summary: "讨论 AI 陪练剧本和语料同步。",
      transcript: "AI陪练可以根据文本生成剧本，产品团队需要确认语料同步方案。",
      capturedAt: startAt + 5 * 60_000,
    });
    await recordAudioEvent(store, {
      memoryId: "rolling-digest-audio-2",
      deviceId: device.deviceId,
      summary: "讨论考核报表和培训安排。",
      transcript: "后面还要确认考核点通过率，海南物流培训也要区分角色讲解工单流程。",
      capturedAt: startAt + 45 * 60_000,
    });

    const context = await engine.buildAssistantContext({
      scope: "custom-range",
      startAt,
      endAt: now,
      question: "过去2小时会议里有哪些任务？",
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });
    const stored = await store.listConversationDigests({
      date: context.date,
      scope: "custom-range",
      startAt,
      endAt: now,
    });
    const memoryCards = await store.listMemoryCards({
      date: context.date,
      scope: "custom-range",
      startAt,
      endAt: now,
    });

    expect(context.rollingDigests).toHaveLength(1);
    expect(context.rollingDigests[0]?.topicIndex.length).toBeGreaterThanOrEqual(2);
    expect(context.rollingDigests[0]?.keywordIndex.some((item) => item.keyword === "AI陪练")).toBe(true);
    expect(context.rollingDigests[0]?.topicIndex.some((topic) => topic.taskHints.length > 0)).toBe(true);
    expect(stored[0]?.digestId).toBe(context.rollingDigests[0]?.digestId);
    expect(context.memoryCards.some((card) => card.kind === "task" && card.summary.includes("语料同步"))).toBe(true);
    expect(memoryCards.some((card) => card.kind === "topic" && card.title === "AI 陪练与剧本")).toBe(true);
  });

  it("removes assistant spoken answers from review-engine windows", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 23, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    await recordAudioEvent(store, {
      memoryId: "audio-assistant-echo-mixed",
      deviceId: device.deviceId,
      summary: "会议模式下，我还没有抓到清晰讨论内容。当前可确认的场景是：画面展示了电脑屏幕。",
      transcript:
        "会议模式下，我还没有抓到清晰讨论内容。当前可确认的场景是：画面展示了电脑屏幕。真正讨论的是上线前要确认法律风险和品牌风险。",
      capturedAt: Date.now() - 5 * 60_000,
    });

    const context = await engine.buildAssistantContext({
      scope: "last-hour",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.windows[0]?.transcriptText).toContain("法律风险");
    expect(context.windows[0]?.transcriptText).not.toContain("会议模式下");
    expect(context.windows[0]?.primarySummary).not.toContain("会议模式下");
  });

  it("summarizes last known activity when the queried day has no events", async () => {
    vi.setSystemTime(new Date("2026-03-11T09:00:00+08:00"));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    await recordAudioEvent(store, {
      memoryId: "audio-previous-day",
      deviceId: device.deviceId,
      summary: "昨晚确认了演示截图顺序。",
      transcript: "昨晚我们确认了演示截图顺序，今天早上再核一次。",
      capturedAt: new Date("2026-03-10T22:10:00+08:00").getTime(),
    });

    const context = await engine.buildAssistantContext({
      scope: "today",
      date: "2026-03-11",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.counts.events).toBe(0);
    expect(context.recentActivity.priorEventCount).toBeGreaterThan(0);
    expect(context.recentActivity.sampleWindows.length).toBeGreaterThan(0);
    expect(context.recentActivity.sampleWindows[0]?.summary).toContain("昨晚确认了演示截图顺序");
    expect(context.summary).toContain("最近一次有效记录");
    expect(context.summary).toContain("过去 7 天");
  });

  it("uses semantic memory recall hints to include a relevant older window when lexical match is weak", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 23, 30, 0));

    const store = createStore(rootDir);
    const semanticSearch = vi.fn(async () => [
      { eventId: "audio-older-semantic" },
    ]);
    const engine = createEngine(rootDir, store, {
      memorySearch: {
        searchRelevantMemories: semanticSearch,
      },
    });
    const baselineEngine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();

    await recordAudioEvent(store, {
      memoryId: "audio-older-semantic",
      deviceId: device.deviceId,
      summary: "普通对话窗口 0",
      transcript: "这段主要在核对预算审批节点、谁来拍板以及风险兜底。",
      capturedAt: new Date(2026, 2, 10, 9, 5, 0).getTime(),
    });

    for (let index = 0; index < 7; index += 1) {
      await recordAudioEvent(store, {
        memoryId: `audio-semantic-generic-${index + 1}`,
        deviceId: device.deviceId,
        summary: `普通对话窗口 ${index + 1}`,
        transcript: `这是一段常规记录 ${index + 1}`,
        capturedAt: now - (index + 1) * 20 * 60_000,
      });
    }

    const question = "今天那段需要优先回看的讨论具体定了什么？";
    const withoutSemantic = await baselineEngine.buildAssistantContext({
      scope: "today",
      question,
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });
    const withSemantic = await engine.buildAssistantContext({
      scope: "today",
      question,
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });

    expect(withoutSemantic.windows.some((window) => window.transcriptText.includes("预算审批节点"))).toBe(false);
    expect(withSemantic.windows.some((window) => window.transcriptText.includes("预算审批节点"))).toBe(true);
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        question,
        startAt: expect.any(Number),
        endAt: expect.any(Number),
        limit: 12,
      }),
    );
    const semanticArgs = semanticSearch.mock.calls[0]?.[0];
    expect(semanticArgs?.startAt).toBeLessThan(semanticArgs?.endAt);
  });

  it("filters assistant context by explicit custom time ranges", async () => {
    vi.setSystemTime(new Date(2026, 2, 15, 18, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();
    const inside = now - 10 * 60_000;
    const outside = now - 2 * 60 * 60 * 1000;

    await recordAudioEvent(store, {
      memoryId: "audio-custom-range-in",
      deviceId: device.deviceId,
      summary: "这段对话在自定义时间窗内。",
      transcript: "我们在这段时间里确认了演示顺序。",
      capturedAt: inside,
    });
    await recordAudioEvent(store, {
      memoryId: "audio-custom-range-out",
      deviceId: device.deviceId,
      summary: "这段对话在时间窗外。",
      transcript: "这段内容不应该被自定义时间窗返回。",
      capturedAt: outside,
    });

    const context = await engine.buildAssistantContext({
      scope: "custom-range",
      startAt: inside - 30_000,
      endAt: inside + 30_000,
      artifactUrlBase: "/api/clawsense/artifacts",
      now,
    });

    expect(context.scope).toBe("custom-range");
    expect(context.startAt).toBe(inside - 30_000);
    expect(context.endAt).toBe(inside + 30_000);
    expect(context.counts.events).toBe(1);
    expect(context.windows).toHaveLength(1);
    expect(context.windows[0]?.primarySummary).toContain("自定义时间窗内");
    expect(context.windows[0]?.events[0]?.summary).toContain("自定义时间窗内");
    expect(context.windows[0]?.events[0]?.summary).not.toContain("时间窗外");
  });

  it("builds cross-day person history from natural-language questions", async () => {
    vi.setSystemTime(new Date(2026, 2, 31, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    const dayOne = new Date(2026, 2, 29, 9, 10, 0).getTime();
    const dayTwo = new Date(2026, 2, 30, 14, 20, 0).getTime();

    const first = await recordAudioEvent(store, {
      memoryId: "amy-history-1",
      deviceId: device.deviceId,
      summary: "Amy 追问演示开场和报价顺序",
      transcript: "Amy 说先讲价值主张，再讲报价。",
      capturedAt: dayOne,
      peopleRefs: ["person_amy"],
    });
    const second = await recordAudioEvent(store, {
      memoryId: "amy-history-2",
      deviceId: device.deviceId,
      summary: "Amy 复核演示截图和报价区间",
      transcript: "Amy 又确认了一遍报价区间和截图顺序。",
      capturedAt: dayTwo,
      peopleRefs: ["person_amy"],
    });

    await engine.annotatePerson({
      personRef: "person_amy",
      displayName: "Amy",
      relationship: "老板",
      notes: "经常会追问演示开场和报价。",
      nextWatchFor: "确认她这次更关注报价还是开场。",
      eventIds: [first.event.eventId, second.event.eventId],
    });
    await store.putMemoryCards([
      {
        cardId: "memcard-amy-demo-task",
        date: "2026-03-29",
        scope: "custom-range",
        kind: "task",
        title: "Amy 要求确认报价顺序",
        summary: "任务线索来自 Amy 参与的演示准备窗口。",
        status: "active",
        confidence: "medium",
        startAt: dayOne,
        endAt: dayOne + 5 * 60_000,
        lastSeenAt: dayOne + 5 * 60_000,
        createdAt: dayOne,
        updatedAt: dayOne + 5 * 60_000,
        keywords: ["Amy", "报价", "演示"],
        source: "rolling-digest",
        evidence: {
          digestId: "digest-amy-history",
          topicIndexes: [1],
          windowIds: [first.event.windowId],
          timeRanges: ["09:10-09:15"],
          taskHints: ["Amy 要求先确认报价顺序。"],
          transcriptExcerpts: ["先讲价值主张，再讲报价。"],
        },
      } satisfies ClawSenseMemoryCard,
    ]);

    const history = await engine.buildIdentityHistory({
      question: "Amy 之前在我的历史记忆里出现过什么？",
      artifactUrlBase: "/api/clawsense/artifacts",
      currentPersonRefs: ["person_amy"],
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.displayName).toBe("Amy");
    expect(history[0]?.relationship).toBe("老板");
    expect(history[0]?.occurrenceCount).toBeGreaterThanOrEqual(2);
    expect(history[0]?.relatedDates).toEqual(expect.arrayContaining(["2026-03-29", "2026-03-30"]));
    expect(history[0]?.recentMoments[0]?.summary).toContain("Amy");
    expect(history[0]?.memoryCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardId: "memcard-amy-demo-task",
          kind: "task",
          title: "Amy 要求确认报价顺序",
          taskHints: ["Amy 要求先确认报价顺序。"],
        }),
      ]),
    );
  });

  it("matches person history by relationship token when question omits display name", async () => {
    vi.setSystemTime(new Date(2026, 2, 31, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    const dayOne = new Date(2026, 2, 29, 11, 20, 0).getTime();
    const dayTwo = new Date(2026, 2, 30, 16, 30, 0).getTime();

    const first = await recordAudioEvent(store, {
      memoryId: "amy-role-history-1",
      deviceId: device.deviceId,
      summary: "Amy 要求先确认报价，再补演示截图。",
      transcript: "Amy 说报价段和截图段都要再过一遍。",
      capturedAt: dayOne,
      peopleRefs: ["person_amy"],
    });
    const second = await recordAudioEvent(store, {
      memoryId: "amy-role-history-2",
      deviceId: device.deviceId,
      summary: "Amy 复核明天演示顺序。",
      transcript: "Amy 说明天先讲价值，再讲报价。",
      capturedAt: dayTwo,
      peopleRefs: ["person_amy"],
    });

    await engine.annotatePerson({
      personRef: "person_amy",
      displayName: "Amy",
      relationship: "老板",
      notes: "经常会问报价和演示顺序。",
      eventIds: [first.event.eventId, second.event.eventId],
    });

    const history = await engine.buildIdentityHistory({
      question: "我老板之前在历史记忆里出现过什么？",
      artifactUrlBase: "/api/clawsense/artifacts",
      currentPersonRefs: [],
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.displayName).toBe("Amy");
    expect(history[0]?.relationship).toBe("老板");
    expect(history[0]?.occurrenceCount).toBeGreaterThanOrEqual(2);
  });

  it("prefers current-context person ref when singular historical question only gives role", async () => {
    vi.setSystemTime(new Date(2026, 2, 31, 11, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    const dayOne = new Date(2026, 2, 29, 9, 30, 0).getTime();
    const dayTwo = new Date(2026, 2, 30, 15, 0, 0).getTime();
    const dayThree = new Date(2026, 2, 31, 9, 10, 0).getTime();

    const amyHistory = await recordAudioEvent(store, {
      memoryId: "amy-role-target-history",
      deviceId: device.deviceId,
      summary: "Amy 复核演示脚本。",
      transcript: "Amy 要求先确认演示开场。",
      capturedAt: dayOne,
      peopleRefs: ["person_amy"],
    });
    const bossZHHistory = await recordAudioEvent(store, {
      memoryId: "boss-zh-role-history",
      deviceId: device.deviceId,
      summary: "王总确认报价区间。",
      transcript: "王总说先把报价区间再对齐一次。",
      capturedAt: dayTwo,
      peopleRefs: ["person_wang"],
    });
    const amyCurrent = await recordAudioEvent(store, {
      memoryId: "amy-role-target-current",
      deviceId: device.deviceId,
      summary: "Amy 今天继续跟进演示细节。",
      transcript: "Amy 说明天开会前再过一遍演示。",
      capturedAt: dayThree,
      peopleRefs: ["person_amy"],
    });

    await engine.annotatePerson({
      personRef: "person_amy",
      displayName: "Amy",
      relationship: "老板",
      notes: "常看演示开场和截图顺序。",
      eventIds: [amyHistory.event.eventId, amyCurrent.event.eventId],
    });
    await engine.annotatePerson({
      personRef: "person_wang",
      displayName: "王总",
      relationship: "老板",
      notes: "更多关注报价细节。",
      eventIds: [bossZHHistory.event.eventId],
    });

    const history = await engine.buildIdentityHistory({
      question: "这个老板之前在历史记忆里出现过什么？",
      artifactUrlBase: "/api/clawsense/artifacts",
      currentPersonRefs: ["person_amy"],
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.displayName).toBe("Amy");
    expect(history[0]?.ref).toBe("person_amy");
  });

  it("builds cross-day project history from natural-language questions", async () => {
    vi.setSystemTime(new Date(2026, 2, 31, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    const dayOne = new Date(2026, 2, 29, 9, 10, 0).getTime();
    const dayTwo = new Date(2026, 2, 30, 14, 20, 0).getTime();

    await recordAudioEvent(store, {
      memoryId: "demo-history-1",
      deviceId: device.deviceId,
      summary: "上午在确认演示开场和截图顺序",
      transcript: "先讲价值主张，再切到关键截图。",
      capturedAt: dayOne,
      projectRefs: ["demo_prep"],
      tags: ["demo"],
    });
    await recordAudioEvent(store, {
      memoryId: "demo-history-2",
      deviceId: device.deviceId,
      summary: "下午继续补齐演示报价段和收尾动作",
      transcript: "报价区间要放在第二部分，最后再讲下一步。",
      capturedAt: dayTwo,
      projectRefs: ["demo_prep"],
      tags: ["demo"],
    });
    const firstEvent = (await store.listEvents()).find((event) => event.eventId === "demo-history-1");
    await store.putMemoryCards([
      {
        cardId: "memcard-demo-prep-topic",
        date: "2026-03-29",
        scope: "custom-range",
        kind: "topic",
        title: "演示准备与截图顺序",
        summary: "演示准备相关话题持续出现。",
        status: "active",
        confidence: "medium",
        startAt: dayOne,
        endAt: dayOne + 5 * 60_000,
        lastSeenAt: dayOne + 5 * 60_000,
        createdAt: dayOne,
        updatedAt: dayOne + 5 * 60_000,
        keywords: ["演示", "截图", "demo_prep"],
        source: "rolling-digest",
        evidence: {
          digestId: "digest-demo-history",
          topicIndexes: [1],
          windowIds: firstEvent ? [firstEvent.windowId] : [],
          timeRanges: ["09:10-09:15"],
          taskHints: ["确认演示截图顺序。"],
          transcriptExcerpts: ["先讲价值主张，再切到关键截图。"],
        },
      } satisfies ClawSenseMemoryCard,
    ]);

    const history = await engine.buildProjectHistory({
      question: "演示准备之前在我的历史记忆里出现过什么？",
      artifactUrlBase: "/api/clawsense/artifacts",
      currentProjectRefs: ["demo_prep"],
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.label).toBe("演示准备");
    expect(history[0]?.occurrenceCount).toBeGreaterThanOrEqual(2);
    expect(history[0]?.relatedDates).toEqual(expect.arrayContaining(["2026-03-29", "2026-03-30"]));
    expect(history[0]?.recentMoments[0]?.summary).toContain("演示");
    expect(history[0]?.memoryCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardId: "memcard-demo-prep-topic",
          kind: "topic",
          title: "演示准备与截图顺序",
          taskHints: ["确认演示截图顺序。"],
        }),
      ]),
    );
  });

  it("matches localized office project aliases in project history questions", async () => {
    vi.setSystemTime(new Date(2026, 5, 26, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    const dayOne = new Date(2026, 5, 25, 10, 1, 0).getTime();
    const dayTwo = new Date(2026, 5, 25, 10, 32, 0).getTime();
    await recordAudioEvent(store, {
      memoryId: "ai-coaching-history-1",
      deviceId: device.deviceId,
      summary: "AI 陪练系统演示，讨论根据聊天记录语料自动生成剧本。",
      transcript: "AI 陪练要支持聊天记录语料同步，并用文本文档自动生成剧本。",
      capturedAt: dayOne,
    });
    await recordAudioEvent(store, {
      memoryId: "ai-coaching-history-2",
      deviceId: device.deviceId,
      summary: "继续讨论 AI 陪练报告视角、考核点通过率和缺陷项汇总。",
      transcript: "陪练报告需要把对话记录、考核点通过率和缺陷项放在一起看。",
      capturedAt: dayTwo,
    });
    await store.recordCapture({
      memoryId: "ai-coaching-later-empty-visual",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "image",
      summary: "画面完全呈现为黑色，没有任何可见的人物、环境、物品或屏幕内容。",
      createdAt: dayTwo + 30 * 60_000,
      capturedAt: dayTwo + 30 * 60_000,
      sourcePath: "/tmp/ai-coaching-later-empty-visual.jpg",
      fileName: "ai-coaching-later-empty-visual.jpg",
      mime: "image/jpeg",
      sizeBytes: 2048,
      storageRelPath: "2026/06/25/device/ai-coaching-later-empty-visual.jpg",
      retentionExpiresAt: dayTwo + 30 * 60_000 + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "metadata-only",
      projectRefs: ["ai_coaching"],
      tags: ["office"],
    });

    const history = await engine.buildProjectHistory({
      question: "AI 陪练这个项目之前在我的历史记忆里出现过什么？",
      artifactUrlBase: "/api/clawsense/artifacts",
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.ref).toBe("ai_coaching");
    expect(history[0]?.label).toBe("AI 陪练");
    expect(history[0]?.occurrenceCount).toBeGreaterThanOrEqual(1);
    expect(history[0]?.recentMoments[0]?.transcriptExcerpt).toMatch(/AI 陪练|陪练/);
    expect(history[0]?.recentMoments[0]?.summary).not.toContain("完全呈现为黑色");
  });

  it("keeps same csAudio:v2 session clips grouped into one context window", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 19, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const sessionStart = Date.now() - 40 * 60_000;

    await recordAudioEvent(store, {
      memoryId: "audio-session-context-1",
      deviceId: device.deviceId,
      summary: "第一次讨论演示顺序",
      transcript: "先确认开场，再展示两张关键截图。",
      capturedAt: sessionStart,
      note: `csAudio:v2 session=ctx-001 segment=1 sessionStart=${sessionStart} boundary=max-duration clipMs=15000 voicedMs=9800 continued=1`,
    });
    await recordAudioEvent(store, {
      memoryId: "audio-session-context-2",
      deviceId: device.deviceId,
      summary: "第二次讨论演示顺序",
      transcript: "后面补一段客户案例，再收回到下一步行动。",
      capturedAt: sessionStart + 18 * 60_000,
      note: `csAudio:v2 session=ctx-001 segment=2 sessionStart=${sessionStart} boundary=max-duration clipMs=15000 voicedMs=10100 continued=1`,
    });

    const context = await engine.buildAssistantContext({
      scope: "last-hour",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.counts.events).toBe(2);
    expect(context.windows).toHaveLength(1);
    expect(context.windows[0]?.startedAt).toBe(sessionStart);
    expect(context.windows[0]?.audioCount).toBe(2);
  });

  it("keeps same csAudio:v2 session grouped even if legacy source window ids drift", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 19, 40, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const sessionStart = Date.now() - 35 * 60_000;

    await store.recordCapture({
      memoryId: "audio-session-drift-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "先确认演示开场怎么说",
      transcript: "先确认演示开场怎么说。",
      note: `csAudio:v2 session=drift-001 segment=1 sessionStart=${sessionStart} boundary=max-duration clipMs=15000 voicedMs=9800 continued=1`,
      createdAt: sessionStart,
      capturedAt: sessionStart,
      sourcePath: "/tmp/audio-session-drift-1.wav",
      fileName: "audio-session-drift-1.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/device/audio-session-drift-1.wav",
      retentionExpiresAt: sessionStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
    });
    await store.recordCapture({
      memoryId: "audio-session-drift-2",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "后面再补客户案例和收尾动作",
      transcript: "后面再补客户案例和收尾动作。",
      note: `csAudio:v2 session=drift-001 segment=2 sessionStart=${sessionStart} boundary=silence clipMs=12000 voicedMs=8800 continued=0`,
      createdAt: sessionStart + 18 * 60 * 1000,
      capturedAt: sessionStart + 18 * 60 * 1000,
      sourcePath: "/tmp/audio-session-drift-2.wav",
      fileName: "audio-session-drift-2.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/device/audio-session-drift-2.wav",
      retentionExpiresAt: sessionStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
    });

    const statePath = path.join(rootDir, "plugins", "clawsense", "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { events: Array<{ windowId: string }> };
    state.events[0]!.windowId = "legacy-window-a";
    state.events[1]!.windowId = "legacy-window-b";
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const context = await engine.buildAssistantContext({
      scope: "last-hour",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.windows).toHaveLength(1);
    expect(context.windows[0]?.audioCount).toBe(2);
    expect(context.windows[0]?.startedAt).toBe(sessionStart);
  });

  it("prefers later strong summaries over the first degraded fallback inside one window", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 19, 50, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const sessionStart = Date.now() - 20 * 60 * 1000;

    await store.recordCapture({
      memoryId: "audio-summary-choice-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but speech transcription was unavailable.",
      transcript: "",
      note: `csAudio:v2 session=summary-001 segment=1 sessionStart=${sessionStart} boundary=max-duration clipMs=15000 voicedMs=9800 continued=1`,
      createdAt: sessionStart,
      capturedAt: sessionStart,
      sourcePath: "/tmp/audio-summary-choice-1.wav",
      fileName: "audio-summary-choice-1.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/device/audio-summary-choice-1.wav",
      retentionExpiresAt: sessionStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });
    await store.recordCapture({
      memoryId: "audio-summary-choice-2",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "讨论明天演示的开场和截图顺序",
      transcript: "我们刚才决定先讲价值主张，再切到关键截图。",
      note: `csAudio:v2 session=summary-001 segment=2 sessionStart=${sessionStart} boundary=silence clipMs=12000 voicedMs=8800 continued=0`,
      createdAt: sessionStart + 10 * 60 * 1000,
      capturedAt: sessionStart + 10 * 60 * 1000,
      sourcePath: "/tmp/audio-summary-choice-2.wav",
      fileName: "audio-summary-choice-2.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/device/audio-summary-choice-2.wav",
      retentionExpiresAt: sessionStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "succeeded",
    });

    const context = await engine.buildAssistantContext({
      scope: "last-hour",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.highlights.recentConversations[0]?.summary).toContain("讨论明天演示的开场和截图顺序");
    expect(context.highlights.recentConversations[0]?.summary).not.toContain("speech transcription was unavailable");
  });

  it("replaces fully degraded window summaries with a user-facing fallback instead of leaking raw degraded text", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const sessionStart = Date.now() - 12 * 60 * 1000;

    await store.recordCapture({
      memoryId: "audio-summary-degraded-only",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but speech transcription was unavailable.",
      transcript: "",
      note: `csAudio:v2 session=summary-002 segment=1 sessionStart=${sessionStart} boundary=silence clipMs=12000 voicedMs=8800 continued=0`,
      createdAt: sessionStart,
      capturedAt: sessionStart,
      sourcePath: "/tmp/audio-summary-degraded-only.wav",
      fileName: "audio-summary-degraded-only.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/device/audio-summary-degraded-only.wav",
      retentionExpiresAt: sessionStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const context = await engine.buildAssistantContext({
      scope: "last-hour",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.highlights.recentConversations[0]?.summary).toBe("采集到一段连续对话，当前语义仍待补强。");
    expect(context.windows[0]?.primarySummary).toBe("采集到一段连续对话，当前语义仍待补强。");
  });

  it("splits legacy over-merged windows by csAudio:v2 session hints", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 19, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const sharedWindowId = "legacy-overmerged-window";
    const firstStart = Date.now() - 45 * 60_000;
    const secondStart = Date.now() - 12 * 60_000;

    await store.recordCapture({
      memoryId: "audio-legacy-session-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "第一次对话",
      transcript: "先确认演示开场怎么说。",
      note: `csAudio:v2 session=legacy-A segment=1 sessionStart=${firstStart} boundary=silence clipMs=14000 voicedMs=9600 continued=0`,
      createdAt: firstStart,
      capturedAt: firstStart,
      sourcePath: "/tmp/audio-legacy-session-1.wav",
      fileName: "audio-legacy-session-1.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/device/audio-legacy-session-1.wav",
      retentionExpiresAt: firstStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
    });
    await store.recordCapture({
      memoryId: "audio-legacy-session-2",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "第二次对话",
      transcript: "后面再补客户案例和收尾动作。",
      note: `csAudio:v2 session=legacy-B segment=1 sessionStart=${secondStart} boundary=silence clipMs=12000 voicedMs=8800 continued=0`,
      createdAt: secondStart,
      capturedAt: secondStart,
      sourcePath: "/tmp/audio-legacy-session-2.wav",
      fileName: "audio-legacy-session-2.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/device/audio-legacy-session-2.wav",
      retentionExpiresAt: secondStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
    });

    const statePath = path.join(rootDir, "plugins", "clawsense", "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { events: Array<{ windowId: string }> };
    state.events[0]!.windowId = sharedWindowId;
    state.events[1]!.windowId = sharedWindowId;
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const context = await engine.buildAssistantContext({
      scope: "last-hour",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.windows).toHaveLength(2);
    expect(new Set(context.windows.map((window) => window.windowId)).size).toBe(2);
  });

  it("keeps daily review schema stable inside assistant context for today", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 19, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    await recordAudioEvent(store, {
      memoryId: "audio-context-review-1",
      deviceId: device.deviceId,
      summary: "晚上确认明天的待办优先级",
      transcript: "明天先处理演示稿，再确认客户回访。",
      capturedAt: Date.now() - 15 * 60_000,
    });

    const context = await engine.buildAssistantContext({
      scope: "today",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    expect(context.review?.sections.map((section) => section.title)).toEqual(REVIEW_SECTION_TITLES);
    expect(context.summary).toBe(context.review?.summary);
  });

  it("uses provider-qualified reviewModel client for multimodal daily review generation", async () => {
    vi.setSystemTime(new Date(2026, 2, 29, 21, 0, 0));

    const store = createStore(rootDir);
    const qwenClient = {
      responses: {
        create: vi.fn(),
      },
    } as any;
    const openAiReviewClient = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            summary: "今天重点是确认了演示节奏和会后跟进项。",
            sections: REVIEW_SECTION_TITLES.map((title) => ({
              title,
              items: ["已记录一条关键事项。"],
            })),
            keyWindowIds: [],
          }),
        }),
      },
    } as any;

    const engine = createEngine(rootDir, store, {
      cfg: {
        analysisMode: "multimodal-preferred",
        reviewModel: "openai/gpt-4.1-mini",
        openaiApiKey: "openai-explicit-key",
        openaiBaseUrl: "https://api.openai.example/v1",
        visionProvider: "openai",
        visionModel: "gpt-4.1-mini",
      },
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "qwen-omni-turbo",
              provider: "qwen",
            },
          },
        },
        models: {
          providers: {
            qwen: {
              apiKey: "qwen-test-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
    });
    const resolveClient = vi.fn((providerId?: string) => {
      const normalized = providerId?.trim().toLowerCase();
      if (!normalized || normalized === "qwen") {
        return qwenClient;
      }
      if (normalized === "openai") {
        return openAiReviewClient;
      }
      return null;
    });
    (engine as unknown as { resolveMultimodalClient: (providerId?: string) => unknown }).resolveMultimodalClient =
      resolveClient;
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 12 * 60_000;
    await recordAudioEvent(store, {
      memoryId: "review-provider-qualified-1",
      deviceId: device.deviceId,
      summary: "确认明天汇报顺序和版本号。",
      transcript: "先讲价值主张，再展示两张关键截图，最后补风险清单。",
      capturedAt,
    });

    const date = toLocalDateKey(Date.now());
    const { windows } = await engine.buildEvents({ date });
    expect(windows.length).toBeGreaterThan(0);
    const keyWindows = windows.slice().sort((left, right) => right.score - left.score).slice(0, 6);
    const review = await (
      engine as unknown as {
        tryGenerateMultimodalReview: (
          date: string,
          windows: unknown[],
          keyWindows: unknown[],
          people: unknown[],
        ) => Promise<{ mode: string } | null>;
      }
    ).tryGenerateMultimodalReview(date, windows, keyWindows, []);

    expect(resolveClient).toHaveBeenCalled();
    expect(openAiReviewClient.responses.create).toHaveBeenCalledTimes(1);
    expect(qwenClient.responses.create).not.toHaveBeenCalled();
    expect(openAiReviewClient.responses.create.mock.calls[0]?.[0]?.model).toBe("gpt-4.1-mini");
    expect(resolveClient).toHaveBeenCalledWith("openai");
    expect(review?.mode).toBe("multimodal");
  });

  it("falls back to chat completions when multimodal daily review responses API is unavailable", async () => {
    vi.setSystemTime(new Date(2026, 2, 29, 21, 30, 0));

    const store = createStore(rootDir);
    const compatibleClient = {
      responses: {
        create: vi.fn().mockRejectedValue(new Error("responses unsupported")),
      },
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "今天重点是复盘了会议里的任务和风险。",
                    sections: REVIEW_SECTION_TITLES.map((title) => ({
                      title,
                      items: ["基于转写整理出一条可用结论。"],
                    })),
                    keyWindowIds: [],
                  }),
                },
              },
            ],
          }),
        },
      },
    } as any;

    const engine = createEngine(rootDir, store, {
      cfg: {
        analysisMode: "multimodal-preferred",
        reviewModel: "dashscope/qwen3.6-plus",
      },
      runtimeConfig: {
        models: {
          providers: {
            dashscope: {
              apiKey: "dashscope-test-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
    });
    (engine as unknown as { resolveMultimodalClient: (providerId?: string) => unknown }).resolveMultimodalClient =
      vi.fn(() => compatibleClient);

    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    await recordAudioEvent(store, {
      memoryId: "review-chat-fallback-1",
      deviceId: device.deviceId,
      summary: "会议讨论了任务分工。",
      transcript: "今天会议确认了任务分工和风险清单，下周继续跟进。",
      capturedAt: Date.now() - 8 * 60_000,
      tags: ["office", "meeting"],
    });

    const review = await engine.getOrGenerateDailyReview(toLocalDateKey(Date.now()), { force: true });

    expect(compatibleClient.responses.create).toHaveBeenCalledTimes(1);
    expect(compatibleClient.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(compatibleClient.chat.completions.create.mock.calls[0]?.[0]?.model).toBe("qwen3.6-plus");
    expect(review.mode).toBe("multimodal");
    expect(review.summary).toContain("任务和风险");
  });

  it("uses ASR fallback during query-time audio recheck when multimodal audio understanding still has no transcript", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 20, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "query-time-audio.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio"));

    await store.recordCapture({
      memoryId: "audio-query-time-asr",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      note: `csAudio:v2 session=query-asr segment=1 sessionStart=${capturedAt} boundary=silence clipMs=12000 voicedMs=8800 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "query-time-audio.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/10/device/query-time-audio.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const multimodalSpy = vi.spyOn(openAiClient, "understandAudioWithPrimaryModel").mockResolvedValue({
      analysisProvider: "primary-multimodal:runtime-primary",
      analysisFailureReason: "primary_multimodal_empty",
    });
    const asrSpy = vi.spyOn(openAiClient, "transcribeAudioWithFallbackModel").mockResolvedValue({
      transcript: "老板说明天先补会议纪要，再确认演示顺序。",
      analysisProvider: "openai-stt:whisper-1",
    });

    const results = await engine.recheckAudioEvidence({
      scope: "today",
      artifactUrlBase: "/api/clawsense/artifacts",
      question: "今天会议里到底说了什么？",
    });

    expect(multimodalSpy).toHaveBeenCalled();
    expect(asrSpy).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.transcript).toContain("老板说明天先补会议纪要");
    expect(results[0]?.analysisProvider).toBe(
      "primary-multimodal:runtime-primary+openai-stt:whisper-1",
    );

    const updatedEvents = await store.listEventsByDate(toLocalDateKey(capturedAt));
    expect(updatedEvents[0]?.transcript).toContain("老板说明天先补会议纪要");
    expect(updatedEvents[0]?.analysisStatus).toBe("succeeded");
  });

  it("uses local FunASR during query-time audio recheck before compatible ASR fallback", async () => {
    vi.setSystemTime(new Date(2026, 2, 10, 20, 30, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "review-funasr-stub.sh",
      `#!/bin/sh
printf '%s\\n' '{"sentence_info":[{"start":120,"end":2600,"text":"会议确认我负责同步报表口径。","speaker":"speaker_2"}],"speakerTimelineSegments":[{"startMs":120,"endMs":2600,"text":"会议确认我负责同步报表口径。","speaker":"speaker_2"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "query-time-local-asr.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio"));

    await store.recordCapture({
      memoryId: "audio-query-time-local-asr",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      note: `csAudio:v2 session=query-local-asr segment=1 sessionStart=${capturedAt} boundary=silence clipMs=12000 voicedMs=8800 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "query-time-local-asr.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/10/device/query-time-local-asr.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const multimodalSpy = vi.spyOn(openAiClient, "understandAudioWithPrimaryModel").mockResolvedValue({
      analysisProvider: "primary-multimodal:runtime-primary",
      analysisFailureReason: "primary_multimodal_empty",
    });
    const asrSpy = vi.spyOn(openAiClient, "transcribeAudioWithFallbackModel").mockResolvedValue({
      transcript: "should not run",
      analysisProvider: "openai-stt:whisper-1",
    });

    const results = await engine.recheckAudioEvidence({
      scope: "today",
      artifactUrlBase: "/api/clawsense/artifacts",
      question: "今天会议里分给我的任务是什么？",
    });

    expect(multimodalSpy).toHaveBeenCalled();
    expect(asrSpy).not.toHaveBeenCalled();
    expect(results[0]?.transcript).toBe("会议确认我负责同步报表口径。");
    expect(results[0]?.transcriptSegments).toEqual([
      { startMs: 120, endMs: 2600, text: "会议确认我负责同步报表口径。", speakerLabel: "speaker_2" },
    ]);
    expect(results[0]?.speakerTimelineSegments).toEqual([
      { startMs: 120, endMs: 2600, text: "会议确认我负责同步报表口径。", speakerLabel: "speaker_2" },
    ]);
    expect(results[0]?.analysisProvider).toBe(
      "primary-multimodal:runtime-primary+local-asr:funasr:zh",
    );

    const updatedEvents = await store.listEventsByDate(toLocalDateKey(capturedAt));
    expect(updatedEvents[0]?.transcript).toBe("会议确认我负责同步报表口径。");
    expect(updatedEvents[0]?.transcriptSegments).toEqual([
      { startMs: 120, endMs: 2600, text: "会议确认我负责同步报表口径。", speakerLabel: "speaker_2" },
    ]);
    expect(updatedEvents[0]?.speakerTimelineSegments).toEqual([
      { startMs: 120, endMs: 2600, text: "会议确认我负责同步报表口径。", speakerLabel: "speaker_2" },
    ]);
    expect(updatedEvents[0]?.sttProvider).toBe("local-asr");
  });

  it("injects provider-scoped clients during query-time recheck when primary and fallback providers differ", async () => {
    vi.setSystemTime(new Date(2026, 2, 26, 21, 10, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        openaiApiKey: "openai-explicit-key",
        openaiBaseUrl: "https://api.openai.example/v1",
        visionProvider: "openai",
        visionModel: "gpt-4.1-mini",
        sttFallbackModel: "qwen3-asr-flash",
      },
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "qwen-omni-turbo",
              provider: "qwen",
            },
          },
        },
        models: {
          providers: {
            qwen: {
              apiKey: "qwen-test-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "query-time-provider-scope.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-provider-scope"));

    await store.recordCapture({
      memoryId: "audio-query-provider-scope",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      note: `csAudio:v2 session=query-provider-scope segment=1 sessionStart=${capturedAt} boundary=silence clipMs=11000 voicedMs=7600 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "query-time-provider-scope.wav",
      mime: "audio/wav",
      sizeBytes: 2304,
      storageRelPath: "2026/03/26/device/query-time-provider-scope.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const multimodalSpy = vi.spyOn(openAiClient, "understandAudioWithPrimaryModel").mockResolvedValue({
      analysisProvider: "primary-multimodal:runtime-primary+openai-audio-fallback",
      analysisFailureReason: "primary_multimodal_empty",
    });
    const asrSpy = vi.spyOn(openAiClient, "transcribeAudioWithFallbackModel").mockResolvedValue({
      transcript: "会议里确认了明早汇报顺序和截图版本号。",
      analysisProvider: "qwen-stt:qwen3-asr-flash",
    });

    await engine.recheckAudioEvidence({
      scope: "today",
      artifactUrlBase: "/api/clawsense/artifacts",
      question: "刚才会议里到底说了什么？",
    });

    const multimodalArgs = multimodalSpy.mock.calls[0]?.[0] as
      | {
          primaryOpenai?: { baseURL?: string | null };
          fallbackOpenai?: { baseURL?: string | null };
        }
      | undefined;
    const asrArgs = asrSpy.mock.calls[0]?.[0] as
      | {
          providerId?: string;
          openai?: { baseURL?: string | null };
        }
      | undefined;

    expect(multimodalArgs?.primaryOpenai?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(multimodalArgs?.fallbackOpenai?.baseURL).toBe("https://api.openai.example/v1");
    expect(multimodalArgs?.primaryOpenai).not.toBe(multimodalArgs?.fallbackOpenai);
    expect(asrArgs?.providerId).toBe("qwen");
    expect(asrArgs?.openai?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("tries multiple small audio artifacts inside one window during query-time audio recheck", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 22, 10, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const sessionStart = Date.now() - 15 * 60_000;
    const sourcePath1 = path.join(rootDir, "query-time-audio-1.wav");
    const sourcePath2 = path.join(rootDir, "query-time-audio-2.wav");
    await fs.writeFile(sourcePath1, Buffer.from("fake-audio-query-1"));
    await fs.writeFile(sourcePath2, Buffer.from("fake-audio-query-2"));

    await store.recordCapture({
      memoryId: "query-window-audio-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "第一段会议音频仍待确认。",
      transcript: "",
      note: `csAudio:v2 session=query-window-1 segment=1 sessionStart=${sessionStart} boundary=silence clipMs=4000 voicedMs=1000 continued=0`,
      createdAt: sessionStart,
      capturedAt: sessionStart,
      sourcePath: sourcePath1,
      fileName: "query-time-audio-1.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/27/device/query-time-audio-1.wav",
      retentionExpiresAt: sessionStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const second = await store.recordCapture({
      memoryId: "query-window-audio-2",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "第二段会议音频更像在确认明天安排。",
      transcript: "",
      note: `csAudio:v2 session=query-window-1 segment=2 sessionStart=${sessionStart} boundary=silence clipMs=4200 voicedMs=3200 continued=1`,
      createdAt: sessionStart + 6_000,
      capturedAt: sessionStart + 6_000,
      sourcePath: sourcePath2,
      fileName: "query-time-audio-2.wav",
      mime: "audio/wav",
      sizeBytes: 2304,
      storageRelPath: "2026/03/27/device/query-time-audio-2.wav",
      retentionExpiresAt: sessionStart + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    vi.spyOn(openAiClient, "understandAudioWithPrimaryModel").mockResolvedValue({
      analysisProvider: "primary-multimodal:runtime-primary",
      analysisFailureReason: "primary_multimodal_empty",
    });
    const asrSpy = vi
      .spyOn(openAiClient, "transcribeAudioWithFallbackModel")
      .mockResolvedValueOnce({
        transcript: "",
        analysisProvider: "dashscope-stt:qwen3-asr-flash",
        analysisFailureReason: "query_time_asr_empty",
      })
      .mockResolvedValueOnce({
        transcript: "老板说明早开会前先把纪要和版本号确认好。",
        analysisProvider: "dashscope-stt:qwen3-asr-flash",
      });

    const results = await engine.recheckAudioEvidence({
      scope: "today",
      artifactUrlBase: "/api/clawsense/artifacts",
      question: "今天会议里具体说了什么？",
      maxWindows: 1,
    });

    expect(asrSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[1]?.transcript).toContain("老板说明早开会前先把纪要和版本号确认好");

    const updatedEvents = await store.listEventsByDate("2026-03-27");
    const updatedSecond = updatedEvents.find((event) => event.eventId === second.event.eventId);
    expect(updatedSecond?.transcript).toContain("老板说明早开会前先把纪要和版本号确认好");
    expect(updatedSecond?.analysisStatus).toBe("succeeded");
  });

  it("incrementally backfills recent degraded audio clips during maintenance-friendly audio backfill", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 30, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "backfill-audio.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-backfill"));

    const created = await store.recordCapture({
      memoryId: "audio-backfill-tick-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      note: `csAudio:v2 session=backfill-1 segment=1 sessionStart=${capturedAt} boundary=silence clipMs=8000 voicedMs=5600 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "backfill-audio.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/backfill-audio.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const asrSpy = vi.spyOn(openAiClient, "transcribeAudioWithFallbackModel").mockResolvedValue({
      transcript: "老板说明天先补会议纪要，再确认演示顺序。",
      analysisProvider: "dashscope-stt:qwen3-asr-flash",
    });

    const result = await engine.runAudioBackfillTick({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      now: Date.now(),
    });

    const updatedEvents = await store.listEventsByDate("2026-03-27");
    const updated = updatedEvents.find((event) => event.eventId === created.event.eventId);

    expect(asrSpy).toHaveBeenCalled();
    expect(result).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(updated?.transcript).toContain("老板说明天先补会议纪要");
    expect(updated?.analysisStatus).toBe("succeeded");
    expect(updated?.sttProvider).toBe("compatible-fallback");
    expect(updated?.audioBackfillAttemptCount).toBe(1);
  });

  it("can dry-run local ASR backfill for already transcribed audio missing transcript segments", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 35, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "backfill-local-dry-run.sh",
      `#!/bin/sh
printf '%s\\n' '{"sentence_info":[{"start":0,"end":1400,"text":"先确认报表口径。","spk":"speaker_1"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "backfill-local-dry-run.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-backfill"));

    const created = await store.recordCapture({
      memoryId: "audio-backfill-local-dry-run",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "会议里确认了报表口径。",
      transcript: "会议里确认了报表口径。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "backfill-local-dry-run.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/backfill-local-dry-run.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
    });

    const result = await engine.runAudioBackfillTick({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      now: Date.now(),
      provider: "local-asr",
      dryRun: true,
      includeTranscribed: true,
    });

    const updatedEvents = await store.listEventsByDate("2026-03-27");
    const updated = updatedEvents.find((event) => event.eventId === created.event.eventId);

    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(result.provider).toBe("local-asr");
    expect(result.items?.[0]).toEqual(
      expect.objectContaining({
        eventId: created.event.eventId,
        provider: "local-asr:funasr:zh",
        status: "succeeded",
        dryRun: true,
        transcriptSegmentCount: 1,
      }),
    );
    expect(updated?.transcriptSegments).toBeUndefined();
    expect(updated?.audioBackfillAttemptCount).toBe(0);
  });

  it("honors explicit dry-run maxArtifacts above the maintenance safety cap", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 38, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "backfill-local-dry-run-max.sh",
      `#!/bin/sh
printf '%s\\n' '{"text":"补充句段。","segments":[{"startMs":0,"endMs":1000,"text":"补充句段。"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    for (let index = 0; index < 8; index += 1) {
      const capturedAt = Date.now() - (index + 1) * 60_000;
      const sourcePath = path.join(rootDir, `backfill-local-dry-run-max-${index}.wav`);
      await fs.writeFile(sourcePath, Buffer.from(`fake-audio-backfill-${index}`));
      await store.recordCapture({
        memoryId: `audio-backfill-local-dry-run-max-${index}`,
        namespace: "clawsense",
        deviceId: device.deviceId,
        modality: "audio",
        summary: "已有转写，缺少句段。",
        transcript: `已有转写 ${index}`,
        createdAt: capturedAt,
        capturedAt,
        sourcePath,
        fileName: `backfill-local-dry-run-max-${index}.wav`,
        mime: "audio/wav",
        sizeBytes: 4096 + index,
        storageRelPath: `2026/03/27/device/backfill-local-dry-run-max-${index}.wav`,
        retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
        analysisMode: "runtime-stt",
        analysisStatus: "succeeded",
        sttProvider: "runtime",
      });
    }

    const result = await engine.runAudioBackfillTick({
      dates: ["2026-03-27"],
      maxArtifacts: 8,
      now: Date.now(),
      provider: "local-asr",
      dryRun: true,
      includeTranscribed: true,
    });

    expect(result.attempted).toBe(8);
    expect(result.succeeded).toBe(8);
    expect(result.items).toHaveLength(8);
  });

  it("uses one local ASR batch command for strict local backfill candidates", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 39, 0));

    const markerPath = path.join(rootDir, "batch-marker.txt");
    const commandPath = await writeExecutableScript(
      rootDir,
      "backfill-local-batch.sh",
      `#!/bin/sh
if [ "$1" = "--batch-json" ]; then
  printf 'batch\\n' >> "${markerPath}"
  printf '%s\\n' '{"results":[{"transcript":"批量补第一段。","segments":[{"startMs":0,"endMs":1000,"text":"批量补第一段。"}]},{"transcript":"批量补第二段。","segments":[{"startMs":0,"endMs":1000,"text":"批量补第二段。"}]},{"transcript":"批量补第三段。","segments":[{"startMs":0,"endMs":1000,"text":"批量补第三段。"}]}]}'
  exit 0
fi
printf 'single\\n' >> "${markerPath}"
printf '%s\\n' '{"transcript":"不应走单条。","segments":[{"startMs":0,"endMs":1000,"text":"不应走单条。"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    for (let index = 0; index < 3; index += 1) {
      const capturedAt = Date.now() - (index + 1) * 60_000;
      const sourcePath = path.join(rootDir, `backfill-local-batch-${index}.wav`);
      await fs.writeFile(sourcePath, Buffer.from(`fake-audio-batch-${index}`));
      await store.recordCapture({
        memoryId: `audio-backfill-local-batch-${index}`,
        namespace: "clawsense",
        deviceId: device.deviceId,
        modality: "audio",
        summary: "已有转写，缺少句段。",
        transcript: `已有转写 ${index}`,
        createdAt: capturedAt,
        capturedAt,
        sourcePath,
        fileName: `backfill-local-batch-${index}.wav`,
        mime: "audio/wav",
        sizeBytes: 4096 + index,
        storageRelPath: `2026/03/27/device/backfill-local-batch-${index}.wav`,
        retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
        analysisMode: "runtime-stt",
        analysisStatus: "succeeded",
        sttProvider: "runtime",
      });
    }

    const result = await engine.runAudioBackfillTick({
      dates: ["2026-03-27"],
      maxArtifacts: 3,
      now: Date.now(),
      provider: "local-asr",
      dryRun: true,
      includeTranscribed: true,
    });

    const marker = await fs.readFile(markerPath, "utf8");
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.items?.map((item) => item.transcriptPreview)).toEqual([
      "批量补第一段。",
      "批量补第二段。",
      "批量补第三段。",
    ]);
    expect(marker.trim().split(/\r?\n/)).toEqual(["batch"]);
  });

  it("writes local ASR transcript segments for already transcribed audio when explicitly requested", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 40, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "backfill-local-write.sh",
      `#!/bin/sh
printf '%s\\n' '{"sentence_info":[{"start":0,"end":1600,"text":"我负责同步培训安排。","spk":"speaker_2"}],"speakerTimelineSegments":[{"startMs":0,"endMs":1600,"text":"我负责同步培训安排。","speaker":"speaker_2"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "backfill-local-write.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-backfill"));

    const created = await store.recordCapture({
      memoryId: "audio-backfill-local-write",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "会议里确认了培训安排。",
      transcript: "已有云端转写保留不覆盖。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "backfill-local-write.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/backfill-local-write.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
    });

    const result = await engine.runAudioBackfillTick({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      now: Date.now(),
      provider: "local-asr",
      includeTranscribed: true,
    });

    const updatedEvents = await store.listEventsByDate("2026-03-27");
    const updated = updatedEvents.find((event) => event.eventId === created.event.eventId);

    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.provider).toBe("local-asr");
    expect(updated?.transcript).toBe("已有云端转写保留不覆盖。");
    expect(updated?.transcriptSegments).toEqual([
      { startMs: 0, endMs: 1600, text: "我负责同步培训安排。", speakerLabel: "speaker_2" },
    ]);
    expect(updated?.speakerTimelineSegments).toEqual([
      { startMs: 0, endMs: 1600, text: "我负责同步培训安排。", speakerLabel: "speaker_2" },
    ]);
    expect(updated?.analysisProvider).toBe("local-asr:funasr:zh");
    expect(updated?.sttProvider).toBe("local-asr");
    expect(updated?.audioBackfillAttemptCount).toBe(1);
  });

  it("plans and runs a resumable local ASR backfill queue", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 42, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "backfill-local-queue.sh",
      `#!/bin/sh
if [ "$1" = "--batch-json" ]; then
  printf '%s\\n' '{"results":[{"transcript":"队列补第一段。","segments":[{"startMs":0,"endMs":1200,"text":"队列补第一段。","speaker":"speaker_1"}],"speakerTimelineSegments":[{"startMs":0,"endMs":1200,"text":"队列补第一段。","speaker":"speaker_1"}]},{"transcript":"队列补第二段。","segments":[{"startMs":0,"endMs":1400,"text":"队列补第二段。","speaker":"speaker_2"}],"speakerTimelineSegments":[{"startMs":0,"endMs":1400,"text":"队列补第二段。","speaker":"speaker_2"}]}]}'
  exit 0
fi
printf '%s\\n' '{"transcript":"不应走单条。","segments":[{"startMs":0,"endMs":1000,"text":"不应走单条。"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });

    const createdEventIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const capturedAt = Date.now() - (index + 1) * 60_000;
      const sourcePath = path.join(rootDir, `backfill-local-queue-${index}.wav`);
      await fs.writeFile(sourcePath, Buffer.from(`fake-audio-queue-${index}`));
      const created = await store.recordCapture({
        memoryId: `audio-backfill-local-queue-${index}`,
        namespace: "clawsense",
        deviceId: device.deviceId,
        modality: "audio",
        summary: "已有转写，缺少句段。",
        transcript: `已有转写 ${index}`,
        note: `csAudio:v2 session=queue-duration segment=${index + 1} sessionStart=${capturedAt} boundary=silence clipMs=${12_000 + index * 1000} voicedMs=${8_000 + index * 1000} continued=0`,
        createdAt: capturedAt,
        capturedAt,
        sourcePath,
        fileName: `backfill-local-queue-${index}.wav`,
        mime: "audio/wav",
        sizeBytes: 4096 + index,
        storageRelPath: `2026/03/27/device/backfill-local-queue-${index}.wav`,
        retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
        analysisMode: "runtime-stt",
        analysisStatus: "succeeded",
        sttProvider: "runtime",
      });
      createdEventIds.push(created.event.eventId);
    }

    const planned = await engine.planAudioBackfillQueue({
      dates: ["2026-03-27"],
      maxArtifacts: 2,
      provider: "local-asr",
      includeTranscribed: true,
    });

    expect(planned.stats).toEqual({
      pending: 2,
      running: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      total: 2,
      remaining: 2,
    });
    expect(planned.audio).toEqual({
      totalClipMs: 25_000,
      remainingClipMs: 25_000,
      totalVoicedMs: 17_000,
      remainingVoicedMs: 17_000,
    });
    expect(planned.recentJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          attempts: 0,
          fileName: expect.stringContaining("backfill-local-queue"),
          clipMs: expect.any(Number),
          voicedMs: expect.any(Number),
        }),
      ]),
    );

    const run = await engine.runAudioBackfillQueue({
      queueId: planned.queueId,
      batchSize: 2,
    });

    expect(run?.attempted).toBe(2);
    expect(run?.succeeded).toBe(2);
    expect(run?.queue.stats.succeeded).toBe(2);
    expect(run?.queue.stats.remaining).toBe(0);
    expect(run?.queue.audio).toEqual({
      totalClipMs: 25_000,
      remainingClipMs: 0,
      totalVoicedMs: 17_000,
      remainingVoicedMs: 0,
    });
    expect(run?.queue.recentJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "succeeded",
          attempts: 1,
          provider: "local-asr:funasr:zh",
          clipMs: expect.any(Number),
          voicedMs: expect.any(Number),
          transcriptSegmentCount: 1,
          speakerTimelineSegmentCount: 1,
          transcriptPreview: expect.stringMatching(/队列补第[一二]段/),
        }),
      ]),
    );

    const status = await engine.getAudioBackfillQueueStatus(planned.queueId);
    expect(status?.stats.succeeded).toBe(2);
    expect(status?.stats.remaining).toBe(0);
    expect(status?.recentJobs[0]?.status).toBe("succeeded");

    const updatedEvents = await store.listEventsByDate("2026-03-27");
    const updatedTargets = createdEventIds.map((eventId) => updatedEvents.find((event) => event.eventId === eventId));
    expect(updatedTargets.every((event) => event?.sttProvider === "local-asr")).toBe(true);
    expect(updatedTargets.flatMap((event) => event?.transcriptSegments ?? []).map((segment) => segment.speakerLabel)).toEqual(
      expect.arrayContaining(["speaker_1", "speaker_2"]),
    );
    expect(updatedTargets.flatMap((event) => event?.speakerTimelineSegments ?? []).map((segment) => segment.speakerLabel)).toEqual(
      expect.arrayContaining(["speaker_1", "speaker_2"]),
    );
  });

  it("plans and runs one ASR worker tick with a resumable queue", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 50, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "asr-worker-run-once.sh",
      `#!/bin/sh
printf '%s\\n' '{"transcript":"worker 自动补强会议转写。","segments":[{"startMs":0,"endMs":1800,"text":"worker 自动补强会议转写。","speaker":"speaker_1"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
        asrWorkerEnabled: true,
        asrWorkerProvider: "local-asr",
        asrWorkerBatchSize: 1,
        asrWorkerMaxJobs: 4,
        asrWorkerLookbackDays: 2,
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 6 * 60_000;
    const sourcePath = path.join(rootDir, "asr-worker-meeting.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-asr-worker-audio"));
    const created = await store.recordCapture({
      memoryId: "audio-asr-worker-meeting",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "会议音频等待 worker 补强。",
      transcript: "",
      note: `csAudio:v2 session=asr-worker segment=1 sessionStart=${capturedAt} boundary=silence clipMs=7200 voicedMs=5200 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "asr-worker-meeting.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/asr-worker-meeting.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty",
    });

    const result = await engine.runAudioBackfillWorkerTick({
      dates: ["2026-03-27"],
    });

    expect(result.planned).toBe(true);
    expect(result.reason).toBe("planned-new-queue");
    expect(result.run?.attempted).toBe(1);
    expect(result.run?.succeeded).toBe(1);
    expect(result.queue?.stats.remaining).toBe(0);
    expect(result.status.enabled).toBe(true);
    expect(result.status.stats.remainingJobs).toBe(0);

    const updatedEvents = await store.listEventsByDate("2026-03-27");
    const updated = updatedEvents.find((event) => event.eventId === created.event.eventId);
    expect(updated?.transcript).toBe("worker 自动补强会议转写。");
    expect(updated?.transcriptSegments?.[0]).toEqual(
      expect.objectContaining({
        speakerLabel: "speaker_1",
      }),
    );
  });

  it("does not resume stale dry-run queues during a real ASR worker tick", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 52, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "asr-worker-skip-dry-run.sh",
      `#!/bin/sh
printf '%s\\n' '{"transcript":"真实 worker 不续 dry-run 队列。","segments":[{"startMs":0,"endMs":1600,"text":"真实 worker 不续 dry-run 队列。"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "asr-worker-real.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-asr-worker-real-audio"));
    await store.recordCapture({
      memoryId: "audio-asr-worker-real",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "音频等待真实 worker 补强。",
      transcript: "",
      note: `csAudio:v2 session=asr-worker-real segment=1 sessionStart=${capturedAt} boundary=silence clipMs=6400 voicedMs=4200 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "asr-worker-real.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/asr-worker-real.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty",
    });
    const dryRunQueue = await engine.planAudioBackfillQueue({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      provider: "local-asr",
      dryRun: true,
    });

    const result = await engine.runAudioBackfillWorkerTick({
      dates: ["2026-03-27"],
      provider: "local-asr",
    });

    expect(dryRunQueue.dryRun).toBe(true);
    expect(dryRunQueue.stats.pending).toBe(1);
    expect(result.reason).toBe("planned-new-queue");
    expect(result.queue?.dryRun).toBe(false);
    expect(result.run?.succeeded).toBe(1);
    expect(result.status.activeQueue).toBeNull();
    expect(result.status.stats.remainingJobs).toBe(0);
    expect(result.status.latestQueues.some((queue) => queue.dryRun)).toBe(true);
  });

  it("does not resume failed-only dry-run queues during ASR worker dry-run", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 54, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "asr-worker-failed-only-dry-run.sh",
      `#!/bin/sh
printf '%s\\n' '{}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 4 * 60_000;
    const sourcePath = path.join(rootDir, "asr-worker-failed-only.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-asr-worker-failed-only"));
    await store.recordCapture({
      memoryId: "audio-asr-worker-failed-only",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "音频等待 dry-run 补强。",
      transcript: "",
      note: `csAudio:v2 session=asr-worker-failed-only segment=1 sessionStart=${capturedAt} boundary=silence clipMs=6400 voicedMs=4200 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "asr-worker-failed-only.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/asr-worker-failed-only.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty",
    });
    const failedQueue = await engine.planAudioBackfillQueue({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      provider: "local-asr",
      dryRun: true,
    });
    const failedRun = await engine.runAudioBackfillQueue({
      queueId: failedQueue.queueId,
      dryRun: true,
    });

    const result = await engine.runAudioBackfillWorkerTick({
      dates: ["2026-03-27"],
      provider: "local-asr",
      dryRun: true,
      maxJobs: 1,
    });

    expect(failedRun?.failed).toBe(1);
    expect(result.reason).toBe("planned-new-queue");
    expect(result.queue?.queueId).not.toBe(failedQueue.queueId);
  });

  it("passes queued diarization settings into local ASR writeback", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 56, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "asr-queue-whisperx-diarization.sh",
      `#!/bin/sh
if [ "$CLAWSENSE_DIARIZATION_PROVIDER" != "whisperx" ]; then
  echo "missing diarization provider" >&2
  exit 3
fi
if [ "$CLAWSENSE_DIARIZATION_SPEAKER_MODEL" != "pyannote/speaker-diarization" ]; then
  echo "missing speaker model" >&2
  exit 4
fi
printf '%s\\n' '{"transcript":"Amy 说我负责整理任务。","segments":[{"startMs":0,"endMs":1800,"text":"Amy 说我负责整理任务。","speaker":"SPEAKER_00"}],"speakerTimelineSegments":[{"startMs":0,"endMs":1800,"text":"Amy 说我负责整理任务。","speaker":"SPEAKER_00"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "whisper",
        localAsrWhisperCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 3 * 60_000;
    const sourcePath = path.join(rootDir, "asr-queue-whisperx.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-asr-queue-whisperx-audio"));
    const created = await store.recordCapture({
      memoryId: "audio-asr-queue-whisperx",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "音频等待 WhisperX speaker 写回。",
      transcript: "",
      note: `csAudio:v2 session=asr-queue-whisperx segment=1 sessionStart=${capturedAt} boundary=silence clipMs=7200 voicedMs=5200 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "asr-queue-whisperx.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/asr-queue-whisperx.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty",
    });

    const queue = await engine.planAudioBackfillQueue({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      provider: "local-asr",
      diarizationProvider: "whisperx",
    });
    const result = await engine.runAudioBackfillQueue({
      queueId: queue.queueId,
      batchSize: 1,
    });

    expect(queue.diarizationProvider).toBe("whisperx");
    expect(queue.speakerModel).toBe("pyannote/speaker-diarization");
    expect(result?.succeeded).toBe(1);

    const updatedEvents = await store.listEventsByDate("2026-03-27");
    const updated = updatedEvents.find((event) => event.eventId === created.event.eventId);
    expect(updated?.transcript).toBe("Amy 说我负责整理任务。");
    expect(updated?.transcriptSegments).toEqual([
      { startMs: 0, endMs: 1800, text: "Amy 说我负责整理任务。", speakerLabel: "SPEAKER_00" },
    ]);
    expect(updated?.speakerTimelineSegments).toEqual([
      { startMs: 0, endMs: 1800, text: "Amy 说我负责整理任务。", speakerLabel: "SPEAKER_00" },
    ]);
  });

  it("runs a read-only diarization probe with a speaker model override", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 44, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "diarization-probe.sh",
      `#!/bin/sh
if [ "$CLAWSENSE_FUNASR_SPK_MODEL" != "cam++" ]; then
  echo "missing speaker model" >&2
  exit 3
fi
if [ "$1" != "--batch-json" ]; then
  printf '%s\\n' '{"transcript":"Amy 确认我负责同步口径。","segments":[{"startMs":0,"endMs":1200,"text":"Amy 确认我负责同步口径。","speaker":"speaker_1"}],"speakerTimelineSegments":[{"startMs":0,"endMs":1200,"text":"Amy 确认我负责同步口径。","speaker":"speaker_1"}]}'
  exit 0
fi
printf '%s\\n' '{"results":[{"transcript":"Amy 确认我负责同步口径。","segments":[{"startMs":0,"endMs":1200,"text":"Amy 确认我负责同步口径。","speaker":"speaker_1"}],"speakerTimelineSegments":[{"startMs":0,"endMs":1200,"text":"Amy 确认我负责同步口径。","speaker":"speaker_1"}]}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "diarization-probe.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-diarization"));
    const created = await store.recordCapture({
      memoryId: "audio-diarization-probe",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "已有转写，缺少句段。",
      transcript: "已有转写。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "diarization-probe.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/diarization-probe.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
    });

    const probe = await engine.runDiarizationProbe({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      speakerModel: "cam++",
    });

    expect(probe.attempted).toBe(1);
    expect(probe.speakerReady).toBe(true);
    expect(probe.diagnosis).toBe("speaker-ready");
    expect(probe.diarizationProvider).toBe("funasr");
    expect(probe.nextActions).toEqual(expect.arrayContaining([expect.stringContaining("speakerLabel")]));
    expect(probe.items[0]).toEqual(
      expect.objectContaining({
        eventId: created.event.eventId,
        diarizationProvider: "funasr",
        status: "succeeded",
        speakerTimelineSegmentCount: 1,
        speakerSegmentCount: 1,
        speakerLabels: ["speaker_1"],
      }),
    );
    const updatedEvents = await store.listEventsByDate("2026-03-27");
    expect(updatedEvents.find((event) => event.eventId === created.event.eventId)?.transcriptSegments).toBeUndefined();
  });

  it("passes diarization provider metadata to pluggable local probes", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 44, 30));

    const commandPath = await writeExecutableScript(
      rootDir,
      "diarization-probe-whisperx.sh",
      `#!/bin/sh
if [ "$CLAWSENSE_DIARIZATION_PROVIDER" != "whisperx" ]; then
  echo "missing diarization provider" >&2
  exit 3
fi
if [ "$CLAWSENSE_DIARIZATION_SPEAKER_MODEL" != "pyannote/test" ]; then
  echo "missing diarization speaker model" >&2
  exit 4
fi
printf '%s\\n' '{"transcript":"Amy 确认我负责同步口径。","segments":[{"startMs":0,"endMs":1200,"text":"Amy 确认我负责同步口径。","speaker":"speaker_1"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 4 * 60_000;
    const sourcePath = path.join(rootDir, "diarization-probe-whisperx.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-diarization-whisperx"));
    await store.recordCapture({
      memoryId: "audio-diarization-probe-whisperx",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "已有转写，缺少 speaker。",
      transcript: "已有转写。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "diarization-probe-whisperx.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/diarization-probe-whisperx.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
    });

    const probe = await engine.runDiarizationProbe({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      provider: "whisperx",
      speakerModel: "pyannote/test",
    });

    expect(probe.diarizationProvider).toBe("whisperx");
    expect(probe.speakerModel).toBe("pyannote/test");
    expect(probe.speakerReady).toBe(true);
    expect(probe.items[0]).toEqual(
      expect.objectContaining({
        diarizationProvider: "whisperx",
        speakerLabels: ["speaker_1"],
      }),
    );
  });

  it("passes hybrid diarization metadata to local ASR probes", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 44, 45));

    const commandPath = await writeExecutableScript(
      rootDir,
      "diarization-probe-hybrid.sh",
      `#!/bin/sh
if [ "$CLAWSENSE_DIARIZATION_PROVIDER" != "hybrid" ]; then
  echo "missing hybrid provider" >&2
  exit 3
fi
if [ "$CLAWSENSE_HYBRID_SPEAKER_MODEL" != "cam++" ]; then
  echo "missing hybrid speaker model" >&2
  exit 4
fi
printf '%s\\n' '{"transcript":"Amy 确认我负责同步口径。","segments":[{"startMs":0,"endMs":1200,"text":"Amy 确认我负责同步口径。","speaker":"speaker_1"}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "whisper",
        localAsrWhisperCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 4 * 60_000;
    const sourcePath = path.join(rootDir, "diarization-probe-hybrid.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-diarization-hybrid"));
    await store.recordCapture({
      memoryId: "audio-diarization-probe-hybrid",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "已有转写，等待 hybrid speaker。",
      transcript: "已有转写。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "diarization-probe-hybrid.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/diarization-probe-hybrid.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
    });

    const probe = await engine.runDiarizationProbe({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      provider: "hybrid",
    });

    expect(probe.diarizationProvider).toBe("hybrid");
    expect(probe.speakerModel).toBe("whisperx+funasr:cam++");
    expect(probe.speakerReady).toBe(true);
    expect(probe.items[0]).toEqual(
      expect.objectContaining({
        diarizationProvider: "hybrid",
        speakerLabels: ["speaker_1"],
      }),
    );
  });

  it("diagnoses read-only diarization probes when ASR works but speaker labels are missing", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 45, 0));

    const commandPath = await writeExecutableScript(
      rootDir,
      "diarization-probe-no-speaker.sh",
      `#!/bin/sh
if [ "$1" != "--batch-json" ]; then
  printf '%s\\n' '{"transcript":"会议确认我负责同步口径。","segments":[{"startMs":0,"endMs":1200,"text":"会议确认我负责同步口径。"}]}'
  exit 0
fi
printf '%s\\n' '{"results":[{"transcript":"会议确认我负责同步口径。","segments":[{"startMs":0,"endMs":1200,"text":"会议确认我负责同步口径。"}]}]}'
`,
    );
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        localAsrBackend: "funasr",
        localAsrFunAsrCommand: commandPath,
        localAsrLanguage: "zh",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60_000;
    const sourcePath = path.join(rootDir, "diarization-probe-no-speaker.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-diarization-no-speaker"));
    const created = await store.recordCapture({
      memoryId: "audio-diarization-probe-no-speaker",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "已有转写，缺少句段。",
      transcript: "已有转写。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "diarization-probe-no-speaker.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/diarization-probe-no-speaker.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
    });

    const probe = await engine.runDiarizationProbe({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      speakerModel: "cam++",
    });

    expect(probe.attempted).toBe(1);
    expect(probe.succeeded).toBe(1);
    expect(probe.speakerReady).toBe(false);
    expect(probe.diagnosis).toBe("asr-ok-speaker-missing");
    expect(probe.nextActions).toEqual(expect.arrayContaining([expect.stringContaining("WhisperX")]));
    expect(probe.items[0]).toEqual(
      expect.objectContaining({
        eventId: created.event.eventId,
        status: "succeeded",
        transcriptSegmentCount: 1,
        speakerSegmentCount: 0,
        speakerLabels: [],
      }),
    );
    const updatedEvents = await store.listEventsByDate("2026-03-27");
    expect(updatedEvents.find((event) => event.eventId === created.event.eventId)?.transcriptSegments).toBeUndefined();
  });

  it("uses adaptive maintenance backfill batch size when pending audio backlog is high", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 14, 5, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const estimateSpy = vi
      .spyOn(
        engine as unknown as {
          estimatePendingAudioBackfillCandidates: (now: number, dates?: string[]) => Promise<number>;
        },
        "estimatePendingAudioBackfillCandidates",
      )
      .mockResolvedValue(40);
    const backfillSpy = vi
      .spyOn(
        engine as unknown as {
          runAudioBackfillTick: (params?: { now?: number; dates?: string[]; maxArtifacts?: number }) => Promise<unknown>;
        },
        "runAudioBackfillTick",
      )
      .mockResolvedValue({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      });
    const now = Date.now();

    await engine.runMaintenanceTick(now);

    expect(estimateSpy).toHaveBeenCalledWith(now);
    expect(backfillSpy).toHaveBeenCalledWith({ now, maxArtifacts: 6 });
  });

  it("keeps maintenance backfill batch at baseline when pending backlog is low", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 14, 10, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const estimateSpy = vi
      .spyOn(
        engine as unknown as {
          estimatePendingAudioBackfillCandidates: (now: number, dates?: string[]) => Promise<number>;
        },
        "estimatePendingAudioBackfillCandidates",
      )
      .mockResolvedValue(1);
    const backfillSpy = vi
      .spyOn(
        engine as unknown as {
          runAudioBackfillTick: (params?: { now?: number; dates?: string[]; maxArtifacts?: number }) => Promise<unknown>;
        },
        "runAudioBackfillTick",
      )
      .mockResolvedValue({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      });
    const now = Date.now();

    await engine.runMaintenanceTick(now);

    expect(estimateSpy).toHaveBeenCalledWith(now);
    expect(backfillSpy).toHaveBeenCalledWith({ now, maxArtifacts: 3 });
  });

  it("pins whisper backfill to the OpenAI provider client when runtime primary is non-openai", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 9, 20, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        openaiApiKey: "openai-explicit-key",
        openaiBaseUrl: "https://api.openai.example/v1",
        visionProvider: "openai",
        visionModel: "gpt-4.1-mini",
        sttFallbackModel: "whisper-1",
      },
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "qwen-omni-turbo",
              provider: "qwen",
            },
          },
        },
        models: {
          providers: {
            qwen: {
              apiKey: "qwen-test-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 6 * 60_000;
    const sourcePath = path.join(rootDir, "backfill-provider-scope.wav");
    await fs.writeFile(sourcePath, Buffer.from("fake-audio-backfill-provider-scope"));

    await store.recordCapture({
      memoryId: "audio-backfill-provider-scope",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      note: `csAudio:v2 session=backfill-provider-scope segment=1 sessionStart=${capturedAt} boundary=silence clipMs=8600 voicedMs=5800 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath,
      fileName: "backfill-provider-scope.wav",
      mime: "audio/wav",
      sizeBytes: 3072,
      storageRelPath: "2026/03/28/device/backfill-provider-scope.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const asrSpy = vi.spyOn(openAiClient, "transcribeAudioWithFallbackModel").mockResolvedValue({
      transcript: "老板说下午先过风险清单，再确认提测时间。",
      analysisProvider: "openai-stt:whisper-1",
    });

    await engine.runAudioBackfillTick({
      dates: ["2026-03-28"],
      maxArtifacts: 1,
      now: Date.now(),
    });

    const asrArgs = asrSpy.mock.calls[0]?.[0] as
      | {
          providerId?: string;
          openai?: { baseURL?: string | null };
        }
      | undefined;
    expect(asrArgs?.providerId).toBe("openai");
    expect(asrArgs?.openai?.baseURL).toBe("https://api.openai.example/v1");
  });

  it("prioritizes meeting or classroom-like audio clips for backfill when only a few slots are available", async () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 45, 0));
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-review-priority-"));
    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 10 * 60_000;
    const genericPath = path.join(rootDir, "generic-audio.wav");
    const meetingPath = path.join(rootDir, "meeting-audio.wav");
    await fs.writeFile(genericPath, Buffer.from("generic-audio"));
    await fs.writeFile(meetingPath, Buffer.from("meeting-audio"));

    await store.recordCapture({
      memoryId: "audio-backfill-generic",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      note: `csAudio:v2 session=generic-1 segment=1 sessionStart=${capturedAt - 5_000} boundary=silence clipMs=12000 voicedMs=1200 continued=0`,
      createdAt: capturedAt - 5_000,
      capturedAt: capturedAt - 5_000,
      sourcePath: genericPath,
      fileName: "generic-audio.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/27/device/generic-audio.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    await store.recordCapture({
      memoryId: "audio-backfill-meeting",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "会议里在确认老板交代的纪要、截图顺序和版本号。",
      transcript: "",
      note: `csAudio:v2 session=meeting-1 segment=1 sessionStart=${capturedAt} boundary=silence clipMs=9000 voicedMs=7800 continued=0`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath: meetingPath,
      fileName: "meeting-audio.wav",
      mime: "audio/wav",
      sizeBytes: 6144,
      storageRelPath: "2026/03/27/device/meeting-audio.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
      tags: ["meeting", "office"],
    });

    const asrSpy = vi.spyOn(openAiClient, "transcribeAudioWithFallbackModel").mockResolvedValue({
      transcript: "老板说明天先补会议纪要，再确认版本号。",
      analysisProvider: "dashscope-stt:qwen3-asr-flash",
    });

    const result = await engine.runAudioBackfillTick({
      dates: ["2026-03-27"],
      maxArtifacts: 1,
      now: Date.now(),
    });

    expect(result).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(asrSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "meeting-audio.wav",
      }),
    );
  });

  it("reports phase acceptance gaps when current lookback window lacks enough evidence", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now: Date.now(),
    });

    expect(report.completion.isPhaseReady).toBe(false);
    expect(report.completion.phaseState).toBe("collecting-data");
    expect(report.criteria).toHaveLength(5);
    expect(report.criteria.some((criterion) => criterion.status === "missing-data")).toBe(true);
    expect(report.criteria.find((criterion) => criterion.id === "video-evidence")?.status).toBe("pass");
    expect(report.completion.passedCriteria).toBeLessThan(report.completion.totalCriteria);
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(report.criteria.every((criterion) => criterion.targets.length > 0)).toBe(true);
  });

  it("builds an actionable acceptance plan with failing targets and runnable commands", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);

    const plan = await engine.buildPhaseAcceptancePlan({
      lookbackDays: 3,
      now: Date.now(),
    });

    expect(plan.phaseState).toBe("collecting-data");
    expect(plan.tracks.length).toBeGreaterThan(0);
    expect(plan.tracks.every((track) => track.failingTargets.length > 0)).toBe(true);
    expect(plan.tracks.every((track) => track.commands.length > 0)).toBe(true);
    expect(plan.quickCommands).toContain("openclaw clawsense doctor");
    expect(plan.quickCommands).toContain("openclaw clawsense acceptance 3");
  });

  it("includes video track commands in acceptance plan when video mode is enabled but evidence is missing", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        hostModelVideoMode: "keyframes",
      },
    });

    const plan = await engine.buildPhaseAcceptancePlan({
      lookbackDays: 3,
      now: Date.now(),
    });

    const videoTrack = plan.tracks.find((track) => track.id === "video-evidence");
    expect(videoTrack).toBeDefined();
    expect(videoTrack?.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("hostModelVideoMode"),
        expect.stringContaining("--modality video"),
      ]),
    );
  });

  it("marks phase acceptance as ready when office, school, audio, and annotation signals are all present", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();

    await store.updateHeartbeat(device.deviceId, {
      batteryPct: 80,
      network: "wifi",
      appState: "running:60",
      raw: {
        batteryPct: 80,
        network: "wifi",
        appState: "running:60",
      },
    });

    const officeCapturedAt = now - 5 * 60 * 60 * 1000;
    const officeTranscript = await recordAudioEvent(store, {
      memoryId: "phase-office-transcript",
      deviceId: device.deviceId,
      summary: "老板 Amy 在会议里确认了报价和明天演示的任务。",
      transcript: "Amy 让我们今晚补完报价，明早先过演示开场和截图顺序。",
      capturedAt: officeCapturedAt,
      peopleRefs: ["person_amy"],
      projectRefs: ["project_quote"],
      tags: ["meeting", "office"],
    });
    await store.recordCapture({
      memoryId: "phase-office-pending",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "采集到一段连续对话，当前语义仍待补强。",
      transcript: "",
      note: `csAudio:v2 session=phase-office-pending segment=1 sessionStart=${officeCapturedAt + 20_000} boundary=silence clipMs=7200 voicedMs=1800 continued=0`,
      createdAt: officeCapturedAt + 20_000,
      capturedAt: officeCapturedAt + 20_000,
      sourcePath: path.join(rootDir, "phase-office-pending.wav"),
      fileName: "phase-office-pending.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/28/device/phase-office-pending.wav",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
      tags: ["meeting", "office"],
    });

    const schoolCapturedAt = now - 3 * 60 * 60 * 1000;
    const schoolTranscript = await recordAudioEvent(store, {
      memoryId: "phase-school-transcript",
      deviceId: device.deviceId,
      summary: "课堂上老师讲了重点，speaker_1 提到明天要交作业。",
      transcript: "老师讲了二次函数重点，speaker_1 提醒大家复习并提交作业。",
      capturedAt: schoolCapturedAt,
      peopleRefs: ["person_teacher"],
      projectRefs: ["math_class"],
      tags: ["classroom", "study"],
    });
    await store.recordCapture({
      memoryId: "phase-school-pending",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "采集到一段连续对话，当前语义仍待补强。",
      transcript: "",
      note: `csAudio:v2 session=phase-school-pending segment=1 sessionStart=${schoolCapturedAt + 20_000} boundary=silence clipMs=8000 voicedMs=2200 continued=0`,
      createdAt: schoolCapturedAt + 20_000,
      capturedAt: schoolCapturedAt + 20_000,
      sourcePath: path.join(rootDir, "phase-school-pending.wav"),
      fileName: "phase-school-pending.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/28/device/phase-school-pending.wav",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
      tags: ["classroom", "study"],
    });

    await engine.annotatePerson({
      personRef: "person_amy",
      displayName: "Amy",
      relationship: "老板",
      eventIds: [officeTranscript.event.eventId],
    });
    await engine.annotatePerson({
      personRef: "person_teacher",
      displayName: "王老师",
      relationship: "老师",
      eventIds: [schoolTranscript.event.eventId],
    });
    await engine.annotateSpeaker({
      speakerRef: "speaker_1",
      displayName: "王老师",
      relationship: "老师",
      eventIds: [schoolTranscript.event.eventId],
      windowId: schoolTranscript.event.windowId,
      deviceId: device.deviceId,
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now,
    });
    const plan = await engine.buildPhaseAcceptancePlan({
      lookbackDays: 1,
      now,
    });

    expect(report.completion.isPhaseReady).toBe(true);
    expect(report.completion.phaseState).toBe("ready-to-close");
    expect(report.criteria.every((criterion) => criterion.status === "pass")).toBe(true);
    expect(report.completion.passedCriteria).toBe(report.completion.totalCriteria);
    expect(report.blockers).toEqual([]);
    expect(report.criteria.every((criterion) => criterion.targets.every((target) => target.pass))).toBe(true);
    expect(plan.phaseState).toBe("ready-to-close");
    expect(plan.tracks).toEqual([]);
  });

  it("accepts transcript-ready office and school fixtures with explicit follow-up and knowledge-gap signals", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Fixture phone",
      platform: "fixture",
      fingerprint: "fixture:acceptance-gap-signals",
    });
    const now = Date.now();

    await store.updateHeartbeat(device.deviceId, {
      batteryPct: 100,
      network: "fixture",
      appState: "host-replay",
      raw: {
        fixture: true,
      },
    });

    const officeEvent = await recordAudioEvent(store, {
      memoryId: "fixture-office-ready",
      deviceId: device.deviceId,
      summary: "办公会议讨论 remote-control project，涉及角色、需求、成本、价格和下一步功能可行性。",
      transcript:
        "会议讨论 remote-control project，Laura 提到需要确认角色分工、成本预算、价格限制、竞品市场和后续功能可行性。",
      capturedAt: now - 5 * 60 * 60 * 1000,
      projectRefs: ["project:remote-control"],
      tags: ["fixture", "office", "meeting", "remote-control"],
    });
    const schoolEvent = await recordAudioEvent(store, {
      memoryId: "fixture-school-ready",
      deviceId: device.deviceId,
      summary: "课堂 lecture 里 Professor Strang 讲 convolution、Fourier coefficients、filtering 和 FFT 复习重点。",
      transcript:
        "Professor Strang 在 lecture 里讲 convolution 和 Fourier coefficients，解释 filtering、signal processing、cyclic convolution 和 FFT，需要复习公式和例题。",
      capturedAt: now - 3 * 60 * 60 * 1000,
      projectRefs: ["course:18.085"],
      tags: ["fixture", "school", "classroom", "lecture", "learning"],
    });

    await engine.annotateSpeaker({
      speakerRef: `speaker:${officeEvent.event.windowId}:1`,
      displayName: "Laura",
      relationship: "project manager",
      eventIds: [officeEvent.event.eventId],
      windowId: officeEvent.event.windowId,
      deviceId: device.deviceId,
    });
    await engine.annotateSpeaker({
      speakerRef: `speaker:${schoolEvent.event.windowId}:1`,
      displayName: "Professor Strang",
      relationship: "teacher",
      eventIds: [schoolEvent.event.eventId],
      windowId: schoolEvent.event.windowId,
      deviceId: device.deviceId,
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now,
    });
    const office = report.criteria.find((item) => item.id === "office-recap");
    const school = report.criteria.find((item) => item.id === "school-recap");

    expect(report.completion.isPhaseReady).toBe(true);
    expect(report.completion.phaseState).toBe("ready-to-close");
    expect(office?.status).toBe("pass");
    expect(office?.evidence.followUpSignalWindows).toBe(1);
    expect(office?.evidence.pendingSignals).toBe(1);
    expect(school?.status).toBe("pass");
    expect(school?.evidence.knowledgeGapWindows).toBe(1);
    expect(school?.evidence.pendingKnowledgeSignals).toBe(1);
    expect(school?.evidence.speakerClues).toBeGreaterThanOrEqual(1);
  });

  it("does not count semantic STT timeouts as device stability failures", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();

    await store.updateHeartbeat(device.deviceId, {
      batteryPct: 80,
      network: "wifi",
      appState: "running:60",
      raw: {
        batteryPct: 80,
        network: "wifi",
        appState: "running:60",
      },
    });

    const annotatedEvent = await recordAudioEvent(store, {
      memoryId: "stability-annotated",
      deviceId: device.deviceId,
      summary: "Amy 在会议里确认了报价任务。",
      transcript: "Amy 让我们今晚补完报价。",
      capturedAt: now - 20 * 60 * 1000,
      peopleRefs: ["person_amy"],
      tags: ["meeting", "office"],
    });
    await engine.annotatePerson({
      personRef: "person_amy",
      displayName: "Amy",
      relationship: "老板",
      eventIds: [annotatedEvent.event.eventId],
    });
    await store.recordCapture({
      memoryId: "semantic-stt-timeout",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but query-time STT timed out.",
      transcript: "",
      createdAt: now - 10 * 60 * 1000,
      capturedAt: now - 10 * 60 * 1000,
      sourcePath: path.join(rootDir, "semantic-stt-timeout.wav"),
      fileName: "semantic-stt-timeout.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/28/device/semantic-stt-timeout.wav",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason:
        "runtime_stt_empty|primary_multimodal_error|query_time_asr_low_signal|openai_stt_timeout",
      tags: ["meeting", "office"],
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now,
    });
    const criterion = report.criteria.find((item) => item.id === "annotation-and-stability");
    const target = criterion?.targets.find((item) => item.metric === "instabilitySignalEvents");

    expect(criterion?.evidence.instabilitySignalEvents).toBe(0);
    expect(target?.pass).toBe(true);
  });

  it("accepts speaker annotations as identity evidence for phase acceptance", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();

    await store.updateHeartbeat(device.deviceId, {
      batteryPct: 80,
      network: "wifi",
      appState: "running:60",
      raw: {
        batteryPct: 80,
        network: "wifi",
        appState: "running:60",
      },
    });

    const officeEvent = await recordAudioEvent(store, {
      memoryId: "speaker-only-office",
      deviceId: device.deviceId,
      summary: "办公会议里 speaker_1 确认任务和报价跟进。",
      transcript: "办公会议里 speaker_1 确认任务和报价跟进。",
      capturedAt: now - 20 * 60 * 1000,
      tags: ["meeting", "office"],
    });
    await store.recordCapture({
      memoryId: "speaker-only-office-pending",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "办公会议里还有一段待确认任务讨论。",
      transcript: "",
      createdAt: now - 18 * 60 * 1000,
      capturedAt: now - 18 * 60 * 1000,
      sourcePath: path.join(rootDir, "speaker-only-office-pending.wav"),
      fileName: "speaker-only-office-pending.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/28/device/speaker-only-office-pending.wav",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty",
      tags: ["meeting", "office"],
    });
    await engine.annotateSpeaker({
      speakerRef: "speaker_1",
      displayName: "李三",
      relationship: "同事",
      eventIds: [officeEvent.event.eventId],
      windowId: officeEvent.event.windowId,
      deviceId: device.deviceId,
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now,
    });
    const office = report.criteria.find((item) => item.id === "office-recap");
    const stability = report.criteria.find((item) => item.id === "annotation-and-stability");

    expect(office?.evidence.confirmedPeople).toBe(0);
    expect(office?.evidence.confirmedSpeakers).toBe(1);
    expect(office?.targets.find((item) => item.metric === "confirmedIdentities")?.pass).toBe(true);
    expect(stability?.evidence.relevantPeopleAnnotations).toBe(0);
    expect(stability?.evidence.relevantSpeakerAnnotations).toBe(1);
    expect(stability?.targets.find((item) => item.metric === "relevantIdentityAnnotations")?.pass).toBe(true);
  });

  it("still counts queue and auth failures as device stability failures", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();

    await store.updateHeartbeat(device.deviceId, {
      batteryPct: 80,
      network: "wifi",
      appState: "running:60",
      raw: {
        batteryPct: 80,
        network: "wifi",
        appState: "running:60",
      },
    });

    const annotatedEvent = await recordAudioEvent(store, {
      memoryId: "stability-queue-annotated",
      deviceId: device.deviceId,
      summary: "Amy 在会议里确认了报价任务。",
      transcript: "Amy 让我们今晚补完报价。",
      capturedAt: now - 20 * 60 * 1000,
      peopleRefs: ["person_amy"],
      tags: ["meeting", "office"],
    });
    await engine.annotatePerson({
      personRef: "person_amy",
      displayName: "Amy",
      relationship: "老板",
      eventIds: [annotatedEvent.event.eventId],
    });
    await store.recordCapture({
      memoryId: "queue-full-failure",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio upload was accepted after retry, but queue was full earlier.",
      transcript: "",
      createdAt: now - 10 * 60 * 1000,
      capturedAt: now - 10 * 60 * 1000,
      sourcePath: path.join(rootDir, "queue-full-failure.wav"),
      fileName: "queue-full-failure.wav",
      mime: "audio/wav",
      sizeBytes: 2048,
      storageRelPath: "2026/03/28/device/queue-full-failure.wav",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "ingest_queue_full",
      tags: ["meeting", "office"],
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now,
    });
    const criterion = report.criteria.find((item) => item.id === "annotation-and-stability");
    const target = criterion?.targets.find((item) => item.metric === "instabilitySignalEvents");

    expect(criterion?.status).toBe("needs-work");
    expect(criterion?.evidence.instabilitySignalEvents).toBe(1);
    expect(target?.pass).toBe(false);
  });

  it("does not fail stability for historical devices that are no longer expected online", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const historicalDevice = await store.registerDevice({
      name: "Old phone",
      platform: "android",
    });
    const freshDevice = await store.registerDevice({
      name: "Fixture phone",
      platform: "android",
    });
    const now = Date.now();

    await store.updateHeartbeat(freshDevice.deviceId, {
      batteryPct: 80,
      network: "wifi",
      appState: "running:60",
      raw: {
        batteryPct: 80,
        network: "wifi",
        appState: "running:60",
      },
    });
    await recordAudioEvent(store, {
      memoryId: "historical-office-context",
      deviceId: historicalDevice.deviceId,
      summary: "上午有一段历史办公讨论，需要保留在跨天回顾里。",
      transcript: "上午讨论了报价和任务安排。",
      capturedAt: now - 6 * 60 * 60 * 1000,
      tags: ["meeting", "office"],
    });
    const freshEvent = await recordAudioEvent(store, {
      memoryId: "fresh-office-context",
      deviceId: freshDevice.deviceId,
      summary: "Amy 刚确认报价任务和下一步跟进。",
      transcript: "Amy 让我们今晚补完报价。",
      capturedAt: now - 10 * 60 * 1000,
      peopleRefs: ["person_amy"],
      tags: ["meeting", "office"],
    });
    await engine.annotatePerson({
      personRef: "person_amy",
      displayName: "Amy",
      relationship: "老板",
      eventIds: [freshEvent.event.eventId],
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now,
    });
    const criterion = report.criteria.find((item) => item.id === "annotation-and-stability");

    expect(criterion?.status).toBe("pass");
    expect(criterion?.evidence.activeDevices).toBe(2);
    expect(criterion?.evidence.recentlyProducingDevices).toBe(1);
    expect(criterion?.evidence.staleActiveDevices).toBe(0);
  });

  it("marks video criterion as missing-data when video mode is enabled but no video evidence exists", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 10, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        hostModelVideoMode: "keyframes",
      },
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now: Date.now(),
    });

    const videoCriterion = report.criteria.find((criterion) => criterion.id === "video-evidence");
    expect(videoCriterion?.status).toBe("missing-data");
    expect(videoCriterion?.targets.some((target) => target.metric === "videoEventsOrKeyframes" && !target.pass)).toBe(
      true,
    );
  });

  it("marks video criterion as pass when video mode is enabled and evidence is replayable", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store, {
      cfg: {
        hostModelVideoMode: "keyframes",
      },
    });
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const now = Date.now();
    const capturedAt = now - 30 * 60 * 1000;

    await store.recordCapture({
      memoryId: "phase-video-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "video",
      summary: "会议室里两位同事在白板前对照任务清单。",
      transcript: "",
      note: "active-window videoRequestId=req-phase-video-1",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: path.join(rootDir, "phase-video-1.mp4"),
      fileName: "phase-video-1.mp4",
      mime: "video/mp4",
      sizeBytes: 2048,
      storageRelPath: "2026/03/28/device/phase-video-1.mp4",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "multimodal-preview",
      analysisStatus: "succeeded",
      tags: ["meeting", "office"],
    });

    await store.recordCapture({
      memoryId: "phase-video-kf-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "image",
      summary: "关键帧里能看到会议白板上的待办列表和截止时间。",
      transcript: "",
      note: "active-window videoRequestId=req-phase-video-1 videoKeyframe=1 keyframe=1",
      createdAt: capturedAt + 5_000,
      capturedAt: capturedAt + 5_000,
      sourcePath: path.join(rootDir, "phase-video-kf-1.jpg"),
      fileName: "phase-video-kf-1.jpg",
      mime: "image/jpeg",
      sizeBytes: 1024,
      storageRelPath: "2026/03/28/device/phase-video-kf-1.jpg",
      retentionExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "multimodal-preview",
      analysisStatus: "succeeded",
      tags: ["meeting", "office"],
    });

    const report = await engine.buildPhaseAcceptance({
      lookbackDays: 1,
      now,
    });

    const videoCriterion = report.criteria.find((criterion) => criterion.id === "video-evidence");
    expect(videoCriterion?.status).toBe("pass");
    expect(videoCriterion?.targets.every((target) => target.pass)).toBe(true);
  });

  it("includes video keyframe image evidence when filtering assistant context by video modality", async () => {
    vi.setSystemTime(new Date(2026, 2, 28, 20, 0, 0));

    const store = createStore(rootDir);
    const engine = createEngine(rootDir, store);
    const device = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const capturedAt = Date.now() - 5 * 60 * 1000;

    await store.recordCapture({
      memoryId: "video-filter-parent",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "video",
      summary: "视频片段显示会议桌上的投影画面。",
      transcript: "",
      note: "videoRequestId=req-video-filter",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: path.join(rootDir, "video-filter-parent.mp4"),
      fileName: "video-filter-parent.mp4",
      mime: "video/mp4",
      sizeBytes: 2048,
      storageRelPath: "2026/03/28/device/video-filter-parent.mp4",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "metadata-only",
      analysisStatus: "degraded",
    });
    await store.recordCapture({
      memoryId: "video-filter-keyframe",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "image",
      summary: "关键帧 OCR 显示 Scaling Law 与收购动态。",
      transcript: "",
      note: "active-window videoRequestId=req-video-filter videoKeyframe=1 keyframe=1 caption=%E8%AE%BF%E8%B0%88%E7%94%BB%E9%9D%A2 ocr=Scaling%20Law%7C%E6%94%B6%E8%B4%AD%E5%8A%A8%E6%80%81",
      createdAt: capturedAt + 1_000,
      capturedAt: capturedAt + 1_000,
      sourcePath: path.join(rootDir, "video-filter-keyframe.jpg"),
      fileName: "video-filter-keyframe.jpg",
      mime: "image/jpeg",
      sizeBytes: 1024,
      storageRelPath: "2026/03/28/device/video-filter-keyframe.jpg",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "multimodal-preview",
      analysisStatus: "succeeded",
    });
    await store.recordCapture({
      memoryId: "video-filter-audio",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "访谈音频转写：主讲人讨论 Scaling Law、模型能力边界和收购动态。",
      transcript: "主讲人讨论 Scaling Law、模型能力边界和收购动态，强调不要只看画面，要结合视频音频理解。",
      note: "csAudio:v2 session=req-video-filter segment=1 sessionStart=100 boundary=fixture clipMs=60000 continued=0 videoRequestId=req-video-filter",
      createdAt: capturedAt + 2_000,
      capturedAt: capturedAt + 2_000,
      sourcePath: path.join(rootDir, "video-filter-audio.wav"),
      fileName: "video-filter-audio.wav",
      mime: "audio/wav",
      sizeBytes: 4096,
      storageRelPath: "2026/03/28/device/video-filter-audio.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
    });

    const context = await engine.buildAssistantContext({
      scope: "today",
      modality: "video",
      artifactUrlBase: "/api/clawsense/artifacts",
      now: Date.now(),
    });

    const events = context.windows.flatMap((window) => window.events);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.modality === "video")).toBe(true);
    expect(events.some((event) => event.modality === "image" && event.summary.includes("Scaling Law"))).toBe(true);
    expect(events.some((event) => event.modality === "audio" && event.transcript?.includes("不要只看画面"))).toBe(
      true,
    );
    expect(context.highlights.audioCoverage.transcriptReadyWindows).toBeGreaterThanOrEqual(1);
  });
});

function createStore(rootDir: string): ClawSenseStateStore {
  return new ClawSenseStateStore({
    resolveStateDir: () => rootDir,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });
}

function createEngine(
  rootDir: string,
  stateStore: ClawSenseStateStore,
  options?: {
    cfg?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
    memorySearch?: {
      searchRelevantMemories: (params: {
        question: string;
        startAt?: number;
        endAt?: number;
        deviceId?: string;
        modality?: "audio" | "image";
        limit?: number;
      }) => Promise<Array<{ eventId: string }>>;
    };
  },
): ClawSenseReviewEngine {
  return new ClawSenseReviewEngine({
    cfg: resolveClawSenseConfig({
      analysisMode: "multimodal-preferred",
      memoryDbPath: path.join(rootDir, "memory-db"),
      ...(options?.cfg ?? {}),
    }),
    runtimeConfig: options?.runtimeConfig ?? {},
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    stateStore,
    memorySearch: options?.memorySearch as any,
  });
}

async function writeExecutableScript(rootDir: string, fileName: string, body: string): Promise<string> {
  const filePath = path.join(rootDir, fileName);
  await fs.writeFile(filePath, body, "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

async function recordAudioEvent(
  store: ClawSenseStateStore,
  params: {
    memoryId: string;
    deviceId: string;
    summary: string;
    transcript?: string;
    note?: string;
    peopleRefs?: string[];
    projectRefs?: string[];
    tags?: string[];
    capturedAt: number;
  },
) {
  return await store.recordCapture({
    memoryId: params.memoryId,
    namespace: "clawsense",
    deviceId: params.deviceId,
    modality: "audio",
    summary: params.summary,
    transcript: params.transcript ?? params.summary,
    note: params.note,
    createdAt: params.capturedAt,
    capturedAt: params.capturedAt,
    sourcePath: `/tmp/${params.memoryId}.wav`,
    fileName: `${params.memoryId}.wav`,
    mime: "audio/wav",
    sizeBytes: 1024,
    storageRelPath: `2026/03/10/device/${params.memoryId}.wav`,
    retentionExpiresAt: params.capturedAt + 7 * 24 * 60 * 60 * 1000,
    analysisMode: "runtime-stt",
    peopleRefs: params.peopleRefs,
    projectRefs: params.projectRefs,
    tags: params.tags,
  });
}
