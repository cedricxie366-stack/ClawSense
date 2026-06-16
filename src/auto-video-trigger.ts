import { normalizeSemanticText } from "./utils.js";

export type AutoVideoTriggerReason =
  | "explicit_record_request"
  | "visual_reference"
  | "high_information_moment";

export function resolveAutoVideoTriggerReason(text: string): AutoVideoTriggerReason | null {
  const normalized = normalizeSemanticText(text).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/(录一下|录一段|拍一下|拍一段|帮我看一下|帮我看看|record this|capture this|take a video)/i.test(normalized)) {
    return "explicit_record_request";
  }
  if (/(看这里|看这个|这张图|这个图|这页|这一页|白板|ppt|slide|diagram|chart|table|screen|whiteboard)/i.test(normalized)) {
    return "visual_reference";
  }
  if (/(重点是|关键是|注意这里|这个很重要|演示|讲解|访谈|采访|demo|important|key point|presentation)/i.test(normalized)) {
    return "high_information_moment";
  }
  return null;
}
