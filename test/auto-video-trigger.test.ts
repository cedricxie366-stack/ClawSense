import { describe, expect, it } from "vitest";
import { resolveAutoVideoTriggerReason } from "../src/auto-video-trigger.js";

describe("resolveAutoVideoTriggerReason", () => {
  it("detects explicit record requests", () => {
    expect(resolveAutoVideoTriggerReason("这段很关键，帮我录一下这个")).toBe("explicit_record_request");
    expect(resolveAutoVideoTriggerReason("Please record this demo")).toBe("explicit_record_request");
  });

  it("detects visual references", () => {
    expect(resolveAutoVideoTriggerReason("看这里，这页 PPT 上的 chart 是核心")).toBe("visual_reference");
    expect(resolveAutoVideoTriggerReason("The speaker points to a whiteboard diagram")).toBe("visual_reference");
  });

  it("detects high-information moments", () => {
    expect(resolveAutoVideoTriggerReason("重点是这个方案的发布节奏")).toBe("high_information_moment");
    expect(resolveAutoVideoTriggerReason("This is an important presentation moment")).toBe("high_information_moment");
  });

  it("ignores ordinary low-signal text", () => {
    expect(resolveAutoVideoTriggerReason("嗯嗯好的，今天先这样")).toBeNull();
  });
});
