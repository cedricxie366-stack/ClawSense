import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
export type RpcItem = { type: string; [key: string]: any };
/** One worker owns one model; bounded queues avoid simultaneous MLX access. */
export class ProcessRpc {
  private closing = false;
  private child?: ChildProcessWithoutNullStreams;
  private generation = 0;
  get processGeneration() { return this.generation; }
  private pending = new Map<
    string,
    { push: (value: RpcItem) => void; fail: (e: Error) => void }
  >();
  constructor(
    private command: string,
    private args: string[],
    private env?: NodeJS.ProcessEnv,
  ) {}
  private boot() {
    if (this.closing) throw new Error("worker_closed");
    if (this.child) return;
    const child = (this.child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: "pipe",
    }));
    this.generation++;
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        this.pending.get(frame.id)?.push(frame);
      } catch {
        this.failAll(new Error("worker_protocol_error"));
        child.kill();
      }
    });
    // Worker diagnostics may contain user material; never forward them to clients or logs.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () =>
      this.failAll(new Error("worker_input_closed")),
    );
    child.on("error", () => this.failAll(new Error("worker_start_failed")));
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      this.failAll(new Error("worker_exited"));
    });
  }
  private failAll(e: Error) {
    for (const item of this.pending.values()) item.fail(e);
    this.pending.clear();
  }
  async *stream(
    op: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<RpcItem> {
    if (signal?.aborted) throw new Error("aborted");
    if (this.pending.size >= 8) throw new Error("worker_busy");
    this.boot();
    const id = randomUUID(),
      queue: RpcItem[] = [];
    let finished = false;
    let error: Error | undefined;
    let wake: (() => void) | undefined;
    const abort = () => {
      error = new Error("aborted");
      if (!this.child?.stdin.writableEnded && !this.child?.stdin.destroyed)
        this.child?.stdin.write(
          JSON.stringify({ op: "cancel", target: id }) + "\n",
        );
      wake?.();
    };
    const timeout = setTimeout(
      () => {
        error = new Error("worker_timeout");
        abort();
      },
      op === "probe" ? 180000 : 120000,
    );
    this.pending.set(id, {
      push(value) {
        if (queue.length > 512) error = new Error("worker_output_overflow");
        else queue.push(value);
        wake?.();
      },
      fail(e) {
        error = e;
        wake?.();
      },
    });
    signal?.addEventListener("abort", abort, { once: true });
    this.child!.stdin.write(JSON.stringify({ ...data, id, op }) + "\n");
    try {
      while (true) {
        if (error) throw error;
        const item = queue.shift();
        if (!item) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        if (item.type === "error") {
          finished = true;
          throw new Error(String(item.code ?? "worker_error"));
        }
        if (item.type === "done") {
          finished = true;
          break;
        }
        yield item;
      }
    } finally {
      if (
        !finished &&
        !signal?.aborted &&
        !this.child?.stdin.writableEnded &&
        !this.child?.stdin.destroyed
      )
        if (!this.child?.stdin.writableEnded && !this.child?.stdin.destroyed)
          this.child?.stdin.write(
            JSON.stringify({ op: "cancel", target: id }) + "\n",
          );
      clearTimeout(timeout);
      this.pending.delete(id);
      signal?.removeEventListener("abort", abort);
    }
  }
  async call(
    op: string,
    data: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    const values: RpcItem[] = [];
    for await (const item of this.stream(op, data, signal)) values.push(item);
    return values;
  }
  async close() {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    this.failAll(new Error("worker_closed"));
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
