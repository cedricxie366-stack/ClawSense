import { describe, expect, it, vi } from "vitest";
import {
  buildClawSenseContextToolText,
  createClawSenseAnnotatePersonTool,
  createClawSenseAnnotateSpeakerTool,
  createClawSenseContextTool,
  resolveClawSenseContext,
} from "../src/assistant-tool.js";

describe("ClawSense assistant tool", () => {
  it("renders a watch-for answer from review sections", async () => {
    const payload = createPayload();
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-1", {
      scope: "today",
      focus: "watch_for",
    });

    expect(result.content[0]?.text).toContain("现在值得注意：");
    expect(result.content[0]?.text).toContain("今天遗漏但值得追问的点");
    expect(result.content[0]?.text).toContain("明天先确认演示截图顺序");
    expect((result.details as any).review.sections).toHaveLength(7);
  });

  it("makes all-day answers use coverage and daily review before sparse windows", () => {
    const text = buildClawSenseContextToolText(
      createPayload({
        counts: { events: 490, windows: 22, artifacts: 490, devices: 1 },
        highlights: {
          ...createPayload().highlights,
          audioCoverage: {
            totalAudioWindows: 21,
            transcriptReadyWindows: 20,
            pendingAudioWindows: 1,
            degradedAudioEvents: 13,
          },
        },
      }),
      "what_happened",
      "昨天发生了什么事情？",
    );

    expect(text).toContain("素材覆盖：490 条事件 / 22 个时间窗 / 490 个媒体文件 / 1 台设备。");
    expect(text).toContain("音频覆盖：20/21 个音频窗口已有可引用转写");
    expect(text).toContain("整天/昨天类问题规则");
    expect(text).toContain("日级回顾（回答整天/昨天问题时优先使用）：");
    expect(text).toContain("今天主要在准备明天的产品演示。");
  });

  it("surfaces raw audio retention boundaries in context evidence", async () => {
    const base = createPayload();
    const audioWindow = (base.windows as any[])[0];
    const audioEvent = audioWindow.events[0];
    const payload = createPayload({
      windows: [
        {
          ...audioWindow,
          events: [
            {
              ...audioEvent,
              artifact: {
                ...audioEvent.artifact,
                available: false,
              },
            },
          ],
        },
      ],
    });
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-audio-diagnostics", {
      scope: "today",
      question: "昨天发生了什么？",
    });

    expect(result.content[0]?.text).toContain("音频诊断：");
    expect(result.content[0]?.text).toContain("原始音频已被 retention 清理");
    expect(result.content[0]?.text).toContain("不能直接补跑本地 ASR / diarization");
    expect(result.content[0]?.text).not.toContain("原始音频：http://claw/api/clawsense/artifacts?id=audio-clip-1");
    expect((result.details as any).evidenceBundle.audioDiagnostics.verdict.rawAudioArtifacts).toBe("deleted");
    expect((result.details as any).responseHints.audioDiagnostics.blockerIds).toEqual(
      expect.arrayContaining(["raw-audio-retention-deleted", "diarization-not-runnable"]),
    );
    expect((result.details as any).evidenceBundle.artifactRefs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "audio-clip-1",
        }),
      ]),
    );
  });

  it("falls back to recent highlights when no daily review exists", () => {
    const text = buildClawSenseContextToolText(
      createPayload({
        scope: "last-hour",
        summary: "过去一小时主要是在准备演示和确认截图顺序。",
        review: undefined,
      }),
      "what_happened",
    );

    expect(text).toContain("最近的对话线索：");
    expect(text).toContain("讨论明天演示的开场和截图顺序");
    expect(text).toContain("最近值得回看的图片：");
  });

  it("adds last-seen activity hints when the current day has no new events", () => {
    const text = buildClawSenseContextToolText(
      createPayload({
        counts: { events: 0, windows: 0, artifacts: 0, devices: 0 },
        windows: [],
        summary: "ClawSense 在 2026-03-19 还没有采集到可用于回顾的事件。",
        recentActivity: {
          lookbackDays: 7,
          priorEventCount: 9,
          priorWindowCount: 4,
          priorActiveDays: 2,
          lastSeenAt: new Date("2026-03-18T22:10:00+08:00").getTime(),
          lastSeenDate: "2026-03-18",
          sampleWindows: [
            {
              windowId: "audio-session::history-1",
              startedAt: new Date("2026-03-18T21:58:00+08:00").getTime(),
              endedAt: new Date("2026-03-18T22:10:00+08:00").getTime(),
              timeRange: "2026-03-18 21:58-22:10",
              summary: "昨晚在确认演示截图顺序。",
              audioCount: 2,
              imageCount: 1,
              videoCount: 0,
            },
          ],
        },
      }),
      "what_happened",
    );

    expect(text).toContain("最近一次有效记录：");
    expect(text).toContain("过去 7 天累计 4 个窗口 / 9 条事件");
    expect(text).toContain("最近历史窗口（便于继续追问）：");
    expect(text).toContain("昨晚在确认演示截图顺序。");
  });

  it("surfaces recentActivity in tool details evidence bundle", async () => {
    const payload = createPayload({
      counts: { events: 0, windows: 0, artifacts: 0, devices: 0 },
      windows: [],
      recentActivity: {
        lookbackDays: 7,
        priorEventCount: 9,
        priorWindowCount: 4,
        priorActiveDays: 2,
        lastSeenAt: new Date("2026-03-18T22:10:00+08:00").getTime(),
        lastSeenDate: "2026-03-18",
        sampleWindows: [],
      },
    });
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-recent-activity", {
      scope: "today",
      focus: "what_happened",
    });

    expect((result.details as any).evidenceBundle.recentActivity.priorEventCount).toBe(9);
    expect((result.details as any).evidenceBundle.recentActivity.priorWindowCount).toBe(4);
    expect((result.details as any).evidenceBundle.gaps[0]).toContain("最近一次有效记录");
  });

  it("includes consolidation outputs when available", async () => {
    const payload = createPayload({
      consolidation: {
        consolidationId: "consolidation-1",
        date: "2026-03-19",
        generatedAt: 1,
        sourceReviewId: "review-1",
        summary: "今天的主线是推进演示准备。",
        keyInsights: ["下午明确了演示顺序。"],
        tasks: ["明早先确认演示截图顺序。"],
        attentionItems: ["仍需确认同事负责的片段。"],
        learningPoints: [],
        keyWindowIds: ["audio-session::1"],
        people: [],
        projects: [],
        stats: {
          windowCount: 1,
          eventCount: 1,
          audioWindowCount: 1,
          transcriptReadyWindows: 1,
          imageCount: 1,
          audioCount: 1,
          degradedEventCount: 0,
        },
      },
    });
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-consolidation", {
      scope: "today",
      focus: "what_happened",
    });

    expect(result.content[0]?.text).toContain("日级 consolidation：");
    expect(result.content[0]?.text).toContain("今日任务候选");
    expect((result.details as any).consolidation?.summary).toContain("推进演示准备");
  });

  it("writes person annotations back in a chat-friendly format", async () => {
    const annotatePerson = vi.fn(async (params) => ({
      annotationId: "ann-1",
      personRef: params.personRef,
      displayName: params.displayName,
      relationship: params.relationship,
      notes: params.notes,
      nextWatchFor: params.nextWatchFor,
      eventIds: params.eventIds ?? [],
      createdAt: 1,
      updatedAt: 1,
    }));
    const tool = createClawSenseAnnotatePersonTool({
      reviewEngine: {
        annotatePerson,
      } as any,
    });

    const result = await tool.execute("tool-2", {
      personRef: "person_li",
      displayName: "小李",
      relationship: "同事",
      nextWatchFor: "确认他负责的演示片段是否已经定稿。",
    });

    expect(annotatePerson).toHaveBeenCalledWith({
      personRef: "person_li",
      displayName: "小李",
      relationship: "同事",
      notes: undefined,
      nextWatchFor: "确认他负责的演示片段是否已经定稿。",
      eventIds: undefined,
    });
    expect(result.content[0]?.text).toContain("已写入 ClawSense 人物标注：小李");
    expect(result.content[0]?.text).toContain("下次留意：确认他负责的演示片段是否已经定稿。");
  });

  it("infers a concrete date from natural-language cross-day questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00+08:00"));
    const payload = createPayload({
      date: "2026-03-31",
      summary: "昨天有一段办公相关记录。",
    });
    const normalizeDateInput = vi.fn((input?: string) => input ?? "2026-04-01");
    const buildAssistantContext = vi.fn(async () => payload);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput,
        buildAssistantContext,
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-yesterday", {
      question: "昨天发生了什么？",
      focus: "what_happened",
    });

    expect(normalizeDateInput).toHaveBeenCalledWith("2026-03-31");
    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "today",
        date: "2026-03-31",
      }),
    );
    expect(result.content[0]?.text).toContain("ClawSense 2026-03-31 这一天证据包");
    vi.useRealTimers();
  });

  it("infers month-day questions without requiring explicit tool params", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T09:00:00+08:00"));
    const payload = createPayload({
      date: "2026-06-25",
      summary: "6 月 25 日记录到一次会议和一段访谈视频。",
    });
    const normalizeDateInput = vi.fn((input?: string) => input ?? "2026-06-30");
    const buildAssistantContext = vi.fn(async () => payload);

    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput,
          buildAssistantContext,
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      {
        question: "6月25日发生了什么？",
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.focus).toBe("what_happened");
    expect(normalizeDateInput).toHaveBeenCalledWith("2026-06-25");
    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "today",
        date: "2026-06-25",
        question: "6月25日发生了什么？",
      }),
    );
    expect(resolved.text).toContain("ClawSense 2026-06-25 这一天证据包");
    vi.useRealTimers();
  });

  it("infers spaced month-day questions without requiring explicit tool params", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T09:00:00+08:00"));
    const payload = createPayload({
      date: "2026-06-25",
      summary: "6 月 25 日记录到一次会议和一段访谈视频。",
    });
    const normalizeDateInput = vi.fn((input?: string) => input ?? "2026-06-30");
    const buildAssistantContext = vi.fn(async () => payload);

    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput,
          buildAssistantContext,
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      {
        question: "请问 6 月 25 日会议里发生了什么？",
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(normalizeDateInput).toHaveBeenCalledWith("2026-06-25");
    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "today",
        date: "2026-06-25",
        question: "请问 6 月 25 日会议里发生了什么？",
      }),
    );
    vi.useRealTimers();
  });

  it("infers anchored past-hour windows from natural-language questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T09:00:00+08:00"));
    const startAt = new Date("2026-06-25T07:16:00+08:00").getTime();
    const endAt = new Date("2026-06-25T11:16:00+08:00").getTime();
    const payload = createPayload({
      scope: "custom-range",
      startAt,
      endAt,
      summary: "这个 4 小时窗口里有多段会议音频。",
    });
    const buildAssistantContext = vi.fn(async () => payload);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-06-30"),
        buildAssistantContext,
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-anchored-4h", {
      question: "以 2026-06-25 11:16 为结束时间，之前4小时我们聊了什么？",
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "custom-range",
        startAt,
        endAt,
        question: "以 2026-06-25 11:16 为结束时间，之前4小时我们聊了什么？",
      }),
    );
    expect(result.content[0]?.text).toContain("音频转写证据（对话/会议/过去几小时类问题优先引用）：");
    vi.useRealTimers();
  });

  it("keeps more transcript windows and range boundaries for broad conversation questions", async () => {
    const base = createPayload();
    const startAt = new Date("2026-06-25T08:00:00+08:00").getTime();
    const windows = Array.from({ length: 9 }, (_, index) => {
      const startedAt = startAt + index * 25 * 60_000;
      const endedAt = startedAt + 8 * 60_000;
      const windowId = `audio-session::range-window-${index + 1}`;
      return {
        ...base.windows[0],
        windowId,
        startedAt,
        endedAt,
        primarySummary: `第 ${index + 1} 段会议窗口`,
        transcriptText:
          index === 0
            ? "第1段讨论会议开头的数据口径和指标定义。"
            : index === 8
              ? "第9段讨论会议收尾的行动项和明天跟进人。"
              : `第${index + 1}段讨论项目排期和风险处理。`,
        imageCount: 0,
        audioCount: 1,
        events: [
          {
            ...base.windows[0].events[0],
            eventId: `range-audio-${index + 1}`,
            capturedAt: startedAt,
            transcript:
              index === 0
                ? "第1段讨论会议开头的数据口径和指标定义。"
                : index === 8
                  ? "第9段讨论会议收尾的行动项和明天跟进人。"
                  : `第${index + 1}段讨论项目排期和风险处理。`,
          },
        ],
      };
    });
    const payload = createPayload({
      scope: "custom-range",
      startAt,
      endAt: startAt + 4 * 60 * 60_000,
      windows,
      highlights: {
        ...base.highlights,
        keyWindowIds: [],
        recentImages: [],
        audioCoverage: {
          totalAudioWindows: 9,
          transcriptReadyWindows: 9,
          pendingAudioWindows: 0,
          degradedAudioEvents: 0,
        },
      },
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question: "过去4小时我们聊了什么，行动项和明天跟进人是什么？" },
    );

    const selectedWindowIds = resolved.details.evidenceBundle.windows.map((window) => window.windowId);
    expect(selectedWindowIds).toHaveLength(8);
    expect(selectedWindowIds).toContain("audio-session::range-window-1");
    expect(selectedWindowIds).toContain("audio-session::range-window-9");
    expect(resolved.details.evidenceBundle.conversationDigest?.coverage.windowCount).toBe(9);
    expect(resolved.details.evidenceBundle.conversationDigest?.coverage.topicSegmentCount).toBeGreaterThanOrEqual(9);
    expect(resolved.details.evidenceBundle.conversationDigest?.topicIndex[0]).toEqual(
      expect.objectContaining({
        index: 1,
        title: expect.any(String),
        summary: expect.any(String),
      }),
    );
    expect((resolved.details.responseHints as any).conversationDigest.followupPrompts[0]).toContain("第 1 段");
    expect((resolved.details.responseHints as any).conversationDigest.queryMatches[0]).toEqual(
      expect.objectContaining({
        index: 9,
        matchedTerms: expect.arrayContaining(["行动项", "跟进"]),
      }),
    );
    expect(resolved.text).toContain("第1段讨论会议开头的数据口径");
    expect(resolved.text).toContain("第9段讨论会议收尾的行动项");
    expect(resolved.text).toContain("长对话索引");
    expect(resolved.text).toContain("与当前问题最相关的话题段");
  });

  it("surfaces persisted rolling digests as a reusable long-conversation index", async () => {
    const payload = createPayload({
      rollingDigests: [
        {
          digestId: "digest-fixture",
          date: "2026-06-25",
          scope: "custom-range",
          startAt: new Date("2026-06-25T09:00:00+08:00").getTime(),
          endAt: new Date("2026-06-25T12:00:00+08:00").getTime(),
          generatedAt: new Date("2026-06-25T12:00:00+08:00").getTime(),
          sourceEventCount: 24,
          sourceWindowCount: 3,
          transcriptWindowCount: 3,
          summary: "2026-06-25 09:00-12:00 持久化索引：3 个窗口，3 个含转写窗口，3 个可检索话题。",
          topicIndex: [
            {
              index: 1,
              windowId: "audio-session::rolling-1",
              timeRange: "09:58-10:15",
              title: "AI 陪练与剧本",
              summary: "讨论 AI 陪练剧本生成。",
              keywordHints: ["AI陪练", "剧本"],
              taskHints: ["产品团队需要确认语料同步方案。"],
              transcriptExcerpt: "AI陪练可以根据文本生成剧本。",
            },
          ],
          keywordIndex: [
            {
              keyword: "AI陪练",
              topicIndexes: [1],
            },
          ],
        },
      ],
      memoryCards: [
        {
          cardId: "memcard-fixture-task",
          date: "2026-06-25",
          scope: "custom-range",
          kind: "task",
          title: "产品团队需要确认语料同步方案",
          summary: "任务线索来自第 1 段（09:58-10:15）：产品团队需要确认语料同步方案。",
          status: "active",
          confidence: "medium",
          startAt: new Date("2026-06-25T09:00:00+08:00").getTime(),
          endAt: new Date("2026-06-25T12:00:00+08:00").getTime(),
          lastSeenAt: new Date("2026-06-25T12:00:00+08:00").getTime(),
          createdAt: new Date("2026-06-25T12:00:00+08:00").getTime(),
          updatedAt: new Date("2026-06-25T12:00:00+08:00").getTime(),
          keywords: ["任务", "AI陪练", "语料"],
          source: "rolling-digest",
          evidence: {
            digestId: "digest-fixture",
            topicIndexes: [1],
            windowIds: ["audio-session::rolling-1"],
            timeRanges: ["09:58-10:15"],
            taskHints: ["产品团队需要确认语料同步方案。"],
            transcriptExcerpts: ["AI陪练可以根据文本生成剧本。"],
          },
        },
      ],
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question: "6 月 25 日上午 AI 陪练和语料同步任务讲了什么？" },
    );

    expect(resolved.text).toContain("持久化长对话索引");
    expect(resolved.text).toContain("与当前问题最相关的持久索引段");
    expect(resolved.text).toContain("AI 陪练与剧本");
    expect(resolved.text).toContain("持久关键词索引");
    expect(resolved.text).toContain("长期记忆卡片");
    expect(resolved.text).toContain("产品团队需要确认语料同步方案");
    expect(resolved.text).toContain("排序理由");
    expect((resolved.details.responseHints as any).rollingDigestMatches[0]).toEqual(
      expect.objectContaining({
        digestId: "digest-fixture",
        title: "AI 陪练与剧本",
        matchedTerms: expect.arrayContaining(["陪练"]),
        taskHints: expect.arrayContaining(["产品团队需要确认语料同步方案。"]),
      }),
    );
    expect((resolved.details.responseHints as any).rollingDigests[0]).toEqual(
      expect.objectContaining({
        digestId: "digest-fixture",
        topicIndex: expect.arrayContaining([
          expect.objectContaining({
            title: "AI 陪练与剧本",
          }),
        ]),
      }),
    );
    expect((resolved.details.responseHints as any).memoryCardMatches[0]).toEqual(
      expect.objectContaining({
        cardId: "memcard-fixture-task",
        kind: "task",
        matchedTerms: expect.arrayContaining(["陪练", "语料"]),
        matchReasons: expect.arrayContaining(["keyword-match", "task-intent", "task-evidence"]),
        retrievalRank: 1,
        score: expect.any(Number),
      }),
    );
  });

  it("ranks memory cards by intent before embeddings are available", async () => {
    const startAt = new Date("2026-06-25T09:00:00+08:00").getTime();
    const endAt = new Date("2026-06-25T12:00:00+08:00").getTime();
    const payload = createPayload({
      scope: "custom-range",
      startAt,
      endAt,
      memoryCards: [
        {
          cardId: "memcard-topic-only",
          date: "2026-06-25",
          scope: "custom-range",
          kind: "topic",
          title: "AI 陪练整体演示",
          summary: "话题索引第 1 段：讨论系统演示流程。",
          status: "active",
          confidence: "medium",
          startAt,
          endAt,
          lastSeenAt: endAt,
          createdAt: endAt,
          updatedAt: endAt,
          keywords: ["演示"],
          source: "rolling-digest",
          evidence: {
            digestId: "digest-intent",
            topicIndexes: [1],
            windowIds: ["audio-session::intent-1"],
            timeRanges: ["09:58-10:15"],
            taskHints: [],
            transcriptExcerpts: ["这里主要演示系统流程。"],
          },
        },
        {
          cardId: "memcard-task-intent",
          date: "2026-06-25",
          scope: "custom-range",
          kind: "task",
          title: "产品团队确认语料同步方案",
          summary: "任务线索来自第 2 段：产品团队确认语料同步方案。",
          status: "active",
          confidence: "medium",
          startAt,
          endAt,
          lastSeenAt: endAt - 1,
          createdAt: endAt,
          updatedAt: endAt,
          keywords: ["语料", "同步"],
          source: "rolling-digest",
          evidence: {
            digestId: "digest-intent",
            topicIndexes: [2],
            windowIds: ["audio-session::intent-2"],
            timeRanges: ["10:15-10:30"],
            taskHints: ["产品团队确认语料同步方案。"],
            transcriptExcerpts: ["后续产品团队要确认语料同步方案。"],
          },
        },
      ],
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question: "今天有哪些待办需要我后续处理？" },
    );

    const matches = (resolved.details.responseHints as any).memoryCardMatches;
    expect(matches[0]).toEqual(
      expect.objectContaining({
        cardId: "memcard-task-intent",
        kind: "task",
        retrievalRank: 1,
        matchReasons: expect.arrayContaining(["task-intent", "task-evidence", "transcript-evidence"]),
      }),
    );
    expect(resolved.text).toContain("#1 score=");
    expect(resolved.text).toContain("排序理由：task-intent");
  });

  it("infers a custom 7-day range from natural-language questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T10:00:00+08:00"));
    const payload = createPayload({
      scope: "custom-range",
      startAt: new Date("2026-04-08T00:00:00+08:00").getTime(),
      endAt: new Date("2026-04-14T10:00:00+08:00").getTime(),
      summary: "最近 7 天里有多段会议与课堂记录。",
    });
    const buildAssistantContext = vi.fn(async () => payload);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-04-14"),
        buildAssistantContext,
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    await tool.execute("tool-7d", {
      question: "最近7天都发生了什么？",
      focus: "what_happened",
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "custom-range",
        startAt: new Date("2026-04-08T00:00:00+08:00").getTime(),
        endAt: new Date("2026-04-14T10:00:00+08:00").getTime(),
      }),
    );
    vi.useRealTimers();
  });

  it("prioritizes transcript windows over high-volume image windows for meeting questions", async () => {
    const imageWindow = {
      ...createPayload().windows[0],
      windowId: "image-window::static",
      startedAt: 1000,
      endedAt: 2000,
      primarySummary: "屏幕静态画面显示一张访谈视频截图。",
      transcriptText: "",
      imageCount: 260,
      audioCount: 0,
      videoCount: 0,
      tags: ["video"],
      events: [
        {
          eventId: "image-static-1",
          modality: "image",
          capturedAt: 1000,
          summary: "访谈视频截图里能看到主讲人和字幕。",
          captureContext: "active-window",
          analysisMode: "multimodal-preview",
          analysisProvider: "primary-multimodal:runtime-primary",
          analysisStatus: "succeeded",
        },
      ],
    };
    const audioWindow = {
      ...createPayload().windows[0],
      windowId: "audio-session::meeting",
      startedAt: 3000,
      endedAt: 4000,
      primarySummary: "讨论数据同步复盘和下一步排查计划。",
      transcriptText: "我们刚才重点讨论了数据同步失败的复盘、排查 owner，以及明天先补告警看板。",
      imageCount: 1,
      audioCount: 2,
      videoCount: 0,
      tags: ["meeting"],
      events: [
        {
          ...createPayload().windows[0].events[0],
          eventId: "audio-meeting-1",
          capturedAt: 3000,
          summary: "讨论数据同步复盘和下一步排查计划。",
          transcript: "我们刚才重点讨论了数据同步失败的复盘、排查 owner，以及明天先补告警看板。",
        },
      ],
    };
    const payload = createPayload({
      windows: [imageWindow, audioWindow],
      highlights: {
        ...createPayload().highlights,
        keyWindowIds: ["image-window::static"],
        recentImages: [],
        recentConversations: [
          {
            windowId: "audio-session::meeting",
            startedAt: 3000,
            endedAt: 4000,
            summary: "讨论数据同步复盘和下一步排查计划。",
            transcriptExcerpt: "我们刚才重点讨论了数据同步失败的复盘、排查 owner，以及明天先补告警看板。",
          },
        ],
      },
    });
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-meeting-priority", {
      question: "刚才会议讨论的重点是什么？",
    });

    expect((result.details as any).evidenceBundle.windows[0].windowId).toBe("audio-session::meeting");
    expect((result.details as any).evidenceBundle.topEvidence[0].kind).toBe("transcript");
    expect(result.content[0]?.text).toContain("对话优先说明");
    expect(result.content[0]?.text).toContain("原始聚合总览（对话问题仅作背景）");
    expect(result.content[0]?.text).toContain("我们刚才重点讨论了数据同步失败的复盘");
  });

  it("builds topic segments and conservative task attribution for long meeting audio", async () => {
    const base = createPayload();
    const startedAt = new Date("2026-06-25T09:58:00+08:00").getTime();
    const audioWindow = {
      ...base.windows[0],
      windowId: "audio-session::long-meeting",
      startedAt,
      endedAt: startedAt + 16 * 60 * 1000,
      primarySummary: "讨论 AI 陪练系统、数据同步、考核报表和培训安排。",
      transcriptText: [
        "我们离线数据好像放在阿里云这边，产品团队需要在7月30日前提供实时语料库同步方案。",
        "这个我问一下我们数仓吧，然后你们先把文字这块演示好。",
        "AI陪练可以根据文本文档自动生成剧本，也可以从通话会话明细导出语料。",
        "后面还要确认考核点通过率与缺陷项汇总逻辑，海南物流培训也要区分角色讲解工单流程。",
      ].join(" "),
      imageCount: 0,
      audioCount: 4,
      videoCount: 0,
      tags: ["meeting", "ai-training"],
      events: [
        {
          ...base.windows[0].events[0],
          eventId: "meeting-audio-1",
          capturedAt: startedAt,
          transcript: "我们离线数据好像放在阿里云这边，产品团队需要在7月30日前提供实时语料库同步方案。",
          summary: "讨论数据源与实时语料库同步方案。",
        },
        {
          ...base.windows[0].events[0],
          eventId: "meeting-audio-2",
          capturedAt: startedAt + 4 * 60 * 1000,
          transcript: "这个我问一下我们数仓吧，然后你们先把文字这块演示好。",
          summary: "讨论数仓确认与演示文字部分。",
        },
        {
          ...base.windows[0].events[0],
          eventId: "meeting-audio-3",
          capturedAt: startedAt + 9 * 60 * 1000,
          transcript: "AI陪练可以根据文本文档自动生成剧本，也可以从通话会话明细导出语料。",
          summary: "演示 AI 陪练剧本生成。",
        },
        {
          ...base.windows[0].events[0],
          eventId: "meeting-audio-4",
          capturedAt: startedAt + 14 * 60 * 1000,
          transcript: "后面还要确认考核点通过率与缺陷项汇总逻辑，海南物流培训也要区分角色讲解工单流程。",
          summary: "讨论考核报表和培训安排。",
        },
      ],
    };
    const payload = createPayload({
      date: "2026-06-25",
      startAt: new Date("2026-06-25T00:00:00+08:00").getTime(),
      endAt: new Date("2026-06-26T00:00:00+08:00").getTime(),
      counts: { events: 4, windows: 1, artifacts: 4, devices: 1 },
      summary: "当天主要围绕 AI 陪练系统的功能演示与优化需求讨论。",
      windows: [audioWindow],
      highlights: {
        ...base.highlights,
        keyWindowIds: ["audio-session::long-meeting"],
        recentImages: [],
        recentConversations: [
          {
            windowId: "audio-session::long-meeting",
            startedAt: audioWindow.startedAt,
            endedAt: audioWindow.endedAt,
            summary: audioWindow.primarySummary,
            transcriptExcerpt: audioWindow.transcriptText,
          },
        ],
        speakers: [
          {
            speakerRef: "speaker:audio-session::long-meeting:1",
            displayName: "speaker_1",
            windowId: "audio-session::long-meeting",
            deviceId: "device-1",
          },
          {
            speakerRef: "speaker:audio-session::long-meeting:2",
            displayName: "speaker_2",
            windowId: "audio-session::long-meeting",
            deviceId: "device-1",
          },
        ],
      },
    });
    const question = "6 月 25 日会议里，有哪些明确分配给我的任务？哪些只是别人提到但没有落到我身上的？";
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question },
    );

    expect(resolved.text).toContain("会议 / 长音频话题段");
    expect(resolved.text).toContain("任务归属候选");
    expect(resolved.details.evidenceBundle.topicSegments.length).toBeGreaterThanOrEqual(2);
    expect(resolved.details.evidenceBundle.topicSegments[0].keywordHints).toEqual(
      expect.arrayContaining(["数据", "阿里云"]),
    );
    expect(resolved.details.evidenceBundle.taskAttribution.status).toBe("needs-speaker-labels");
    expect(resolved.details.evidenceBundle.taskAttribution.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "named-assignee",
          assigneeHint: "产品团队",
          userAssignmentStatus: "not-user-unless-role-matches",
        }),
        expect.objectContaining({
          category: "speaker-dependent",
          assigneeHint: expect.stringMatching(/我|你们/),
          userAssignmentStatus: "needs-speaker-label",
        }),
      ]),
    );
    expect(resolved.details.evidenceBundle.taskAttribution.buckets.assignedToOthersOrTeams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assigneeHint: "产品团队",
          userAssignmentStatus: "not-user-unless-role-matches",
        }),
      ]),
    );
    expect(resolved.details.evidenceBundle.taskAttribution.buckets.needsSpeakerLabel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "speaker-dependent",
          userAssignmentStatus: "needs-speaker-label",
        }),
      ]),
    );
    expect(resolved.text).toContain("任务归属分桶");
    expect((resolved.details.responseHints as any).topicSegments.length).toBeGreaterThanOrEqual(2);
    expect((resolved.details.responseHints as any).conversationDigest.topicIndex.length).toBeGreaterThanOrEqual(2);
    expect((resolved.details.responseHints as any).conversationDigest.overview).toContain("可追问话题段");
    expect((resolved.details.responseHints as any).conversationDigest.taskMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userAssignmentStatus: "needs-speaker-label",
        }),
      ]),
    );
    expect((resolved.details.responseHints as any).taskAttribution.status).toBe("needs-speaker-labels");
    expect((resolved.details.responseHints as any).taskAttributionBuckets.needsSpeakerLabel.length).toBeGreaterThan(0);
    expect((resolved.details.responseHints as any).speakerResolutionPrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskCount: expect.any(Number),
          resolutionMode: expect.stringMatching(/exact-speaker-label|window-context-only/),
          requiresDiarization: expect.any(Boolean),
          selfSentenceTemplate: expect.stringContaining("我本人"),
          candidateSpeakerSlots: expect.any(Array),
        }),
      ]),
    );
    expect((resolved.details.responseHints as any).topicFollowUpTargets[0]).toEqual(
      expect.objectContaining({
        source: "topic",
        kind: "topic-segment",
        segmentId: resolved.details.evidenceBundle.topicSegments[0].segmentId,
        prompt: expect.stringContaining("第 1 段"),
      }),
    );
    expect((resolved.details.responseHints as any).evidenceFollowUpTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "topic",
          kind: "topic-segment",
          prompt: expect.stringContaining("具体讲了什么"),
        }),
      ]),
    );
    expect(resolved.text).toContain("长对话索引");
    expect(resolved.text).toContain("与当前问题相关的任务候选");
    expect(resolved.text).toContain("speaker 归属追问");
  });

  it("uses finer topic segmentation for dense meeting questions without changing the source window", async () => {
    const base = createPayload();
    const startedAt = new Date("2026-06-25T10:00:00+08:00").getTime();
    const windowId = "audio-session::dense-meeting";
    const events = Array.from({ length: 13 }, (_, index) => {
      const capturedAt = startedAt + index * 15_000;
      return {
        ...base.windows[0].events[0],
        eventId: `dense-meeting-audio-${index + 1}`,
        capturedAt,
        modality: "audio" as const,
        transcript:
          index < 6
            ? `第${index + 1}段讨论数据同步方案，需要确认接口字段。`
            : `第${index + 1}段讨论培训安排，我负责整理会议纪要。`,
        summary: "会议短句转写。",
      };
    });
    const payload = createPayload({
      scope: "today",
      date: "2026-06-25",
      windows: [
        {
          ...base.windows[0],
          windowId,
          startedAt,
          endedAt: startedAt + 3 * 60_000,
          primarySummary: "密集会议讨论数据同步和培训安排。",
          transcriptText: events.map((event) => event.transcript).join(" "),
          imageCount: 0,
          audioCount: events.length,
          events,
        },
      ],
      highlights: {
        ...base.highlights,
        keyWindowIds: [windowId],
        recentImages: [],
      },
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question: "刚才会议讨论的重点是什么？" },
    );

    expect(resolved.details.evidenceBundle.windows).toHaveLength(1);
    expect(resolved.details.evidenceBundle.topicSegments.length).toBeGreaterThanOrEqual(2);
    expect(new Set(resolved.details.evidenceBundle.topicSegments.map((segment) => segment.windowId))).toEqual(
      new Set([windowId]),
    );
    expect(resolved.text).toContain("会议 / 长音频话题段");
  });

  it("uses speaker-labeled transcript segments to avoid assigning another speaker's pronoun task to the user", async () => {
    const base = createPayload();
    const startedAt = new Date("2026-06-25T10:12:00+08:00").getTime();
    const endedAt = new Date("2026-06-25T10:13:00+08:00").getTime();
    const windowId = "audio-session::speaker-task";
    const payload = createPayload({
      scope: "today",
      date: "2026-06-25",
      windows: [
        {
          ...base.windows[0],
          windowId,
          startedAt,
          endedAt,
          primarySummary: "会议里确认培训安排由 Amy 跟进。",
          transcriptText: "我负责同步培训安排。",
          imageCount: 0,
          audioCount: 1,
          events: [
            {
              ...base.windows[0].events[0],
              eventId: "event-speaker-task-1",
              capturedAt: startedAt,
              summary: "Amy 说自己负责同步培训安排。",
              transcript: "我负责同步培训安排。",
              transcriptSegments: [
                {
                  startMs: 0,
                  endMs: 1800,
                  text: "我负责同步培训安排。",
                },
              ],
              speakerTimelineSegments: [
                {
                  startMs: 0,
                  endMs: 1800,
                  text: "我负责同步培训安排。",
                  speakerLabel: "speaker_2",
                },
              ],
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        keyWindowIds: [windowId],
        speakers: [
          {
            speakerRef: `speaker:${windowId}:2`,
            displayName: "Amy",
            relationship: "同事",
            windowId,
            deviceId: "device-1",
          },
        ],
      },
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question: "会议里哪些任务是分配给我的？" },
    );

    expect(resolved.details.evidenceBundle.taskAttribution.status).toBe("ready");
    expect(resolved.details.windows[0]?.events[0]?.speakerTimelineSegments).toEqual([
      {
        startMs: 0,
        endMs: 1800,
        text: "我负责同步培训安排。",
        speakerLabel: "speaker_2",
      },
    ]);
    expect(resolved.details.evidenceBundle.taskAttribution.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "speaker-dependent",
          speakerLabel: "speaker_2",
          speakerDisplayName: "Amy",
          userAssignmentStatus: "assigned-to-known-speaker",
        }),
      ]),
    );
    expect(resolved.details.evidenceBundle.taskAttribution.buckets.assignedToOthersOrTeams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          speakerDisplayName: "Amy",
          userAssignmentStatus: "assigned-to-known-speaker",
        }),
      ]),
    );
    expect(resolved.details.evidenceBundle.taskAttribution.buckets.assignedToUser).toHaveLength(0);
    expect(resolved.text).toContain("说话人：Amy（同事，speaker_2）");
    expect(resolved.text).toContain("speaker 已标注为其他人物，不能默认算你的任务");
  });

  it("keeps speaker-labeled pronoun tasks in exact speaker mode before identity annotation", async () => {
    const base = createPayload();
    const startedAt = new Date("2026-06-25T10:15:00+08:00").getTime();
    const endedAt = new Date("2026-06-25T10:16:00+08:00").getTime();
    const windowId = "audio-session::speaker-unlabeled-task";
    const payload = createPayload({
      scope: "today",
      date: "2026-06-25",
      windows: [
        {
          ...base.windows[0],
          windowId,
          startedAt,
          endedAt,
          primarySummary: "会议里有人说自己负责同步培训安排。",
          transcriptText: "我负责同步培训安排。",
          imageCount: 0,
          audioCount: 1,
          events: [
            {
              ...base.windows[0].events[0],
              eventId: "event-speaker-unlabeled-task-1",
              capturedAt: startedAt,
              summary: "未标注 speaker 说自己负责同步培训安排。",
              transcript: "我负责同步培训安排。",
              speakerTimelineSegments: [
                {
                  startMs: 0,
                  endMs: 1800,
                  text: "我负责同步培训安排。",
                  speakerLabel: "speaker_1",
                },
              ],
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        keyWindowIds: [windowId],
      },
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question: "会议里哪些任务是分配给我的？" },
    );

    expect(resolved.details.evidenceBundle.taskAttribution.status).toBe("needs-speaker-labels");
    expect(resolved.details.evidenceBundle.taskAttribution.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "speaker-dependent",
          speakerLabel: "speaker_1",
          speakerRef: `speaker:${windowId}:1`,
          userAssignmentStatus: "needs-speaker-label",
          reason: expect.stringContaining("句级转写显示这句话由 speaker_1 说出"),
        }),
      ]),
    );
    expect((resolved.details.responseHints as any).speakerResolutionPrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          speakerLabel: "speaker_1",
          speakerRef: `speaker:${windowId}:1`,
          resolutionMode: "exact-speaker-label",
          requiresDiarization: false,
          selfCommandTemplate: expect.stringContaining(`speaker:${windowId}:1`),
        }),
      ]),
    );
    expect((resolved.details.responseHints as any).conversationDigest.taskMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("我负责同步培训安排"),
          speakerLabel: "speaker_1",
          speakerRef: `speaker:${windowId}:1`,
          userAssignmentStatus: "needs-speaker-label",
          resolutionMode: "exact-speaker-label",
          requiresDiarization: false,
          selfSentenceTemplate: expect.stringContaining("speaker_1"),
          selfCommandTemplate: expect.stringContaining(`speaker:${windowId}:1`),
        }),
      ]),
    );
    expect(resolved.text).toContain("说话人：speaker_1");
  });

  it("uses speaker relationship labels to recognize the user's own pronoun tasks", async () => {
    const base = createPayload();
    const startedAt = new Date("2026-06-25T10:18:00+08:00").getTime();
    const endedAt = new Date("2026-06-25T10:19:00+08:00").getTime();
    const windowId = "audio-session::speaker-self-task";
    const payload = createPayload({
      scope: "today",
      date: "2026-06-25",
      windows: [
        {
          ...base.windows[0],
          windowId,
          startedAt,
          endedAt,
          primarySummary: "会议里确认我负责同步培训安排。",
          transcriptText: "我负责同步培训安排。",
          imageCount: 0,
          audioCount: 1,
          events: [
            {
              ...base.windows[0].events[0],
              eventId: "event-speaker-self-task-1",
              capturedAt: startedAt,
              summary: "用户说自己负责同步培训安排。",
              transcript: "我负责同步培训安排。",
              transcriptSegments: [
                {
                  startMs: 0,
                  endMs: 1800,
                  text: "我负责同步培训安排。",
                },
              ],
              speakerTimelineSegments: [
                {
                  startMs: 0,
                  endMs: 1800,
                  text: "我负责同步培训安排。",
                  speakerLabel: "speaker_2",
                },
              ],
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        keyWindowIds: [windowId],
        speakers: [
          {
            speakerRef: `speaker:${windowId}:2`,
            displayName: "Cedric",
            relationship: "本人",
            windowId,
            deviceId: "device-1",
          },
        ],
      },
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-06-25"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      { question: "会议里哪些任务是分配给我的？" },
    );

    expect(resolved.details.evidenceBundle.taskAttribution.status).toBe("ready");
    expect(resolved.details.evidenceBundle.taskAttribution.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "speaker-dependent",
          speakerLabel: "speaker_2",
          speakerDisplayName: "Cedric",
          speakerRelationship: "本人",
          userAssignmentStatus: "assigned-to-user",
        }),
      ]),
    );
    expect(resolved.details.evidenceBundle.taskAttribution.buckets.assignedToUser).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          speakerDisplayName: "Cedric",
          speakerRelationship: "本人",
          userAssignmentStatus: "assigned-to-user",
        }),
      ]),
    );
    expect((resolved.details.responseHints as any).taskAttributionBuckets.assignedToUser).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          speakerDisplayName: "Cedric",
          userAssignmentStatus: "assigned-to-user",
        }),
      ]),
    );
    expect((resolved.details.responseHints as any).conversationDigest.taskMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          speakerDisplayName: "Cedric",
          userAssignmentStatus: "assigned-to-user",
        }),
      ]),
    );
    expect((resolved.details.responseHints as any).speakerResolutionPrompts).toHaveLength(0);
    expect(resolved.text).toContain("说话人：Cedric（本人，speaker_2）");
    expect(resolved.text).toContain("speaker 已标注为用户本人，可作为你的任务候选");
  });

  it("supports explicit lookbackDays and turns it into a custom-range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T10:00:00+08:00"));
    const payload = createPayload({
      scope: "custom-range",
      startAt: new Date("2026-04-07T10:00:00+08:00").getTime(),
      endAt: new Date("2026-04-14T10:00:00+08:00").getTime(),
    });
    const buildAssistantContext = vi.fn(async () => payload);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-04-14"),
        buildAssistantContext,
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    await tool.execute("tool-lookback", {
      lookbackDays: 7,
      question: "最近一周最值得注意的事情",
      focus: "what_happened",
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "custom-range",
        startAt: new Date("2026-04-07T10:00:00+08:00").getTime(),
        endAt: new Date("2026-04-14T10:00:00+08:00").getTime(),
      }),
    );
    vi.useRealTimers();
  });

  it("defaults undated meeting-minutes follow-ups to a recent evidence window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:00:00+08:00"));
    const payload = createPayload({
      scope: "custom-range",
      startAt: new Date("2026-06-25T00:00:00+08:00").getTime(),
      endAt: new Date("2026-07-01T10:00:00+08:00").getTime(),
      summary: "最近一周有一段可整理成会议纪要的音频会议。",
    });
    const buildAssistantContext = vi.fn(async () => payload);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-07-01"),
        buildAssistantContext,
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    await tool.execute("tool-recent-meeting-minutes", {
      question: "那帮我整理成会议纪要",
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "custom-range",
        startAt: new Date("2026-06-25T00:00:00+08:00").getTime(),
        endAt: new Date("2026-07-01T10:00:00+08:00").getTime(),
      }),
    );
    vi.useRealTimers();
  });

  it("infers last-week window for cross-day recall questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T10:00:00+08:00"));
    const payload = createPayload({
      scope: "custom-range",
      startAt: new Date("2026-04-06T00:00:00+08:00").getTime(),
      endAt: new Date("2026-04-12T23:59:59.999+08:00").getTime(),
      summary: "上周记录到了几段值得回看的讨论。",
    });
    const buildAssistantContext = vi.fn(async () => payload);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-04-14"),
        buildAssistantContext,
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    await tool.execute("tool-last-week", {
      question: "上周我和老板都聊了什么？",
      focus: "what_happened",
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "custom-range",
        startAt: new Date("2026-04-06T00:00:00+08:00").getTime(),
        endAt: new Date("2026-04-12T23:59:59.999+08:00").getTime(),
      }),
    );
    vi.useRealTimers();
  });

  it("accepts explicit custom time ranges and forwards them to context + recheck", async () => {
    const payload = createPayload({
      scope: "custom-range",
      date: "2026-03-19",
      startAt: 1770000000000,
      endAt: 1770003600000,
      summary: "这个时间窗里主要记录到一段会议讨论。",
      windows: [
        {
          ...createPayload().windows[0],
          transcriptText: "",
          primarySummary: "这段会议仍待确认。",
          events: [
            {
              ...createPayload().windows[0].events[0],
              summary: "Audio captured, but primary multimodal audio analysis failed.",
              transcript: "",
              analysisStatus: "degraded",
            },
          ],
        },
      ],
      highlights: {
        ...createPayload().highlights,
        audioCoverage: {
          totalAudioWindows: 1,
          transcriptReadyWindows: 0,
          pendingAudioWindows: 1,
          degradedAudioEvents: 1,
        },
      },
    });
    const buildAssistantContext = vi.fn(async () => payload);
    const recheckAudioEvidence = vi.fn(async () => []);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext,
        recheckAudioEvidence,
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-range", {
      focus: "what_happened",
      startAt: 1770000000000,
      endAt: 1770003600000,
      question: "这段时间里发生了什么？",
    });

    expect(buildAssistantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "custom-range",
        startAt: 1770000000000,
        endAt: 1770003600000,
      }),
    );
    expect(recheckAudioEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "custom-range",
        startAt: 1770000000000,
        endAt: 1770003600000,
      }),
    );
    expect((result.details as any).evidenceBundle.timeRange.scope).toBe("custom-range");
    expect((result.details as any).evidenceBundle.timeRange.startAt).toBe(1770000000000);
    expect((result.details as any).evidenceBundle.timeRange.endAt).toBe(1770003600000);
  });

  it("exposes shared context resolution success for CLI/API reuse", async () => {
    const payload = createPayload({
      scope: "today",
      date: "2026-03-19",
      summary: "今天记录到一次会议讨论。",
    });
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-03-19"),
          buildAssistantContext: vi.fn(async () => payload),
          recheckAudioEvidence: vi.fn(async () => []),
          buildIdentityHistory: vi.fn(async () => []),
          buildProjectHistory: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      {
        scope: "today",
        focus: "what_happened",
        question: "今天发生了什么",
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.details.evidenceBundle.schemaVersion).toBe("2026-07-08");
    expect(resolved.details.evidenceBundle.timeRange.scope).toBe("today");
    expect(resolved.details.evidenceBundle.windows.length).toBeGreaterThan(0);
  });

  it("exposes shared context resolution validation errors for CLI/API reuse", async () => {
    const resolved = await resolveClawSenseContext(
      {
        reviewEngine: {
          normalizeDateInput: vi.fn(() => "2026-03-19"),
          buildAssistantContext: vi.fn(async () => createPayload()),
          recheckAudioEvidence: vi.fn(async () => []),
          buildIdentityHistory: vi.fn(async () => []),
          buildProjectHistory: vi.fn(async () => []),
        } as any,
        artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
      },
      {
        startAt: 1770000000000,
      },
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.details.error).toBe("invalid_time_range");
    expect(resolved.text).toContain("时间窗参数无效");
  });

  it("surfaces historical memory for a named person without a separate mode", async () => {
    const payload = createPayload();
    const buildIdentityHistory = vi.fn(async () => [
      {
        kind: "person",
        ref: "person-amy",
        displayName: "Amy",
        relationship: "老板",
        notes: "经常在演示前确认开场顺序。",
        nextWatchFor: "确认她这次更关注报价还是开场顺序。",
        occurrenceCount: 3,
        relatedDates: ["2026-03-30", "2026-03-29"],
        firstSeenAt: 100,
        lastSeenAt: 300,
        recentMoments: [
          {
            date: "2026-03-30",
            timeRange: "09:10-09:25",
            windowId: "audio-session::amy-1",
            summary: "Amy 追问演示开场和关键截图顺序。",
            transcriptExcerpt: "先讲价值主张，再过一遍报价区间。",
            artifactUrls: ["http://claw/api/clawsense/artifacts?id=amy-1"],
          },
        ],
        memoryCards: [
          {
            cardId: "memcard-amy-task",
            kind: "task",
            title: "Amy 要求确认报价顺序",
            summary: "任务线索来自 Amy 参与的演示准备窗口。",
            confidence: "medium",
            timeRanges: ["09:10-09:25"],
            taskHints: ["Amy 要求先确认报价顺序。"],
            transcriptExcerpts: ["先讲价值主张，再过一遍报价区间。"],
          },
        ],
      },
    ]);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-31"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
        buildIdentityHistory,
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-history", {
      question: "Amy 之前在我的历史记忆里出现过什么？",
    });

    expect(buildIdentityHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "Amy 之前在我的历史记忆里出现过什么？",
      }),
    );
    expect(result.content[0]?.text).toContain("相关人物 / 发言者的历史记忆：");
    expect(result.content[0]?.text).toContain("Amy（老板）");
    expect(result.content[0]?.text).toContain("历史上出现过 3 个时间窗");
    expect(result.content[0]?.text).toContain("2026-03-30 09:10-09:25");
    expect(result.content[0]?.text).toContain("关联记忆卡片：");
    expect(result.content[0]?.text).toContain("任务卡 Amy 要求确认报价顺序");
    expect(result.content[0]?.text).toContain("可继续追问：你可以继续问");
    expect(result.content[0]?.text).toContain("快捷追问入口：");
    expect(result.content[0]?.text).toContain("围绕 Amy");
    expect((result.details as any).identityHistory[0].displayName).toBe("Amy");
    expect((result.details as any).evidenceBundle.identityHistory[0].ref).toBe("person-amy");
    expect((result.details as any).responseHints.historyFollowUps[0]).toContain("围绕 Amy");
    expect((result.details as any).responseHints.evidenceFollowUpTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "history",
          kind: "history-follow-up",
          prompt: expect.stringContaining("围绕 Amy"),
        }),
      ]),
    );
  });

  it("surfaces historical memory for a named project without a separate mode", async () => {
    const payload = createPayload({
      windows: [
        {
          ...createPayload().windows[0],
          projectRefs: ["demo_prep"],
          tags: ["demo"],
        },
      ],
    });
    const buildProjectHistory = vi.fn(async () => [
      {
        ref: "demo_prep",
        label: "演示准备",
        source: "project-ref",
        occurrenceCount: 4,
        relatedDates: ["2026-03-30", "2026-03-29"],
        firstSeenAt: 100,
        lastSeenAt: 300,
        recentMoments: [
          {
            date: "2026-03-30",
            timeRange: "09:10-09:25",
            windowId: "audio-session::demo-1",
            summary: "团队反复确认演示开场和关键截图顺序。",
            transcriptExcerpt: "先讲价值主张，再过一遍报价区间。",
            artifactUrls: ["http://claw/api/clawsense/artifacts?id=demo-1"],
          },
        ],
        memoryCards: [
          {
            cardId: "memcard-demo-topic",
            kind: "topic",
            title: "演示准备与截图顺序",
            summary: "演示准备相关话题持续出现。",
            confidence: "medium",
            timeRanges: ["09:10-09:25"],
            taskHints: ["确认演示截图顺序。"],
            transcriptExcerpts: ["先讲价值主张，再过一遍报价区间。"],
          },
        ],
      },
    ]);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-31"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
        buildProjectHistory,
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-project-history", {
      question: "演示准备之前在我的历史记忆里出现过什么？",
    });

    expect(buildProjectHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "演示准备之前在我的历史记忆里出现过什么？",
        currentProjectRefs: ["demo_prep"],
      }),
    );
    expect(result.content[0]?.text).toContain("相关项目 / 主题的历史记忆：");
    expect(result.content[0]?.text).toContain("演示准备");
    expect(result.content[0]?.text).toContain("历史上出现过 4 个时间窗");
    expect(result.content[0]?.text).toContain("关联记忆卡片：");
    expect(result.content[0]?.text).toContain("话题卡 演示准备与截图顺序");
    expect((result.details as any).projectHistory[0].label).toBe("演示准备");
    expect((result.details as any).evidenceBundle.projectHistory[0].ref).toBe("demo_prep");
  });

  it("triggers identity history retrieval for role-based singular questions", async () => {
    const payload = createPayload();
    const buildIdentityHistory = vi.fn(async () => []);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-31"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
        buildIdentityHistory,
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    await tool.execute("tool-role-history", {
      question: "这个老板之前在历史记忆里出现过什么？",
    });

    expect(buildIdentityHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "这个老板之前在历史记忆里出现过什么？",
      }),
    );
  });

  it("writes speaker annotations back in a chat-friendly format", async () => {
    const annotateSpeaker = vi.fn(async (params) => ({
      annotationId: "speaker-ann-1",
      speakerRef: params.speakerRef,
      displayName: params.displayName,
      relationship: params.relationship,
      notes: params.notes,
      windowId: params.windowId,
      deviceId: params.deviceId,
      eventIds: params.eventIds ?? [],
      createdAt: 1,
      updatedAt: 1,
    }));
    const tool = createClawSenseAnnotateSpeakerTool({
      reviewEngine: {
        annotateSpeaker,
      } as any,
    });

    const result = await tool.execute("tool-speaker", {
      speakerRef: "speaker:audio-session::1:1",
      displayName: "Amy",
      relationship: "老板",
      windowId: "audio-session::1",
      deviceId: "device-1",
    });

    expect(annotateSpeaker).toHaveBeenCalledWith({
      speakerRef: "speaker:audio-session::1:1",
      displayName: "Amy",
      relationship: "老板",
      notes: undefined,
      windowId: "audio-session::1",
      deviceId: "device-1",
      eventIds: undefined,
    });
    expect(result.content[0]?.text).toContain("已写入 ClawSense 说话人标注：Amy");
  });

  it("exposes evidence windows and the original question for host-model reasoning", async () => {
    const payload = createPayload();
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-3", {
      scope: "today",
      focus: "what_happened",
      question: "今天发生了什么，和演示准备有关吗？",
    });

    expect(result.content[0]?.text).toContain("用户问题：今天发生了什么，和演示准备有关吗？");
    expect(result.content[0]?.text).toContain("已确认的证据：");
    expect(result.content[0]?.text).toContain("建议回答骨架：先给一句结论，再列 2 到 4 条已确认的证据");
    expect(result.content[0]?.text).toContain("关键时间窗：");
    expect(result.content[0]?.text).toContain("可直接引用的证据片段：");
    expect(result.content[0]?.text).toContain("更有用的整理角度：");
    expect(result.content[0]?.text).toContain("如果下面提供了原始音频 URL");
    expect(result.content[0]?.text).toContain("http://claw/api/clawsense/artifacts?id=audio-clip-1");
    expect(result.content[0]?.text).toContain("场景化回答桶：一句结论 / 项目主线 / 任务候选 / 已确认人物 / 角色线索 / 待确认重点");
    expect(result.content[0]?.text).toContain("场景判断：偏办公场景");
    expect(result.content[0]?.text).toContain("任务候选：");
    expect(result.content[0]?.text).toContain("项目 / 主题主线：");
    expect(result.content[0]?.text).toContain("已确认人物：Amy（老板）");
    expect(result.content[0]?.text).toContain("角色线索：");
    expect(result.content[0]?.text).toContain("音频细节覆盖：已补强 1 / 1 个音频窗口");
    expect(result.content[0]?.text).toContain("音频追问建议：你可以继续问：");
    expect(result.content[0]?.text).toContain("快捷追问入口：");
    expect(result.content[0]?.text).toContain("说话人层：");
    expect(result.content[0]?.text).toContain("speaker_1 @");
    expect(result.content[0]?.text).toContain("可继续动作：如果你知道某个 speaker 是谁");
    expect(result.content[0]?.text).toContain("标注命令（可直接执行）：");
    expect(result.content[0]?.text).toContain("openclaw clawsense annotate-speaker");
    expect(result.content[0]?.text).toContain("转写摘录：明天先讲价值主张，再切到关键截图。");
    expect(result.content[0]?.text).toContain("回答风格：先用 2 到 4 句概括今天真正记录到的变化或活动");
    expect(result.content[0]?.text).toContain("不要推断设备关闭、故障或休眠");
    expect((result.details as any).evidenceBundle.windows[0].windowId).toBe("audio-session::1");
    expect((result.details as any).evidenceBundle.windows[0].audioArtifacts[0].url).toBe(
      "http://claw/api/clawsense/artifacts?id=audio-clip-1",
    );
    expect((result.details as any).evidenceBundle.schemaVersion).toBe("2026-07-08");
    expect((result.details as any).evidenceBundle.timeRange.scope).toBe("today");
    expect((result.details as any).evidenceBundle.topEvidence[0].kind).toBe("transcript");
    expect((result.details as any).evidenceBundle.transcriptSpans[0].eventId).toBe("event-1");
    expect((result.details as any).evidenceBundle.artifactRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "audio-clip-1",
          modality: "audio",
          eventId: "event-1",
        }),
      ]),
    );
    expect((result.details as any).evidenceBundle.fragments[0].kind).toBe("transcript");
    expect((result.details as any).evidenceBundle.fragments[1].artifactUrl).toBe(
      "http://claw/api/clawsense/artifacts?id=audio-clip-1",
    );
    expect((result.details as any).evidenceBundle.signalProfile.transcriptWindowCount).toBe(1);
    expect((result.details as any).evidenceBundle.scenarioProfile.candidate).toBe("work");
    expect((result.details as any).evidenceBundle.practicalOutputs.tasks).toEqual(
      expect.arrayContaining([expect.stringContaining("明天先确认演示截图顺序")]),
    );
    expect((result.details as any).evidenceBundle.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining("演示"),
        }),
      ]),
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.people).toContain("Amy（老板）");
    expect((result.details as any).evidenceBundle.practicalOutputs.roleHints).toEqual(
      expect.arrayContaining([expect.stringContaining("待确认发言者：speaker_2")]),
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.attentionItems[0]).toContain("这位同事具体负责哪一部分演示");
    expect((result.details as any).evidenceBundle.speakerLayer.status).toBe("ready-for-labeling");
    expect((result.details as any).evidenceBundle.speakerLayer.suggestedSlots[0].speakerRef).toBe("speaker:audio-session::1:1");
    expect((result.details as any).responseHints.answerShape).toContain("一句结论");
    expect((result.details as any).responseHints.answerBuckets).toEqual([
      "一句结论",
      "项目主线",
      "任务候选",
      "已确认人物",
      "角色线索",
      "待确认重点",
    ]);
    expect((result.details as any).responseHints.confirmedFindings[0]).toContain("今天主要在准备明天的产品演示");
    expect((result.details as any).responseHints.audioCoverage).toEqual({
      totalAudioWindows: 1,
      transcriptReadyWindows: 1,
      pendingAudioWindows: 0,
      degradedAudioEvents: 0,
    });
    expect((result.details as any).responseHints.audioDiagnostics.verdict.rawAudioArtifacts).toBe("available");
    expect((result.details as any).responseHints.audioDiagnostics.blockerIds).toEqual(
      expect.arrayContaining(["diarization-runnable"]),
    );
    expect((result.details as any).responseHints.audioFollowUps[0]).toContain("这段对话里");
    expect((result.details as any).responseHints.audioFollowUpTargets[0]).toEqual(
      expect.objectContaining({
        windowId: "audio-session::1",
        status: "transcript-ready",
        eventId: "event-1",
        artifactUrl: "http://claw/api/clawsense/artifacts?id=audio-clip-1",
        transcriptExcerpt: expect.stringContaining("明天先讲"),
      }),
    );
    expect((result.details as any).responseHints.evidenceFollowUpTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "audio",
          windowId: "audio-session::1",
          eventId: "event-1",
        }),
      ]),
    );
    expect((result.details as any).responseHints.annotationPrompts[0]).toContain("speaker_2");
    expect((result.details as any).responseHints.annotationPrompts[0]).toContain("是我本人");
    expect((result.details as any).responseHints.annotationSuggestions.speakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          suggestionId: "speaker:speaker:audio-session::1:2",
          speakerRef: "speaker:audio-session::1:2",
          confidence: "medium",
          selfSentenceTemplate: expect.stringContaining("是我本人"),
          selfCommandTemplate: expect.stringContaining("--relationship \"本人\""),
        }),
      ]),
    );
    expect(result.content[0]?.text).toContain("是我本人");
    expect(result.content[0]?.text).toContain("--relationship \"本人\"");
    expect((result.details as any).question).toBe("今天发生了什么，和演示准备有关吗？");
  });

  it("groups video events and keyframes by videoRequestId for evidence retrieval", async () => {
    const base = createPayload();
    const payload = {
      ...base,
      counts: { events: 5, windows: 1, artifacts: 4, devices: 1 },
      windows: [
        {
          ...base.windows[0],
          imageCount: 2,
          videoCount: 1,
          events: [
            ...base.windows[0].events,
            {
              eventId: "event-video-1",
              modality: "video",
              capturedAt: 160,
              summary: "会议室里正在复盘演示流程，白板上有任务分工。",
              transcript: undefined,
              note: "meeting clip videoRequestId=req-100",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-clip-1",
                fileName: "clip.mp4",
                mime: "video/mp4",
                available: true,
                sizeBytes: 8096,
                url: "http://claw/api/clawsense/artifacts?id=video-clip-1",
              },
            },
            {
              eventId: "event-image-kf-1",
              modality: "image",
              capturedAt: 162,
              summary: "关键帧显示白板上的分工列表，白板写着：明天9点前发送演示最终版给 Amy。",
              transcript: undefined,
              note: "active-window videoRequestId=req-100 videoKeyframe=1 keyframe=1",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-kf-1",
                fileName: "kf-1.jpg",
                mime: "image/jpeg",
                available: true,
                sizeBytes: 2048,
                url: "http://claw/api/clawsense/artifacts?id=video-kf-1",
              },
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        recentImages: [
          ...base.highlights.recentImages,
          {
            eventId: "event-image-kf-1",
            capturedAt: 162,
            summary: "关键帧显示白板上的分工列表，白板写着：明天9点前发送演示最终版给 Amy。",
            artifact: {
              artifactId: "video-kf-1",
              fileName: "kf-1.jpg",
              mime: "image/jpeg",
              available: true,
              sizeBytes: 2048,
              url: "http://claw/api/clawsense/artifacts?id=video-kf-1",
            },
          },
        ],
      },
    };
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-video-groups", {
      scope: "today",
      focus: "what_happened",
      question: "今天这段视频里有哪些关键细节？",
    });

    expect(result.content[0]?.text).toContain("视频证据组（同次上传聚合）：");
    expect(result.content[0]?.text).toContain("视频 1 段 / 关键帧 1 张");
    expect(result.content[0]?.text).toContain("OCR / 板书线索：");
    expect((result.details as any).evidenceBundle.videoEvidenceGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          videoRequestId: "req-100",
          videoEventIds: expect.arrayContaining(["event-video-1"]),
          keyframeEventIds: expect.arrayContaining(["event-image-kf-1"]),
          videoDetails: expect.arrayContaining([
            expect.objectContaining({
              eventId: "event-video-1",
              artifactId: "video-clip-1",
            }),
          ]),
          keyframeDetails: expect.arrayContaining([
            expect.objectContaining({
              eventId: "event-image-kf-1",
              artifactId: "video-kf-1",
              keyframeIndex: 1,
              caption: expect.stringContaining("白板上的分工列表"),
              ocrHints: expect.arrayContaining([expect.stringContaining("明天9点前发送演示最终版给 Amy")]),
              linkedVideoEventId: "event-video-1",
              linkedVideoArtifactId: "video-clip-1",
              linkedVideoTime: "08:00",
              linkMethod: "nearest-clip",
              url: "http://claw/api/clawsense/artifacts?id=video-kf-1",
            }),
          ]),
          semanticSignals: expect.objectContaining({
            ocrHints: expect.arrayContaining([expect.stringContaining("明天9点前发送演示最终版给 Amy")]),
            linkedKeyframes: 1,
            totalKeyframes: 1,
          }),
          transcriptSpans: expect.arrayContaining([
            expect.objectContaining({
              eventId: "event-1",
              text: expect.stringContaining("明天先讲"),
            }),
          ]),
        }),
      ]),
    );
    expect((result.details as any).evidenceBundle.fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "video-observation",
          videoRequestId: "req-100",
        }),
        expect.objectContaining({
          fragmentId: "video-keyframe:req-100:event-image-kf-1",
          artifactId: "video-kf-1",
          videoRequestId: "req-100",
          keyframeIndex: 1,
        }),
      ]),
    );
    expect((result.details as any).evidenceBundle.topEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "video-observation",
          videoRequestId: "req-100",
          artifactId: expect.stringMatching(/^video-/),
          artifactUrl: expect.stringContaining("video-"),
        }),
      ]),
    );
    expect((result.details as any).evidenceBundle.artifactRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "video-kf-1",
          modality: "image",
          videoRequestId: "req-100",
          keyframeIndex: 1,
        }),
      ]),
    );
    expect((result.details as any).responseHints.videoCoverage).toEqual(
      expect.objectContaining({
        totalVideoGroups: 1,
        groupsWithVideoArtifacts: 1,
        groupsWithKeyframes: 1,
        groupsWithOcrHints: 1,
        linkedKeyframes: 1,
        totalKeyframes: 1,
      }),
    );
    expect((result.details as any).responseHints.videoFollowUps[0]).toContain("第 1 帧");
    expect((result.details as any).responseHints.videoFollowUpTargets[0]).toEqual(
      expect.objectContaining({
        kind: "keyframe",
        eventId: "event-image-kf-1",
        artifactId: "video-kf-1",
        linkedTranscriptEventId: "event-1",
        linkedTranscriptExcerpt: expect.stringContaining("明天先讲"),
        ocrHints: expect.arrayContaining([expect.stringContaining("明天9点前发送演示最终版给 Amy")]),
        linkedVideoEventId: "event-video-1",
        linkedVideoArtifactId: "video-clip-1",
        linkedVideoTime: "08:00",
        linkMethod: "nearest-clip",
        keyframeIndex: 1,
        frameTime: "08:00",
        artifactUrl: "http://claw/api/clawsense/artifacts?id=video-kf-1",
        videoRequestId: "req-100",
      }),
    );
    expect((result.details as any).responseHints.evidenceFollowUpTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "video",
          videoRequestId: "req-100",
          eventId: "event-image-kf-1",
          keyframeIndex: 1,
        }),
      ]),
    );
    expect(result.content[0]?.text).toContain("视频追问建议：你可以继续问");
  });

  it("uses structured keyframe note markers for caption, OCR, and video offset linking", async () => {
    const base = createPayload();
    const payload = {
      ...base,
      counts: { events: 2, windows: 1, artifacts: 2, devices: 1 },
      windows: [
        {
          ...base.windows[0],
          imageCount: 1,
          videoCount: 1,
          events: [
            {
              eventId: "event-video-structured-1",
              modality: "video",
              capturedAt: 160,
              summary: "访谈视频片段已记录。",
              transcript: undefined,
              note: "interview clip videoRequestId=req-structured-1",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-structured-1",
                fileName: "interview.mp4",
                mime: "video/mp4",
                available: true,
                sizeBytes: 8192,
                url: "http://claw/api/clawsense/artifacts?id=video-structured-1",
              },
            },
            {
              eventId: "event-video-structured-kf-1",
              modality: "image",
              capturedAt: 12160,
              summary: "关键帧已记录。",
              transcript: undefined,
              note:
                "active-window videoRequestId=req-structured-1 videoKeyframe=1 keyframe=2 videoOffsetMs=12000 caption=%E8%AE%BF%E8%B0%88%E8%A7%86%E9%A2%91%E4%B8%AD%E4%B8%BB%E8%AE%B2%E4%BA%BA%E6%AD%A3%E5%9C%A8%E8%B0%88%E6%A8%A1%E5%9E%8B%E8%83%BD%E5%8A%9B%E8%BE%B9%E7%95%8C ocr=Scaling%20Law%7C%E6%94%B6%E8%B4%AD%E5%8A%A8%E6%80%81",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-structured-kf-1",
                fileName: "interview-kf-2.jpg",
                mime: "image/jpeg",
                available: true,
                sizeBytes: 2048,
                url: "http://claw/api/clawsense/artifacts?id=video-structured-kf-1",
              },
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        recentImages: [],
      },
    };
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-video-structured-markers", {
      scope: "today",
      focus: "what_happened",
      question: "刚才视频里有哪些重点？",
    });

    const group = (result.details as any).evidenceBundle.videoEvidenceGroups[0];
    expect(group.keyframeDetails[0]).toEqual(
      expect.objectContaining({
        eventId: "event-video-structured-kf-1",
        keyframeIndex: 2,
        videoOffsetMs: 12000,
        videoOffsetLabel: "00:12",
        caption: "访谈视频中主讲人正在谈模型能力边界",
        ocrHints: expect.arrayContaining(["Scaling Law", "收购动态"]),
        linkedVideoEventId: "event-video-structured-1",
        linkedVideoArtifactId: "video-structured-1",
        linkMethod: "offset-marker",
      }),
    );
    expect(group.semanticSignals).toEqual(
      expect.objectContaining({
        captions: expect.arrayContaining(["访谈视频中主讲人正在谈模型能力边界"]),
        ocrHints: expect.arrayContaining(["Scaling Law", "收购动态"]),
      }),
    );
    expect((result.details as any).responseHints.videoFollowUpTargets[0]).toEqual(
      expect.objectContaining({
        videoOffsetMs: 12000,
        videoOffsetLabel: "00:12",
        linkMethod: "offset-marker",
        caption: "访谈视频中主讲人正在谈模型能力边界",
        ocrHints: expect.arrayContaining(["Scaling Law", "收购动态"]),
      }),
    );
    expect((result.details as any).responseHints.videoFollowUps[0]).toContain("片段内 00:12");
    expect(result.content[0]?.text).toContain("片段内 00:12");
  });

  it("still groups video evidence when videoRequestId marker is missing", async () => {
    const base = createPayload();
    const payload = {
      ...base,
      counts: { events: 3, windows: 1, artifacts: 2, devices: 1 },
      windows: [
        {
          ...base.windows[0],
          imageCount: 1,
          videoCount: 1,
          events: [
            {
              eventId: "event-video-no-marker",
              modality: "video",
              capturedAt: 210,
              summary: "会议室里两位同事在投影屏前核对任务列表。",
              transcript: undefined,
              note: "meeting clip without request marker",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-no-marker-1",
                fileName: "clip-no-marker.mp4",
                mime: "video/mp4",
                available: true,
                sizeBytes: 9000,
                url: "http://claw/api/clawsense/artifacts?id=video-no-marker-1",
              },
            },
            {
              eventId: "event-image-kf-no-marker",
              modality: "image",
              capturedAt: 212,
              summary: "关键帧显示投影上的待办清单。",
              transcript: undefined,
              note: "active-window videoKeyframe=1 keyframe=1",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-no-marker-kf-1",
                fileName: "kf-no-marker-1.jpg",
                mime: "image/jpeg",
                available: true,
                sizeBytes: 1500,
                url: "http://claw/api/clawsense/artifacts?id=video-no-marker-kf-1",
              },
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        recentImages: [
          {
            eventId: "event-image-kf-no-marker",
            capturedAt: 212,
            summary: "关键帧显示投影上的待办清单。",
            artifact: {
              artifactId: "video-no-marker-kf-1",
              fileName: "kf-no-marker-1.jpg",
              mime: "image/jpeg",
              available: true,
              sizeBytes: 1500,
              url: "http://claw/api/clawsense/artifacts?id=video-no-marker-kf-1",
            },
          },
        ],
      },
    };
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-video-groups-no-marker", {
      scope: "today",
      focus: "what_happened",
      question: "今天这段视频里有哪些重点？",
    });

    const videoGroups = (result.details as any).evidenceBundle.videoEvidenceGroups;
    expect(videoGroups.length).toBeGreaterThan(0);
    expect(videoGroups[0]).toEqual(
      expect.objectContaining({
        videoEventIds: expect.arrayContaining(["event-video-no-marker"]),
        videoDetails: expect.arrayContaining([
          expect.objectContaining({
            artifactId: "video-no-marker-1",
          }),
        ]),
        keyframeDetails: expect.arrayContaining([
          expect.objectContaining({
            artifactId: "video-no-marker-kf-1",
          }),
        ]),
      }),
    );
    expect((result.details as any).evidenceBundle.fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "video-observation",
          videoRequestId: "video-window:audio-session::1",
          artifactUrl: "http://claw/api/clawsense/artifacts?id=video-no-marker-1",
        }),
        expect.objectContaining({
          fragmentId: "video-keyframe:video-window:audio-session::1:event-image-kf-no-marker",
          artifactId: "video-no-marker-kf-1",
          videoRequestId: "video-window:audio-session::1",
          keyframeIndex: 1,
        }),
      ]),
    );
    expect((result.details as any).evidenceBundle.artifactRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "video-no-marker-1",
          videoRequestId: "video-window:audio-session::1",
        }),
        expect.objectContaining({
          artifactId: "video-no-marker-kf-1",
          videoRequestId: "video-window:audio-session::1",
          keyframeIndex: 1,
        }),
      ]),
    );
    expect((result.details as any).responseHints.videoFollowUpTargets[0]).toEqual(
      expect.objectContaining({
        kind: "keyframe",
        artifactId: "video-no-marker-kf-1",
        keyframeIndex: 1,
      }),
    );
  });

  it("uses keyframe evidence to infer work tasks even without transcript windows", async () => {
    const base = createPayload();
    const payload = {
      ...base,
      summary: "今天采集到一段会议室视频。",
      review: {
        ...base.review,
        summary: "今天采集到一段会议室视频。",
        sections: [],
      },
      windows: [
        {
          ...base.windows[0],
          windowId: "video-window::1",
          startedAt: 600,
          endedAt: 720,
          primarySummary: "会议室里在确认演示收尾安排。",
          transcriptText: "",
          imageCount: 1,
          audioCount: 0,
          videoCount: 1,
          tags: [],
          events: [
            {
              eventId: "event-video-work-1",
              modality: "video",
              capturedAt: 600,
              summary: "会议室里几位同事在看白板并讨论演示流程。",
              transcript: undefined,
              note: "office clip videoRequestId=req-work-1",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-work-1",
                fileName: "office.mp4",
                mime: "video/mp4",
                available: true,
                sizeBytes: 16096,
                url: "http://claw/api/clawsense/artifacts?id=video-work-1",
              },
            },
            {
              eventId: "event-video-work-kf-1",
              modality: "image",
              capturedAt: 612,
              summary: "白板写着：明天9点前确认报价并发送演示最终版给 Amy。",
              transcript: undefined,
              note: "active-window videoRequestId=req-work-1 videoKeyframe=1 keyframe=1",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-work-kf-1",
                fileName: "office-kf-1.jpg",
                mime: "image/jpeg",
                available: true,
                sizeBytes: 4096,
                url: "http://claw/api/clawsense/artifacts?id=video-work-kf-1",
              },
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        keyWindowIds: ["video-window::1"],
        audioCoverage: {
          totalAudioWindows: 0,
          transcriptReadyWindows: 0,
          pendingAudioWindows: 0,
          degradedAudioEvents: 0,
        },
        recentConversations: [],
        people: [],
        speakers: [],
        recentImages: [
          {
            eventId: "event-video-work-kf-1",
            capturedAt: 612,
            summary: "白板写着：明天9点前确认报价并发送演示最终版给 Amy。",
            artifact: {
              artifactId: "video-work-kf-1",
              fileName: "office-kf-1.jpg",
              mime: "image/jpeg",
              available: true,
              sizeBytes: 4096,
              url: "http://claw/api/clawsense/artifacts?id=video-work-kf-1",
            },
          },
        ],
      },
      consolidation: undefined,
    };
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-video-work-infer", {
      scope: "today",
      focus: "what_happened",
      question: "今天有哪些要跟进的办公任务？",
    });

    expect((result.details as any).evidenceBundle.scenarioProfile.candidate).toBe("work");
    expect((result.details as any).evidenceBundle.practicalOutputs.tasks).toEqual(
      expect.arrayContaining([expect.stringContaining("确认报价并发送演示最终版")]),
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.roleHints).toEqual(
      expect.arrayContaining([expect.stringContaining("Amy")]),
    );
    expect((result.details as any).responseHints.annotationPrompts).toEqual(
      expect.arrayContaining([expect.stringContaining("Amy")]),
    );
    expect((result.details as any).responseHints.annotationSuggestions.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          suggestionId: "person:person_amy",
          displayName: "Amy",
          personRef: "person_amy",
          confidence: "high",
          autoApplyEligible: true,
          commandTemplate: expect.stringContaining("openclaw clawsense annotate"),
        }),
      ]),
    );
  });

  it("uses classroom keyframe evidence to infer study scenario and learning points", async () => {
    const base = createPayload();
    const payload = {
      ...base,
      summary: "今天采集到一段课堂视频。",
      review: {
        ...base.review,
        summary: "今天采集到一段课堂视频。",
        sections: [],
      },
      windows: [
        {
          ...base.windows[0],
          windowId: "video-classroom::1",
          startedAt: 800,
          endedAt: 920,
          primarySummary: "教室里老师在讲考试重点。",
          transcriptText: "",
          imageCount: 1,
          audioCount: 0,
          videoCount: 1,
          tags: [],
          events: [
            {
              eventId: "event-video-study-1",
              modality: "video",
              capturedAt: 800,
              summary: "课堂上老师在讲义前讲解考试范围。",
              transcript: undefined,
              note: "class clip videoRequestId=req-study-1",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-study-1",
                fileName: "class.mp4",
                mime: "video/mp4",
                available: true,
                sizeBytes: 13200,
                url: "http://claw/api/clawsense/artifacts?id=video-study-1",
              },
            },
            {
              eventId: "event-video-study-kf-1",
              modality: "image",
              capturedAt: 812,
              summary: "板书写着：线性代数考试重点是特征值与相似对角化，课后完成作业3。",
              transcript: undefined,
              note: "active-window videoRequestId=req-study-1 videoKeyframe=1 keyframe=1",
              captureContext: "active-window",
              analysisMode: "multimodal-preview",
              analysisProvider: "primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "video-study-kf-1",
                fileName: "class-kf-1.jpg",
                mime: "image/jpeg",
                available: true,
                sizeBytes: 4024,
                url: "http://claw/api/clawsense/artifacts?id=video-study-kf-1",
              },
            },
          ],
        },
      ],
      highlights: {
        ...base.highlights,
        keyWindowIds: ["video-classroom::1"],
        audioCoverage: {
          totalAudioWindows: 0,
          transcriptReadyWindows: 0,
          pendingAudioWindows: 0,
          degradedAudioEvents: 0,
        },
        recentConversations: [],
        people: [],
        speakers: [],
        recentImages: [
          {
            eventId: "event-video-study-kf-1",
            capturedAt: 812,
            summary: "板书写着：线性代数考试重点是特征值与相似对角化，课后完成作业3。",
            artifact: {
              artifactId: "video-study-kf-1",
              fileName: "class-kf-1.jpg",
              mime: "image/jpeg",
              available: true,
              sizeBytes: 4024,
              url: "http://claw/api/clawsense/artifacts?id=video-study-kf-1",
            },
          },
        ],
      },
      consolidation: undefined,
    };
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-video-study-infer", {
      scope: "today",
      focus: "what_happened",
      question: "今天课堂里有哪些学习重点？",
    });

    expect((result.details as any).evidenceBundle.scenarioProfile.candidate).toBe("study");
    expect((result.details as any).evidenceBundle.practicalOutputs.learningPoints).toEqual(
      expect.arrayContaining([expect.stringContaining("特征值与相似对角化")]),
    );
  });

  it("triggers query-time audio recheck when audio windows still have no transcript", async () => {
    const payload = createPayload({
      windows: [
        {
          windowId: "audio-session::gap-1",
          deviceId: "device-1",
          startedAt: 100,
          endedAt: 200,
          primarySummary: "有一段待确认的会议对话",
          transcriptText: "",
          imageCount: 0,
          audioCount: 1,
          captureContexts: ["audio-window"],
          peopleRefs: [],
          projectRefs: [],
          tags: ["meeting"],
          events: [
            {
              eventId: "event-gap-1",
              modality: "audio",
              capturedAt: 100,
              summary: "Audio captured, but primary multimodal audio analysis failed.",
              transcript: "",
              captureContext: "audio-window",
              analysisMode: "runtime-stt-fallback",
              analysisProvider: "runtime+primary-multimodal:runtime-primary",
              analysisStatus: "degraded",
              artifact: {
                artifactId: "audio-gap-1",
                fileName: "capture-gap.wav",
                mime: "audio/wav",
                available: true,
                sizeBytes: 4096,
                url: "http://claw/api/clawsense/artifacts?id=audio-gap-1",
              },
            },
          ],
        },
      ],
      highlights: {
        keyWindowIds: ["audio-session::gap-1"],
        recentImages: [],
        recentConversations: [
          {
            windowId: "audio-session::gap-1",
            startedAt: 100,
            endedAt: 200,
            summary: "有一段待确认的会议对话",
          },
        ],
        people: [],
        speakers: [],
      },
    });
    const recheckAudioEvidence = vi.fn(async () => [
      {
        windowId: "audio-session::gap-1",
        timeRange: "00:01-00:03",
        summary: "查询时复核判断这段音频主要在确认会议安排。",
        analysisProvider: "primary-multimodal:runtime-primary",
        artifact: {
          artifactId: "audio-gap-1",
          fileName: "capture-gap.wav",
          mime: "audio/wav",
          available: true,
          sizeBytes: 4096,
          url: "http://claw/api/clawsense/artifacts?id=audio-gap-1",
        },
      },
    ]);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence,
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-audio-recheck", {
      scope: "today",
      focus: "what_happened",
      question: "今天会议里到底说了什么？",
    });

    expect(result.content[0]?.text).toContain("查询时音频复核：");
    expect(result.content[0]?.text).toContain("查询时复核判断这段音频主要在确认会议安排");
    expect((result.details as any).audioRechecks[0].artifact.url).toBe(
      "http://claw/api/clawsense/artifacts?id=audio-gap-1",
    );
    expect((result.details as any).responseHints.audioFollowUpTargets[0]).toEqual(
      expect.objectContaining({
        windowId: "audio-session::gap-1",
        status: "needs-recheck",
        eventId: "event-gap-1",
        artifactUrl: "http://claw/api/clawsense/artifacts?id=audio-gap-1",
      }),
    );
    expect(recheckAudioEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        maxWindows: 1,
      }),
    );
  });

  it("refreshes assistant context after query-time audio recheck backfills a transcript", async () => {
    const initialPayload = createPayload({
      review: undefined,
      summary: "今天只有一段待确认音频。",
      windows: [
        {
          windowId: "audio-session::refresh-1",
          deviceId: "device-1",
          startedAt: 100,
          endedAt: 200,
          primarySummary: "有一段待确认的会议对话",
          transcriptText: "",
          imageCount: 0,
          audioCount: 1,
          captureContexts: ["audio-window"],
          peopleRefs: [],
          projectRefs: [],
          tags: ["meeting"],
          events: [
            {
              eventId: "event-refresh-1",
              modality: "audio",
              capturedAt: 100,
              summary: "Audio captured, but primary multimodal audio analysis failed.",
              transcript: "",
              captureContext: "audio-window",
              analysisMode: "runtime-stt-fallback",
              analysisProvider: "runtime+primary-multimodal:runtime-primary",
              analysisStatus: "degraded",
              artifact: {
                artifactId: "audio-refresh-1",
                fileName: "refresh.wav",
                mime: "audio/wav",
                available: true,
                sizeBytes: 4096,
                url: "http://claw/api/clawsense/artifacts?id=audio-refresh-1",
              },
            },
          ],
        },
      ],
      highlights: {
        keyWindowIds: ["audio-session::refresh-1"],
        recentImages: [],
        recentConversations: [
          {
            windowId: "audio-session::refresh-1",
            startedAt: 100,
            endedAt: 200,
            summary: "有一段待确认的会议对话",
          },
        ],
        people: [],
        speakers: [],
      },
    });
    const refreshedPayload = createPayload({
      review: undefined,
      summary: "今天确认了一段会议对话。",
      windows: [
        {
          ...initialPayload.windows[0]!,
          primarySummary: "老板说明天先补会议纪要，再确认演示顺序。",
          transcriptText: "老板说明天先补会议纪要，再确认演示顺序。",
          events: [
            {
              ...initialPayload.windows[0]!.events[0]!,
              summary: "老板说明天先补会议纪要，再确认演示顺序。",
              transcript: "老板说明天先补会议纪要，再确认演示顺序。",
              analysisStatus: "succeeded",
            },
          ],
        },
      ],
      highlights: {
        ...initialPayload.highlights,
        recentConversations: [
          {
            windowId: "audio-session::refresh-1",
            startedAt: 100,
            endedAt: 200,
            summary: "老板说明天先补会议纪要，再确认演示顺序。",
            transcriptExcerpt: "老板说明天先补会议纪要，再确认演示顺序。",
          },
        ],
      },
    });
    const buildAssistantContext = vi
      .fn()
      .mockResolvedValueOnce(initialPayload)
      .mockResolvedValueOnce(refreshedPayload);
    const recheckAudioEvidence = vi.fn(async () => [
      {
        windowId: "audio-session::refresh-1",
        timeRange: "00:01-00:03",
        transcript: "老板说明天先补会议纪要，再确认演示顺序。",
        analysisProvider: "primary-multimodal:runtime-primary+dashscope-stt:qwen3-asr-flash",
        artifact: {
          artifactId: "audio-refresh-1",
          fileName: "refresh.wav",
          mime: "audio/wav",
          available: true,
          sizeBytes: 4096,
          url: "http://claw/api/clawsense/artifacts?id=audio-refresh-1",
        },
      },
    ]);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext,
        recheckAudioEvidence,
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-audio-refresh", {
      scope: "today",
      focus: "what_happened",
      question: "今天会议里到底说了什么？",
    });

    expect(buildAssistantContext).toHaveBeenCalledTimes(2);
    expect(result.content[0]?.text).toContain("老板说明天先补会议纪要，再确认演示顺序。");
    expect((result.details as any).summary).toBe("今天确认了一段会议对话。");
  });

  it("stabilizes study outputs with learning points and pending speaker labels", async () => {
    const payload = createPayload({
      summary: "今天主要是上课、记笔记，并确认作业要求。",
      review: {
        reviewId: "review-study",
        date: "2026-03-19",
        generatedAt: 1,
        mode: "multimodal",
        summary: "今天主要是上课、记笔记，并确认作业要求。",
        sections: [
          { title: "Today at a glance", items: ["今天主要在课堂上整理老师讲的重点，并确认作业要求。"] },
          { title: "时间线回顾", items: ["老师反复强调实验报告的截止时间和评分标准。"] },
          { title: "关键人物", items: ["待确认老师在一段音频里补充了实验要求。"] },
          { title: "关键项目 / 主题", items: ["实验报告、课程复习。"] },
          { title: "值得注意的细节", items: ["老师特别提醒实验报告需要附上数据截图。"] },
          { title: "今天遗漏但值得追问的点", items: ["今天遗漏但值得追问的点：实验报告到底是周五中午前交，还是晚上前交？"] },
          { title: "明天建议关注的事情", items: ["明天先确认实验报告提交时间，再整理一遍课堂笔记。"] },
        ],
        keyEventIds: [],
        keyArtifactIds: [],
      },
      windows: [
        {
          windowId: "audio-session::study-1",
          deviceId: "device-1",
          startedAt: 100,
          endedAt: 200,
          primarySummary: "课堂上反复确认实验报告和评分标准",
          transcriptText: "老师说实验报告要附上数据截图，评分会看实验步骤是否完整。",
          imageCount: 1,
          audioCount: 1,
          captureContexts: ["audio-window", "active-window"],
          peopleRefs: [],
          projectRefs: [],
          tags: ["class"],
          events: [
            {
              eventId: "event-study-1",
              modality: "audio",
              capturedAt: 100,
              summary: "课堂上反复确认实验报告和评分标准",
              transcript: "老师说实验报告要附上数据截图，评分会看实验步骤是否完整。",
              captureContext: "audio-window",
              analysisMode: "runtime-stt-fallback",
              analysisProvider: "runtime+primary-multimodal:runtime-primary",
              analysisStatus: "succeeded",
            },
          ],
        },
      ],
      highlights: {
        keyWindowIds: ["audio-session::study-1"],
        recentImages: [
          {
            eventId: "image-study-1",
            capturedAt: 150,
            summary: "教室前方的投影屏上显示实验报告要求和截止时间。",
            artifact: {
              artifactId: "artifact-study-1",
              fileName: "classroom.jpg",
              mime: "image/jpeg",
              available: true,
              sizeBytes: 2048,
              url: "http://claw/api/clawsense/artifacts?id=artifact-study-1",
            },
          },
        ],
        recentConversations: [
          {
            windowId: "audio-session::study-1",
            startedAt: 100,
            endedAt: 200,
            summary: "课堂上反复确认实验报告和评分标准",
            transcriptExcerpt: "老师说实验报告要附上数据截图，评分会看实验步骤是否完整。",
          },
        ],
        people: [],
        speakers: [],
      },
    });
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-study", {
      scope: "today",
      focus: "general",
      question: "今天老师讲了哪些重点，明天要注意什么？",
    });

    expect((result.details as any).evidenceBundle.scenarioProfile.candidate).toBe("study");
    expect((result.details as any).evidenceBundle.practicalOutputs.learningPoints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("老师特别提醒实验报告需要附上数据截图"),
        expect.stringContaining("老师说实验报告要附上数据截图"),
      ]),
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.tasks).toEqual(
      expect.arrayContaining([expect.stringContaining("确认实验报告提交时间")]),
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.attentionItems).toEqual(
      expect.arrayContaining([expect.stringContaining("speaker_1")]),
    );
    expect(result.content[0]?.text).toContain("场景判断：偏课堂 / 学习场景");
    expect(result.content[0]?.text).toContain("回答优先级：优先回答学习要点、老师/同学、待确认知识点。");
    expect(result.content[0]?.text).toContain(
      "场景化回答桶：一句结论 / 课程 / 主题主线 / 学习要点 / 已确认人物 / 角色线索 / 待确认知识点",
    );
    expect(result.content[0]?.text).toContain("项目 / 主题主线：课堂主线；实验报告、课程复习。");
  });

  it("promotes transcript-derived office tasks and role hints when work audio is available", async () => {
    const payload = createPayload({
      summary: "今天主要在办公室里确认会议纪要、截图顺序和版本号。",
      review: {
        reviewId: "review-work-2",
        date: "2026-03-19",
        generatedAt: 1,
        mode: "multimodal",
        summary: "今天主要在办公室里确认会议纪要、截图顺序和版本号。",
        sections: [
          { title: "Today at a glance", items: ["今天主要在办公室里确认会议纪要、截图顺序和版本号。"] },
          { title: "时间线回顾", items: ["下午在会议室里反复确认纪要和版本号。"] },
          { title: "关键人物", items: [] },
          { title: "关键项目 / 主题", items: ["会议纪要整理。"] },
          { title: "值得注意的细节", items: ["办公室里多次提到会议纪要和截图顺序。"] },
          { title: "今天遗漏但值得追问的点", items: [] },
          { title: "明天建议关注的事情", items: [] },
        ],
        keyEventIds: [],
        keyArtifactIds: [],
      },
      windows: [
        {
          windowId: "audio-session::work-2",
          deviceId: "device-1",
          startedAt: 100,
          endedAt: 180,
          primarySummary: "办公室里在确认会议纪要、截图顺序和版本号",
          transcriptText: "老板说明天先补会议纪要，再把新版截图发给同事；同事提醒明早开会前确认版本号。",
          imageCount: 1,
          audioCount: 1,
          captureContexts: ["audio-window", "active-window"],
          peopleRefs: [],
          projectRefs: [],
          tags: ["meeting", "office"],
          events: [
            {
              eventId: "event-work-2",
              modality: "audio",
              capturedAt: 110,
              summary: "办公室里在确认会议纪要、截图顺序和版本号",
              transcript: "老板说明天先补会议纪要，再把新版截图发给同事；同事提醒明早开会前确认版本号。",
              captureContext: "audio-window",
              analysisMode: "runtime-stt-fallback",
              analysisProvider: "dashscope-stt:qwen3-asr-flash",
              analysisStatus: "succeeded",
              artifact: {
                artifactId: "audio-work-2",
                fileName: "work-2.wav",
                mime: "audio/wav",
                available: true,
                sizeBytes: 4096,
                url: "http://claw/api/clawsense/artifacts?id=audio-work-2",
              },
            },
          ],
        },
      ],
      highlights: {
        keyWindowIds: ["audio-session::work-2"],
        recentImages: [
          {
            eventId: "image-work-2",
            capturedAt: 120,
            summary: "会议室天花板和投影幕布出现在画面里。",
            artifact: {
              artifactId: "image-work-2",
              fileName: "work-2.jpg",
              mime: "image/jpeg",
              available: true,
              sizeBytes: 1024,
              url: "http://claw/api/clawsense/artifacts?id=image-work-2",
            },
          },
        ],
        recentConversations: [],
        people: [],
        speakers: [],
      },
    });
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-work-2", {
      scope: "today",
      focus: "what_happened",
      question: "今天工作里最值得注意的任务和人物是什么？",
    });

    expect((result.details as any).evidenceBundle.scenarioProfile.candidate).toBe("work");
    expect((result.details as any).evidenceBundle.practicalOutputs.tasks).toEqual(
      expect.arrayContaining([
        expect.stringContaining("补会议纪要"),
        expect.stringContaining("确认版本号"),
      ]),
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.people).toEqual(
      [],
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.roleHints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("待确认角色：老板"),
        expect.stringContaining("待确认角色：同事"),
        expect.stringContaining("待确认发言者：speaker_1"),
      ]),
    );
    expect(result.content[0]?.text).toContain("任务候选：");
    expect(result.content[0]?.text).toContain("已确认人物：当前暂无稳定身份标注。");
    expect(result.content[0]?.text).toContain("角色线索：");
  });

  it("prioritizes concrete chinese/english name hints over generic role hints", async () => {
    const payload = createPayload({
      summary: "今天围绕报价、同步和复盘安排展开。",
      review: {
        reviewId: "review-work-names",
        date: "2026-03-19",
        generatedAt: 1,
        mode: "multimodal",
        summary: "今天围绕报价、同步和复盘安排展开。",
        sections: [
          { title: "Today at a glance", items: ["今天主要在对齐报价和交付节奏。"] },
          { title: "时间线回顾", items: ["下午有一段关于报价和客户同步的对话。"] },
          { title: "关键人物", items: [] },
          { title: "关键项目 / 主题", items: ["报价确认。"] },
          { title: "值得注意的细节", items: ["对话里出现了明确的人名。"] },
          { title: "今天遗漏但值得追问的点", items: [] },
          { title: "明天建议关注的事情", items: [] },
        ],
        keyEventIds: [],
        keyArtifactIds: [],
      },
      windows: [
        {
          windowId: "audio-session::work-name-1",
          deviceId: "device-1",
          startedAt: 100,
          endedAt: 180,
          primarySummary: "会议里在确认报价和同步对象",
          transcriptText:
            "老板王磊说今天先走查报价；同事Amy提醒向客户李老师同步最终版本；老板说明天再复盘。",
          imageCount: 0,
          audioCount: 1,
          captureContexts: ["audio-window"],
          peopleRefs: [],
          projectRefs: [],
          tags: ["office"],
          events: [
            {
              eventId: "event-work-name-1",
              modality: "audio",
              capturedAt: 110,
              summary: "会议里在确认报价和同步对象",
              transcript:
                "老板王磊说今天先走查报价；同事Amy提醒向客户李老师同步最终版本；老板说明天再复盘。",
              captureContext: "audio-window",
              analysisMode: "runtime-stt-fallback",
              analysisProvider: "dashscope-stt:qwen3-asr-flash",
              analysisStatus: "succeeded",
            },
          ],
        },
      ],
      highlights: {
        keyWindowIds: ["audio-session::work-name-1"],
        audioCoverage: {
          totalAudioWindows: 1,
          transcriptReadyWindows: 1,
          pendingAudioWindows: 0,
          degradedAudioEvents: 0,
        },
        recentImages: [],
        recentConversations: [],
        people: [],
        speakers: [],
      },
    });

    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-work-name-hints", {
      scope: "today",
      focus: "what_happened",
      question: "今天涉及到哪些人物，后续要关注谁？",
    });

    expect((result.details as any).evidenceBundle.practicalOutputs.roleHints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("待确认人物：王磊"),
        expect.stringContaining("待确认人物：Amy"),
        expect.stringContaining("待确认人物：李老师"),
      ]),
    );
    expect((result.details as any).evidenceBundle.practicalOutputs.roleHints).not.toEqual(
      expect.arrayContaining([expect.stringContaining("待确认人物：说明天")]),
    );
    expect((result.details as any).responseHints.annotationSuggestions.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: "王磊", relationshipHint: "老板" }),
        expect.objectContaining({ displayName: "Amy", relationshipHint: "同事" }),
        expect.objectContaining({ displayName: "李老师", relationshipHint: "客户" }),
      ]),
    );
  });

  it("filters object and concept nouns from person annotation suggestions", async () => {
    const payload = createPayload({
      review: {
        reviewId: "review-noisy-people",
        date: "2026-03-19",
        generatedAt: 1,
        mode: "multimodal",
        summary: "今天有一些 OCR / 语音噪声和一个真实人名。",
        sections: [
          { title: "Today at a glance", items: ["今天主要在做办公验收。"] },
          { title: "时间线回顾", items: ["晚上有一段短对话。"] },
          {
            title: "关键人物",
            items: [
              "待确认人物：构造（20:52-20:57 音频线索）",
              "待确认人物：纸箱（21:53-21:54 事件线索）",
              "待确认人物：王磊（角色：老板；20:52-20:57 音频线索）",
              "待确认对话对象（在技术故障时询问“我可以直接帮你吗”），需确认其身份是同事还是AI助手。",
            ],
          },
          { title: "关键项目 / 主题", items: ["验收。"] },
          { title: "值得注意的细节", items: ["存在普通名词被误提取的风险。"] },
          { title: "今天遗漏但值得追问的点", items: [] },
          { title: "明天建议关注的事情", items: [] },
        ],
        keyEventIds: [],
        keyArtifactIds: [],
      },
    });
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence: vi.fn(async () => []),
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    const result = await tool.execute("tool-noisy-people", {
      scope: "today",
      focus: "what_happened",
      question: "今天有哪些人物线索？",
    });
    const people = (result.details as any).responseHints.annotationSuggestions.people;

    expect(people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: "王磊", relationshipHint: "老板" }),
      ]),
    );
    expect(people).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: "构造" }),
        expect.objectContaining({ displayName: "纸箱" }),
        expect.objectContaining({ displayName: "还是" }),
      ]),
    );
  });

  it("expands query-time audio review windows for office and classroom questions", async () => {
    const payload = createPayload({
      windows: [
        createPayload().windows[0],
        {
          ...createPayload().windows[0],
          windowId: "audio-session::2",
          startedAt: 210,
          endedAt: 260,
          transcriptText: "",
          primarySummary: "第二段会议窗口仍待确认",
          events: [
            {
              ...createPayload().windows[0].events[0],
              eventId: "event-2",
              capturedAt: 220,
              summary: "第二段会议窗口仍待确认",
              transcript: "",
              analysisStatus: "degraded",
            },
          ],
        },
        {
          ...createPayload().windows[0],
          windowId: "audio-session::3",
          startedAt: 270,
          endedAt: 320,
          transcriptText: "",
          primarySummary: "第三段课堂窗口仍待确认",
          events: [
            {
              ...createPayload().windows[0].events[0],
              eventId: "event-3",
              capturedAt: 280,
              summary: "第三段课堂窗口仍待确认",
              transcript: "",
              analysisStatus: "degraded",
            },
          ],
        },
      ],
      highlights: {
        ...createPayload().highlights,
        audioCoverage: {
          totalAudioWindows: 3,
          transcriptReadyWindows: 1,
          pendingAudioWindows: 2,
          degradedAudioEvents: 2,
        },
      },
    });
    const recheckAudioEvidence = vi.fn(async () => []);
    const tool = createClawSenseContextTool({
      reviewEngine: {
        normalizeDateInput: vi.fn(() => "2026-03-19"),
        buildAssistantContext: vi.fn(async () => payload),
        recheckAudioEvidence,
      } as any,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    });

    await tool.execute("tool-work-wide", {
      scope: "today",
      focus: "general",
      question: "今天最值得注意的任务和人物是什么？",
    });

    expect(recheckAudioEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        maxWindows: 2,
      }),
    );
  });
});

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    scope: "today",
    date: "2026-03-19",
    startAt: 0,
    endAt: 1,
    counts: { events: 3, windows: 1, artifacts: 2, devices: 1 },
    summary: "今天主要围绕明天演示准备和一段待确认的对话展开。",
    recentActivity: {
      lookbackDays: 7,
      priorEventCount: 2,
      priorWindowCount: 1,
      priorActiveDays: 1,
      lastSeenAt: new Date("2026-03-18T21:30:00+08:00").getTime(),
      lastSeenDate: "2026-03-18",
      sampleWindows: [],
    },
    review: {
      reviewId: "review-1",
      date: "2026-03-19",
      generatedAt: 1,
      mode: "multimodal",
      summary: "今天主要围绕明天演示准备和一段待确认的对话展开。",
      sections: [
        { title: "Today at a glance", items: ["今天主要在准备明天的产品演示。"] },
        { title: "时间线回顾", items: ["下午花了较多时间确认演示开场和截图顺序。"] },
        { title: "关键人物", items: ["一位待确认同事参与了演示讨论。"] },
        { title: "关键项目 / 主题", items: ["产品演示准备。"] },
        { title: "值得注意的细节", items: ["桌面截图和开场顺序被反复提到。"] },
        { title: "今天遗漏但值得追问的点", items: ["今天遗漏但值得追问的点：这位同事具体负责哪一部分演示？"] },
        { title: "明天建议关注的事情", items: ["明天先确认演示截图顺序，再检查开场是否自然。"] },
      ],
      keyEventIds: [],
      keyArtifactIds: [],
    },
    rollingDigests: [],
    memoryCards: [],
    windows: [
      {
        windowId: "audio-session::1",
        deviceId: "device-1",
        startedAt: 100,
        endedAt: 200,
        primarySummary: "讨论明天演示的开场和截图顺序",
        transcriptText: "明天先讲价值主张，再切到关键截图。",
        imageCount: 1,
        videoCount: 0,
        audioCount: 1,
        captureContexts: ["audio-window", "active-window"],
        peopleRefs: [],
        projectRefs: [],
        tags: ["demo"],
        events: [
          {
            eventId: "event-1",
            modality: "audio",
            capturedAt: 100,
            summary: "讨论明天演示的开场和截图顺序",
            transcript: "明天先讲价值主张，再切到关键截图。",
            captureContext: "audio-window",
            analysisMode: "runtime-stt-fallback",
            analysisProvider: "runtime+primary-multimodal:runtime-primary",
            analysisStatus: "succeeded",
            artifact: {
              artifactId: "audio-clip-1",
              fileName: "capture-1.wav",
              mime: "audio/wav",
              available: true,
              sizeBytes: 4096,
              url: "http://claw/api/clawsense/artifacts?id=audio-clip-1",
            },
          },
        ],
      },
    ],
    highlights: {
      keyWindowIds: ["audio-session::1"],
      audioCoverage: {
        totalAudioWindows: 1,
        transcriptReadyWindows: 1,
        pendingAudioWindows: 0,
        degradedAudioEvents: 0,
      },
      recentImages: [
        {
          eventId: "image-1",
          capturedAt: 150,
          summary: "桌面上放着演示提纲和截图草稿。",
          artifact: {
            artifactId: "artifact-1",
            fileName: "demo.jpg",
            mime: "image/jpeg",
            available: true,
            sizeBytes: 2048,
            url: "http://claw/api/clawsense/artifacts?id=artifact-1",
          },
        },
      ],
      recentConversations: [
        {
          windowId: "audio-session::1",
          startedAt: 100,
          endedAt: 200,
          summary: "讨论明天演示的开场和截图顺序",
          transcriptExcerpt: "明天先讲价值主张，再切到关键截图。",
        },
      ],
      people: [
        {
          personRef: "person-1",
          displayName: "待确认同事",
          nextWatchFor: "确认他负责的演示片段是否已经定稿。",
        },
      ],
      speakers: [
        {
          speakerRef: "speaker:audio-session::1:1",
          displayName: "Amy",
          relationship: "老板",
          windowId: "audio-session::1",
          deviceId: "device-1",
        },
      ],
    },
    ...overrides,
  };
}
