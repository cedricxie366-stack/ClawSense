import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Connection, Table } from "@lancedb/lancedb";
import type { ClawSenseConfig } from "./config.js";
import type { OpenClawConfig, PluginLogger } from "./openclaw-types.js";
import { resolveOpenAiClient } from "./openai-client.js";
import type {
  ClawSenseDeviceRecord,
  ClawSenseIngestReceipt,
  ClawSenseStateStore,
} from "./state-store.js";

type LanceRow = {
  id: string;
  namespace: string;
  deviceId: string;
  modality: "audio" | "image";
  summary: string;
  transcript: string;
  note: string;
  sourcePath: string;
  createdAt: number;
  vector: number[];
};

const TABLE_NAME = "memories";

export class ClawSenseMemoryStore {
  private db: Connection | null = null;
  private table: Table | null = null;
  private initPromise: Promise<void> | null = null;
  private journalOnlyMode = false;
  private readonly cfg: ClawSenseConfig;
  private readonly runtimeConfig: OpenClawConfig;
  private readonly logger: PluginLogger;
  private readonly stateStore: ClawSenseStateStore;
  private readonly openai;

  constructor(params: {
    cfg: ClawSenseConfig;
    runtimeConfig: OpenClawConfig;
    logger: PluginLogger;
    stateStore: ClawSenseStateStore;
  }) {
    this.cfg = params.cfg;
    this.runtimeConfig = params.runtimeConfig;
    this.logger = params.logger;
    this.stateStore = params.stateStore;
    this.openai = resolveOpenAiClient(params.cfg, params.runtimeConfig);
  }

  async ingest(params: {
    device: ClawSenseDeviceRecord;
    modality: "audio" | "image";
    body: Buffer;
    fileName: string;
    mime?: string;
    capturedAt?: number;
    note?: string;
    describeImage: (args: {
      buffer: Buffer;
      fileName: string;
      mime?: string;
    }) => Promise<{ text: string }>;
    transcribeAudio: (args: { filePath: string; mime?: string }) => Promise<{ text?: string }>;
  }): Promise<ClawSenseIngestReceipt> {
    const storedFilePath = await this.writeBinaryArtifact(params.body, params.fileName);
    try {
      const createdAt = params.capturedAt ?? Date.now();
      const transcript =
        params.modality === "audio"
          ? await this.safeTranscribeAudio({
              filePath: storedFilePath,
              mime: params.mime,
              transcribeAudio: params.transcribeAudio,
            })
          : "";
      const summary =
        params.modality === "audio"
          ? summarizeAudio(transcript, params.note)
          : await this.safeDescribeImage({
              buffer: params.body,
              fileName: params.fileName,
              mime: params.mime,
              note: params.note,
              describeImage: params.describeImage,
            });

      const embeddingText = [
        `source=${this.cfg.memoryNamespace}`,
        `device=${params.device.deviceId}`,
        `modality=${params.modality}`,
        summary,
        transcript,
        params.note ?? "",
      ]
        .filter(Boolean)
        .join("\n");
      const memoryId = randomUUID();
      let embeddingModel: string | undefined;
      if (!this.journalOnlyMode) {
        try {
          await this.ensureTable();
          if (this.table) {
            const row: LanceRow = {
              id: memoryId,
              namespace: this.cfg.memoryNamespace,
              deviceId: params.device.deviceId,
              modality: params.modality,
              summary,
              transcript,
              note: params.note ?? "",
              sourcePath: storedFilePath,
              createdAt,
              vector: await this.embed(embeddingText),
            };
            await this.table.add([row]);
            embeddingModel = this.cfg.embeddingModel;
          }
        } catch (error) {
          this.enableJournalOnlyMode(error);
        }
      }

      await this.stateStore.appendJournal({
        memoryId,
        namespace: this.cfg.memoryNamespace,
        deviceId: params.device.deviceId,
        modality: params.modality,
        summary,
        transcript: transcript || undefined,
        note: params.note || undefined,
        createdAt,
        embeddingModel,
        sourcePath: storedFilePath,
      });

      return {
        memoryId,
        deviceId: params.device.deviceId,
        modality: params.modality,
        summary,
        transcript: transcript || undefined,
        createdAt,
        storedAt: storedFilePath,
        namespace: this.cfg.memoryNamespace,
      };
    } catch (error) {
      await fs.unlink(storedFilePath).catch(() => {});
      throw error;
    }
  }

  private async writeBinaryArtifact(body: Buffer, fileName: string): Promise<string> {
    const dir = path.join(os.tmpdir(), "clawsense-artifacts");
    await fs.mkdir(dir, { recursive: true });
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(dir, `${Date.now()}-${safeFileName}`);
    await fs.writeFile(filePath, body);
    return filePath;
  }

  private async ensureTable(): Promise<void> {
    if (this.journalOnlyMode) {
      return;
    }
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const lancedb = await import("@lancedb/lancedb");
    const dbPath =
      this.cfg.memoryDbPath ??
      path.join(os.homedir(), ".openclaw", "memory", "clawsense-lancedb");
    this.db = await lancedb.connect(dbPath);
    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      return;
    }

    const vectorSize = this.cfg.embeddingDimensions ?? 1536;
    this.table = await this.db.createTable(TABLE_NAME, [
      {
        id: "__schema__",
        namespace: this.cfg.memoryNamespace,
        deviceId: "",
        modality: "audio",
        summary: "",
        transcript: "",
        note: "",
        sourcePath: "",
        createdAt: 0,
        vector: Array.from({ length: vectorSize }, () => 0),
      },
    ]);
    await this.table.delete('id = "__schema__"');
    this.logger.info(`[clawsense] memory table initialized at ${dbPath}`);
  }

  private async embed(input: string): Promise<number[]> {
    if (!this.openai) {
      this.logger.warn(
        "[clawsense] OpenAI embedding client unavailable; using deterministic fallback vectors",
      );
      return fallbackEmbed(input, this.cfg.embeddingDimensions ?? 1536);
    }
    const response = await this.openai.embeddings.create({
      model: this.cfg.embeddingModel,
      input,
      dimensions: this.cfg.embeddingDimensions,
    });
    return response.data[0].embedding;
  }

  private async safeTranscribeAudio(params: {
    filePath: string;
    mime?: string;
    transcribeAudio: (args: { filePath: string; mime?: string }) => Promise<{ text?: string }>;
  }): Promise<string> {
    try {
      const response = await params.transcribeAudio({
        filePath: params.filePath,
        mime: params.mime,
      });
      return response.text?.trim() ?? "";
    } catch (error) {
      this.logger.warn(`[clawsense] audio transcription failed, storing fallback summary: ${String(error)}`);
      return "";
    }
  }

  private async safeDescribeImage(params: {
    buffer: Buffer;
    fileName: string;
    mime?: string;
    note?: string;
    describeImage: (args: {
      buffer: Buffer;
      fileName: string;
      mime?: string;
    }) => Promise<{ text: string }>;
  }): Promise<string> {
    try {
      const response = await params.describeImage({
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.mime,
      });
      const text = response.text.trim();
      if (text) {
        return text;
      }
    } catch (error) {
      this.logger.warn(`[clawsense] image description failed, storing fallback summary: ${String(error)}`);
    }
    return params.note?.trim() || "Image captured but visual summary was unavailable.";
  }

  private enableJournalOnlyMode(error: unknown): void {
    if (!this.journalOnlyMode) {
      this.logger.warn(
        `[clawsense] LanceDB unavailable; falling back to journal-only memory storage: ${String(error)}`,
      );
    }
    this.journalOnlyMode = true;
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}

function summarizeAudio(transcript: string, note?: string): string {
  const trimmed = transcript.trim();
  if (trimmed) {
    return note?.trim()
      ? `${trimmed}\n\nOperator note: ${note.trim()}`
      : trimmed;
  }
  return note?.trim() || "Audio captured but transcription was empty.";
}

function fallbackEmbed(input: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const normalized = input.trim() || "clawsense";
  for (let index = 0; index < dimensions; index += 1) {
    const digest = createHash("sha256")
      .update(normalized)
      .update(":")
      .update(String(index))
      .digest();
    const value = digest.readUInt32BE(0) / 0xffffffff;
    vector[index] = value * 2 - 1;
  }
  return vector;
}
