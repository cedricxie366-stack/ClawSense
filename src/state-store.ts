import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeviceSecret, hashSecret } from "./utils.js";
import type { PluginLogger } from "./openclaw-types.js";

const STATE_RELATIVE_DIR = ["plugins", "clawsense"] as const;
const STATE_FILE_NAME = "state.json";

export type ClawSenseSetupToken = {
  token: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
};

export type ClawSenseDeviceRecord = {
  deviceId: string;
  name: string;
  platform: string;
  appVersion?: string;
  fingerprint?: string;
  createdAt: number;
  lastSeenAt?: number;
  lastHeartbeatAt?: number;
  secretHash: string;
  plainSecret?: string;
  lastHeartbeat?: Record<string, unknown>;
};

export type ClawSenseMemoryJournal = {
  memoryId: string;
  namespace: string;
  deviceId: string;
  modality: "audio" | "image";
  summary: string;
  transcript?: string;
  note?: string;
  createdAt: number;
  embeddingModel?: string;
  sourcePath?: string;
};

export type ClawSenseIngestReceipt = {
  memoryId: string;
  deviceId: string;
  modality: "audio" | "image";
  summary: string;
  transcript?: string;
  createdAt: number;
  storedAt: string;
  namespace: string;
};

type StoredState = {
  version: 1;
  setupTokens: ClawSenseSetupToken[];
  devices: ClawSenseDeviceRecord[];
  journal: ClawSenseMemoryJournal[];
};

const EMPTY_STATE: StoredState = {
  version: 1,
  setupTokens: [],
  devices: [],
  journal: [],
};

export class ClawSenseStateStore {
  private readonly resolveStateDir: () => string;
  private readonly logger: PluginLogger;

  constructor(params: { resolveStateDir: () => string; logger: PluginLogger }) {
    this.resolveStateDir = params.resolveStateDir;
    this.logger = params.logger;
  }

  async listSetupTokens(): Promise<ClawSenseSetupToken[]> {
    return (await this.readState()).setupTokens;
  }

  async upsertSetupToken(token: ClawSenseSetupToken): Promise<void> {
    await this.mutate((state) => {
      const next = state.setupTokens
        .filter((item) => item.expiresAt > Date.now() && !item.consumedAt)
        .concat(token);
      state.setupTokens = next.sort((left, right) => right.createdAt - left.createdAt);
    });
  }

  async consumeSetupToken(rawToken: string): Promise<ClawSenseSetupToken | null> {
    let consumed: ClawSenseSetupToken | null = null;
    const now = Date.now();
    await this.mutate((state) => {
      const tokenHash = hashSecret(rawToken);
      const target = state.setupTokens.find((token) => token.tokenHash === tokenHash);
      if (!target || target.consumedAt || target.expiresAt <= now) {
        state.setupTokens = state.setupTokens.filter((token) => token.expiresAt > now && !token.consumedAt);
        return;
      }
      target.consumedAt = now;
      consumed = { ...target };
      state.setupTokens = state.setupTokens.filter((token) => token.expiresAt > now);
    });
    return consumed;
  }

  async pruneExpiredSetupTokens(fallbackTtlSeconds: number): Promise<void> {
    const threshold = Date.now() - fallbackTtlSeconds * 1000;
    await this.mutate((state) => {
      state.setupTokens = state.setupTokens.filter(
        (token) => token.expiresAt > Date.now() && token.createdAt >= threshold,
      );
    });
  }

  async listDevices(): Promise<ClawSenseDeviceRecord[]> {
    return (await this.readState()).devices;
  }

  async registerDevice(params: {
    name: string;
    platform: string;
    appVersion?: string;
    fingerprint?: string;
  }): Promise<ClawSenseDeviceRecord> {
    const plainSecret = createDeviceSecret();
    const device: ClawSenseDeviceRecord = {
      deviceId: randomUUID(),
      name: params.name,
      platform: params.platform,
      appVersion: params.appVersion,
      fingerprint: params.fingerprint,
      createdAt: Date.now(),
      secretHash: hashSecret(plainSecret),
      plainSecret,
    };
    await this.mutate((state) => {
      state.devices.push({ ...device, plainSecret: undefined });
    });
    return device;
  }

  async touchDevice(deviceId: string): Promise<void> {
    await this.mutate((state) => {
      const device = state.devices.find((item) => item.deviceId === deviceId);
      if (device) {
        device.lastSeenAt = Date.now();
      }
    });
  }

  async updateHeartbeat(
    deviceId: string,
    heartbeat: {
      batteryPct?: number;
      network?: string;
      appState?: string;
      raw: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.mutate((state) => {
      const device = state.devices.find((item) => item.deviceId === deviceId);
      if (!device) {
        return;
      }
      const now = Date.now();
      device.lastSeenAt = now;
      device.lastHeartbeatAt = now;
      device.lastHeartbeat = {
        ...heartbeat.raw,
        batteryPct: heartbeat.batteryPct,
        network: heartbeat.network,
        appState: heartbeat.appState,
      };
    });
  }

  async appendJournal(entry: ClawSenseMemoryJournal): Promise<void> {
    await this.mutate((state) => {
      state.journal.push(entry);
    });
  }

  async listJournal(): Promise<ClawSenseMemoryJournal[]> {
    return (await this.readState()).journal;
  }

  private get statePath(): string {
    return path.join(this.resolveStateDir(), ...STATE_RELATIVE_DIR, STATE_FILE_NAME);
  }

  private async ensureStateDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
  }

  private async readState(): Promise<StoredState> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredState>;
      if (parsed.version !== 1) {
        return structuredClone(EMPTY_STATE);
      }
      return {
        version: 1,
        setupTokens: Array.isArray(parsed.setupTokens) ? parsed.setupTokens : [],
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        journal: Array.isArray(parsed.journal) ? parsed.journal : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`[clawsense] failed to read state: ${String(error)}`);
      }
      return structuredClone(EMPTY_STATE);
    }
  }

  private async writeState(next: StoredState): Promise<void> {
    await this.ensureStateDir();
    const tempPath = `${this.statePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.statePath);
  }

  private async mutate(mutator: (state: StoredState) => void): Promise<void> {
    const state = await this.readState();
    mutator(state);
    await this.writeState(state);
  }
}
