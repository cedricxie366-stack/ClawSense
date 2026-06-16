import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createDeviceSecret,
  hashSecret,
  isLowSignalSemanticText,
  normalizeSemanticText,
  parseClawSenseAudioSessionHint,
} from "./utils.js";
import type { PluginLogger } from "./openclaw-types.js";

const STATE_RELATIVE_DIR = ["plugins", "clawsense"] as const;
const STATE_FILE_NAME = "state.json";
const AUDIO_WINDOW_GAP_MS = 4 * 60_000;
const ACTIVE_WINDOW_GAP_MS = 3 * 60_000;
const BASELINE_IMAGE_WINDOW_GAP_MS = 10 * 60_000;
const MAX_CONVERSATION_WINDOW_SPAN_MS = 30 * 60_000;
const LEGACY_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

export type ClawSenseArtifactRecord = {
  artifactId: string;
  deviceId: string;
  modality: "audio" | "image" | "video";
  fileName: string;
  mime?: string;
  capturedAt: number;
  createdAt: number;
  sizeBytes: number;
  storagePath: string;
  storageRelPath: string;
  retentionExpiresAt: number;
  deletedAt?: number;
};

export type ClawSenseCaptureEvent = {
  eventId: string;
  windowId: string;
  artifactId: string;
  deviceId: string;
  modality: "audio" | "image" | "video";
  summary: string;
  transcript?: string;
  note?: string;
  createdAt: number;
  capturedAt: number;
  sourcePath: string;
  embeddingModel?: string;
  analysisMode:
    | "multimodal-preview"
    | "runtime-stt"
    | "runtime-stt-fallback"
    | "openai-stt-fallback"
    | "metadata-only";
  analysisProvider?: string;
  analysisStatus?: "succeeded" | "degraded";
  analysisFailureReason?: string;
  sttProvider?: "runtime" | "openai-fallback" | "compatible-fallback";
  lastAudioBackfillAttemptAt?: number;
  audioBackfillAttemptCount?: number;
  captureContext: "audio-window" | "active-window" | "baseline-snapshot";
  peopleRefs: string[];
  projectRefs: string[];
  tags: string[];
};

export type ClawSenseMemoryJournal = {
  memoryId: string;
  eventId: string;
  artifactId: string;
  windowId: string;
  namespace: string;
  deviceId: string;
  modality: "audio" | "image" | "video";
  summary: string;
  transcript?: string;
  note?: string;
  createdAt: number;
  embeddingModel?: string;
  sourcePath?: string;
  analysisMode?: ClawSenseCaptureEvent["analysisMode"];
  analysisProvider?: ClawSenseCaptureEvent["analysisProvider"];
  analysisStatus?: ClawSenseCaptureEvent["analysisStatus"];
  analysisFailureReason?: ClawSenseCaptureEvent["analysisFailureReason"];
  sttProvider?: ClawSenseCaptureEvent["sttProvider"];
  lastAudioBackfillAttemptAt?: ClawSenseCaptureEvent["lastAudioBackfillAttemptAt"];
  audioBackfillAttemptCount?: ClawSenseCaptureEvent["audioBackfillAttemptCount"];
  captureContext?: ClawSenseCaptureEvent["captureContext"];
};

export type ClawSenseIngestReceipt = {
  memoryId: string;
  deviceId: string;
  modality: "audio" | "image" | "video";
  summary: string;
  transcript?: string;
  createdAt: number;
  storedAt: string;
  namespace: string;
  windowId?: string;
  artifactId?: string;
  analysisMode?: ClawSenseCaptureEvent["analysisMode"];
};

export type ClawSensePersonAnnotation = {
  annotationId: string;
  personRef: string;
  displayName: string;
  notes?: string;
  relationship?: string;
  nextWatchFor?: string;
  eventIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type ClawSenseSpeakerAnnotation = {
  annotationId: string;
  speakerRef: string;
  displayName: string;
  notes?: string;
  relationship?: string;
  windowId?: string;
  deviceId?: string;
  eventIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type ClawSenseReviewSection = {
  title: string;
  items: string[];
};

export type ClawSenseDailyReview = {
  reviewId: string;
  date: string;
  generatedAt: number;
  mode: "multimodal" | "heuristic";
  model?: string;
  summary: string;
  sections: ClawSenseReviewSection[];
  keyEventIds: string[];
  keyArtifactIds: string[];
};

export type ClawSenseDailyConsolidation = {
  consolidationId: string;
  date: string;
  generatedAt: number;
  sourceReviewId?: string;
  summary: string;
  keyInsights: string[];
  tasks: string[];
  attentionItems: string[];
  learningPoints: string[];
  keyWindowIds: string[];
  people: Array<{
    personRef?: string;
    speakerRef?: string;
    displayName: string;
    relationship?: string;
    status: "confirmed" | "hint";
    evidenceCount: number;
  }>;
  projects: Array<{
    ref: string;
    label: string;
    source: "project-ref" | "tag";
    evidenceCount: number;
    windowIds: string[];
  }>;
  stats: {
    windowCount: number;
    eventCount: number;
    audioWindowCount: number;
    transcriptReadyWindows: number;
    imageCount: number;
    audioCount: number;
    degradedEventCount: number;
  };
};

type StoredStateV1 = {
  version: 1;
  setupTokens: ClawSenseSetupToken[];
  devices: ClawSenseDeviceRecord[];
  journal: Array<{
    memoryId: string;
    namespace: string;
    deviceId: string;
    modality: "audio" | "image" | "video";
    summary: string;
    transcript?: string;
    note?: string;
    createdAt: number;
    embeddingModel?: string;
    sourcePath?: string;
  }>;
};

type StoredState = {
  version: 2;
  setupTokens: ClawSenseSetupToken[];
  devices: ClawSenseDeviceRecord[];
  journal: ClawSenseMemoryJournal[];
  artifacts: ClawSenseArtifactRecord[];
  events: ClawSenseCaptureEvent[];
  people: ClawSensePersonAnnotation[];
  speakers: ClawSenseSpeakerAnnotation[];
  reviews: ClawSenseDailyReview[];
  consolidations: ClawSenseDailyConsolidation[];
};

const EMPTY_STATE: StoredState = {
  version: 2,
  setupTokens: [],
  devices: [],
  journal: [],
  artifacts: [],
  events: [],
  people: [],
  speakers: [],
  reviews: [],
  consolidations: [],
};

export class ClawSenseStateStore {
  private readonly resolveStateDir: () => string;
  private readonly logger: PluginLogger;
  private mutationChain: Promise<unknown> = Promise.resolve();

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
      if (!target || target.consumedAt) {
        state.setupTokens = state.setupTokens.filter((token) => token.expiresAt > now && !token.consumedAt);
        return;
      }
      if (target.expiresAt <= now) {
        consumed = { ...target };
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
    const normalizedFingerprint = params.fingerprint?.trim() || undefined;
    let device: ClawSenseDeviceRecord | null = null;
    await this.mutate((state) => {
      const existing =
        normalizedFingerprint
          ? state.devices.find(
              (item) =>
                item.platform === params.platform &&
                typeof item.fingerprint === "string" &&
                item.fingerprint.trim() === normalizedFingerprint,
            )
          : undefined;
      if (existing) {
        existing.name = params.name;
        existing.platform = params.platform;
        existing.appVersion = params.appVersion;
        existing.fingerprint = normalizedFingerprint;
        existing.secretHash = hashSecret(plainSecret);
        device = {
          ...existing,
          plainSecret,
        };
        return;
      }

      device = {
        deviceId: randomUUID(),
        name: params.name,
        platform: params.platform,
        appVersion: params.appVersion,
        fingerprint: normalizedFingerprint,
        createdAt: Date.now(),
        secretHash: hashSecret(plainSecret),
        plainSecret,
      };
      state.devices.push({ ...device, plainSecret: undefined });
    });
    if (!device) {
      throw new Error("failed_to_register_device");
    }
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

  async recordCapture(params: {
    memoryId: string;
    namespace: string;
    deviceId: string;
    modality: "audio" | "image" | "video";
    summary: string;
    transcript?: string;
    note?: string;
    createdAt: number;
    capturedAt: number;
    sourcePath: string;
    fileName: string;
    mime?: string;
    sizeBytes: number;
    storageRelPath: string;
    retentionExpiresAt: number;
    embeddingModel?: string;
    analysisMode: ClawSenseCaptureEvent["analysisMode"];
    analysisProvider?: ClawSenseCaptureEvent["analysisProvider"];
    analysisStatus?: ClawSenseCaptureEvent["analysisStatus"];
    analysisFailureReason?: ClawSenseCaptureEvent["analysisFailureReason"];
    sttProvider?: ClawSenseCaptureEvent["sttProvider"];
    peopleRefs?: string[];
    projectRefs?: string[];
    tags?: string[];
  }): Promise<{ artifact: ClawSenseArtifactRecord; event: ClawSenseCaptureEvent }> {
    return await this.mutate((state) => {
      const artifact: ClawSenseArtifactRecord = {
        artifactId: randomUUID(),
        deviceId: params.deviceId,
        modality: params.modality,
        fileName: params.fileName,
        mime: params.mime,
        capturedAt: params.capturedAt,
        createdAt: params.createdAt,
        sizeBytes: params.sizeBytes,
        storagePath: params.sourcePath,
        storageRelPath: params.storageRelPath,
        retentionExpiresAt: params.retentionExpiresAt,
      };

      const { windowId, captureContext } = resolveWindowAssignment({
        events: state.events,
        deviceId: params.deviceId,
        modality: params.modality,
        capturedAt: params.capturedAt,
        note: params.note,
      });
      const semanticSignals = deriveEventSemanticSignals({
        summary: params.summary,
        transcript: params.transcript,
        note: params.note,
        modality: params.modality,
        projectRefs: params.projectRefs,
        tags: params.tags,
      });

      const event: ClawSenseCaptureEvent = {
        eventId: params.memoryId,
        windowId,
        artifactId: artifact.artifactId,
        deviceId: params.deviceId,
        modality: params.modality,
        summary: params.summary,
        transcript: params.transcript,
        note: params.note,
        createdAt: params.createdAt,
        capturedAt: params.capturedAt,
        sourcePath: params.sourcePath,
        embeddingModel: params.embeddingModel,
        analysisMode: params.analysisMode,
        analysisProvider: params.analysisProvider,
        analysisStatus: params.analysisStatus,
        analysisFailureReason: params.analysisFailureReason,
        sttProvider: params.sttProvider,
        lastAudioBackfillAttemptAt: undefined,
        audioBackfillAttemptCount: 0,
        captureContext,
        peopleRefs: normalizeStringList(params.peopleRefs),
        projectRefs: semanticSignals.projectRefs,
        tags: Array.from(new Set([captureContext, ...semanticSignals.tags])),
      };

      const journalEntry: ClawSenseMemoryJournal = {
        memoryId: params.memoryId,
        eventId: event.eventId,
        artifactId: artifact.artifactId,
        windowId,
        namespace: params.namespace,
        deviceId: params.deviceId,
        modality: params.modality,
        summary: params.summary,
        transcript: params.transcript,
        note: params.note,
        createdAt: params.createdAt,
        embeddingModel: params.embeddingModel,
        sourcePath: params.sourcePath,
        analysisMode: params.analysisMode,
        analysisProvider: params.analysisProvider,
        analysisStatus: params.analysisStatus,
        analysisFailureReason: params.analysisFailureReason,
        sttProvider: params.sttProvider,
        lastAudioBackfillAttemptAt: undefined,
        audioBackfillAttemptCount: 0,
        captureContext,
      };

      state.artifacts.push(artifact);
      state.events.push(event);
      state.journal.push(journalEntry);
      return { artifact, event };
    });
  }

  async listJournal(): Promise<ClawSenseMemoryJournal[]> {
    return (await this.readState()).journal;
  }

  async listArtifacts(): Promise<ClawSenseArtifactRecord[]> {
    return (await this.readState()).artifacts;
  }

  async getArtifact(artifactId: string): Promise<ClawSenseArtifactRecord | null> {
    return (await this.readState()).artifacts.find((item) => item.artifactId === artifactId) ?? null;
  }

  async listEvents(): Promise<ClawSenseCaptureEvent[]> {
    return (await this.readState()).events;
  }

  async listEventsByDate(date: string): Promise<ClawSenseCaptureEvent[]> {
    return (await this.readState()).events.filter((event) => toLocalDateKey(event.capturedAt) === date);
  }

  async backfillCaptureAnalysis(params: {
    artifactId: string;
    summary?: string;
    transcript?: string;
    analysisMode?: ClawSenseCaptureEvent["analysisMode"];
    analysisProvider?: ClawSenseCaptureEvent["analysisProvider"];
    analysisStatus?: ClawSenseCaptureEvent["analysisStatus"];
    analysisFailureReason?: ClawSenseCaptureEvent["analysisFailureReason"];
    sttProvider?: ClawSenseCaptureEvent["sttProvider"];
    projectRefs?: string[];
    tags?: string[];
    attemptedAt?: number;
  }): Promise<{ updated: boolean; event: ClawSenseCaptureEvent | null }> {
    return await this.mutate((state) => {
      const normalizedTranscript = normalizeSemanticText(params.transcript) || undefined;
      const normalizedSummary = normalizeSemanticText(params.summary) || undefined;
      const attemptedAt = params.attemptedAt ?? Date.now();
      let updated = false;
      let nextEvent: ClawSenseCaptureEvent | null = null;
      let targetDate: string | null = null;

      state.events = state.events.map((event) => {
        if (event.artifactId !== params.artifactId) {
          return event;
        }

        let next = event;
        const nextTranscript = normalizedTranscript ?? event.transcript;
        if (normalizedTranscript && normalizedTranscript !== event.transcript) {
          next = { ...next, transcript: normalizedTranscript };
          updated = true;
        }

        if (
          normalizedSummary &&
          normalizedSummary !== event.summary &&
          shouldAdoptBackfilledSummary(event.summary, normalizedSummary, event.analysisStatus, nextTranscript)
        ) {
          next = { ...next, summary: normalizedSummary };
          updated = true;
        }

        if (params.analysisProvider && params.analysisProvider !== next.analysisProvider) {
          next = { ...next, analysisProvider: params.analysisProvider };
          updated = true;
        }
        if (params.analysisMode && params.analysisMode !== next.analysisMode) {
          next = { ...next, analysisMode: params.analysisMode };
          updated = true;
        }
        if (params.analysisStatus && params.analysisStatus !== next.analysisStatus) {
          next = { ...next, analysisStatus: params.analysisStatus };
          updated = true;
        }

        const nextFailureReason =
          params.analysisStatus === "succeeded" || normalizedTranscript
            ? undefined
            : params.analysisFailureReason ?? next.analysisFailureReason;
        if (nextFailureReason !== next.analysisFailureReason) {
          next = { ...next, analysisFailureReason: nextFailureReason };
          updated = true;
        }

        if (params.sttProvider && params.sttProvider !== next.sttProvider) {
          next = { ...next, sttProvider: params.sttProvider };
          updated = true;
        }
        const nextSignals = deriveEventSemanticSignals({
          summary: normalizedSummary ?? next.summary,
          transcript: nextTranscript,
          note: next.note,
          modality: next.modality,
          projectRefs: params.projectRefs ?? next.projectRefs,
          tags: params.tags ?? next.tags,
        });
        if (!sameStringList(nextSignals.projectRefs, next.projectRefs)) {
          next = { ...next, projectRefs: nextSignals.projectRefs };
          updated = true;
        }
        const nextTags = Array.from(new Set([next.captureContext, ...nextSignals.tags]));
        if (!sameStringList(nextTags, next.tags)) {
          next = { ...next, tags: nextTags };
          updated = true;
        }
        if (attemptedAt !== next.lastAudioBackfillAttemptAt) {
          next = {
            ...next,
            lastAudioBackfillAttemptAt: attemptedAt,
            audioBackfillAttemptCount: (next.audioBackfillAttemptCount ?? 0) + 1,
          };
          updated = true;
        }

        nextEvent = next;
        targetDate = toLocalDateKey(next.capturedAt);
        return next;
      });

      if (!nextEvent) {
        return { updated: false, event: null };
      }

      state.journal = state.journal.map((entry) => {
        if (entry.artifactId !== params.artifactId) {
          return entry;
        }

        let next = entry;
        if (normalizedTranscript && normalizedTranscript !== entry.transcript) {
          next = { ...next, transcript: normalizedTranscript };
        }
        if (
          normalizedSummary &&
          normalizedSummary !== entry.summary &&
          shouldAdoptBackfilledSummary(entry.summary, normalizedSummary, entry.analysisStatus, normalizedTranscript)
        ) {
          next = { ...next, summary: normalizedSummary };
        }
        if (params.analysisProvider && params.analysisProvider !== next.analysisProvider) {
          next = { ...next, analysisProvider: params.analysisProvider };
        }
        if (params.analysisMode && params.analysisMode !== next.analysisMode) {
          next = { ...next, analysisMode: params.analysisMode };
        }
        if (params.analysisStatus && params.analysisStatus !== next.analysisStatus) {
          next = { ...next, analysisStatus: params.analysisStatus };
        }
        const nextFailureReason =
          params.analysisStatus === "succeeded" || normalizedTranscript
            ? undefined
            : params.analysisFailureReason ?? next.analysisFailureReason;
        if (nextFailureReason !== next.analysisFailureReason) {
          next = { ...next, analysisFailureReason: nextFailureReason };
        }
        if (params.sttProvider && params.sttProvider !== next.sttProvider) {
          next = { ...next, sttProvider: params.sttProvider };
        }
        if (attemptedAt !== next.lastAudioBackfillAttemptAt) {
          next = {
            ...next,
            lastAudioBackfillAttemptAt: attemptedAt,
            audioBackfillAttemptCount: (next.audioBackfillAttemptCount ?? 0) + 1,
          };
        }
        return next;
      });

      if (updated && targetDate) {
        state.reviews = state.reviews.filter((review) => review.date !== targetDate);
        state.consolidations = state.consolidations.filter((item) => item.date !== targetDate);
      }

      return { updated, event: nextEvent };
    });
  }

  async noteAudioBackfillAttempt(params: {
    artifactId: string;
    analysisProvider?: ClawSenseCaptureEvent["analysisProvider"];
    analysisFailureReason?: ClawSenseCaptureEvent["analysisFailureReason"];
    attemptedAt?: number;
  }): Promise<{ updated: boolean; event: ClawSenseCaptureEvent | null }> {
    return await this.mutate((state) => {
      const attemptedAt = params.attemptedAt ?? Date.now();
      let updated = false;
      let nextEvent: ClawSenseCaptureEvent | null = null;

      state.events = state.events.map((event) => {
        if (event.artifactId !== params.artifactId) {
          return event;
        }
        let next = event;
        if (params.analysisProvider && params.analysisProvider !== next.analysisProvider) {
          next = { ...next, analysisProvider: params.analysisProvider };
          updated = true;
        }
        if (params.analysisFailureReason && params.analysisFailureReason !== next.analysisFailureReason) {
          next = { ...next, analysisFailureReason: params.analysisFailureReason };
          updated = true;
        }
        next = {
          ...next,
          lastAudioBackfillAttemptAt: attemptedAt,
          audioBackfillAttemptCount: (next.audioBackfillAttemptCount ?? 0) + 1,
        };
        updated = true;
        nextEvent = next;
        return next;
      });

      state.journal = state.journal.map((entry) => {
        if (entry.artifactId !== params.artifactId) {
          return entry;
        }
        let next = entry;
        if (params.analysisProvider && params.analysisProvider !== next.analysisProvider) {
          next = { ...next, analysisProvider: params.analysisProvider };
        }
        if (params.analysisFailureReason && params.analysisFailureReason !== next.analysisFailureReason) {
          next = { ...next, analysisFailureReason: params.analysisFailureReason };
        }
        return {
          ...next,
          lastAudioBackfillAttemptAt: attemptedAt,
          audioBackfillAttemptCount: (next.audioBackfillAttemptCount ?? 0) + 1,
        };
      });

      return { updated, event: nextEvent };
    });
  }

  async listPeople(): Promise<ClawSensePersonAnnotation[]> {
    return (await this.readState()).people;
  }

  async listSpeakers(): Promise<ClawSenseSpeakerAnnotation[]> {
    return (await this.readState()).speakers;
  }

  async upsertPersonAnnotation(params: {
    personRef: string;
    displayName: string;
    notes?: string;
    relationship?: string;
    nextWatchFor?: string;
    eventIds?: string[];
  }): Promise<ClawSensePersonAnnotation> {
    return await this.mutate((state) => {
      const now = Date.now();
      const existing = state.people.find((item) => item.personRef === params.personRef);
      if (existing) {
        existing.displayName = params.displayName;
        existing.notes = params.notes ?? existing.notes;
        existing.relationship = params.relationship ?? existing.relationship;
        existing.nextWatchFor = params.nextWatchFor ?? existing.nextWatchFor;
        existing.eventIds = Array.from(new Set(existing.eventIds.concat(params.eventIds ?? [])));
        existing.updatedAt = now;
        return existing;
      }
      const created: ClawSensePersonAnnotation = {
        annotationId: randomUUID(),
        personRef: params.personRef,
        displayName: params.displayName,
        notes: params.notes,
        relationship: params.relationship,
        nextWatchFor: params.nextWatchFor,
        eventIds: normalizeStringList(params.eventIds),
        createdAt: now,
        updatedAt: now,
      };
      state.people.push(created);
      return created;
    });
  }

  async upsertSpeakerAnnotation(params: {
    speakerRef: string;
    displayName: string;
    notes?: string;
    relationship?: string;
    windowId?: string;
    deviceId?: string;
    eventIds?: string[];
  }): Promise<ClawSenseSpeakerAnnotation> {
    return await this.mutate((state) => {
      const now = Date.now();
      const existing = state.speakers.find((item) => item.speakerRef === params.speakerRef);
      if (existing) {
        existing.displayName = params.displayName;
        existing.notes = params.notes ?? existing.notes;
        existing.relationship = params.relationship ?? existing.relationship;
        existing.windowId = params.windowId ?? existing.windowId;
        existing.deviceId = params.deviceId ?? existing.deviceId;
        existing.eventIds = Array.from(new Set(existing.eventIds.concat(params.eventIds ?? [])));
        existing.updatedAt = now;
        return existing;
      }
      const created: ClawSenseSpeakerAnnotation = {
        annotationId: randomUUID(),
        speakerRef: params.speakerRef,
        displayName: params.displayName,
        notes: params.notes,
        relationship: params.relationship,
        windowId: params.windowId,
        deviceId: params.deviceId,
        eventIds: normalizeStringList(params.eventIds),
        createdAt: now,
        updatedAt: now,
      };
      state.speakers.push(created);
      return created;
    });
  }

  async getDailyReview(date: string): Promise<ClawSenseDailyReview | null> {
    return (await this.readState()).reviews.find((item) => item.date === date) ?? null;
  }

  async listDailyReviews(): Promise<ClawSenseDailyReview[]> {
    return (await this.readState()).reviews;
  }

  async putDailyReview(review: ClawSenseDailyReview): Promise<void> {
    await this.mutate((state) => {
      state.reviews = state.reviews.filter((item) => item.date !== review.date).concat(review);
      state.reviews.sort((left, right) => left.date.localeCompare(right.date));
    });
  }

  async getDailyConsolidation(date: string): Promise<ClawSenseDailyConsolidation | null> {
    return (await this.readState()).consolidations.find((item) => item.date === date) ?? null;
  }

  async listDailyConsolidations(): Promise<ClawSenseDailyConsolidation[]> {
    return (await this.readState()).consolidations;
  }

  async putDailyConsolidation(consolidation: ClawSenseDailyConsolidation): Promise<void> {
    await this.mutate((state) => {
      state.consolidations = state.consolidations
        .filter((item) => item.date !== consolidation.date)
        .concat(consolidation);
      state.consolidations.sort((left, right) => left.date.localeCompare(right.date));
    });
  }

  async pruneExpiredArtifacts(now = Date.now()): Promise<ClawSenseArtifactRecord[]> {
    return await this.mutate((state) => {
      const removed: ClawSenseArtifactRecord[] = [];
      state.artifacts = state.artifacts.map((artifact) => {
        if (artifact.deletedAt || artifact.retentionExpiresAt > now) {
          return artifact;
        }
        const deleted = { ...artifact, deletedAt: now };
        removed.push(deleted);
        return deleted;
      });
      return removed;
    });
  }

  async markArtifactsDeleted(
    artifactIds: string[],
    now = Date.now(),
  ): Promise<ClawSenseArtifactRecord[]> {
    const ids = new Set(artifactIds.filter(Boolean));
    if (ids.size === 0) {
      return [];
    }
    return await this.mutate((state) => {
      const removed: ClawSenseArtifactRecord[] = [];
      state.artifacts = state.artifacts.map((artifact) => {
        if (artifact.deletedAt || !ids.has(artifact.artifactId)) {
          return artifact;
        }
        const deleted = { ...artifact, deletedAt: now };
        removed.push(deleted);
        return deleted;
      });
      return removed;
    });
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
      const parsed = JSON.parse(raw) as Partial<StoredState> | Partial<StoredStateV1>;
      if (parsed.version === 2) {
        const normalized: StoredState = {
          version: 2,
          setupTokens: Array.isArray(parsed.setupTokens) ? parsed.setupTokens : [],
          devices: Array.isArray(parsed.devices) ? parsed.devices : [],
          journal: Array.isArray((parsed as StoredState).journal) ? (parsed as StoredState).journal : [],
          artifacts: Array.isArray((parsed as StoredState).artifacts) ? (parsed as StoredState).artifacts : [],
          events: Array.isArray((parsed as StoredState).events) ? (parsed as StoredState).events : [],
          people: Array.isArray((parsed as StoredState).people) ? (parsed as StoredState).people : [],
          speakers: Array.isArray((parsed as StoredState).speakers) ? (parsed as StoredState).speakers : [],
          reviews: Array.isArray((parsed as StoredState).reviews) ? (parsed as StoredState).reviews : [],
          consolidations: Array.isArray((parsed as StoredState).consolidations)
            ? (parsed as StoredState).consolidations
            : [],
        };
        return await this.repairStateIfNeeded(normalized);
      }
      if (parsed.version === 1) {
        const migrated = await this.repairStateIfNeeded(migrateV1(parsed as StoredStateV1));
        await this.writeState(migrated);
        return migrated;
      }
      return structuredClone(EMPTY_STATE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`[clawsense] failed to read state: ${String(error)}`);
      }
      return structuredClone(EMPTY_STATE);
    }
  }

  private async writeState(next: StoredState): Promise<void> {
    await this.ensureStateDir();
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.statePath);
  }

  private async mutate<T>(mutator: (state: StoredState) => T): Promise<T> {
    const operation = this.mutationChain
      .catch(() => undefined)
      .then(async () => {
        const state = await this.readState();
        const result = mutator(state);
        await this.writeState(state);
        return result;
      });
    this.mutationChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async repairStateIfNeeded(state: StoredState): Promise<StoredState> {
    let changed = false;
    const now = Date.now();
    const repairedArtifacts = await Promise.all(
      state.artifacts.map(async (artifact) => {
        let next = artifact;
        let retentionExpiresAt = artifact.retentionExpiresAt;

        if (!Number.isFinite(retentionExpiresAt) || retentionExpiresAt <= artifact.createdAt) {
          retentionExpiresAt = artifact.createdAt + LEGACY_ARTIFACT_RETENTION_MS;
          next = { ...next, retentionExpiresAt };
          changed = true;
        }

        if (next.deletedAt && retentionExpiresAt > now && next.storagePath) {
          try {
            await fs.access(next.storagePath);
            next = { ...next, deletedAt: undefined };
            changed = true;
          } catch {
            // Keep deletedAt when the raw artifact is already gone.
          }
        }

        return next;
      }),
    );

    if (!changed) {
      return state;
    }

    const repairedState: StoredState = {
      ...state,
      artifacts: repairedArtifacts,
    };
    await this.writeState(repairedState);
    this.logger.info("[clawsense] repaired legacy artifact retention metadata in state store");
    return repairedState;
  }
}

function migrateV1(previous: StoredStateV1): StoredState {
  const next: StoredState = {
    version: 2,
    setupTokens: Array.isArray(previous.setupTokens) ? previous.setupTokens : [],
    devices: Array.isArray(previous.devices) ? previous.devices : [],
    journal: [],
    artifacts: [],
    events: [],
    people: [],
    speakers: [],
    reviews: [],
    consolidations: [],
  };

  for (const item of Array.isArray(previous.journal) ? previous.journal : []) {
    const artifactId = randomUUID();
    const windowId = randomUUID();
    const sourcePath = item.sourcePath ?? "";
    const fileName = sourcePath ? path.basename(sourcePath) : `${item.modality}-${item.memoryId}`;
    const artifact: ClawSenseArtifactRecord = {
      artifactId,
      deviceId: item.deviceId,
      modality: item.modality,
      fileName,
      capturedAt: item.createdAt,
      createdAt: item.createdAt,
      sizeBytes: 0,
      storagePath: sourcePath,
      storageRelPath: fileName,
      retentionExpiresAt: item.createdAt + LEGACY_ARTIFACT_RETENTION_MS,
      deletedAt: sourcePath ? undefined : item.createdAt,
    };
    const event: ClawSenseCaptureEvent = {
      eventId: item.memoryId,
      windowId,
      artifactId,
      deviceId: item.deviceId,
      modality: item.modality,
      summary: item.summary,
      transcript: item.transcript,
      note: item.note,
      createdAt: item.createdAt,
      capturedAt: item.createdAt,
      sourcePath,
      embeddingModel: item.embeddingModel,
      analysisMode: item.transcript?.trim() ? "runtime-stt" : "metadata-only",
      analysisProvider: item.transcript?.trim() ? "runtime" : "metadata-only",
      analysisStatus: item.transcript?.trim() ? "succeeded" : "degraded",
      analysisFailureReason: item.transcript?.trim() ? undefined : "legacy_transcript_unavailable",
      sttProvider: item.transcript?.trim() ? "runtime" : undefined,
      lastAudioBackfillAttemptAt: undefined,
      audioBackfillAttemptCount: 0,
      captureContext: defaultCaptureContextForModality(item.modality),
      peopleRefs: [],
      projectRefs: [],
      tags: [defaultCaptureContextForModality(item.modality)],
    };
    next.artifacts.push(artifact);
    next.events.push(event);
    next.journal.push({
      memoryId: item.memoryId,
      eventId: item.memoryId,
      artifactId,
      windowId,
      namespace: item.namespace,
      deviceId: item.deviceId,
      modality: item.modality,
      summary: item.summary,
      transcript: item.transcript,
      note: item.note,
      createdAt: item.createdAt,
      embeddingModel: item.embeddingModel,
      sourcePath: item.sourcePath,
      analysisMode: event.analysisMode,
      analysisProvider: event.analysisProvider,
      analysisStatus: event.analysisStatus,
      analysisFailureReason: event.analysisFailureReason,
      sttProvider: event.sttProvider,
      lastAudioBackfillAttemptAt: event.lastAudioBackfillAttemptAt,
      audioBackfillAttemptCount: event.audioBackfillAttemptCount,
      captureContext: event.captureContext,
    });
  }

  return next;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

type DerivedEventSemanticSignals = {
  projectRefs: string[];
  tags: string[];
};

const EVENT_SIGNAL_RULES: Array<{
  projectRef: string;
  tags: string[];
  patterns: RegExp[];
}> = [
  {
    projectRef: "demo_prep",
    tags: ["demo"],
    patterns: [/演示/u, /\bdemo\b/i, /presentation/i, /截图顺序/u, /开场顺序/u],
  },
  {
    projectRef: "quote_followup",
    tags: ["quote"],
    patterns: [/报价/u, /\bquote\b/i, /pricing/i, /price/i, /价格区间/u],
  },
  {
    projectRef: "meeting_notes",
    tags: ["meeting", "meeting-notes"],
    patterns: [/会议纪要/u, /会议记录/u, /\bminutes\b/i],
  },
  {
    projectRef: "report_followup",
    tags: ["report"],
    patterns: [/汇报/u, /报告/u, /\breport\b/i],
  },
  {
    projectRef: "course_notes",
    tags: ["classroom"],
    patterns: [/课堂/u, /课程/u, /老师讲/u, /\blecture\b/i, /\bclass\b/i],
  },
  {
    projectRef: "homework_followup",
    tags: ["homework"],
    patterns: [/作业/u, /\bhomework\b/i, /课后/u],
  },
  {
    projectRef: "exam_prep",
    tags: ["exam"],
    patterns: [/考试/u, /测验/u, /复习/u, /考点/u, /\bexam\b/i],
  },
  {
    projectRef: "lab_work",
    tags: ["experiment"],
    patterns: [/实验/u, /实验报告/u, /\blab\b/i],
  },
  {
    projectRef: "launch_checklist",
    tags: ["launch"],
    patterns: [/上线/u, /发布/u, /上线清单/u, /\blaunch\b/i],
  },
];

function deriveEventSemanticSignals(params: {
  summary?: string;
  transcript?: string;
  note?: string;
  modality: "audio" | "image" | "video";
  projectRefs?: string[];
  tags?: string[];
}): DerivedEventSemanticSignals {
  const projectRefs = normalizeStringList(params.projectRefs);
  const tags = normalizeStringList(params.tags);
  const signalTexts = collectEventSignalTexts(params);
  const normalizedNote = normalizeSemanticText(params.note);
  if (params.modality === "video") {
    tags.push("video");
    if (/\bvideoRequestId=([^\s]+)/i.test(normalizedNote)) {
      tags.push("video-request");
    }
    if (/\bvideoKeyframe=1\b/i.test(normalizedNote) || /\bkeyframe=\d+\b/i.test(normalizedNote)) {
      tags.push("video-keyframe");
    }
  }
  if (signalTexts.length === 0) {
    return {
      projectRefs,
      tags,
    };
  }

  const combined = signalTexts.join("\n").toLowerCase();
  if (/(会议|开会|老板|同事|客户|汇报|演示|报价|产品|办公室|工位|\bmeeting\b|\boffice\b|\bdemo\b|\bquote\b|\bpricing\b)/i.test(combined)) {
    tags.push("office");
  }
  if (/(老师|课堂|课程|作业|复习|考试|实验|教室|\bclass\b|\blecture\b|\bstudy\b|\bhomework\b|\bexam\b|\blab\b)/i.test(combined)) {
    tags.push("study");
  }
  if (/(朋友|聚会|吃饭|派对|聊天|\bparty\b|\bsocial\b|\bdinner\b)/i.test(combined)) {
    tags.push("social");
  }

  for (const rule of EVENT_SIGNAL_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(combined))) {
      projectRefs.push(rule.projectRef);
      tags.push(...rule.tags);
    }
  }

  return {
    projectRefs: normalizeStringList(projectRefs),
    tags: normalizeStringList(tags),
  };
}

function collectEventSignalTexts(params: {
  summary?: string;
  transcript?: string;
  note?: string;
  modality: "audio" | "image" | "video";
}): string[] {
  const summary = normalizeSemanticText(params.summary);
  const transcript = normalizeSemanticText(params.transcript);
  const note = normalizeSemanticText(params.note);
  const texts = [
    transcript,
    summary && !isLowSignalSemanticText(summary) ? summary : "",
    note && !parseClawSenseAudioSessionHint(note) && !isLowSignalSemanticText(note) ? note : "",
  ].filter((value) => value.length >= 4);
  return Array.from(new Set(texts));
}

function sameStringList(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = normalizeStringList(left);
  const normalizedRight = normalizeStringList(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function shouldAdoptBackfilledSummary(
  currentSummary: string,
  candidateSummary: string,
  currentStatus?: ClawSenseCaptureEvent["analysisStatus"],
  nextTranscript?: string,
): boolean {
  const normalizedCurrent = normalizeSemanticText(currentSummary);
  const normalizedCandidate = normalizeSemanticText(candidateSummary);
  if (!normalizedCandidate) {
    return false;
  }
  if (!normalizedCurrent) {
    return true;
  }
  if (normalizedCandidate === normalizedCurrent) {
    return false;
  }
  if (normalizedTranscriptLooksUsable(nextTranscript) && isLowSignalSemanticText(normalizedCurrent)) {
    return true;
  }
  if (currentStatus === "degraded") {
    return true;
  }
  return normalizedCandidate.length > normalizedCurrent.length && isLowSignalSemanticText(normalizedCurrent);
}

function normalizedTranscriptLooksUsable(value: string | undefined): boolean {
  return Boolean(normalizeSemanticText(value));
}

function defaultCaptureContextForModality(
  modality: "audio" | "image" | "video",
): ClawSenseCaptureEvent["captureContext"] {
  if (modality === "audio") {
    return "audio-window";
  }
  if (modality === "image") {
    return "baseline-snapshot";
  }
  return "active-window";
}

function resolveWindowAssignment(params: {
  events: ClawSenseCaptureEvent[];
  deviceId: string;
  modality: "audio" | "image" | "video";
  capturedAt: number;
  note?: string;
}): Pick<ClawSenseCaptureEvent, "windowId" | "captureContext"> {
  const currentAudioSession =
    params.modality === "audio" ? parseClawSenseAudioSessionHint(params.note) : null;
  const sameSessionAudio =
    params.modality === "audio" && currentAudioSession?.session
      ? findMostRecentEventBefore(
          params.events,
          params.deviceId,
          params.capturedAt,
          (event) =>
            event.modality === "audio" &&
            parseClawSenseAudioSessionHint(event.note)?.session === currentAudioSession.session,
        )
      : undefined;
  const recentAudio = findMostRecentEventBefore(
    params.events,
    params.deviceId,
    params.capturedAt,
    (event) => event.modality === "audio",
  );
  const recentAudioSession = recentAudio ? parseClawSenseAudioSessionHint(recentAudio.note) : null;
  const recentActiveEvent = findMostRecentEventBefore(
    params.events,
    params.deviceId,
    params.capturedAt,
    (event) => event.captureContext !== "baseline-snapshot",
  );
  const recentBaselineImage = findMostRecentEventBefore(
    params.events,
    params.deviceId,
    params.capturedAt,
    (event) => event.modality === "image" && event.captureContext === "baseline-snapshot",
  );

  if (params.modality === "audio") {
    if (currentAudioSession?.session) {
      if (sameSessionAudio) {
        return {
          windowId: sameSessionAudio.windowId,
          captureContext: "audio-window",
        };
      }
      if (recentAudioSession?.session && recentAudioSession.session !== currentAudioSession.session) {
        return {
          windowId: randomUUID(),
          captureContext: "audio-window",
        };
      }
      return {
        windowId: randomUUID(),
        captureContext: "audio-window",
      };
    }
    if (
      recentAudio &&
      params.capturedAt - recentAudio.capturedAt <= AUDIO_WINDOW_GAP_MS &&
      windowAgeWithinLimit(params.events, recentAudio.windowId, params.capturedAt)
    ) {
      return {
        windowId: recentAudio.windowId,
        captureContext: "audio-window",
      };
    }
    if (
      recentActiveEvent &&
      params.capturedAt - recentActiveEvent.capturedAt <= ACTIVE_WINDOW_GAP_MS &&
      windowHasModality(params.events, recentActiveEvent.windowId, "audio", params.capturedAt) &&
      windowAgeWithinLimit(params.events, recentActiveEvent.windowId, params.capturedAt)
    ) {
      return {
        windowId: recentActiveEvent.windowId,
        captureContext: "audio-window",
      };
    }
    return {
      windowId: randomUUID(),
      captureContext: "audio-window",
    };
  }

  if (params.modality === "image") {
    if (
      recentActiveEvent &&
      params.capturedAt - recentActiveEvent.capturedAt <= ACTIVE_WINDOW_GAP_MS &&
      windowHasModality(params.events, recentActiveEvent.windowId, "audio", params.capturedAt) &&
      windowAgeWithinLimit(params.events, recentActiveEvent.windowId, params.capturedAt)
    ) {
      return {
        windowId: recentActiveEvent.windowId,
        captureContext: "active-window",
      };
    }
    if (recentBaselineImage && params.capturedAt - recentBaselineImage.capturedAt <= BASELINE_IMAGE_WINDOW_GAP_MS) {
      return {
        windowId: recentBaselineImage.windowId,
        captureContext: "baseline-snapshot",
      };
    }
    return {
      windowId: randomUUID(),
      captureContext: "baseline-snapshot",
    };
  }

  if (
    recentActiveEvent &&
    params.capturedAt - recentActiveEvent.capturedAt <= ACTIVE_WINDOW_GAP_MS &&
    windowAgeWithinLimit(params.events, recentActiveEvent.windowId, params.capturedAt)
  ) {
    return {
      windowId: recentActiveEvent.windowId,
      captureContext: "active-window",
    };
  }

  return {
    windowId: randomUUID(),
    captureContext: "active-window",
  };
}

function findMostRecentEventBefore(
  events: ClawSenseCaptureEvent[],
  deviceId: string,
  capturedAt: number,
  predicate: (event: ClawSenseCaptureEvent) => boolean,
): ClawSenseCaptureEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.deviceId === deviceId && event.capturedAt <= capturedAt && predicate(event)) {
      return event;
    }
  }
  return undefined;
}

function windowHasModality(
  events: ClawSenseCaptureEvent[],
  windowId: string,
  modality: "audio" | "image" | "video",
  capturedAt: number,
): boolean {
  return events.some(
    (event) => event.windowId === windowId && event.modality === modality && event.capturedAt <= capturedAt,
  );
}

function windowAgeWithinLimit(
  events: ClawSenseCaptureEvent[],
  windowId: string,
  capturedAt: number,
): boolean {
  let startedAt = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.windowId !== windowId || event.capturedAt > capturedAt) {
      continue;
    }
    startedAt = Math.min(startedAt, event.capturedAt);
  }
  if (!Number.isFinite(startedAt)) {
    return true;
  }
  return capturedAt - startedAt <= MAX_CONVERSATION_WINDOW_SPAN_MS;
}

export function toLocalDateKey(timestamp: number): string {
  const value = new Date(timestamp);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
