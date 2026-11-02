import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDigitalScopes, type DigitalScope } from "./digital-access.js";
import { normalizeContextScopes, normalizeContextCapabilities, type ContextScope, type ContextMutation } from "./context-access.js";

export type AgentGrant = { id: string; agentId: string; createdAt: number; revokedAt?: number; digitalScopes?: DigitalScope[]; contextScopes?: ContextScope[]; contextCapabilities?: ContextMutation[]; contextProcessingLocation?: "local-only" | "owned-devices" | "selected-external" };
type StoredGrant = AgentGrant & { tokenHash: string };
const operations = new Map<string, Promise<unknown>>();

/** Single-owner companion grants. Each token gives access to this owner's library. */
export class AgentAccessStore {
  private readonly file: string;
  constructor({ stateDir }: { stateDir: string }) {
    this.file = path.join(path.resolve(stateDir), "agent-grants.json");
  }

  async issue(agentId: string, requestedScopes?: unknown, requestedContextScopes?: unknown, requestedCapabilities?: unknown, processingLocation?: AgentGrant["contextProcessingLocation"]): Promise<{ token: string; grant: AgentGrant }> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agentId) || ["local-owner", "openclaw"].includes(agentId)) {
      throw new Error("invalid_agent_id");
    }
    const digitalScopes = normalizeDigitalScopes(requestedScopes);
    const contextScopes = normalizeContextScopes(requestedContextScopes);
    const contextCapabilities = normalizeContextCapabilities(requestedCapabilities);
    if (processingLocation !== undefined && !["local-only", "owned-devices", "selected-external"].includes(processingLocation)) throw new Error("invalid_processing_location");
    return this.mutate((grants) => {
      const token = randomBytes(32).toString("base64url");
      const grant = { id: randomUUID(), agentId, createdAt: Date.now(), digitalScopes, ...(contextScopes === undefined ? {} : { contextScopes, contextCapabilities: contextCapabilities ?? [] }), ...(processingLocation ? { contextProcessingLocation: processingLocation } : {}) };
      grants.push({ ...grant, tokenHash: digest(token) });
      return { token, grant };
    });
  }

  async authenticate(token: string): Promise<AgentGrant | null> {
    if (!token || token.length > 512) return null;
    const hash = Buffer.from(digest(token), "hex");
    const match = (await this.read()).find((grant) => !grant.revokedAt && timingSafeEqual(hash, Buffer.from(grant.tokenHash, "hex")));
    return match ? publicGrant(match) : null;
  }

  async list(): Promise<AgentGrant[]> {
    return (await this.read()).map(publicGrant);
  }

  async revoke(id: string): Promise<boolean> {
    return this.mutate((grants) => {
      const grant = grants.find((item) => item.id === id);
      if (!grant) return false;
      grant.revokedAt ??= Date.now();
      return true;
    });
  }

  private async read(): Promise<StoredGrant[]> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_grant_store");
      const data: unknown = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(data) || !data.every((item) => item && typeof item.id === "string" &&
        typeof item.agentId === "string" && Number.isFinite(item.createdAt) &&
        (item.revokedAt === undefined || Number.isFinite(item.revokedAt)) &&
        typeof item.tokenHash === "string" && /^[a-f0-9]{64}$/.test(item.tokenHash))) {
        throw new Error("invalid_grant_store");
      }
      for (const item of data) { normalizeDigitalScopes(item.digitalScopes); normalizeContextScopes(item.contextScopes); normalizeContextCapabilities(item.contextCapabilities); }
      if (data.some((item) => item.contextProcessingLocation !== undefined && !["local-only", "owned-devices", "selected-external"].includes(item.contextProcessingLocation))) throw new Error("invalid_processing_location");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("agent_grant_store_unreadable", { cause: error });
    }
  }

  private async mutate<T>(operation: (grants: StoredGrant[]) => T): Promise<T> {
    const previous = operations.get(this.file) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const grants = await this.read();
      const result = operation(grants);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, this.file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
    operations.set(this.file, pending);
    try { return await pending; }
    finally { if (operations.get(this.file) === pending) operations.delete(this.file); }
  }
}

function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function publicGrant({ tokenHash: _tokenHash, ...grant }: StoredGrant): AgentGrant { return grant; }
