import { randomUUID } from "node:crypto";
import type { LiveFrame } from "./types.js";
import { explicitTextTransform, literalReading, stripCompanionAddress, suppliedStatementRepeat } from "./dialogue.js";

export function needsCurrentFrame(query: string, companionName = "小伴"): boolean {
  const request = stripCompanionAddress(query, companionName);
  if (literalReading(request) !== undefined || explicitTextTransform(request) || suppliedStatementRepeat(request)) return false;
  if (/翻译|译成|译为|改写|润色|这句话.*(?:意思|含义)/.test(query)) return false;
  if (/(?:刚才|昨天|上次|早些)/.test(query) && !/(?:现在|当前|变化|此刻)/.test(query)) return false;
  // Speech recognizers insert 正在/的是/是是; these remain requests to see,
  // rather than invitations for the text model to guess a scene from chat.
  if (/(?:我(?:现在|此刻|当前)?|现在|此刻|当前)(?:正?在)?看(?:到|见)?(?:的)?(?:是)*(?:什么|啥)/.test(query)) return true;
  if (/(?:桌[上边]|杯子|物体|遮挡|镜头|眼前).*(?:什么|颜色|变化|移动|看)|(?:看[看一下]+).*(?:物体|杯子|画面)/.test(query)) return true;
  return /(?:我(?:现在)?在看|眼前|镜头|画面|看[见到着].*(?:什么|物体|颜色)|这(?:个杯子|张照片)|刚才.*变化|发生.*变化|有什么变化)/.test(query);
}
/** A frame belongs to one question. Never reuse an old image after timeout or reconnection. */
export class LiveFrameRequests {
  private pending?: { id: string; at: number; resolve: (frame: LiveFrame) => void; reject: (error: Error) => void; clean: () => void };
  constructor(private emit: (requestId: string) => void, private timeoutMs = 2000) {}
  request(signal: AbortSignal): Promise<LiveFrame> {
    this.clear();
    if (signal.aborted) return Promise.reject(new Error("aborted"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => this.clear("aborted");
      const timer = setTimeout(() => this.clear("current_frame_unavailable"), this.timeoutMs);
      this.pending = { id, at: Date.now(), resolve, reject, clean: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } };
      signal.addEventListener("abort", abort, { once: true });
      this.emit(id);
    });
  }
  accept(value: unknown) {
    const frame = value as LiveFrame;
    const p = this.pending;
    if (!p || frame?.requestId !== p.id) throw new Error("frame_request_expired");
    if (!Number.isFinite(frame.capturedAt) || !Number.isFinite(frame.ageMs) || frame.ageMs < 0 || frame.ageMs > 2000 || Date.now() - p.at > this.timeoutMs) { this.clear("current_frame_expired"); return; }
    if (typeof frame.jpeg !== "string" || frame.jpeg.length > 280000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.jpeg)) throw new Error("invalid_live_frame");
    const bytes = Buffer.from(frame.jpeg, "base64");
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error("invalid_live_frame");
    this.pending = undefined; p.clean(); p.resolve({ ...frame, receivedAt: Date.now() });
  }
  clear(code = "aborted") { const p = this.pending; this.pending = undefined; if (p) { p.clean(); p.reject(new Error(code)); } }
}
