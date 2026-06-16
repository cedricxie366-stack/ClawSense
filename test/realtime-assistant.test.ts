import { describe, expect, it, vi } from "vitest";
import {
  answerAssistantQuery,
  buildAssistantDraftDocument,
  buildAssistantModelPrompt,
  buildRecentContextPayload,
  mergeAssistantModelAnswer,
  resolveAssistantAudioRecheckPlan,
  resolveAssistantQueryText,
  shouldFallbackAssistantContextToAllDevices,
  shouldUseDeterministicAssistantAnswer,
  shouldUsePreviousTurnEvidenceRange,
  withAssistantDeviceFallbackHint,
} from "../src/realtime-assistant.js";

describe("realtime assistant helpers", () => {
  it("builds a recent-context payload from assistant context windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T15:30:00+08:00"));

    const payload = createAssistantContextPayload();
    const result = await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext: vi.fn(async () => payload),
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_60s",
      question: "刚才重点是什么",
      modeHint: "meeting",
    });

    expect(result.recentContext.windowHint).toBe("last_5m");
    expect(result.recentContext.modeUsed).toBe("meeting");
    expect(result.recentContext.sceneSummary).toContain("会议室大屏");
    expect(result.recentContext.recentTranscriptSpans[0]?.text).toContain("明天先把报价单");
    expect(result.recentContext.taskHints.join(" ")).toContain("报价单");
    expect(result.recentContext.topEvidence[0]?.artifactUrls).toContain("/api/clawsense/artifacts?id=artifact-image-1");

    vi.useRealTimers();
  });

  it("does not treat visual text containing 要 as a task hint", async () => {
    const payload = createAssistantContextPayload({
      summary: "木框里有一句提示文字。",
      windows: [
        {
          ...createAssistantContextPayload().windows[0],
          primarySummary: "木框里印着“你为什么要打开手机”的中文文字。",
          transcriptText: "木框里印着“你为什么要打开手机”的中文文字。",
          peopleRefs: [],
          projectRefs: [],
          events: [],
        },
      ],
      highlights: {
        ...createAssistantContextPayload().highlights,
        people: [],
        speakers: [],
      },
    });
    const result = await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext: vi.fn(async () => payload),
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_60s",
      question: "有没有要我跟进的事",
      modeHint: "desk",
    });

    expect(result.recentContext.taskHints).toEqual([]);
    expect(result.recentContext.attentionHints).toEqual([]);
  });

  it("filters assistant spoken answers out of recent discussion context", async () => {
    const base = createAssistantContextPayload();
    const payload = createAssistantContextPayload({
      windows: [
        {
          ...base.windows[0],
          primarySummary: "会议模式下，我还没有抓到清晰讨论内容。当前可确认的场景是：画面展示了电脑屏幕。",
          transcriptText:
            "会议模式下，我还没有抓到清晰讨论内容。当前可确认的场景是：画面展示了电脑屏幕。真正讨论的是发布给公众前要确认法律风险和品牌风险。",
          events: [
            {
              ...base.windows[0].events[0],
              transcript: "会议模式下，我还没有抓到清晰讨论内容。当前可确认的场景是：画面展示了电脑屏幕。",
              eventId: "assistant-echo-audio",
            },
            {
              ...base.windows[0].events[0],
              transcript: "真正讨论的是发布给公众前要确认法律风险和品牌风险。",
              eventId: "real-audio",
              capturedAt: new Date("2026-04-24T15:29:40+08:00").getTime(),
            },
          ],
        },
      ],
    });
    const result = await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext: vi.fn(async () => payload),
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_5m",
      question: "刚才讨论的重点是什么",
      modeHint: "meeting",
    });

    expect(result.recentContext.recentTranscriptSpans).toHaveLength(1);
    expect(result.recentContext.recentTranscriptSpans[0]?.text).toContain("法律风险");
    expect(result.recentContext.recentTranscriptSpans[0]?.text).not.toContain("会议模式下");
    expect(result.recentContext.topEvidence[0]?.transcriptExcerpt).toContain("法律风险");
    expect(result.recentContext.topEvidence[0]?.transcriptExcerpt).not.toContain("会议模式下");
    expect(result.recentContext.topEvidence[0]?.summary).not.toContain("会议模式下");
  });

  it("prioritizes transcript evidence over recent visual-only windows for discussion questions", async () => {
    const base = createAssistantContextPayload();
    const audioWindow = {
      ...base.windows[0],
      windowId: "audio-window",
      startedAt: new Date("2026-04-24T15:27:00+08:00").getTime(),
      endedAt: new Date("2026-04-24T15:28:30+08:00").getTime(),
      primarySummary: "访谈视频的声音转写，讨论模型能力来源。",
      transcriptText: "主讲人讨论模型能力提升主要来自数据、算力和算法，并强调先把问题定义清楚。",
      imageCount: 0,
      audioCount: 1,
      events: [
        {
          ...base.windows[0].events[0],
          eventId: "audio-interview",
          modality: "audio" as const,
          capturedAt: new Date("2026-04-24T15:28:00+08:00").getTime(),
          summary: "访谈音频转写",
          transcript: "主讲人讨论模型能力提升主要来自数据、算力和算法，并强调先把问题定义清楚。",
          artifact: {
            artifactId: "artifact-audio-interview",
            fileName: "interview.wav",
            mime: "audio/wav",
            available: true,
            sizeBytes: 234,
            url: "/api/clawsense/artifacts?id=artifact-audio-interview",
          },
        },
      ],
    };
    const visualOnlyWindow = {
      ...base.windows[0],
      windowId: "visual-window",
      startedAt: new Date("2026-04-24T15:29:00+08:00").getTime(),
      endedAt: new Date("2026-04-24T15:30:00+08:00").getTime(),
      primarySummary: "画面展示电脑屏幕上正在播放采访视频，一位男子对着麦克风讲话。",
      transcriptText: "",
      imageCount: 1,
      audioCount: 0,
      events: [
        {
          ...base.windows[0].events[1],
          eventId: "image-interview",
          capturedAt: new Date("2026-04-24T15:29:30+08:00").getTime(),
          summary: "画面展示电脑屏幕上正在播放采访视频，一位男子对着麦克风讲话。",
          transcript: undefined,
        },
      ],
    };
    const payload = createAssistantContextPayload({
      windows: [visualOnlyWindow, audioWindow],
      highlights: {
        ...base.highlights,
        audioCoverage: {
          totalAudioWindows: 1,
          transcriptReadyWindows: 1,
          pendingAudioWindows: 0,
          degradedAudioEvents: 0,
        },
      },
    });

    const result = await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext: vi.fn(async () => payload),
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_60s",
      question: "刚才讨论的重点是什么？",
      modeHint: "meeting",
    });

    expect(result.recentContext.topEvidence[0]?.windowId).toBe("audio-window");
    expect(result.recentContext.topEvidence[0]?.transcriptExcerpt).toContain("数据、算力和算法");
    expect(result.recentContext.recentTranscriptSpans[0]?.text).toContain("问题定义清楚");
  });

  it("expands recent context from natural time range questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T18:00:00+08:00"));
    const buildAssistantContext = vi.fn(async (params) =>
      createAssistantContextPayload({
        startAt: params.startAt,
        endAt: params.endAt,
      }),
    );

    const result = await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext,
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_60s",
      question: "过去4个小时我们聊了什么？",
      modeHint: "meeting",
    });

    const expectedStart = new Date("2026-04-24T14:00:00+08:00").getTime();
    expect(buildAssistantContext).toHaveBeenCalledWith(expect.objectContaining({ startAt: expectedStart }));
    expect(result.recentContext.windowHint).toBe("custom");
    expect(result.recentContext.timeRange.startAt).toBe(expectedStart);

    vi.useRealTimers();
  });

  it("promotes auto recent discussion questions to the five-minute window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T18:00:00+08:00"));
    const buildAssistantContext = vi.fn(async (params) =>
      createAssistantContextPayload({
        startAt: params.startAt,
        endAt: params.endAt,
      }),
    );

    const result = await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext,
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_60s",
      question: "刚才沟通的重点是什么？",
      modeHint: "auto",
    });

    const expectedStart = new Date("2026-04-24T17:55:00+08:00").getTime();
    expect(buildAssistantContext).toHaveBeenCalledWith(expect.objectContaining({ startAt: expectedStart }));
    expect(result.recentContext.windowHint).toBe("last_5m");
    expect(result.recentContext.modeUsed).toBe("meeting");

    vi.useRealTimers();
  });

  it("marks empty device-scoped contexts as eligible for all-device fallback", () => {
    const empty = {
      ...createRecentContext(),
      attentionHints: [],
      topEvidence: [],
      recentTranscriptSpans: [],
      counts: {
        windows: 0,
        events: 0,
        transcriptSpans: 0,
        audioEvents: 0,
        pendingAudioWindows: 0,
      },
    };
    const fallback = withAssistantDeviceFallbackHint({
      recentContext: createRecentContext(),
      deviceName: "测试手机",
    });

    expect(shouldFallbackAssistantContextToAllDevices(empty)).toBe(true);
    expect(shouldFallbackAssistantContextToAllDevices(createRecentContext())).toBe(false);
    expect(fallback.attentionHints[0]).toContain("测试手机");
    expect(fallback.attentionHints[0]).toContain("全部设备证据");
  });

  it("allows continuation and draft requests to inherit the previous turn range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T21:30:00+08:00"));
    const previousTurn = {
      queryText: "过去4个小时我们聊了什么？",
      answerText: "过去4小时主要讨论了智能来源和验证 Agent。",
      answerSpokenText: "过去4小时主要讨论了智能来源和验证 Agent。",
      answeredAt: 20,
      modeUsed: "meeting" as const,
      timeRange: {
        startAt: new Date("2026-05-14T17:20:00+08:00").getTime(),
        endAt: new Date("2026-05-14T21:20:00+08:00").getTime(),
        label: "17:20-21:20",
      },
    };
    const buildAssistantContext = vi.fn(async (params) =>
      createAssistantContextPayload({
        startAt: params.startAt,
        endAt: params.endAt,
      }),
    );

    expect(shouldUsePreviousTurnEvidenceRange({ queryText: "继续说", previousTurn })).toBe(true);
    expect(shouldUsePreviousTurnEvidenceRange({ queryText: "间短点", previousTurn })).toBe(true);
    expect(shouldUsePreviousTurnEvidenceRange({ queryText: "帮我整理成会议纪要", previousTurn })).toBe(true);
    expect(shouldUsePreviousTurnEvidenceRange({ queryText: "昨天发生了什么", previousTurn })).toBe(false);

    await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext,
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_60s",
      question: "帮我整理成会议纪要",
      modeHint: "meeting",
      timeRangeOverride: previousTurn.timeRange,
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        startAt: previousTurn.timeRange.startAt,
        endAt: previousTurn.timeRange.endAt,
      }),
    );

    vi.useRealTimers();
  });

  it("uses daily review scope for yesterday questions instead of a sparse custom range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T10:00:00+08:00"));
    const buildAssistantContext = vi.fn(async (params) =>
      createAssistantContextPayload({
        ...createYesterdayReviewContextPayload(),
        startAt: new Date("2026-05-11T00:00:00+08:00").getTime(),
        endAt: new Date("2026-05-12T00:00:00+08:00").getTime(),
      }),
    );

    const result = await buildRecentContextPayload({
      reviewEngine: {
        buildAssistantContext,
      } as any,
      artifactUrlBase: "/api/clawsense/artifacts",
      windowHint: "last_60s",
      question: "请问昨天发生了什么？",
      modeHint: "meeting",
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "today",
        date: "2026-05-11",
      }),
    );
    expect(result.recentContext.windowHint).toBe("custom");
    expect(result.recentContext.timeRange.label).toBe("2026-05-11 全天");
    expect(result.recentContext.overview?.kind).toBe("day");
    expect(result.recentContext.overview?.reviewItems.join(" ")).toContain("数据看板");

    vi.useRealTimers();
  });

  it("answers yesterday overview questions from daily summary and coverage", () => {
    const answer = answerAssistantQuery({
      queryText: "请问昨天发生了什么？",
      recentContext: createYesterdayRecentContext(),
      answeredAt: 9,
    });

    expect(answer.answerText).toContain("2026-05-11 我按全天记录回顾了");
    expect(answer.answerText).toContain("490 条事件");
    expect(answer.answerText).toContain("数据看板");
    expect(answer.answerText).not.toContain("场景上看");
    expect(answer.answerSpokenText).toContain("490 条事件");
    expect(answer.answerSpokenText).toContain("19/21 个音频窗口有清晰转写");
    expect(answer.answerSpokenText).toContain("数据看板");
    expect(answer.answerSpokenText).toContain("完整内容我已经显示在屏幕上");
    expect(answer.answerSpokenText.length).toBeGreaterThan(120);
    expect(answer.answerSpokenText.length).toBeLessThanOrEqual(360);
  });

  it("answers custom range overview questions without calling them all-day reviews", () => {
    const answer = answerAssistantQuery({
      queryText: "过去4个小时我们聊了什么？",
      recentContext: createCustomRangeRecentContext(),
      answeredAt: 25,
    });

    expect(answer.answerText).toContain("我按 17:20-21:20 这个时间范围回顾了");
    expect(answer.answerText).toContain("可读音频主要包括");
    expect(answer.answerText).not.toContain("按全天记录回顾");
    expect(answer.answerSpokenText).toContain("17:20-21:20");
    expect(answer.answerSpokenText).not.toContain("按全天记录回顾");
    expect(answer.answerSpokenText.length).toBeLessThanOrEqual(280);
    expect(answer.answerSpokenText).toMatch(/[。？！]$/);
  });

  it("plans query-time audio recheck for broad voice questions with pending audio gaps", () => {
    const rangePlan = resolveAssistantAudioRecheckPlan({
      queryText: "过去4个小时我们聊了什么？",
      recentContext: createCustomRangeRecentContext(),
    });
    const dayPlan = resolveAssistantAudioRecheckPlan({
      queryText: "昨天发生了什么？",
      recentContext: createYesterdayRecentContext(),
    });
    const scenePlan = resolveAssistantAudioRecheckPlan({
      queryText: "我现在在看什么？",
      recentContext: createCustomRangeRecentContext(),
    });

    expect(rangePlan).toEqual({
      shouldRecheck: true,
      maxWindows: 1,
      reason: "pending_audio_summary",
    });
    expect(dayPlan).toEqual({
      shouldRecheck: true,
      maxWindows: 2,
      reason: "pending_audio_summary",
    });
    expect(scenePlan.shouldRecheck).toBe(false);
  });

  it("builds model prompts from evidence and merges model answers", () => {
    const recentContext = createYesterdayRecentContext();
    const fallback = answerAssistantQuery({
      queryText: "昨天发生了什么？你怎么看？",
      recentContext,
      answeredAt: 10,
    });
    const prompt = buildAssistantModelPrompt({
      queryText: "昨天发生了什么？你怎么看？",
      recentContext,
      templateAnswer: fallback,
      previousTurn: {
        queryText: "昨天发生了什么？",
        answerText: "昨天主要讨论了数据看板和大促复盘。",
        answerSpokenText: "昨天重点是数据看板和大促复盘。",
        answeredAt: 9,
        modeUsed: "meeting",
        timeRange: recentContext.timeRange,
      },
    });

    expect(prompt.system).toContain("现实世界语音对话入口");
    expect(prompt.system).toContain("只输出 JSON");
    expect(prompt.user).toContain("昨天发生了什么");
    expect(prompt.user).toContain("490");
    expect(prompt.user).toContain("数据看板");
    expect(prompt.user).toContain("previousTurn");
    expect(prompt.user).toContain("昨天主要讨论了数据看板和大促复盘");

    const merged = mergeAssistantModelAnswer({
      rawText: JSON.stringify({
        answerText: "昨天最值得沉淀的是：数据看板和大促缺货复盘都暴露了指标口径问题，建议整理成一份复盘文档。",
        answerSpokenText: "昨天重点是数据看板和大促缺货复盘，建议沉淀成复盘文档。",
        actionIntent: {
          type: "draft_document",
          title: "2026-05-11 会议复盘",
          reason: "用户在追问沉淀文件",
          contentHint: "围绕指标口径、缺货复盘和下一步行动项整理。",
        },
      }),
      queryText: "昨天发生了什么？你怎么看？",
      recentContext,
      fallback,
      answeredAt: 11,
    });

    expect(merged?.answerSource).toBe("model");
    expect(merged?.answerText).toContain("指标口径");
    expect(merged?.answerSpokenText).toContain("建议沉淀");
    expect(merged?.actionIntent?.type).toBe("draft_document");
    expect(merged?.supportingEvidence).toEqual(fallback.supportingEvidence);
  });

  it("rejects unusable model answers so template fallback can remain active", () => {
    const fallback = answerAssistantQuery({
      queryText: "昨天发生了什么？",
      recentContext: createYesterdayRecentContext(),
      answeredAt: 12,
    });
    const merged = mergeAssistantModelAnswer({
      rawText: "not json",
      queryText: "昨天发生了什么？",
      recentContext: createYesterdayRecentContext(),
      fallback,
    });

    expect(merged).toBeNull();
  });

  it("builds markdown draft documents from draft_document actions", () => {
    const recentContext = {
      ...createYesterdayRecentContext(),
      attentionHints: [
        "Host Assistant Query Smoke 在这个时间窗没有单独采到记录，已临时回退到同一 ClawSense 媒体库里的全部设备证据。",
        ...createYesterdayRecentContext().attentionHints,
      ],
    };
    const fallback = answerAssistantQuery({
      queryText: "帮我整理成会议纪要",
      recentContext,
      answeredAt: 13,
    });
    const answer = {
      ...fallback,
      answerText: "会议纪要草稿：昨天围绕数据看板、大促缺货复盘和毛利率计算形成了几条待跟进事项。",
      actionIntent: {
        type: "draft_document" as const,
        title: "2026-05-11 会议纪要",
        reason: "用户要求沉淀会议纪要",
        contentHint: "整理指标口径、缺货复盘和下一步行动项。",
      },
    };

    const draft = buildAssistantDraftDocument({
      queryText: "帮我整理成会议纪要",
      answer,
      recentContext,
      createdAt: new Date("2026-05-13T01:30:00+08:00").getTime(),
    });

    expect(draft?.title).toBe("2026-05-11 会议纪要");
    expect(draft?.markdown).toContain("# 2026-05-11 会议纪要");
    expect(draft?.markdown).toContain("用户要求沉淀会议纪要");
    expect(draft?.markdown).toContain("会议纪要草稿");
    expect(draft?.markdown).toContain("数据看板");
    expect(draft?.markdown).toContain("证据窗口");
    expect(draft?.markdown).not.toContain("Host Assistant Query Smoke");
  });

  it("sets draft_document intent from template fallback when user asks to persist notes", () => {
    const answer = answerAssistantQuery({
      queryText: "帮我整理成会议纪要",
      recentContext: createYesterdayRecentContext(),
      answeredAt: 14,
    });

    expect(answer.actionIntent?.type).toBe("draft_document");
    expect(answer.actionIntent?.title).toContain("会议纪要");
    expect(answer.actionIntent?.contentHint).toContain("2026-05-11");
  });

  it("continues voice conversation from the previous assistant turn", () => {
    const previousTurn = {
      queryText: "昨天发生了什么？",
      answerText:
        "昨天主要讨论了数据看板指标优化。还复盘了大促缺货问题。第三个重点是毛利率计算口径。最后还看了 AI 行业趋势视频。",
      answerSpokenText: "昨天重点是数据看板、大促缺货和毛利率口径。",
      answeredAt: 20,
      modeUsed: "meeting" as const,
      timeRange: createYesterdayRecentContext().timeRange,
      actionIntent: { type: "none" as const },
    };

    const continued = answerAssistantQuery({
      queryText: "继续说",
      recentContext: createYesterdayRecentContext(),
      previousTurn,
      answeredAt: 21,
    });

    expect(continued.answerText).toContain("上一轮");
    expect(continued.answerText).toContain("昨天发生了什么");
    expect(continued.answerText).toContain("当前可回链的证据");
    expect(continued.answerSpokenText.length).toBeGreaterThan(80);

    const shortened = answerAssistantQuery({
      queryText: "简短点",
      recentContext: createYesterdayRecentContext(),
      previousTurn,
      answeredAt: 22,
    });
    expect(shortened.answerText).toContain("简短版");
    expect(shortened.answerSpokenText.length).toBeLessThanOrEqual(160);

    const full = answerAssistantQuery({
      queryText: "读全文",
      recentContext: createYesterdayRecentContext(),
      previousTurn,
      answeredAt: 23,
    });
    expect(full.answerText).toContain("上一轮完整回答");
    expect(full.answerSpokenText).toContain("毛利率计算口径");
  });

  it("answers scene questions conservatively from recent visual evidence", () => {
    const answer = answerAssistantQuery({
      queryText: "我现在在看什么？",
      recentContext: createRecentContext(),
      answeredAt: 1,
    });

    expect(answer.answerText).toContain("我最近看到的场景是");
    expect(answer.answerText).toContain("会议室大屏");
    expect(answer.answerSpokenText.length).toBeLessThanOrEqual(120);
  });

  it("answers speech and attention questions from transcript and hints", () => {
    const recentContext = createRecentContext();

    const speechAnswer = answerAssistantQuery({
      queryText: "刚才他们说了什么？",
      recentContext,
      answeredAt: 2,
    });
    expect(speechAnswer.answerText).toContain("我听到的重点是");
    expect(speechAnswer.answerText).toContain("报价单");
    expect(speechAnswer.answerText).toContain("画面线索");

    const attentionAnswer = answerAssistantQuery({
      queryText: "现在有什么需要我注意的？",
      recentContext,
      answeredAt: 3,
    });
    expect(attentionAnswer.answerText).toContain("最需要注意的是");
    expect(attentionAnswer.answerText).toContain("待跟进");
  });

  it("answers meeting assignment and self-reply questions without inventing owners", () => {
    const recentContext = createRecentContext();

    const assignmentAnswer = answerAssistantQuery({
      queryText: "最后任务落给谁？",
      recentContext,
      answeredAt: 5,
    });
    expect(assignmentAnswer.answerText).toContain("没有听到明确");
    expect(assignmentAnswer.answerText).toContain("报价单");

    const selfReplyAnswer = answerAssistantQuery({
      queryText: "我刚才怎么回复的？",
      recentContext,
      answeredAt: 6,
    });
    expect(selfReplyAnswer.answerText).toContain("不能可靠区分");
    expect(selfReplyAnswer.answerText).toContain("Amy 说");
  });

  it("fuses audio focus and visual evidence for meeting questions", () => {
    const answer = answerAssistantQuery({
      queryText: "刚才讨论的重点是什么？",
      recentContext: createRecentContext(),
      answeredAt: 8,
    });

    expect(answer.answerText).toContain("音频重点");
    expect(answer.answerText).toContain("Amy 说");
    expect(answer.answerText).toContain("画面线索");
    expect(answer.answerText).toContain("会议室大屏");
  });

  it("answers desk visit questions from people and speech evidence", () => {
    const answer = answerAssistantQuery({
      queryText: "有人来找过我吗？",
      recentContext: createDeskRecentContext(),
      answeredAt: 7,
    });

    expect(answer.answerText).toContain("工位模式");
    expect(answer.answerText).toContain("李三");
    expect(answer.answerText).toContain("合同版本");
    expect(answer.answerSpokenText.length).toBeLessThanOrEqual(96);
  });

  it("falls back gracefully when query transcription is empty", () => {
    const answer = answerAssistantQuery({
      queryText: "   ",
      recentContext: createRecentContext(),
      answeredAt: 4,
    });

    expect(answer.answerText).toContain("没有听清");
    expect(answer.answerText).toContain("最近听到的是");
    expect(answer.answerSpokenText).toContain("按最近上下文看");
    expect(answer.supportingEvidence[0]?.windowId).toBe("window-1");
  });

  it("rejects long ambient interview transcript instead of treating it as a user question", () => {
    const raw =
      "我觉得这个做作为你的系统性才是才是关键你觉得模型能力还能提高但它的驱动力数据算法你觉得他的驱动力主要来于哪个呢我觉得其实都有但是从某种意义上来说数据和算力其实是很强的关联的一件事数据的算力嗯对因为你算力上去了啥就会需要更多数据对数据上去你就觉得需要更多算力对然后算法上来说我觉得算法作用往往是有一个阶段是你完全没有搞清楚该怎么做那个阶段你就算法会非常的关键";
    const resolved = resolveAssistantQueryText({
      queryText: raw,
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(true);
    expect(resolved.queryText).toBe("");
    expect(resolved.rawQueryText).toBe(raw);
    expect(resolved.reason).toBe("ambient_transcript_too_long");

    const answer = answerAssistantQuery({
      queryText: resolved.queryText,
      recentContext: createRecentContext(),
      queryRewriteReason: resolved.reason,
      rawQueryText: resolved.rawQueryText,
      answeredAt: 24,
    });
    expect(answer.queryText).toBe("");
    expect(answer.answerText).toContain("不会把它当成“最近显式提问”");
    expect(answer.answerSpokenText).toContain("环境声音");
  });

  it("rejects short multimodal ambient summaries that are not user questions", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "听起来像在讨论报价单",
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(true);
    expect(resolved.queryText).toBe("");
    expect(resolved.rawQueryText).toBe("听起来像在讨论报价单");
    expect(resolved.reason).toBe("ambient_transcript_no_question");
  });

  it("accepts short non-whitelist questions when the user explicitly asked", () => {
    const truncated = resolveAssistantQueryText({
      queryText: "发生了什么？",
      modeHint: "auto",
      explicitQuery: true,
    });
    const freeForm = resolveAssistantQueryText({
      queryText: "我刚才放在桌上的钥匙去哪了",
      modeHint: "auto",
      explicitQuery: true,
    });

    expect(truncated.replaced).toBe(false);
    expect(truncated.queryText).toBe("发生了什么？");
    expect(freeForm.replaced).toBe(false);
    expect(freeForm.queryText).toBe("我刚才放在桌上的钥匙去哪了");
  });

  it("still rejects description-style transcripts in explicit query mode", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "听起来像在讨论报价单",
      modeHint: "meeting",
      explicitQuery: true,
    });

    expect(resolved.queryText).toBe("");
    expect(resolved.reason).toBe("ambient_transcript_no_question");
  });

  it("still rejects long ambient transcripts in explicit query mode", () => {
    const raw =
      "我觉得这个做作为你的系统性才是才是关键你觉得模型能力还能提高但它的驱动力数据算法你觉得他的驱动力主要来于哪个呢我觉得其实都有但是从某种意义上来说数据和算力其实是很强的关联的一件事";
    const resolved = resolveAssistantQueryText({
      queryText: raw,
      modeHint: "meeting",
      explicitQuery: true,
    });

    expect(resolved.queryText).toBe("");
    expect(resolved.rawQueryText).toBe(raw);
  });

  it("keeps rejecting non-question short summaries without explicit query mode", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "发生了什么？",
      modeHint: "auto",
    });

    expect(resolved.queryText).toBe("");
    expect(resolved.reason).toBe("ambient_transcript_no_question");
  });

  it("keeps short supported user questions intact", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "刚才讨论的重点是什么？",
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(false);
    expect(resolved.queryText).toBe("刚才讨论的重点是什么？");
  });

  it("keeps short recent-event questions intact", () => {
    const happened = resolveAssistantQueryText({
      queryText: "刚才发生了什么？",
      modeHint: "auto",
    });
    const saw = resolveAssistantQueryText({
      queryText: "刚刚看到了什么？",
      modeHint: "auto",
    });

    expect(happened.replaced).toBe(false);
    expect(happened.queryText).toBe("刚才发生了什么？");
    expect(saw.replaced).toBe(false);
    expect(saw.queryText).toBe("刚刚看到了什么？");
  });

  it("keeps natural longer-range user questions intact", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "过去4个小时我们聊了什么？",
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(false);
    expect(resolved.queryText).toBe("过去4个小时我们聊了什么？");
  });

  it("expands truncated time-range voice queries instead of dropping them", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "过去四小时",
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(true);
    expect(resolved.rawQueryText).toBe("过去四小时");
    expect(resolved.queryText).toBe("过去四小时我们聊了什么？");
    expect(resolved.reason).toBeUndefined();
  });

  it("expands bare voice recall questions when ASR drops the time range", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "我们聊了什么？",
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(true);
    expect(resolved.rawQueryText).toBe("我们聊了什么？");
    expect(resolved.queryText).toBe("过去4个小时我们聊了什么？");
    expect(resolved.reason).toBeUndefined();
  });

  it("keeps yesterday overview questions intact", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "请问昨天发生了什么？",
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(false);
    expect(resolved.queryText).toBe("请问昨天发生了什么？");
  });

  it("keeps concise English smoke-test questions intact", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "what happened in the last five minutes",
      modeHint: "auto",
    });

    expect(resolved.replaced).toBe(false);
    expect(resolved.queryText).toBe("what happened in the last five minutes");
  });

  it("keeps concise summarization commands intact", () => {
    const resolved = resolveAssistantQueryText({
      queryText: "总结一下",
      modeHint: "meeting",
    });

    expect(resolved.replaced).toBe(false);
    expect(resolved.queryText).toBe("总结一下");
  });

  it("normalizes short voice-control ASR aliases", () => {
    const readFull = resolveAssistantQueryText({
      queryText: "朱全文",
      modeHint: "auto",
    });
    const shorten = resolveAssistantQueryText({
      queryText: "间短点",
      modeHint: "auto",
    });

    expect(readFull.queryText).toBe("读全文");
    expect(readFull.rawQueryText).toBe("朱全文");
    expect(readFull.replaced).toBe(true);
    expect(shouldUseDeterministicAssistantAnswer(readFull.queryText)).toBe(true);
    expect(shorten.queryText).toBe("简短点");
    expect(shouldUseDeterministicAssistantAnswer(shorten.queryText)).toBe(false);
  });
});

function createAssistantContextPayload(overrides: Record<string, unknown> = {}) {
  return {
    scope: "custom-range",
    date: "2026-04-24",
    startAt: new Date("2026-04-24T15:29:00+08:00").getTime(),
    endAt: new Date("2026-04-24T15:30:00+08:00").getTime(),
    counts: { events: 3, windows: 1, artifacts: 2, devices: 1 },
    summary: "最近一分钟里在会议室里讨论了报价单和测试安排。",
    recentActivity: {
      lookbackDays: 7,
      priorEventCount: 0,
      priorWindowCount: 0,
      priorActiveDays: 0,
      sampleWindows: [],
    },
    review: undefined,
    consolidation: undefined,
    windows: [
      {
        windowId: "window-1",
        deviceId: "device-1",
        startedAt: new Date("2026-04-24T15:29:05+08:00").getTime(),
        endedAt: new Date("2026-04-24T15:29:55+08:00").getTime(),
        primarySummary: "会议室大屏上展示着报价单和测试排期。",
        transcriptText: "Amy 说，明天先把报价单发出去，然后下午再确认测试排期。",
        imageCount: 1,
        videoCount: 0,
        audioCount: 1,
        captureContexts: ["audio-window", "active-window"],
        peopleRefs: ["person_amy"],
        projectRefs: ["quote_followup"],
        tags: ["office"],
        events: [
          {
            eventId: "audio-1",
            modality: "audio",
            capturedAt: new Date("2026-04-24T15:29:30+08:00").getTime(),
            summary: "讨论报价单发送与测试排期",
            transcript: "Amy 说，明天先把报价单发出去，然后下午再确认测试排期。",
            note: "csAudio:v2",
            captureContext: "audio-window",
            analysisMode: "runtime-stt",
            analysisProvider: "runtime",
            analysisStatus: "succeeded",
            analysisFailureReason: undefined,
            artifact: {
              artifactId: "artifact-audio-1",
              fileName: "capture.wav",
              mime: "audio/wav",
              available: true,
              sizeBytes: 123,
              url: "/api/clawsense/artifacts?id=artifact-audio-1",
            },
          },
          {
            eventId: "image-1",
            modality: "image",
            capturedAt: new Date("2026-04-24T15:29:35+08:00").getTime(),
            summary: "会议室大屏上展示着报价单和测试排期。",
            transcript: undefined,
            note: "active-window",
            captureContext: "active-window",
            analysisMode: "multimodal-preview",
            analysisProvider: "primary",
            analysisStatus: "succeeded",
            analysisFailureReason: undefined,
            artifact: {
              artifactId: "artifact-image-1",
              fileName: "snapshot.jpg",
              mime: "image/jpeg",
              available: true,
              sizeBytes: 456,
              url: "/api/clawsense/artifacts?id=artifact-image-1",
            },
          },
        ],
      },
    ],
    highlights: {
      keyWindowIds: ["window-1"],
      audioCoverage: {
        totalAudioWindows: 1,
        transcriptReadyWindows: 1,
        pendingAudioWindows: 0,
        degradedAudioEvents: 0,
      },
      recentImages: [],
      recentConversations: [],
      people: [
        {
          personRef: "person_amy",
          displayName: "Amy",
          relationship: "老板",
          nextWatchFor: "确认报价单今天是否发出。",
        },
      ],
      speakers: [
        {
          speakerRef: "speaker_1",
          displayName: "Amy",
          relationship: "老板",
          windowId: "window-1",
          deviceId: "device-1",
        },
      ],
    },
    ...overrides,
  };
}

function createRecentContext() {
  return {
    windowHint: "last_60s" as const,
    modeUsed: "meeting" as const,
    timeRange: {
      startAt: 1,
      endAt: 2,
      label: "15:29-15:30",
    },
    sceneSummary: "会议室大屏上展示着报价单和测试排期。",
    recentTranscriptSpans: [
      {
        windowId: "window-1",
        eventId: "audio-1",
        capturedAt: 1,
        time: "15:29",
        text: "Amy 说，明天先把报价单发出去，然后下午再确认测试排期。",
        artifactUrl: "/api/clawsense/artifacts?id=artifact-audio-1",
      },
    ],
    peopleHints: [
      {
        kind: "person" as const,
        ref: "person_amy",
        displayName: "Amy",
        relationship: "老板",
      },
    ],
    attentionHints: [
      "待跟进：明天先把报价单发出去，然后下午再确认测试排期。",
      "Amy：确认报价单今天是否发出。",
    ],
    taskHints: [
      "明天先把报价单发出去，然后下午再确认测试排期。",
    ],
    topEvidence: [
      {
        windowId: "window-1",
        timeRange: "15:29-15:30",
        summary: "会议室大屏上展示着报价单和测试排期。",
        transcriptExcerpt: "Amy 说，明天先把报价单发出去，然后下午再确认测试排期。",
        artifactUrls: [
          "/api/clawsense/artifacts?id=artifact-image-1",
          "/api/clawsense/artifacts?id=artifact-audio-1",
        ],
        people: ["Amy"],
      },
    ],
    counts: {
      windows: 1,
      events: 2,
      transcriptSpans: 1,
      audioEvents: 1,
      pendingAudioWindows: 0,
    },
  };
}

function createYesterdayReviewContextPayload() {
  return {
    scope: "today",
    date: "2026-05-11",
    counts: { events: 490, windows: 22, artifacts: 490, devices: 1 },
    summary: "当天主要讨论了数据看板指标优化、大促缺货复盘及毛利率计算问题，同时观看了关于 AI 行业趋势的视频。",
    review: {
      reviewId: "review-yesterday",
      date: "2026-05-11",
      generatedAt: new Date("2026-05-12T00:10:00+08:00").getTime(),
      sourceWindowIds: ["window-1"],
      summary: "当天主要讨论了数据看板指标优化、大促缺货复盘及毛利率计算问题，同时观看了关于 AI 行业趋势的视频。",
      sections: [
        {
          title: "Today at a glance",
          items: ["数据看板指标优化、大促缺货复盘和毛利率计算是主要工作线。"],
        },
        {
          title: "时间线回顾",
          items: ["18:55-19:14 讨论前海 APP push、复旦数据推送和节点故障处理。"],
        },
      ],
      keyWindowIds: ["window-1"],
    },
    highlights: {
      ...createAssistantContextPayload().highlights,
      audioCoverage: {
        totalAudioWindows: 21,
        transcriptReadyWindows: 19,
        pendingAudioWindows: 2,
        degradedAudioEvents: 13,
      },
    },
  };
}

function createYesterdayRecentContext() {
  return {
    ...createRecentContext(),
    windowHint: "custom" as const,
    timeRange: {
      startAt: new Date("2026-05-11T00:00:00+08:00").getTime(),
      endAt: new Date("2026-05-12T00:00:00+08:00").getTime(),
      label: "2026-05-11 全天",
    },
    overview: {
      kind: "day" as const,
      date: "2026-05-11",
      summary: "当天主要讨论了数据看板指标优化、大促缺货复盘及毛利率计算问题，同时观看了关于 AI 行业趋势的视频。",
      counts: { events: 490, windows: 22, artifacts: 490, devices: 1 },
      audioCoverage: {
        totalAudioWindows: 21,
        transcriptReadyWindows: 19,
        pendingAudioWindows: 2,
        degradedAudioEvents: 13,
      },
      reviewItems: [
        "Today at a glance：数据看板指标优化、大促缺货复盘和毛利率计算是主要工作线。",
        "时间线回顾：18:55-19:14 讨论前海 APP push、复旦数据推送和节点故障处理。",
      ],
      keyWindowSummaries: [],
    },
  };
}

function createCustomRangeRecentContext() {
  return {
    ...createRecentContext(),
    windowHint: "custom" as const,
    timeRange: {
      startAt: new Date("2026-05-14T17:20:00+08:00").getTime(),
      endAt: new Date("2026-05-14T21:20:00+08:00").getTime(),
      label: "17:20-21:20",
    },
    overview: {
      kind: "custom" as const,
      date: "2026-05-14",
      summary: "过去四小时主要讨论了智能来源、工作流调试和收尾闲聊。",
      counts: { events: 167, windows: 12, artifacts: 167, devices: 1 },
      audioCoverage: {
        totalAudioWindows: 12,
        transcriptReadyWindows: 11,
        pendingAudioWindows: 1,
        degradedAudioEvents: 21,
      },
      reviewItems: [],
      keyWindowSummaries: [
        "20:49-20:52：讨论智能来源和社会规则。",
        "20:57-21:02：讨论验证 Agent 和上传调试。",
      ],
    },
  };
}

function createDeskRecentContext() {
  return {
    windowHint: "last_60s" as const,
    modeUsed: "desk" as const,
    timeRange: {
      startAt: 1,
      endAt: 2,
      label: "10:01-10:02",
    },
    sceneSummary: "工位旁有人站在显示器边，桌面上有打开的笔记本电脑。",
    recentTranscriptSpans: [
      {
        windowId: "desk-window-1",
        eventId: "desk-audio-1",
        capturedAt: 1,
        time: "10:01",
        text: "李三说，等你回来帮我确认一下合同版本。",
        artifactUrl: "/api/clawsense/artifacts?id=desk-audio-1",
      },
    ],
    peopleHints: [
      {
        kind: "person" as const,
        ref: "person_lisan",
        displayName: "李三",
        relationship: "同事",
      },
    ],
    attentionHints: [
      "待跟进：等你回来帮我确认一下合同版本。",
    ],
    taskHints: [
      "等你回来帮我确认一下合同版本。",
    ],
    topEvidence: [
      {
        windowId: "desk-window-1",
        timeRange: "10:01-10:02",
        summary: "工位旁有人站在显示器边，像是在找你沟通事情。",
        transcriptExcerpt: "李三说，等你回来帮我确认一下合同版本。",
        artifactUrls: [
          "/api/clawsense/artifacts?id=desk-image-1",
          "/api/clawsense/artifacts?id=desk-audio-1",
        ],
        people: ["李三"],
      },
    ],
    counts: {
      windows: 1,
      events: 2,
      transcriptSpans: 1,
      audioEvents: 1,
      pendingAudioWindows: 0,
    },
  };
}
