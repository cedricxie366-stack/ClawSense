import assert from "node:assert/strict";
import test from "node:test";
import { resolveAutoVideoTriggerReason } from "../dist/src/auto-video-trigger.js";

test("English video-recording negation overrides positive trigger phrases", () => {
  assert.equal(resolveAutoVideoTriggerReason("Please don't take a video of this screen"), null);
  assert.equal(resolveAutoVideoTriggerReason("Do not take a video during this private discussion"), null);
});
