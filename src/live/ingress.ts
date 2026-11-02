import fs from "node:fs/promises";
import path from "node:path";
import { constants, lstatSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { contextRoot } from "../context-coordinator.js";
import type { ContextPolicy } from "../context-access.js";

/** Atomic files already have a single writer. Audio ingress only needs credential/policy
 * metadata; it must not acquire the evidence coordinator's durable write lock every 20ms.
 * Check inode/ctime/mtime on every input, reload after every replacement, fail closed. */
class AtomicMetadata<T> {
  private signature = "";
  private cached?: T;
  private loading?: Promise<void>;
  constructor(private file: string, private parse: (input: any) => T) {}
  async read(): Promise<T> {
    // These bounded metadata syscalls must not queue behind durable fsyncs in
    // libuv's shared worker pool. File contents still reload asynchronously.
    for (let attempt = 0; attempt < 4; attempt++) {
      const info = lstatSync(this.file);
      const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("live_metadata_unavailable");
      if (signature === this.signature && this.cached !== undefined) return this.cached;
      this.loading ??= this.reload().finally(() => { this.loading = undefined; });
      await this.loading;
      // A replacement during reload must be checked again, including revocation.
    }
    throw new Error("live_metadata_unavailable");
  }
  private async reload(): Promise<void> {
    const handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("live_metadata_unavailable");
      const parsed = this.parse(JSON.parse(await handle.readFile("utf8")));
      this.cached = parsed; this.signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } finally { await handle.close(); }
  }
}
export class LiveIngressAuthorization {
  private root: string;
  private devices: AtomicMetadata<Array<{ deviceId: string; secretHash: string }>>;
  private policies: AtomicMetadata<Record<string, ContextPolicy>>;
  constructor(root: string) {
    this.root = contextRoot(root);
    this.devices = new AtomicMetadata(path.join(this.root, "plugins", "clawsense", "state.json"), input => {
      if (![1,2].includes(input.version) || !Array.isArray(input.devices)) throw new Error("live_metadata_unavailable");
      return input.devices.map((d: any) => { if (typeof d.deviceId !== "string" || !/^[a-f0-9]{64}$/.test(d.secretHash)) throw new Error("live_metadata_unavailable"); return { deviceId: d.deviceId, secretHash: d.secretHash }; });
    });
    this.policies = new AtomicMetadata(path.join(this.root, "plugins", "clawsense", "unified", "context.json"), input => {
      if (input.version !== 1 || !input.devicePolicies || typeof input.devicePolicies !== "object" || Array.isArray(input.devicePolicies)) throw new Error("live_metadata_unavailable"); return input.devicePolicies;
    });
  }
  async authenticate(authorization?: string) {
    const secret = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!secret || secret.length > 1024) return { ok: false };
    try {
      for (const suffix of ["plugins", "plugins/clawsense", "plugins/clawsense/unified"]) if (lstatSync(path.join(this.root,suffix)).isSymbolicLink()) throw new Error("live_metadata_unavailable");
      try { lstatSync(path.join(this.root,"context-authority-moved.json")); return { ok: false }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const hashed = createHash("sha256").update(secret).digest();
      const device = (await this.devices.read()).find(d => timingSafeEqual(Buffer.from(d.secretHash,"hex"),hashed));
      return device ? { ok: true, device: { deviceId: device.deviceId } } : { ok: false };
    } catch { return { ok: false }; }
  }
  async authorizeCapture(deviceId: string, projectId: string) {
    const policies = await this.policies.read(), policy = policies[deviceId] ?? policies["*"];
    if (!policy || !Array.isArray(policy.projectIds)) throw new Error("live_project_not_authorized");
    if (policy.processingLocation === "local-only") throw new Error("phone_local_processing_required");
    if (!["owned-devices", "selected-external", "legacy-configured"].includes(policy.processingLocation)) throw new Error("live_metadata_unavailable");
    if (!policy.projectIds.includes(projectId)) throw new Error("live_project_not_authorized");
  }
}
