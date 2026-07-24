#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const localOpenClaw = path.join(projectRoot, "scripts", "local-openclaw.sh");
const date = process.env.CLAWSENSE_EVIDENCE_SMOKE_DATE || "2026-06-25";
const [dateYear, dateMonth, dateDay] = date.split("-");
const question =
  process.env.CLAWSENSE_EVIDENCE_SMOKE_QUESTION ||
  `${dateYear} 年 ${Number(dateMonth)} 月 ${Number(dateDay)} 日会议里，有哪些明确分配给我的任务？哪些只是别人提到但没有落到我身上的？`;
const projectHistoryQuestion =
  process.env.CLAWSENSE_EVIDENCE_SMOKE_PROJECT_QUESTION ||
  "AI 陪练这个项目之前在我的历史记忆里出现过什么？";

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function runClawSense(command, extraArgs = []) {
  return runRawClawSense(command, ["--question", question, ...extraArgs]);
}

function runClawSenseText(command, extraArgs = []) {
  const res = spawnSync(
    localOpenClaw,
    ["openclaw", "clawsense", command, "--question", question, ...extraArgs],
    {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (res.status !== 0) {
    throw Object.assign(new Error(`${command} command failed`), {
      details: {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
      },
    });
  }
  return res.stdout;
}

function runRawClawSense(command, extraArgs = []) {
  const res = spawnSync(
    localOpenClaw,
    ["openclaw", "clawsense", command, ...extraArgs],
    {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (res.status !== 0) {
    throw Object.assign(new Error(`${command} command failed`), {
      details: {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
      },
    });
  }
  return parseJsonObject(res.stdout, command);
}

function parseJsonObject(stdout, command) {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw Object.assign(new Error(`${command} did not output a JSON object`), {
      details: text.slice(0, 2000),
    });
  }
  return JSON.parse(text.slice(start, end + 1));
}

function summarize(payload) {
  const details = payload.details ?? payload;
  const evidence = details.evidenceBundle ?? details;
  const hints = details.responseHints ?? payload.responseHints ?? {};
  return {
    scope: details.scope ?? evidence.timeRange?.scope,
    date: details.date ?? evidence.timeRange?.date,
    counts: details.counts,
    summary: details.summary ?? evidence.summary,
    windowCount: details.windows?.length ?? evidence.windows?.length ?? 0,
    transcriptSpanCount: evidence.transcriptSpans?.length ?? 0,
    topicSegmentCount: evidence.topicSegments?.length ?? hints.topicSegments?.length ?? 0,
    rollingDigestCount:
      evidence.rollingDigests?.length ??
      hints.rollingDigests?.length ??
      details.rollingDigests?.length ??
      0,
    rollingDigestMatchCount:
      evidence.rollingDigestMatches?.length ??
      hints.rollingDigestMatches?.length ??
      details.rollingDigestMatches?.length ??
      0,
    memoryCardCount:
      evidence.memoryCards?.length ??
      hints.memoryCards?.length ??
      details.memoryCards?.length ??
      0,
    memoryCardMatchCount:
      evidence.memoryCardMatches?.length ??
      hints.memoryCardMatches?.length ??
      details.memoryCardMatches?.length ??
      0,
    conversationDigestTopicCount:
      evidence.conversationDigest?.topicIndex?.length ??
      hints.conversationDigest?.topicIndex?.length ??
      0,
    conversationDigestQueryMatchCount:
      evidence.conversationDigest?.queryMatches?.length ??
      hints.conversationDigest?.queryMatches?.length ??
      0,
    conversationDigestKeywordCount:
      evidence.conversationDigest?.keywordIndex?.length ??
      hints.conversationDigest?.keywordIndex?.length ??
      0,
    conversationDigestTaskMatchCount:
      evidence.conversationDigest?.taskMatches?.length ??
      hints.conversationDigest?.taskMatches?.length ??
      0,
    taskAttributionStatus: evidence.taskAttribution?.status ?? hints.taskAttribution?.status,
    taskCandidateCount: evidence.taskAttribution?.candidates?.length ?? hints.taskAttribution?.candidates?.length ?? 0,
    contextAudioRawAudioArtifacts:
      evidence.audioDiagnostics?.verdict?.rawAudioArtifacts ??
      hints.audioDiagnostics?.verdict?.rawAudioArtifacts,
    contextAudioBlockerIds:
      evidence.audioDiagnostics?.blockerIds ??
      hints.audioDiagnostics?.blockerIds ??
      [],
    speakerResolutionPromptCount:
      evidence.taskAttribution?.speakerResolutionPrompts?.length ??
      hints.speakerResolutionPrompts?.length ??
      hints.taskAttribution?.speakerResolutionPrompts?.length ??
      0,
    evidenceFollowUpTargetCount: hints.evidenceFollowUpTargets?.length ?? payload.evidenceFollowUpTargets?.length ?? 0,
    audioFollowUpTargetCount: hints.audioFollowUpTargets?.length ?? payload.audioFollowUpTargets?.length ?? 0,
    topicFollowUpTargetCount: hints.topicFollowUpTargets?.length ?? payload.topicFollowUpTargets?.length ?? 0,
    conversationDigestFollowUpTargetCount:
      payload.conversationDigestFollowUpTargets?.length ??
      hints.conversationDigestFollowUpTargets?.length ??
      0,
    conversationDigestFollowUpCount:
      payload.conversationDigestFollowUps?.length ??
      hints.conversationDigestFollowUps?.length ??
      0,
    firstTopicTitle: (evidence.topicSegments ?? hints.topicSegments ?? [])[0]?.title,
    firstTaskCandidate: (evidence.taskAttribution?.candidates ?? hints.taskAttribution?.candidates ?? [])[0],
  };
}

function summarizeDigests(payload) {
  return {
    source: payload.source,
    scope: payload.scope,
    date: payload.date,
    count: payload.count ?? payload.digests?.length ?? 0,
    topicCount: payload.summary?.topicCount ?? 0,
    transcriptWindowCount: payload.summary?.transcriptWindowCount ?? 0,
    keywordCount: payload.summary?.keywordCount ?? 0,
    taskHintCount: payload.summary?.taskHintCount ?? 0,
    firstTopicTitle: payload.summary?.firstTopicTitle,
  };
}

function summarizeMemoryCards(payload) {
  return {
    source: payload.source,
    scope: payload.scope,
    date: payload.date,
    count: payload.count ?? payload.cards?.length ?? 0,
    matchCount: payload.matchCount ?? payload.matches?.length ?? 0,
    taskCount: payload.summary?.taskCount ?? 0,
    topicCount: payload.summary?.topicCount ?? 0,
    attentionCount: payload.summary?.attentionCount ?? 0,
    learningCount: payload.summary?.learningCount ?? 0,
    firstCardTitle: payload.summary?.firstCardTitle,
  };
}

function summarizeProjectHistory(payload) {
  const firstProject = payload.projectHistory?.[0];
  const firstMoment = firstProject?.recentMoments?.[0];
  return {
    source: payload.source,
    scope: payload.scope,
    date: payload.date,
    projectCount: payload.summary?.projectCount ?? payload.projectHistory?.length ?? 0,
    projectMemoryCardCount: payload.summary?.projectMemoryCardCount ?? 0,
    firstProjectLabel: firstProject?.label,
    firstProjectRef: firstProject?.ref,
    firstMomentHasTranscript: Boolean(firstMoment?.transcriptExcerpt),
    firstMomentSummary: firstMoment?.summary,
  };
}

async function main() {
  const refreshDryRun = runRawClawSense("refresh-semantics", [date, "--max-samples", "5"]);
  const refreshApply =
    refreshDryRun.changedEvents > 0
      ? runRawClawSense("refresh-semantics", [date, "--apply", "--max-samples", "5"])
      : null;
  const context = runClawSense("context");
  const evidence = runClawSense("evidence");
  const followups = runClawSense("followups");
  const digests = runClawSense("digests");
  const memoryCards = runClawSense("memory-cards");
  const memoryCardsMarkdown = runClawSenseText("memory-cards", ["--format", "markdown"]);
  const projectHistory = runRawClawSense("history", [
    date,
    "--question",
    projectHistoryQuestion,
    "--type",
    "project",
  ]);
  const audioDiagnostics = runRawClawSense("audio-diagnostics", [date]);
  const speakerSlots = runClawSense("speaker-slots");

  const contextSummary = summarize(context);
  const evidenceSummary = summarize(evidence);
  const followupSummary = summarize(followups);
  const digestSummary = summarizeDigests(digests);
  const memoryCardSummary = summarizeMemoryCards(memoryCards);
  const projectHistorySummary = summarizeProjectHistory(projectHistory);

  assert(refreshDryRun.ok === true, "refresh-semantics dry-run should succeed", refreshDryRun);
  assert(refreshDryRun.date === date, "refresh-semantics dry-run should inspect the requested date", refreshDryRun);
  assert(refreshDryRun.scannedEvents > 0, "refresh-semantics should scan historical events", refreshDryRun);
  if (refreshApply) {
    assert(refreshApply.apply === true, "refresh-semantics --apply should write when dry-run found changes", refreshApply);
    assert(refreshApply.changedEvents >= 0, "refresh-semantics --apply should report changed events", refreshApply);
  }
  assert(contextSummary.date === date, "context should infer the requested historical date", contextSummary);
  assert(contextSummary.windowCount > 0, "context should include at least one evidence window", contextSummary);
  assert(contextSummary.transcriptSpanCount > 0, "context should include transcript spans for meeting questions", contextSummary);
  assert(contextSummary.topicSegmentCount > 0, "context should include topic segments", contextSummary);
  assert(contextSummary.rollingDigestCount > 0, "context should include persisted rolling conversation digests", contextSummary);
  assert(contextSummary.rollingDigestMatchCount > 0, "context should include question-relevant persisted rolling digest matches", contextSummary);
  assert(contextSummary.memoryCardCount > 0, "context should include persisted long-term memory cards", contextSummary);
  assert(contextSummary.memoryCardMatchCount > 0, "context should include question-relevant memory card matches", contextSummary);
  assert(contextSummary.conversationDigestTopicCount > 0, "context should include a conversation digest index", contextSummary);
  assert(contextSummary.conversationDigestQueryMatchCount > 0, "context should include question-relevant digest matches", contextSummary);
  assert(contextSummary.conversationDigestKeywordCount > 0, "context should include a digest keyword index", contextSummary);
  assert(contextSummary.conversationDigestTaskMatchCount > 0, "context should include question-relevant task matches", contextSummary);
  assert(contextSummary.taskCandidateCount > 0, "context should include task attribution candidates", contextSummary);
  assert(
    contextSummary.taskAttributionStatus === "needs-speaker-labels" ||
      contextSummary.taskAttributionStatus === "ready",
    "task attribution status should be actionable",
    contextSummary,
  );
  if (contextSummary.taskAttributionStatus === "needs-speaker-labels") {
    assert(
      contextSummary.speakerResolutionPromptCount > 0,
      "unresolved task attribution should include speaker resolution prompts",
      contextSummary,
    );
  }
  assert(evidenceSummary.topicSegmentCount > 0, "evidence command should expose topic segments", evidenceSummary);
  assert(evidenceSummary.rollingDigestCount > 0, "evidence command should expose persisted rolling digests", evidenceSummary);
  assert(evidenceSummary.rollingDigestMatchCount > 0, "evidence command should expose question-relevant persisted rolling digest matches", evidenceSummary);
  assert(evidenceSummary.memoryCardCount > 0, "evidence command should expose persisted memory cards", evidenceSummary);
  assert(evidenceSummary.memoryCardMatchCount > 0, "evidence command should expose question-relevant memory card matches", evidenceSummary);
  assert(evidenceSummary.conversationDigestTopicCount > 0, "evidence command should expose conversation digest topics", evidenceSummary);
  assert(evidenceSummary.conversationDigestTaskMatchCount > 0, "evidence command should expose question-relevant task matches", evidenceSummary);
  assert(followupSummary.evidenceFollowUpTargetCount > 0, "followups command should expose unified evidence follow-up targets", followupSummary);
  assert(followupSummary.topicFollowUpTargetCount > 0, "followups command should expose topic follow-up targets", followupSummary);
  assert(
    followupSummary.conversationDigestFollowUpTargetCount > 0,
    "followups command should expose conversation digest follow-up targets",
    followupSummary,
  );
  assert(digestSummary.date === date, "digests command should infer the requested historical date", digestSummary);
  assert(digestSummary.count > 0, "digests command should output at least one persisted rolling digest", digestSummary);
  assert(digestSummary.topicCount > 0, "digests command should expose rolling digest topic index", digestSummary);
  assert(digestSummary.keywordCount > 0, "digests command should expose rolling digest keyword index", digestSummary);
  assert(memoryCardSummary.date === date, "memory-cards command should infer the requested historical date", memoryCardSummary);
  assert(memoryCardSummary.count > 0, "memory-cards command should output persisted memory cards", memoryCardSummary);
  assert(memoryCardSummary.matchCount > 0, "memory-cards command should output question-relevant memory card matches", memoryCardSummary);
  assert(
    memoryCardSummary.taskCount > 0 || memoryCardSummary.topicCount > 0,
    "memory-cards command should expose task or topic cards",
    memoryCardSummary,
  );
  assert(
    memoryCardsMarkdown.includes("# ClawSense 长期记忆卡片报告"),
    "memory-cards markdown output should include a report title",
    memoryCardsMarkdown.slice(0, 2000),
  );
  assert(
    memoryCardsMarkdown.includes("## 总览") && memoryCardsMarkdown.includes("## 与当前问题最相关"),
    "memory-cards markdown output should include summary and matched cards sections",
    memoryCardsMarkdown.slice(0, 2000),
  );
  assert(
    memoryCardsMarkdown.includes("证据时间") || memoryCardsMarkdown.includes("转写摘录"),
    "memory-cards markdown output should preserve evidence references",
    memoryCardsMarkdown.slice(0, 2000),
  );
  assert(
    memoryCardsMarkdown.includes("检索排序") && memoryCardsMarkdown.includes("理由："),
    "memory-cards markdown output should expose deterministic retrieval rank and reasons",
    memoryCardsMarkdown.slice(0, 2000),
  );
  assert(projectHistory.date === date, "history command should inspect the requested date", projectHistory);
  if (date === "2026-06-25") {
    assert(projectHistorySummary.projectCount > 0, "history command should expose AI coaching project history", projectHistorySummary);
    assert(
      projectHistorySummary.firstProjectLabel === "AI 陪练",
      "history command should use localized project labels",
      projectHistorySummary,
    );
    assert(
      projectHistorySummary.firstMomentHasTranscript,
      "project history should prioritize transcript-backed moments",
      projectHistorySummary,
    );
  }
  assert(audioDiagnostics.date === date, "audio-diagnostics should inspect the requested historical date", audioDiagnostics);
  assert(
    typeof contextSummary.contextAudioRawAudioArtifacts === "string",
    "context should expose audioDiagnostics; if this fails after source edits, run scripts/local-openclaw.sh setup to sync the repo-local runtime",
    {
      contextSummary,
      expectedRuntime: ".local/openclaw/state/extensions/clawsense",
      syncCommand: "scripts/local-openclaw.sh setup",
    },
  );
  assert(
    contextSummary.contextAudioRawAudioArtifacts === audioDiagnostics.verdict?.rawAudioArtifacts,
    "context should expose the same raw audio availability verdict as audio-diagnostics",
    { contextSummary, audioDiagnostics: audioDiagnostics.verdict },
  );
  assert(audioDiagnostics.counts?.audioEvents > 0, "audio-diagnostics should find audio events", audioDiagnostics);
  assert(
    audioDiagnostics.counts?.audioArtifactRecords > 0,
    "audio-diagnostics should distinguish artifact records from active raw artifacts",
    audioDiagnostics,
  );
  assert(audioDiagnostics.counts?.transcriptReadyEvents > 0, "audio-diagnostics should expose transcript-ready audio", audioDiagnostics);
  assert(
    audioDiagnostics.verdict?.rawAudioArtifacts === "available" ||
      audioDiagnostics.verdict?.rawAudioArtifacts === "deleted",
    "audio-diagnostics should clearly report whether raw audio is available or retention-deleted",
    audioDiagnostics,
  );
  assert(
    Array.isArray(audioDiagnostics.recommendedCommands) && audioDiagnostics.recommendedCommands.length > 0,
    "audio-diagnostics should include actionable commands",
    audioDiagnostics,
  );
  assert(
    Array.isArray(audioDiagnostics.blockers) && audioDiagnostics.blockers.length > 0,
    "audio-diagnostics should include explicit blockers or readiness notes",
    audioDiagnostics,
  );
  assert(
    Array.isArray(audioDiagnostics.nextActions) && audioDiagnostics.nextActions.length > 0,
    "audio-diagnostics should include human-readable next actions",
    audioDiagnostics,
  );
  if (audioDiagnostics.verdict?.rawAudioArtifacts === "deleted") {
    assert(
      audioDiagnostics.blockers.some((blocker) => blocker.id === "raw-audio-retention-deleted"),
      "retention-deleted raw audio should be called out as a blocker",
      audioDiagnostics.blockers,
    );
    assert(
      contextSummary.contextAudioBlockerIds.includes("raw-audio-retention-deleted"),
      "context should expose retention-deleted raw audio blocker to the host model",
      contextSummary,
    );
    assert(
      audioDiagnostics.nextActions.some((action) => /不能直接.*补跑|重新导入|retention/.test(action)),
      "retention-deleted raw audio should explain why ASR/diarization cannot be rerun",
      audioDiagnostics.nextActions,
    );
  }
  assert(speakerSlots.date === date, "speaker-slots should infer the requested historical date", speakerSlots);
  assert(
    speakerSlots.status === "needs-speaker-labels" || speakerSlots.status === "ready",
    "speaker-slots should expose an actionable speaker status",
    speakerSlots,
  );
  if (speakerSlots.status === "needs-speaker-labels") {
    assert(
      speakerSlots.summary?.promptCount > 0 || speakerSlots.summary?.unresolvedSlotCount > 0,
      "speaker-slots should expose unresolved speaker prompts or slots",
      speakerSlots,
    );
    assert(
      Array.isArray(speakerSlots.slotTaskImpacts) && speakerSlots.slotTaskImpacts.length > 0,
      "speaker-slots should expose which speaker slots affect unresolved task attribution",
      speakerSlots,
    );
    assert(
      speakerSlots.slotTaskImpacts.some(
        (impact) =>
          impact?.commands?.markAsMe &&
          impact?.commands?.markAsColleague &&
          typeof impact.requiresDiarization === "boolean",
      ),
      "speaker slot impacts should include copyable commands and diarization boundary",
      speakerSlots.slotTaskImpacts,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        date,
        question,
        context: contextSummary,
        evidence: evidenceSummary,
        followups: followupSummary,
        digests: digestSummary,
        memoryCards: memoryCardSummary,
        refreshSemantics: {
          dryRun: {
            scannedEvents: refreshDryRun.scannedEvents,
            changedEvents: refreshDryRun.changedEvents,
            sampleChangeCount: refreshDryRun.sampleChanges?.length ?? 0,
          },
          applied: refreshApply
            ? {
                changedEvents: refreshApply.changedEvents,
                invalidatedDates: refreshApply.invalidatedDates,
              }
            : null,
        },
        projectHistory: projectHistorySummary,
        audioDiagnostics: {
          counts: audioDiagnostics.counts,
          coverage: audioDiagnostics.coverage,
          verdict: audioDiagnostics.verdict,
          blockerIds: (audioDiagnostics.blockers ?? []).map((blocker) => blocker.id),
          nextActionCount: audioDiagnostics.nextActions?.length ?? 0,
        },
        speakerSlots: {
          status: speakerSlots.status,
          summary: speakerSlots.summary,
          quickCommandCount: speakerSlots.quickCommands?.length ?? 0,
          slotTaskImpactCount: speakerSlots.slotTaskImpacts?.length ?? 0,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message,
        details: error.details,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
