import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Durable receipts: reconnect/restart must never silently execute a request twice. */
export class LiveRequestStore {
  constructor(private root: string) {}
  async claim(device: string, id: string, text: string): Promise<{ fresh: boolean; state: string }> {
    if (!id || id.length > 100 || /[\u0000-\u001f]/.test(id)) throw new Error("invalid_request_id");
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const directory = path.join(this.root, "live", "requests", hash(device));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, hash(id) + ".json");
    const temporary = file + "." + randomUUID();
    const value = { textHash: hash(text), state: "execution_unconfirmed", at: Date.now() };
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await fs.link(temporary, file);
      return { fresh: true, state: "claimed" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = JSON.parse(await fs.readFile(file, "utf8"));
      if (previous.textHash !== value.textHash) throw new Error("request_id_conflict");
      // Accepted is not a completion receipt. Unknown or interrupted execution is deliberately not retried.
      return { fresh: false, state: previous.state };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async update(device: string, id: string, state: string, workItemId?: string) {
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const file = path.join(this.root, "live", "requests", hash(device), hash(id) + ".json");
    const previous = JSON.parse(await fs.readFile(file, "utf8"));
    const temporary = file + "." + randomUUID();
    try { await fs.writeFile(temporary, JSON.stringify({ ...previous, state, workItemId, updatedAt: Date.now() }), { mode: 0o600, flag: "wx" }); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
  }
}
