import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalAsrCommandOutput } from "../dist/src/local-asr.js";

test("local ASR parses a multiline JSON object emitted after diagnostic logs", () => {
  const parsed = parseLocalAsrCommandOutput([
    "Loading local ASR model...",
    "{",
    '  "language": "zh",',
    '  "segments": [',
    '    { "start": 0.5, "end": 2.0, "text": "先确认数据口径。" }',
    "  ]",
    "}",
  ].join("\n"));

  assert.equal(parsed.language, "zh");
  assert.equal(parsed.transcript, "先确认数据口径。");
  assert.deepEqual(parsed.transcriptSegments, [
    { startMs: 500, endMs: 2000, text: "先确认数据口径。" },
  ]);
});
