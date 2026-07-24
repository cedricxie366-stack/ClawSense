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
    expect(resolveAutoVideoTriggerReason("看这个表，库存字段这里需要说明")).toBe("visual_reference");
    expect(resolveAutoVideoTriggerReason("这份报告右侧的 dashboard 是关键证据")).toBe("visual_reference");
  });

  it("detects high-information moments", () => {
    expect(resolveAutoVideoTriggerReason("重点是这个方案的发布节奏")).toBe("high_information_moment");
    expect(resolveAutoVideoTriggerReason("This is an important presentation moment")).toBe("high_information_moment");
    expect(resolveAutoVideoTriggerReason("行动项是明天把方案发给产品团队")).toBe("high_information_moment");
    expect(resolveAutoVideoTriggerReason("这段访谈里提到了模型能力边界")).toBe("high_information_moment");
  });

  it("ignores ordinary low-signal text", () => {
    expect(resolveAutoVideoTriggerReason("嗯嗯好的，今天先这样")).toBeNull();
  });

  it("does not trigger when the user explicitly disables recording", () => {
    expect(resolveAutoVideoTriggerReason("不用录，这里只是闲聊")).toBeNull();
    expect(resolveAutoVideoTriggerReason("Please do not record this screen")).toBeNull();
  });
});
