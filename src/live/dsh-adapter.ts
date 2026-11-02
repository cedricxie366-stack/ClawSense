import {
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  constants,
} from "node:fs";
import { parseEnv } from "node:util";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  personaPrompt,
  type HarnessAdapter,
  type LiveConfig,
  type ProviderChunk,
  type ReplyInput,
} from "./types.js";
type Frame = Record<string, any>;
/** DSH 0.2 SDK has session-level events, no per-prompt cancel. Dedicated session + serialization is mandatory. */
export class DshAdapter implements HarnessAdapter {
  readonly cancelSupported = true;
  private active = new Map<string, ChildProcessWithoutNullStreams>();
  private processes = new Map<
    string,
    {
      child: ChildProcessWithoutNullStreams;
      ready: Promise<void>;
      requests: Map<
        string,
        { resolve: (v: any) => void; reject: (e: Error) => void }
      >;
      notify?: (f: Frame) => void;
    }
  >();
  private busy = new Set<string>();
  constructor(private config: NonNullable<LiveConfig["dsh"]>) {}
  routes() {
    return [...this.config.routes];
  }
  private process(route: (typeof this.config.routes)[number]) {
    const existing = this.processes.get(route.id);
    if (existing) return existing;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.config.home,
    };
    const credential = this.config.credential;
    if (credential && !env[credential.env]) {
      if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(credential.env))
        throw new Error("invalid_credential_environment");
      const fd = openSync(
        credential.file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 65536)
          throw new Error("invalid_credential_file");
        const body = readFileSync(fd, "utf8").trim();
        const value =
          credential.format === "raw-token"
            ? body
            : parseEnv(body)[credential.field ?? credential.env];
        if (!value || /[\r\n\0]/.test(value))
          throw new Error("harness_credential_unavailable");
        env[credential.env] = value;
      } finally {
        closeSync(fd);
      }
    }
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    const state = {
      child,
      ready: Promise.resolve(),
      requests: new Map<
        string,
        { resolve: (v: any) => void; reject: (e: Error) => void }
      >(),
      notify: undefined as ((f: Frame) => void) | undefined,
    };
    const fail = () => {
      for (const r of state.requests.values())
        r.reject(new Error("dsh_process_exited"));
      state.requests.clear();
      state.notify?.({ method: "error" });
      this.processes.delete(route.id);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.id) {
          const r = state.requests.get(String(frame.id));
          if (r) {
            state.requests.delete(String(frame.id));
            frame.error
              ? r.reject(new Error("dsh_rpc_error_" + frame.error.code))
              : r.resolve(frame.result);
          }
        } else state.notify?.(frame);
      } catch {
        fail();
        child.kill();
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("exit", fail);
    this.processes.set(route.id, state);
    state.ready = this.rpc(state, "initialize", {
      cwd: this.config.cwd,
      provider: route.provider,
      model: route.model,
      maxTokens: 2048,
    }).then((result) => {
      if (result.serverInfo?.name !== "deepseek-harness-sdk-runtime")
        throw new Error("invalid_dsh_runtime");
    });
    // Initialization failures are observed by reply(); suppress unhandled rejection while idle.
    void state.ready.catch(() => {});
    return state;
  }
  private rpc(
    state: ReturnType<DshAdapter["process"]>,
    method: string,
    params: Frame,
  ) {
    const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.requests.delete(id);
        reject(new Error("dsh_rpc_timeout"));
      }, 30000);
      state.requests.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      state.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  async *reply(
    input: ReplyInput,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    const route = this.config.routes[0];
    if (!route) throw new Error("configure_harness_model");
    const key = input.sessionId;
    if (this.busy.has(key) || this.busy.has(route.id))
      throw new Error("harness_busy");
    this.busy.add(key);
    this.busy.add(route.id);
    let state: ReturnType<DshAdapter["process"]>;
    try {
      state = this.process(route);
      this.active.set(key, state.child);
      await state.ready;
      if (signal.aborted) throw new Error("aborted");
    } catch (error) {
      this.busy.delete(key);
      this.busy.delete(route.id);
      this.active.delete(key);
      throw error;
    }
    const sessionId = "clawsense-live-" + key;
    const queue: Frame[] = [];
    let wake: (() => void) | undefined;
    state.notify = (frame) => {
      if (frame.method === "error" || frame.params?.sessionId === sessionId) {
        queue.push(frame);
        wake?.();
      }
    };
    let running = false,
      ended = false,
      emitted = "";
    // The worker keeps draining after speech interruption; the task cannot be truthfully called cancelled.
    const deadline = Date.now() + (this.config.timeoutMs ?? 120000);
    try {
      await this.rpc(state, "session/prompt", {
        sessionId,
        contentBlocks: [
          {
            type: "text",
            text:
              personaPrompt(input.persona) +
              "\n这是当前用户请求，按宿主自身工具规则处理。必要时调用ClawSense获取证据。\n当前资料：" +
              JSON.stringify({ scene: input.context.scene, confirmed: input.context.confirmed, work: input.context.work }).slice(0, 12000) +
              "\n近期对话：" +
              JSON.stringify(input.history.slice(-8)) +
              "\n请求：" +
              input.query,
          },
        ],
      });
      while (!ended) {
        if (Date.now() >= deadline)
          throw new Error("harness_timeout_execution_unconfirmed");
        const frame = queue.shift();
        if (!frame) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
          continue;
        }
        if (frame.method === "error")
          throw new Error("harness_disconnected_execution_unconfirmed");
        if (frame.method === "session.status") {
          if (frame.params.status === "running") running = true;
          if (running && frame.params.status === "idle") ended = true;
        }
        if (frame.method !== "session.event") continue;
        const event = frame.params.event;
        if (event.type === "turn/end") {
          if (
            event.data?.reason?.kind &&
            event.data.reason.kind !== "completed"
          )
            throw new Error("harness_turn_failed_" + event.data.reason.kind);
          ended = true;
        }
        if (event.type === "assistant/message") {
          const message = event.data?.message ?? event.data;
          if (message?.role === "assistant") {
            const text = (message.content ?? message.contentBlocks ?? [])
              .filter((b: Frame) => b.type === "text")
              .map((b: Frame) => b.text)
              .join("");
            if (text) {
              emitted += text;
              yield { type: "text", text };
            }
          }
        }
      }
      if (!emitted.trim()) throw new Error("harness_no_answer");
      if (
        /无法(?:完成|处理|执行)|需要更强.{0,6}模型|超出.{0,6}能力/.test(emitted)
      )
        throw new Error("configure_stronger_harness_model");
    } finally {
      state.notify = undefined;
      this.busy.delete(key);
      this.busy.delete(route.id);
      this.active.delete(key);
      // A timeout cannot leave an uncorrelated worker running for the next prompt.
      if (!ended) {
        state.child.stdin.end();
        this.kill(state.child);
        this.processes.delete(route.id);
      }
    }
  }
  async close() {
    for (const state of this.processes.values()) {
      state.child.stdin.end();
      this.kill(state.child);
    }
    this.processes.clear();
  }
  async cancel(sessionId: string): Promise<"cancelled" | "unconfirmed"> {
    const child = this.active.get(sessionId);
    if (!child) return "unconfirmed";
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.kill(child, "SIGKILL"); }, 1000);
      const deadline = setTimeout(() => { clearTimeout(timer); resolve("unconfirmed"); }, 4000);
      child.once("exit", () => { clearTimeout(timer); clearTimeout(deadline); resolve("cancelled"); });
      this.kill(child);
    });
  }
  private kill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM") { try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid!, signal); } catch { child.kill(signal); } }
}
