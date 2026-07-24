import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveClawSenseConfig } from "../src/config.js";
import {
  inspectLocalAsrConfig,
  parseLocalAsrBatchCommandOutput,
  parseLocalAsrCommandOutput,
  transcribeAudioBatchWithLocalAsr,
  transcribeAudioWithLocalAsr,
} from "../src/local-asr.js";

describe("local ASR backends", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-local-asr-test-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("parses plain text command output as a transcript", () => {
    const parsed = parseLocalAsrCommandOutput("今天讨论了报价策略和复盘安排。\n");

    expect(parsed.transcript).toBe("今天讨论了报价策略和复盘安排。");
    expect(parsed.transcriptSegments).toEqual([{ text: "今天讨论了报价策略和复盘安排。" }]);
  });

  it("parses Whisper-style JSON segments", () => {
    const parsed = parseLocalAsrCommandOutput(
      JSON.stringify({
        language: "zh",
        segments: [
          { start: 1.25, end: 3.5, text: "先确认数据口径。" },
          { startMs: 4000, endMs: 6200, text: "然后补会议纪要。", speaker: "speaker_2" },
        ],
      }),
    );

    expect(parsed.language).toBe("zh");
    expect(parsed.transcript).toBe("先确认数据口径。 然后补会议纪要。");
    expect(parsed.transcriptSegments).toEqual([
      { startMs: 1250, endMs: 3500, text: "先确认数据口径。" },
      { startMs: 4000, endMs: 6200, text: "然后补会议纪要。", speakerLabel: "speaker_2" },
    ]);
  });

  it("parses FunASR sentence_info millisecond segments", () => {
    const parsed = parseLocalAsrCommandOutput(
      JSON.stringify({
        sentence_info: [
          { start: 120, end: 1860, text: "Amy 说先看客户反馈。", spk: 0 },
          { start: 2000, end: 3800, text: "我负责整理任务清单。", spk: 1 },
        ],
      }),
    );

    expect(parsed.transcript).toBe("Amy 说先看客户反馈。 我负责整理任务清单。");
    expect(parsed.transcriptSegments).toEqual([
      { startMs: 120, endMs: 1860, text: "Amy 说先看客户反馈。", speakerLabel: "speaker_1" },
      { startMs: 2000, endMs: 3800, text: "我负责整理任务清单。", speakerLabel: "speaker_2" },
    ]);
  });

  it("parses speaker timeline segments separately from primary transcript segments", () => {
    const parsed = parseLocalAsrCommandOutput(
      JSON.stringify({
        transcript: "Amy 说先确认口径。 我负责写纪要。",
        segments: [
          { startMs: 0, endMs: 2000, text: "Amy 说先确认口径。" },
          { startMs: 2000, endMs: 4000, text: "我负责写纪要。" },
        ],
        speakerTimelineSegments: [
          { startMs: 0, endMs: 1900, text: "Amy speaker span", speaker: "speaker_1" },
          { startMs: 2100, endMs: 3900, text: "user speaker span", speaker: "speaker_2" },
        ],
      }),
    );

    expect(parsed.transcriptSegments).toEqual([
      { startMs: 0, endMs: 2000, text: "Amy 说先确认口径。" },
      { startMs: 2000, endMs: 4000, text: "我负责写纪要。" },
    ]);
    expect(parsed.speakerTimelineSegments).toEqual([
      { startMs: 0, endMs: 1900, text: "Amy speaker span", speakerLabel: "speaker_1" },
      { startMs: 2100, endMs: 3900, text: "user speaker span", speakerLabel: "speaker_2" },
    ]);
  });

  it("normalizes one-based numeric speaker labels without shifting them", () => {
    const parsed = parseLocalAsrCommandOutput(
      JSON.stringify({
        segments: [
          { startMs: 120, endMs: 1860, text: "主持人开场。", speaker: "1" },
          { startMs: 2000, endMs: 3800, text: "嘉宾回答。", speaker: "2" },
        ],
      }),
    );

    expect(parsed.transcriptSegments).toEqual([
      { startMs: 120, endMs: 1860, text: "主持人开场。", speakerLabel: "speaker_1" },
      { startMs: 2000, endMs: 3800, text: "嘉宾回答。", speakerLabel: "speaker_2" },
    ]);
  });

  it("parses the final JSON line when command stdout contains noisy logs", () => {
    const parsed = parseLocalAsrCommandOutput(
      [
        "Notice: ffmpeg is not installed. torchaudio is used to load audio",
        "Downloading model files...",
        JSON.stringify({
          transcript: "刚才讨论了数据同步方案。",
          segments: [{ startMs: 0, endMs: 2100, text: "刚才讨论了数据同步方案。" }],
        }),
      ].join("\n"),
    );

    expect(parsed.transcript).toBe("刚才讨论了数据同步方案。");
    expect(parsed.transcriptSegments).toEqual([
      { startMs: 0, endMs: 2100, text: "刚才讨论了数据同步方案。" },
    ]);
  });

  it("synthesizes sentence segments when command JSON only contains a transcript", () => {
    const parsed = parseLocalAsrCommandOutput(
      JSON.stringify({
        transcript: "先确认数据口径。然后同步会议纪要。",
      }),
    );

    expect(parsed.transcript).toBe("先确认数据口径。然后同步会议纪要。");
    expect(parsed.transcriptSegments).toEqual([
      { text: "先确认数据口径。" },
      { text: "然后同步会议纪要。" },
    ]);
  });

  it("strips SenseVoice control tags from transcripts and segments", () => {
    const parsed = parseLocalAsrCommandOutput(
      JSON.stringify({
        transcript: "<|zh|><|NEUTRAL|>< | S pe ech |>< | withi tn | >刚才讨论了数据同步方案。",
        segments: [
          {
            startMs: 0,
            endMs: 2100,
            text: "<|zh|><|NEUTRAL|>刚才讨论了数据同步方案。",
          },
        ],
      }),
    );

    expect(parsed.transcript).toBe("刚才讨论了数据同步方案。");
    expect(parsed.transcriptSegments).toEqual([
      { startMs: 0, endMs: 2100, text: "刚才讨论了数据同步方案。" },
    ]);
  });

  it("parses batch command output by result id", () => {
    const parsed = parseLocalAsrBatchCommandOutput(
      JSON.stringify({
        results: [
          {
            id: "event-a",
            transcript: "第一段会议转写。",
            segments: [{ startMs: 0, endMs: 1200, text: "第一段会议转写。", speaker: "speaker_1" }],
          },
          {
            id: "event-b",
            error: "query_time_local_asr_empty",
          },
        ],
      }),
      "local-asr:funasr:zh",
      [
        { id: "event-a", filePath: "/tmp/a.wav" },
        { id: "event-b", filePath: "/tmp/b.wav" },
      ],
    );

    expect(parsed.get("event-a")).toEqual({
      transcript: "第一段会议转写。",
      transcriptSegments: [
        { startMs: 0, endMs: 1200, text: "第一段会议转写。", speakerLabel: "speaker_1" },
      ],
      analysisProvider: "local-asr:funasr:zh",
    });
    expect(parsed.get("event-b")).toEqual({
      analysisProvider: "local-asr:funasr:zh",
      analysisFailureReason: "query_time_local_asr_empty",
    });
  });

  it("synthesizes transcript segments for batch items without segment arrays", () => {
    const parsed = parseLocalAsrBatchCommandOutput(
      JSON.stringify({
        results: [
          {
            id: "event-a",
            transcript: "先确认数据口径。然后同步会议纪要。",
          },
        ],
      }),
      "local-asr:funasr:zh",
      [{ id: "event-a", filePath: "/tmp/a.wav" }],
    );

    expect(parsed.get("event-a")).toEqual({
      transcript: "先确认数据口径。然后同步会议纪要。",
      transcriptSegments: [
        { text: "先确认数据口径。" },
        { text: "然后同步会议纪要。" },
      ],
      analysisProvider: "local-asr:funasr:zh",
    });
  });

  it("runs a configured Whisper command backend", async () => {
    const commandPath = await writeExecutableScript(
      "whisper-stub.sh",
      `#!/bin/sh
printf '%s\\n' '{"language":"zh","segments":[{"start":0,"end":2.4,"text":"刚才讨论了上线顺序。","speaker":"speaker_1"}]}'
`,
    );
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "whisper",
      localAsrWhisperCommand: commandPath,
      localAsrLanguage: "zh",
    });

    const result = await transcribeAudioWithLocalAsr({
      cfg,
      filePath: path.join(rootDir, "audio.wav"),
      resolveStateDir: () => rootDir,
    });

    expect(result.analysisProvider).toBe("local-asr:whisper:zh");
    expect(result.transcript).toBe("刚才讨论了上线顺序。");
    expect(result.transcriptSegments).toEqual([
      { startMs: 0, endMs: 2400, text: "刚才讨论了上线顺序。", speakerLabel: "speaker_1" },
    ]);
  });

  it("runs a configured FunASR command backend", async () => {
    const commandPath = await writeExecutableScript(
      "funasr-stub.sh",
      `#!/bin/sh
printf '%s\\n' '{"text":"确认报表和培训安排。","sentence_info":[{"start":80,"end":1800,"text":"确认报表和培训安排。","speaker":"speaker_1"}]}'
`,
    );
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "funasr",
      localAsrFunAsrCommand: commandPath,
      localAsrLanguage: "zh",
    });

    const result = await transcribeAudioWithLocalAsr({
      cfg,
      filePath: path.join(rootDir, "audio.wav"),
      resolveStateDir: () => rootDir,
    });

    expect(result.analysisProvider).toBe("local-asr:funasr:zh");
    expect(result.transcript).toBe("确认报表和培训安排。");
    expect(result.transcriptSegments).toEqual([
      { startMs: 80, endMs: 1800, text: "确认报表和培训安排。", speakerLabel: "speaker_1" },
    ]);
  });

  it("runs the hybrid Whisper + FunASR wrapper and merges speaker labels by time overlap", async () => {
    const primaryCommand = await writeExecutableScript(
      "hybrid-primary-stub.sh",
      `#!/bin/sh
printf '%s\\n' '{"language":"zh","transcript":"Amy 说先确认口径。 我负责写纪要。","segments":[{"startMs":0,"endMs":2000,"text":"Amy 说先确认口径。"},{"startMs":2000,"endMs":4000,"text":"我负责写纪要。"}]}'
`,
    );
    const speakerCommand = await writeExecutableScript(
      "hybrid-speaker-stub.sh",
      `#!/bin/sh
if [ "$CLAWSENSE_ASR_MODEL" != "iic/SenseVoiceSmall" ]; then
  echo "speaker model inherited wrong ASR model: $CLAWSENSE_ASR_MODEL" >&2
  exit 3
fi
printf '%s\\n' '{"segments":[{"startMs":0,"endMs":1900,"text":"speaker one","spk":0},{"startMs":2100,"endMs":3900,"text":"speaker two","spk":1}]}'
`,
    );
    const hybridCommand = path.join(process.cwd(), "scripts/local-asr/hybrid-whisper-funasr.py");
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "whisper",
      localAsrWhisperCommand: hybridCommand,
      localAsrWhisperModel: "fake-whisper-model",
      localAsrLanguage: "zh",
    });

    const result = await transcribeAudioWithLocalAsr({
      cfg,
      filePath: path.join(rootDir, "audio.wav"),
      resolveStateDir: () => rootDir,
      extraEnv: {
        CLAWSENSE_HYBRID_ASR_COMMAND: primaryCommand,
        CLAWSENSE_HYBRID_SPEAKER_COMMAND: speakerCommand,
      },
    });

    expect(result.analysisProvider).toBe("local-asr:whisper:zh");
    expect(result.transcript).toBe("Amy 说先确认口径。 我负责写纪要。");
    expect(result.transcriptSegments).toEqual([
      { startMs: 0, endMs: 2000, text: "Amy 说先确认口径。", speakerLabel: "speaker_1", confidence: 0.95 },
      { startMs: 2000, endMs: 4000, text: "我负责写纪要。", speakerLabel: "speaker_2", confidence: 0.9 },
    ]);
    expect(result.speakerTimelineSegments).toEqual([
      { startMs: 0, endMs: 1900, text: "speaker one", speakerLabel: "speaker_1" },
      { startMs: 2100, endMs: 3900, text: "speaker two", speakerLabel: "speaker_2" },
    ]);
  });

  it("keeps FunASR sentence_info when hybrid primary emits an empty segments array", async () => {
    const primaryCommand = await writeExecutableScript(
      "hybrid-funasr-primary-stub.sh",
      `#!/bin/sh
if [ "$CLAWSENSE_FUNASR_SENTENCE_TIMESTAMP" != "1" ]; then
  echo "missing sentence timestamp env" >&2
  exit 4
fi
if [ "$CLAWSENSE_FUNASR_SPK_MODEL" != "cam++" ]; then
  echo "missing speaker model env" >&2
  exit 5
fi
printf '%s\\n' '{"transcript":"现在讨论年会安排。 团建可以结合预算看。","segments":[],"sentence_info":[{"start":9560,"end":60380,"text":"现在讨论年会安排。","spk":1},{"start":60380,"end":66370,"text":"团建可以结合预算看。","spk":2}]}'
`,
    );
    const speakerCommand = await writeExecutableScript(
      "hybrid-funasr-primary-speaker-stub.sh",
      `#!/bin/sh
printf '%s\\n' '{"sentence_info":[{"start":9560,"end":60380,"text":"speaker two","spk":1},{"start":60380,"end":66370,"text":"speaker three","spk":2}]}'
`,
    );
    const hybridCommand = path.join(process.cwd(), "scripts/local-asr/hybrid-whisper-funasr.py");
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "whisper",
      localAsrWhisperCommand: hybridCommand,
      localAsrLanguage: "zh",
    });

    const result = await transcribeAudioWithLocalAsr({
      cfg,
      filePath: path.join(rootDir, "audio.wav"),
      resolveStateDir: () => rootDir,
      extraEnv: {
        CLAWSENSE_HYBRID_ASR_COMMAND: primaryCommand,
        CLAWSENSE_HYBRID_SPEAKER_COMMAND: speakerCommand,
      },
    });

    expect(result.transcriptSegments).toEqual([
      { startMs: 9560, endMs: 60380, text: "现在讨论年会安排。", speakerLabel: "speaker_1", confidence: 1 },
      { startMs: 60380, endMs: 66370, text: "团建可以结合预算看。", speakerLabel: "speaker_2", confidence: 1 },
    ]);
    expect(result.speakerTimelineSegments).toEqual([
      { startMs: 9560, endMs: 60380, text: "speaker two", speakerLabel: "speaker_1" },
      { startMs: 60380, endMs: 66370, text: "speaker three", speakerLabel: "speaker_2" },
    ]);
  });

  it("retries the hybrid speaker pass without FunASR punc when labels are missing", async () => {
    const primaryCommand = await writeExecutableScript(
      "hybrid-primary-retry-stub.sh",
      `#!/bin/sh
printf '%s\\n' '{"language":"en","transcript":"Sarah opened the meeting. Mark answered.","segments":[{"startMs":0,"endMs":2000,"text":"Sarah opened the meeting."},{"startMs":2000,"endMs":4200,"text":"Mark answered."}]}'
`,
    );
    const speakerCommand = await writeExecutableScript(
      "hybrid-speaker-retry-stub.sh",
      `#!/bin/sh
if [ "$CLAWSENSE_FUNASR_PUNC_MODEL" = "none" ]; then
  printf '%s\\n' '{"segments":[{"startMs":0,"endMs":1900,"text":"speaker one","speaker":"1"},{"startMs":2100,"endMs":4000,"text":"speaker two","speaker":"2"}]}'
else
  printf '%s\\n' '{"segments":[{"startMs":0,"endMs":4200,"text":"no labels yet"}]}'
fi
`,
    );
    const hybridCommand = path.join(process.cwd(), "scripts/local-asr/hybrid-whisper-funasr.py");
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "whisper",
      localAsrWhisperCommand: hybridCommand,
      localAsrWhisperModel: "fake-whisper-model",
      localAsrLanguage: "en",
    });

    const result = await transcribeAudioWithLocalAsr({
      cfg,
      filePath: path.join(rootDir, "audio.wav"),
      resolveStateDir: () => rootDir,
      extraEnv: {
        CLAWSENSE_HYBRID_ASR_COMMAND: primaryCommand,
        CLAWSENSE_HYBRID_SPEAKER_COMMAND: speakerCommand,
      },
    });

    expect(result.analysisProvider).toBe("local-asr:whisper:en");
    expect(result.transcriptSegments).toEqual([
      { startMs: 0, endMs: 2000, text: "Sarah opened the meeting.", speakerLabel: "speaker_1", confidence: 0.95 },
      { startMs: 2000, endMs: 4200, text: "Mark answered.", speakerLabel: "speaker_2", confidence: 0.864 },
    ]);
    expect(result.speakerTimelineSegments).toEqual([
      { startMs: 0, endMs: 1900, text: "speaker one", speakerLabel: "speaker_1" },
      { startMs: 2100, endMs: 4000, text: "speaker two", speakerLabel: "speaker_2" },
    ]);
  });

  it("runs a configured FunASR command backend in batch mode", async () => {
    const commandPath = await writeExecutableScript(
      "funasr-batch-stub.sh",
      `#!/bin/sh
if [ "$1" != "--batch-json" ]; then
  echo "expected --batch-json" >&2
  exit 2
fi
printf '%s\\n' '{"results":[{"id":"audio-a","transcript":"第一条音频。","segments":[{"startMs":0,"endMs":1000,"text":"第一条音频。"}]},{"id":"audio-b","transcript":"第二条音频。","segments":[{"startMs":1000,"endMs":2400,"text":"第二条音频。","speaker":"speaker_2"}]}]}'
`,
    );
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "funasr",
      localAsrFunAsrCommand: commandPath,
      localAsrLanguage: "zh",
    });

    const result = await transcribeAudioBatchWithLocalAsr({
      cfg,
      items: [
        { id: "audio-a", filePath: path.join(rootDir, "audio-a.wav") },
        { id: "audio-b", filePath: path.join(rootDir, "audio-b.wav") },
      ],
      resolveStateDir: () => rootDir,
    });

    expect(result.get("audio-a")?.transcript).toBe("第一条音频。");
    expect(result.get("audio-b")?.transcriptSegments).toEqual([
      { startMs: 1000, endMs: 2400, text: "第二条音频。", speakerLabel: "speaker_2" },
    ]);
  });

  it("degrades clearly when a command backend has no command configured", async () => {
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "whisper",
      localAsrLanguage: "zh",
    });

    const result = await transcribeAudioWithLocalAsr({
      cfg,
      filePath: path.join(rootDir, "audio.wav"),
      resolveStateDir: () => rootDir,
    });

    expect(result.analysisProvider).toBe("local-asr:whisper:zh");
    expect(result.analysisFailureReason).toBe("query_time_local_asr_command_missing");
  });

  it("reports disabled local ASR status", async () => {
    const cfg = resolveClawSenseConfig({});

    const status = await inspectLocalAsrConfig({
      cfg,
      resolveStateDir: () => rootDir,
    });

    expect(status.enabled).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.provider).toBe("local-asr:none");
    expect(status.issues).toContain("local_asr_disabled");
  });

  it("reports executable command backend status", async () => {
    const commandPath = await writeExecutableScript(
      "funasr-status-stub.sh",
      `#!/bin/sh
printf '%s\\n' '{}'
`,
    );
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "funasr",
      localAsrFunAsrCommand: commandPath,
      localAsrFunAsrModel: "paraformer-zh",
    });

    const status = await inspectLocalAsrConfig({
      cfg,
      resolveStateDir: () => rootDir,
    });

    expect(status.enabled).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.commandExists).toBe(true);
    expect(status.commandExecutable).toBe(true);
    expect(status.model).toBe("paraformer-zh");
    expect(status.issues).toEqual([]);
  });

  it("reports non-executable command backend status", async () => {
    const commandPath = path.join(rootDir, "funasr-not-executable.sh");
    await fs.writeFile(commandPath, "#!/bin/sh\n", "utf8");
    const cfg = resolveClawSenseConfig({
      localAsrBackend: "funasr",
      localAsrFunAsrCommand: commandPath,
    });

    const status = await inspectLocalAsrConfig({
      cfg,
      resolveStateDir: () => rootDir,
    });

    expect(status.ready).toBe(false);
    expect(status.commandExists).toBe(true);
    expect(status.commandExecutable).toBe(false);
    expect(status.issues).toContain("local_asr_command_not_executable");
  });

  async function writeExecutableScript(fileName: string, body: string): Promise<string> {
    const filePath = path.join(rootDir, fileName);
    await fs.writeFile(filePath, body, "utf8");
    await fs.chmod(filePath, 0o755);
    return filePath;
  }
});
