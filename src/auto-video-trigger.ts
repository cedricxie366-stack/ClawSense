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
  if (/(不要录|别录|不用录|先别录|停止录|不要拍|别拍|不用拍|stop recording|do not record|don't record|no recording)/iu.test(normalized)) {
    return null;
  }
  if (/(录一下|录一段|录下来|记录一下|拍一下|拍一段|拍下来|帮我看一下|帮我看看|record this|capture this|take a video)/iu.test(normalized)) {
    return "explicit_record_request";
  }
  if (
    /(看这里|看这个|看屏幕|这个页面|这个屏幕|这张图|这个图|这份报告|这份材料|这个表|这张表|这页|这一页|白板|黑板|ppt|slide|diagram|chart|table|screen|whiteboard|spreadsheet|dashboard)/iu.test(normalized)
  ) {
    return "visual_reference";
  }
  if (
    /(重点是|关键是|结论是|注意这里|这里要注意|这个很重要|你记一下|记住|行动项|任务|风险|决策|决定|同步一下|复盘|评审|需求|方案|里程碑|发布节奏|演示|讲解|访谈|采访|demo|important|key point|presentation|decision|action item|milestone|interview)/iu.test(normalized)
  ) {
    return "high_information_moment";
  }
  return null;
}
