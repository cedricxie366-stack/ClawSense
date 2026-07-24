import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClawSenseStateStore, toLocalDateKey, type ClawSenseMemoryCard } from "../src/state-store.js";
import { issueSetupToken } from "../src/utils.js";

describe("ClawSenseStateStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-state-test-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const createStore = () =>
    new ClawSenseStateStore({
      resolveStateDir: () => rootDir,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

  it("consumes setup token only once", async () => {
    const store = createStore();
    const token = issueSetupToken(600);
    await store.upsertSetupToken(token);

    const first = await store.consumeSetupToken(token.token);
    const second = await store.consumeSetupToken(token.token);

    expect(first?.tokenHash).toBe(token.tokenHash);
    expect(second).toBeNull();
  });

  it("returns expired setup token metadata so callers can report expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T10:00:00+08:00"));
    const store = createStore();
    const token = issueSetupToken(1);
    await store.upsertSetupToken(token);

    vi.setSystemTime(new Date("2026-04-24T10:00:02+08:00"));
    const consumed = await store.consumeSetupToken(token.token);

    expect(consumed?.tokenHash).toBe(token.tokenHash);
    expect(consumed?.expiresAt).toBeLessThanOrEqual(Date.now());
    expect(await store.listSetupTokens()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("registers device without persisting plain secret", async () => {
    const store = createStore();

    const created = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const listed = await store.listDevices();

    expect(created.plainSecret).toBeTruthy();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.plainSecret).toBeUndefined();
    expect(listed[0]?.secretHash).toBeTruthy();
  });

  it("reuses the same device record for repeat pairing on the same fingerprint", async () => {
    const store = createStore();

    const first = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
      appVersion: "0.1.0",
      fingerprint: "brand:model:device:35",
    });
    const second = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
      appVersion: "0.1.1",
      fingerprint: "brand:model:device:35",
    });
    const listed = await store.listDevices();

    expect(listed).toHaveLength(1);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.plainSecret).toBeTruthy();
    expect(second.plainSecret).not.toBe(first.plainSecret);
    expect(listed[0]?.appVersion).toBe("0.1.1");
    expect(listed[0]?.secretHash).toBe(second.secretHash);
  });

  it("persists speaker annotations for later audio labeling", async () => {
    const store = createStore();

    const first = await store.upsertSpeakerAnnotation({
      speakerRef: "speaker:audio-session::1:1",
      displayName: "Amy",
      relationship: "老板",
      windowId: "audio-session::1",
      deviceId: "device-1",
    });
    const second = await store.upsertSpeakerAnnotation({
      speakerRef: "speaker:audio-session::1:1",
      displayName: "Amy",
      notes: "在周会里经常先发言。",
      eventIds: ["event-1"],
    });

    const listed = await store.listSpeakers();

    expect(listed).toHaveLength(1);
    expect(second.annotationId).toBe(first.annotationId);
    expect(listed[0]?.displayName).toBe("Amy");
    expect(listed[0]?.relationship).toBe("老板");
    expect(listed[0]?.notes).toContain("经常先发言");
    expect(listed[0]?.eventIds).toContain("event-1");
  });

  it("backfills audio transcripts into events and invalidates the cached daily review", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const capturedAt = Date.UTC(2026, 2, 10, 18, 0, 0);
    const created = await store.recordCapture({
      memoryId: "audio-backfill-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: "/tmp/audio-backfill-1.wav",
      fileName: "audio-backfill-1.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/pdem10/audio-backfill-1.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    await store.putDailyReview({
      reviewId: "review-1",
      date: toLocalDateKey(capturedAt),
      generatedAt: capturedAt + 5_000,
      mode: "heuristic",
      summary: "旧回顾",
      sections: [],
      keyEventIds: [created.event.eventId],
      keyArtifactIds: [created.artifact.artifactId],
    });
    await store.putDailyConsolidation({
      consolidationId: "consolidation-1",
      date: toLocalDateKey(capturedAt),
      generatedAt: capturedAt + 5_000,
      sourceReviewId: "review-1",
      summary: "旧 consolidation",
      keyInsights: ["旧洞察"],
      tasks: ["旧任务"],
      attentionItems: ["旧缺口"],
      learningPoints: [],
      keyWindowIds: [created.event.windowId],
      people: [],
      projects: [],
      stats: {
        windowCount: 1,
        eventCount: 1,
        audioWindowCount: 1,
        transcriptReadyWindows: 0,
        imageCount: 0,
        audioCount: 1,
        degradedEventCount: 1,
      },
    });

    const backfilled = await store.backfillCaptureAnalysis({
      artifactId: created.artifact.artifactId,
      summary: "和老板确认明天先补会议纪要，再调整演示顺序。",
      transcript: "老板说明天先补会议纪要，再确认演示顺序。",
      analysisProvider: "primary-multimodal:runtime-primary+dashscope-stt:qwen3-asr-flash",
      analysisStatus: "succeeded",
      sttProvider: "compatible-fallback",
    });

    const events = await store.listEventsByDate(toLocalDateKey(capturedAt));
    const journal = await store.listJournal();
    const review = await store.getDailyReview(toLocalDateKey(capturedAt));
    const consolidation = await store.getDailyConsolidation(toLocalDateKey(capturedAt));

    expect(backfilled.updated).toBe(true);
    expect(events[0]?.transcript).toContain("老板说明天先补会议纪要");
    expect(events[0]?.analysisStatus).toBe("succeeded");
    expect(events[0]?.analysisFailureReason).toBeUndefined();
    expect(events[0]?.sttProvider).toBe("compatible-fallback");
    expect(events[0]?.projectRefs).toEqual(expect.arrayContaining(["meeting_notes", "demo_prep"]));
    expect(events[0]?.tags).toEqual(expect.arrayContaining(["office", "meeting-notes", "demo"]));
    expect(journal[0]?.transcript).toContain("老板说明天先补会议纪要");
    expect(review).toBeNull();
    expect(consolidation).toBeNull();
  });

  it("derives study-facing project refs and tags during initial capture", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const capturedAt = Date.UTC(2026, 2, 11, 9, 0, 0);

    const created = await store.recordCapture({
      memoryId: "audio-study-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "老师提醒先完成实验报告，再准备周五考试复习。",
      transcript: "老师提醒先完成实验报告，再准备周五考试复习。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: "/tmp/audio-study-1.wav",
      fileName: "audio-study-1.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/11/pdem10/audio-study-1.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
    });

    expect(created.event.projectRefs).toEqual(expect.arrayContaining(["lab_work", "exam_prep"]));
    expect(created.event.tags).toEqual(expect.arrayContaining(["study", "experiment", "exam"]));
  });

  it("derives office product project refs from AI coaching meeting transcripts", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const capturedAt = Date.UTC(2026, 5, 25, 10, 0, 0);

    const created = await store.recordCapture({
      memoryId: "audio-ai-coaching-projects",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "AI 陪练系统需求评审，讨论真实语料同步、考核点、报表优化和海南物流培训安排。",
      transcript:
        "AI 陪练要支持聊天记录语料同步，后续还要确认考核点通过率、缺陷项报表优化，以及海南物流培训里的工单流程和角色讲解。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: "/tmp/audio-ai-coaching-projects.wav",
      fileName: "audio-ai-coaching-projects.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/06/25/pdem10/audio-ai-coaching-projects.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
    });

    expect(created.event.projectRefs).toEqual(
      expect.arrayContaining([
        "ai_coaching",
        "corpus_sync",
        "assessment_rubric",
        "ai_report_optimization",
        "training_arrangement",
      ]),
    );
    expect(created.event.tags).toEqual(
      expect.arrayContaining(["office", "ai-coaching", "corpus", "assessment", "ai-report", "training-plan"]),
    );
    expect(created.event.tags).not.toContain("social");
  });

  it("refreshes stale event semantic refs only when explicitly applied", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const capturedAt = Date.UTC(2026, 5, 25, 10, 0, 0);
    const date = toLocalDateKey(capturedAt);
    const created = await store.recordCapture({
      memoryId: "audio-stale-semantic-refs",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "AI 陪练系统需求评审，讨论真实语料同步和考核点。",
      transcript: "AI 陪练要支持聊天记录语料同步，并确认考核点通过率和缺陷项报表优化。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: "/tmp/audio-stale-semantic-refs.wav",
      fileName: "audio-stale-semantic-refs.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/06/25/pdem10/audio-stale-semantic-refs.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
      analysisStatus: "succeeded",
    });

    const statePath = path.join(rootDir, "plugins", "clawsense", "state.json");
    const staleState = JSON.parse(await fs.readFile(statePath, "utf8"));
    staleState.events = staleState.events.map((event: { eventId: string; projectRefs?: string[]; tags?: string[] }) =>
      event.eventId === created.event.eventId
        ? {
            ...event,
            projectRefs: [],
            tags: ["audio-window"],
          }
        : event,
    );
    staleState.reviews = [
      {
        reviewId: "cached-review",
        date,
        generatedAt: capturedAt,
        mode: "heuristic",
        summary: "cached",
        sections: [],
        keyEventIds: [],
        keyArtifactIds: [],
      },
    ];
    staleState.consolidations = [
      {
        consolidationId: "cached-consolidation",
        date,
        generatedAt: capturedAt,
        summary: "cached",
        keyInsights: [],
        tasks: [],
        attentionItems: [],
        learningPoints: [],
        keyWindowIds: [],
        people: [],
        projects: [],
        stats: {
          windowCount: 0,
          eventCount: 0,
          audioWindowCount: 0,
          transcriptReadyWindows: 0,
          imageCount: 0,
          audioCount: 0,
          degradedEventCount: 0,
        },
      },
    ];
    await fs.writeFile(statePath, `${JSON.stringify(staleState, null, 2)}\n`, "utf8");

    const dryRun = await store.refreshEventSemanticSignals({ date, apply: false });
    expect(dryRun.changedEvents).toBe(1);
    expect(dryRun.sampleChanges[0]?.nextProjectRefs).toEqual(
      expect.arrayContaining(["ai_coaching", "corpus_sync", "assessment_rubric", "ai_report_optimization"]),
    );
    expect((await store.listEvents())[0]?.projectRefs).toEqual([]);

    const applied = await store.refreshEventSemanticSignals({ date, apply: true });
    const [updated] = await store.listEvents();
    expect(applied.changedEvents).toBe(1);
    expect(applied.invalidatedDates).toEqual([date]);
    expect(updated?.projectRefs).toEqual(
      expect.arrayContaining(["ai_coaching", "corpus_sync", "assessment_rubric", "ai_report_optimization"]),
    );

    const appliedState = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(appliedState.reviews).toEqual([]);
    expect(appliedState.consolidations).toEqual([]);
  });

  it("adds video and keyframe semantic tags when video request markers are present", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const capturedAt = Date.UTC(2026, 2, 11, 19, 30, 0);

    const created = await store.recordCapture({
      memoryId: "video-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "video",
      summary: "会议室里两位同事在投影前讨论上线清单。",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: "/tmp/video-1.mp4",
      fileName: "video-1.mp4",
      mime: "video/mp4",
      sizeBytes: 4096,
      storageRelPath: "2026/03/11/pdem10/video-1.mp4",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      note: "active-window videoRequestId=req-1 videoKeyframe=1 keyframe=2",
      analysisMode: "metadata-only",
      analysisStatus: "degraded",
      analysisFailureReason: "video_analysis_disabled_by_mode",
    });

    expect(created.event.tags).toEqual(
      expect.arrayContaining(["video", "video-request", "video-keyframe", "office", "launch"]),
    );
    expect(created.event.projectRefs).toEqual(expect.arrayContaining(["launch_checklist"]));
  });

  it("records audio backfill attempts even when no transcript was recovered", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const capturedAt = Date.UTC(2026, 2, 10, 18, 30, 0);
    const created = await store.recordCapture({
      memoryId: "audio-backfill-failed-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "Audio captured, but primary multimodal audio analysis failed.",
      transcript: "",
      createdAt: capturedAt,
      capturedAt,
      sourcePath: "/tmp/audio-backfill-failed-1.wav",
      fileName: "audio-backfill-failed-1.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/pdem10/audio-backfill-failed-1.wav",
      retentionExpiresAt: capturedAt + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt-fallback",
      analysisStatus: "degraded",
      analysisFailureReason: "runtime_stt_empty|primary_multimodal_error",
    });

    const attempt = await store.noteAudioBackfillAttempt({
      artifactId: created.artifact.artifactId,
      analysisProvider: "dashscope-stt:qwen3-asr-flash",
      analysisFailureReason: "query_time_asr_empty",
      attemptedAt: capturedAt + 1_000,
    });
    const events = await store.listEventsByDate(toLocalDateKey(capturedAt));

    expect(attempt.updated).toBe(true);
    expect(events[0]?.transcript).toBe("");
    expect(events[0]?.lastAudioBackfillAttemptAt).toBe(capturedAt + 1_000);
    expect(events[0]?.audioBackfillAttemptCount).toBe(1);
    expect(events[0]?.analysisProvider).toBe("dashscope-stt:qwen3-asr-flash");
    expect(events[0]?.analysisFailureReason).toBe("query_time_asr_empty");
  });

  it("stores and retrieves daily consolidation snapshots", async () => {
    const store = createStore();
    await store.putDailyConsolidation({
      consolidationId: "con-2026-03-12",
      date: "2026-03-12",
      generatedAt: Date.UTC(2026, 2, 12, 22, 0, 0),
      sourceReviewId: "review-2026-03-12",
      summary: "今天主要围绕课堂复习和作业确认展开。",
      keyInsights: ["课堂上明确了复习重点。"],
      tasks: ["今晚先完成实验报告。"],
      attentionItems: ["还需要确认作业截止时间。"],
      learningPoints: ["复习主线：考试重点整理。"],
      keyWindowIds: ["window-1"],
      people: [
        {
          personRef: "person_teacher",
          displayName: "王老师",
          relationship: "老师",
          status: "confirmed",
          evidenceCount: 2,
        },
      ],
      projects: [
        {
          ref: "exam_prep",
          label: "考试复习",
          source: "project-ref",
          evidenceCount: 2,
          windowIds: ["window-1"],
        },
      ],
      stats: {
        windowCount: 2,
        eventCount: 3,
        audioWindowCount: 1,
        transcriptReadyWindows: 1,
        imageCount: 1,
        audioCount: 2,
        degradedEventCount: 0,
      },
    });

    const loaded = await store.getDailyConsolidation("2026-03-12");
    const listed = await store.listDailyConsolidations();

    expect(loaded?.summary).toContain("课堂复习");
    expect(loaded?.projects[0]?.ref).toBe("exam_prep");
    expect(listed).toHaveLength(1);
  });

  it("stores searchable conversation digest snapshots", async () => {
    const store = createStore();
    const first = {
      digestId: "digest-2026-06-25",
      date: "2026-06-25",
      scope: "today" as const,
      startAt: Date.UTC(2026, 5, 25, 0, 0, 0),
      endAt: Date.UTC(2026, 5, 26, 0, 0, 0),
      generatedAt: Date.UTC(2026, 5, 25, 12, 0, 0),
      sourceEventCount: 20,
      sourceWindowCount: 3,
      transcriptWindowCount: 2,
      summary: "6月25日持久化会议索引。",
      topicIndex: [
        {
          index: 1,
          windowId: "audio-session::meeting-1",
          timeRange: "09:58-10:15",
          title: "AI 陪练与剧本",
          summary: "讨论 AI 陪练剧本生成。",
          keywordHints: ["AI陪练", "剧本"],
          taskHints: ["产品团队需要确认接口方案。"],
          transcriptExcerpt: "来介绍一下 AI 陪练相关的功能。",
        },
      ],
      keywordIndex: [
        {
          keyword: "AI陪练",
          topicIndexes: [1],
        },
      ],
    };
    await store.putConversationDigest(first);
    await store.putConversationDigest({
      ...first,
      generatedAt: first.generatedAt + 1_000,
      summary: "更新后的索引。",
    });

    const listed = await store.listConversationDigests({
      date: "2026-06-25",
      startAt: Date.UTC(2026, 5, 25, 8, 0, 0),
      endAt: Date.UTC(2026, 5, 25, 12, 0, 0),
    });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.summary).toBe("更新后的索引。");
    expect(listed[0]?.topicIndex[0]?.keywordHints).toEqual(["AI陪练", "剧本"]);
  });

  it("stores filterable long-term memory cards", async () => {
    const store = createStore();
    const startAt = Date.UTC(2026, 5, 25, 9, 58, 0);
    const endAt = Date.UTC(2026, 5, 25, 10, 15, 0);
    await store.putMemoryCards([
      {
        cardId: "memcard-task-1",
        date: "2026-06-25",
        scope: "custom-range",
        kind: "task",
        title: "产品团队需要确认接口方案",
        summary: "任务线索来自第 1 段。",
        status: "active",
        confidence: "medium",
        startAt,
        endAt,
        lastSeenAt: endAt,
        createdAt: startAt,
        updatedAt: endAt,
        keywords: ["任务", "接口"],
        source: "rolling-digest",
        evidence: {
          digestId: "digest-1",
          topicIndexes: [1],
          windowIds: ["audio-session::meeting-1"],
          timeRanges: ["09:58-10:15"],
          taskHints: ["产品团队需要确认接口方案。"],
          transcriptExcerpts: ["来介绍一下 AI 陪练相关的功能。"],
        },
      },
      {
        cardId: "memcard-topic-1",
        date: "2026-06-25",
        scope: "custom-range",
        kind: "topic",
        title: "AI 陪练与剧本",
        summary: "话题索引第 1 段。",
        status: "active",
        confidence: "medium",
        startAt,
        endAt,
        lastSeenAt: endAt,
        createdAt: startAt,
        updatedAt: endAt,
        keywords: ["AI陪练"],
        source: "rolling-digest",
        evidence: {
          digestId: "digest-1",
          topicIndexes: [1],
          windowIds: ["audio-session::meeting-1"],
          timeRanges: ["09:58-10:15"],
          taskHints: [],
          transcriptExcerpts: ["来介绍一下 AI 陪练相关的功能。"],
        },
      },
    ]);

    const all = await store.listMemoryCards({
      date: "2026-06-25",
      startAt: Date.UTC(2026, 5, 25, 9, 0, 0),
      endAt: Date.UTC(2026, 5, 25, 11, 0, 0),
    });
    const tasks = await store.listMemoryCards({
      date: "2026-06-25",
      kind: "task",
    });

    expect(all.map((card) => card.kind)).toEqual(["task", "topic"]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toContain("接口方案");
  });

  it("merges semantically duplicate memory cards while preserving evidence", async () => {
    const store = createStore();
    const startAt = Date.UTC(2026, 5, 25, 9, 58, 0);
    const middleAt = Date.UTC(2026, 5, 25, 10, 8, 0);
    const endAt = Date.UTC(2026, 5, 25, 10, 15, 0);
    const firstCard: ClawSenseMemoryCard = {
      cardId: "memcard-task-old",
      date: "2026-06-25",
      scope: "custom-range",
      kind: "task",
      title: "产品团队需要确认接口方案",
      summary: "任务线索来自第 1 段。",
      status: "active",
      confidence: "low",
      startAt,
      endAt: middleAt,
      lastSeenAt: middleAt,
      createdAt: startAt,
      updatedAt: middleAt,
      keywords: ["任务", "接口"],
      source: "rolling-digest",
      evidence: {
        digestId: "digest-old",
        topicIndexes: [1],
        windowIds: ["audio-session::meeting-1"],
        timeRanges: ["09:58-10:08"],
        taskHints: ["产品团队需要确认接口方案。"],
        transcriptExcerpts: ["需要确认接口字段。"],
      },
    };
    const secondCard: ClawSenseMemoryCard = {
      ...firstCard,
      cardId: "memcard-task-new",
      summary: "任务线索来自第 2 段，补充了 API 输出方式。",
      confidence: "medium",
      startAt: middleAt,
      endAt,
      lastSeenAt: endAt,
      createdAt: middleAt,
      updatedAt: endAt,
      keywords: ["任务", "API"],
      evidence: {
        digestId: "digest-new",
        topicIndexes: [2],
        windowIds: ["audio-session::meeting-2"],
        timeRanges: ["10:08-10:15"],
        taskHints: ["提供 API 输出方案。"],
        transcriptExcerpts: ["或者我们提供 API 出来。"],
      },
    };

    await store.putMemoryCards([firstCard]);
    await store.putMemoryCards([secondCard]);

    const cards = await store.listMemoryCards({ date: "2026-06-25", kind: "task" });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(
      expect.objectContaining({
        cardId: "memcard-task-old",
        title: "产品团队需要确认接口方案",
        confidence: "medium",
        startAt,
        endAt,
        createdAt: startAt,
        updatedAt: endAt,
        lastSeenAt: endAt,
      }),
    );
    expect(cards[0]?.keywords).toEqual(["任务", "接口", "API"]);
    expect(cards[0]?.evidence.digestId).toBe("digest-new");
    expect(cards[0]?.evidence.topicIndexes).toEqual([1, 2]);
    expect(cards[0]?.evidence.windowIds).toEqual(["audio-session::meeting-1", "audio-session::meeting-2"]);
    expect(cards[0]?.evidence.timeRanges).toEqual(["09:58-10:08", "10:08-10:15"]);
    expect(cards[0]?.evidence.taskHints).toEqual(["产品团队需要确认接口方案。", "提供 API 输出方案。"]);
    expect(cards[0]?.evidence.transcriptExcerpts).toEqual(["需要确认接口字段。", "或者我们提供 API 出来。"]);
  });

  it("groups audio and nearby images into the same event window", async () => {
    const store = createStore();

    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 10, 0, 0);

    const firstAudio = await store.recordCapture({
      memoryId: "audio-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "meeting started",
      createdAt: baseTime,
      capturedAt: baseTime,
      sourcePath: "/tmp/a1.wav",
      fileName: "100000-audio-a1.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/pdem10/100000-audio-a1.wav",
      retentionExpiresAt: baseTime + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
    });

    const secondAudio = await store.recordCapture({
      memoryId: "audio-2",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "meeting continued",
      createdAt: baseTime + 10_000,
      capturedAt: baseTime + 10_000,
      sourcePath: "/tmp/a2.wav",
      fileName: "100010-audio-a2.wav",
      mime: "audio/wav",
      sizeBytes: 1024,
      storageRelPath: "2026/03/10/pdem10/100010-audio-a2.wav",
      retentionExpiresAt: baseTime + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "runtime-stt",
    });

    const activeImage = await store.recordCapture({
      memoryId: "image-1",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "image",
      summary: "conversation snapshot",
      createdAt: baseTime + 60_000,
      capturedAt: baseTime + 60_000,
      sourcePath: "/tmp/i1.jpg",
      fileName: "100100-image-i1.jpg",
      mime: "image/jpeg",
      sizeBytes: 2048,
      storageRelPath: "2026/03/10/pdem10/100100-image-i1.jpg",
      retentionExpiresAt: baseTime + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "multimodal-preview",
    });

    const baselineImage = await store.recordCapture({
      memoryId: "image-2",
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "image",
      summary: "baseline snapshot",
      createdAt: baseTime + 5 * 60_000,
      capturedAt: baseTime + 5 * 60_000,
      sourcePath: "/tmp/i2.jpg",
      fileName: "100500-image-i2.jpg",
      mime: "image/jpeg",
      sizeBytes: 2048,
      storageRelPath: "2026/03/10/pdem10/100500-image-i2.jpg",
      retentionExpiresAt: baseTime + 7 * 24 * 60 * 60 * 1000,
      analysisMode: "multimodal-preview",
    });

    const events = await store.listEventsByDate(toLocalDateKey(baseTime));

    expect(events).toHaveLength(4);
    expect(secondAudio.event.windowId).toBe(firstAudio.event.windowId);
    expect(activeImage.event.windowId).toBe(firstAudio.event.windowId);
    expect(activeImage.event.captureContext).toBe("active-window");
    expect(baselineImage.event.windowId).not.toBe(firstAudio.event.windowId);
    expect(baselineImage.event.captureContext).toBe("baseline-snapshot");
  });

  it("keeps a conversation window alive when an active image lands between audio captures", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 11, 0, 0);

    const firstAudio = await recordCapture(store, {
      memoryId: "audio-bridge-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "planning kickoff",
      capturedAt: baseTime,
    });
    const activeImage = await recordCapture(store, {
      memoryId: "image-bridge-1",
      deviceId: device.deviceId,
      modality: "image",
      summary: "whiteboard snapshot",
      capturedAt: baseTime + 90_000,
    });
    const laterAudio = await recordCapture(store, {
      memoryId: "audio-bridge-2",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "follow-up question",
      capturedAt: baseTime + 110_000,
    });

    expect(activeImage.event.windowId).toBe(firstAudio.event.windowId);
    expect(laterAudio.event.windowId).toBe(firstAudio.event.windowId);
    expect(laterAudio.event.captureContext).toBe("audio-window");
  });

  it("keeps successive active images attached to the same live conversation window", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 12, 0, 0);

    const audio = await recordCapture(store, {
      memoryId: "audio-live-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "desk conversation",
      capturedAt: baseTime,
    });
    const firstImage = await recordCapture(store, {
      memoryId: "image-live-1",
      deviceId: device.deviceId,
      modality: "image",
      summary: "first desk snapshot",
      capturedAt: baseTime + 100_000,
    });
    const secondImage = await recordCapture(store, {
      memoryId: "image-live-2",
      deviceId: device.deviceId,
      modality: "image",
      summary: "second desk snapshot",
      capturedAt: baseTime + 150_000,
    });

    expect(firstImage.event.windowId).toBe(audio.event.windowId);
    expect(secondImage.event.windowId).toBe(audio.event.windowId);
    expect(secondImage.event.captureContext).toBe("active-window");
  });

  it("keeps a longer spoken conversation in one window across multi-minute audio slices", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 12, 30, 0);

    const firstAudio = await recordCapture(store, {
      memoryId: "audio-long-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation start",
      capturedAt: baseTime,
    });
    const secondAudio = await recordCapture(store, {
      memoryId: "audio-long-2",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation continued",
      capturedAt: baseTime + 3 * 60_000,
    });
    const thirdAudio = await recordCapture(store, {
      memoryId: "audio-long-3",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation wrap-up",
      capturedAt: baseTime + 6 * 60_000,
    });

    expect(secondAudio.event.windowId).toBe(firstAudio.event.windowId);
    expect(thirdAudio.event.windowId).toBe(firstAudio.event.windowId);
  });

  it("keeps same csAudio:v2 session clips in one window even across max-duration boundaries", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 14, 0, 0);

    const firstAudio = await recordCapture(store, {
      memoryId: "audio-session-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation segment 1",
      capturedAt: baseTime,
      note: `csAudio:v2 session=session-123 segment=1 sessionStart=${baseTime} boundary=max-duration clipMs=15000 voicedMs=9200 continued=1`,
    });
    const secondAudio = await recordCapture(store, {
      memoryId: "audio-session-2",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation segment 2",
      capturedAt: baseTime + 6 * 60_000,
      note: `csAudio:v2 session=session-123 segment=2 sessionStart=${baseTime} boundary=max-duration clipMs=15000 voicedMs=10100 continued=1`,
    });
    const thirdAudio = await recordCapture(store, {
      memoryId: "audio-session-3",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation segment 3",
      capturedAt: baseTime + 12 * 60_000,
      note: `csAudio:v2 session=session-123 segment=3 sessionStart=${baseTime} boundary=silence clipMs=9000 voicedMs=6400 continued=1`,
    });

    expect(secondAudio.event.windowId).toBe(firstAudio.event.windowId);
    expect(thirdAudio.event.windowId).toBe(firstAudio.event.windowId);
  });

  it("starts a new window when a fresh csAudio:v2 session begins within the legacy gap", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 14, 15, 0);

    const firstAudio = await recordCapture(store, {
      memoryId: "audio-session-split-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation A",
      capturedAt: baseTime,
      note: `csAudio:v2 session=session-A segment=1 sessionStart=${baseTime} boundary=silence clipMs=12000 voicedMs=8400 continued=0`,
    });
    const secondAudio = await recordCapture(store, {
      memoryId: "audio-session-split-2",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation B",
      capturedAt: baseTime + 2 * 60_000,
      note: `csAudio:v2 session=session-B segment=1 sessionStart=${baseTime + 2 * 60_000} boundary=silence clipMs=11000 voicedMs=7900 continued=0`,
    });

    expect(secondAudio.event.windowId).not.toBe(firstAudio.event.windowId);
  });

  it("does not merge a fresh csAudio:v2 session back into a nearby active window", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 14, 22, 0);

    const firstAudio = await recordCapture(store, {
      memoryId: "audio-session-active-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation A",
      capturedAt: baseTime,
      note: `csAudio:v2 session=session-A segment=1 sessionStart=${baseTime} boundary=max-duration clipMs=12000 voicedMs=8400 continued=1`,
    });
    const image = await recordCapture(store, {
      memoryId: "audio-session-active-image",
      deviceId: device.deviceId,
      modality: "image",
      summary: "whiteboard snapshot",
      capturedAt: baseTime + 60_000,
    });
    const secondAudio = await recordCapture(store, {
      memoryId: "audio-session-active-2",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "conversation B",
      capturedAt: baseTime + 2 * 60_000,
      note: `csAudio:v2 session=session-B segment=1 sessionStart=${baseTime + 2 * 60_000} boundary=silence clipMs=11000 voicedMs=7900 continued=0`,
    });

    expect(image.event.windowId).toBe(firstAudio.event.windowId);
    expect(secondAudio.event.windowId).not.toBe(firstAudio.event.windowId);
  });

  it("falls back to legacy gap rules when csAudio:v2 note is malformed", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 14, 30, 0);

    const firstAudio = await recordCapture(store, {
      memoryId: "audio-bad-note-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "first clip",
      capturedAt: baseTime,
      note: "csAudio:v2 boundary=max-duration continued=1",
    });
    const laterAudio = await recordCapture(store, {
      memoryId: "audio-bad-note-2",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "later clip",
      capturedAt: baseTime + 5 * 60_000,
      note: "csAudio:v2 boundary=max-duration continued=1",
    });

    expect(laterAudio.event.windowId).not.toBe(firstAudio.event.windowId);
  });

  it("splits a conversation window after a longer idle gap", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 12, 45, 0);

    const firstAudio = await recordCapture(store, {
      memoryId: "audio-gap-1",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "first exchange",
      capturedAt: baseTime,
    });
    const laterAudio = await recordCapture(store, {
      memoryId: "audio-gap-2",
      deviceId: device.deviceId,
      modality: "audio",
      summary: "separate exchange",
      capturedAt: baseTime + 5 * 60_000,
    });

    expect(laterAudio.event.windowId).not.toBe(firstAudio.event.windowId);
  });

  it("groups nearby passive snapshots into a baseline window and splits distant ones", async () => {
    const store = createStore();
    const device = await store.registerDevice({
      name: "PDEM10",
      platform: "android",
    });
    const baseTime = Date.UTC(2026, 2, 10, 13, 0, 0);

    const firstBaseline = await recordCapture(store, {
      memoryId: "image-base-1",
      deviceId: device.deviceId,
      modality: "image",
      summary: "office baseline",
      capturedAt: baseTime,
    });
    const secondBaseline = await recordCapture(store, {
      memoryId: "image-base-2",
      deviceId: device.deviceId,
      modality: "image",
      summary: "office baseline updated",
      capturedAt: baseTime + 4 * 60_000,
    });
    const distantBaseline = await recordCapture(store, {
      memoryId: "image-base-3",
      deviceId: device.deviceId,
      modality: "image",
      summary: "later office baseline",
      capturedAt: baseTime + 16 * 60_000,
    });

    expect(firstBaseline.event.captureContext).toBe("baseline-snapshot");
    expect(secondBaseline.event.windowId).toBe(firstBaseline.event.windowId);
    expect(secondBaseline.event.captureContext).toBe("baseline-snapshot");
    expect(distantBaseline.event.windowId).not.toBe(firstBaseline.event.windowId);
  });

  it("migrates v1 journal artifacts with a 7-day retention window instead of expiring immediately", async () => {
    const store = createStore();
    const createdAt = Date.UTC(2026, 2, 10, 8, 0, 0);
    const statePath = path.join(rootDir, "plugins", "clawsense", "state.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          setupTokens: [],
          devices: [],
          journal: [
            {
              memoryId: "legacy-audio-1",
              namespace: "clawsense",
              deviceId: "device-1",
              modality: "audio",
              summary: "legacy clip",
              createdAt,
              sourcePath: "/tmp/legacy.wav",
            },
          ],
        },
        null,
        2,
      ),
    );

    const artifacts = await store.listArtifacts();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.retentionExpiresAt).toBe(createdAt + 7 * 24 * 60 * 60 * 1000);
    expect(artifacts[0]?.deletedAt).toBeUndefined();
  });

  it("repairs already-migrated artifacts that were marked deleted too early when the raw file still exists", async () => {
    const store = createStore();
    const createdAt = Date.now() - 24 * 60 * 60 * 1000;
    const artifactPath = path.join(rootDir, "media", "legacy-photo.jpg");
    const statePath = path.join(rootDir, "plugins", "clawsense", "state.json");
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(artifactPath, Buffer.from("jpeg"));
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 2,
          setupTokens: [],
          devices: [],
          journal: [],
          artifacts: [
            {
              artifactId: "artifact-1",
              deviceId: "device-1",
              modality: "image",
              fileName: "legacy-photo.jpg",
              capturedAt: createdAt,
              createdAt,
              sizeBytes: 4,
              storagePath: artifactPath,
              storageRelPath: "2026/03/10/device/legacy-photo.jpg",
              retentionExpiresAt: createdAt,
              deletedAt: createdAt,
            },
          ],
          events: [],
          people: [],
          reviews: [],
        },
        null,
        2,
      ),
    );

    const artifacts = await store.listArtifacts();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.retentionExpiresAt).toBe(createdAt + 7 * 24 * 60 * 60 * 1000);
    expect(artifacts[0]?.deletedAt).toBeUndefined();
  });
});

async function recordCapture(
  store: ClawSenseStateStore,
  params: {
    memoryId: string;
    deviceId: string;
    modality: "audio" | "image";
    summary: string;
    capturedAt: number;
    note?: string;
  },
) {
  const extension = params.modality === "audio" ? "wav" : "jpg";
  return await store.recordCapture({
    memoryId: params.memoryId,
    namespace: "clawsense",
    deviceId: params.deviceId,
    modality: params.modality,
    summary: params.summary,
    note: params.note,
    createdAt: params.capturedAt,
    capturedAt: params.capturedAt,
    sourcePath: `/tmp/${params.memoryId}.${extension}`,
    fileName: `${params.memoryId}.${extension}`,
    mime: params.modality === "audio" ? "audio/wav" : "image/jpeg",
    sizeBytes: params.modality === "audio" ? 1024 : 2048,
    storageRelPath: `2026/03/10/pdem10/${params.memoryId}.${extension}`,
    retentionExpiresAt: params.capturedAt + 7 * 24 * 60 * 60 * 1000,
    analysisMode: params.modality === "audio" ? "runtime-stt" : "multimodal-preview",
  });
}
