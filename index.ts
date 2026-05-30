import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type ClawSenseContextToolParams,
  createClawSenseAnnotatePersonTool,
  createClawSenseAnnotateSpeakerTool,
  createClawSenseContextTool,
  resolveClawSenseContext,
} from "./src/assistant-tool.js";
import qrcode from "qrcode-terminal";
import { ClawSenseMemoryStore } from "./src/memory-store.js";
import type { OpenClawPluginApi } from "./src/openclaw-types.js";
import { DEFAULT_PAIRING_TTL_SECONDS, clawsenseConfigSchema, resolveClawSenseConfig } from "./src/config.js";
import { createJsonRoute, json, methodNotAllowed, parseBearerToken, readJson, unauthorized } from "./src/http.js";
import {
  type ClawSenseDeviceRecord,
  type ClawSenseIngestReceipt,
  type ClawSenseSetupToken,
  ClawSenseStateStore,
} from "./src/state-store.js";
import { ClawSenseReviewEngine } from "./src/review-engine.js";
import {
  analyzeImageWithPrimaryModel,
  analyzeVideoWithPrimaryModel,
  extractChatCompletionText,
  resolveOpenAiClientForProvider,
  resolveReviewGenerationModel,
  transcribeAudioWithFallbackModel,
  understandAudioWithPrimaryModel,
} from "./src/openai-client.js";
import { transcribeAudioWithLocalAsr } from "./src/local-asr.js";
import { enqueueIngestJob } from "./src/ingest-queue.js";
import {
  buildCliAnnotationApplyPlan,
  normalizeCliAnnotationSuggestions,
  normalizeCliSuggestionIdSelection,
  resolveMinimumConfidence,
} from "./src/annotation-suggestions.js";
import {
  createSetupCode,
  classifyRuntimeSttError,
  hashSecret,
  inferMimeFromName,
  inferPublicBaseUrl,
  normalizeSemanticText,
  issueSetupToken,
  safeJsonStringify,
  stripTrailingSlash,
  toSafeSlug,
  timingSafeMatches,
} from "./src/utils.js";
import {
  answerAssistantQuery,
  buildAssistantDraftDocument,
  buildAssistantModelPrompt,
  buildRecentContextPayload,
  mergeAssistantModelAnswer,
  resolveAssistantQueryText,
  shouldFallbackAssistantContextToAllDevices,
  shouldUseDeterministicAssistantAnswer,
  shouldUsePreviousTurnEvidenceRange,
  type AssistantConversationTurn,
  type AssistantModeHint,
  type RecentContextWindowHint,
  withAssistantDeviceFallbackHint,
} from "./src/realtime-assistant.js";

const plugin = {
  id: "clawsense",
  name: "ClawSense",
  description: "Always-on sensory companion for OpenClaw",
  configSchema: clawsenseConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = resolveClawSenseConfig(api.pluginConfig as Record<string, unknown> | undefined);
    const stateStore = new ClawSenseStateStore({
      resolveStateDir: api.runtime.state.resolveStateDir,
      logger: api.logger,
    });
    const memoryStore = new ClawSenseMemoryStore({
      cfg,
      runtimeConfig: api.config,
      logger: api.logger,
      stateStore,
      resolveStateDir: api.runtime.state.resolveStateDir,
    });
    const reviewEngine = new ClawSenseReviewEngine({
      cfg,
      runtimeConfig: api.config,
      logger: api.logger,
      stateStore,
      memorySearch: memoryStore,
    });
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const DEVICE_HEARTBEAT_STALE_FACTOR = 3;
    let maintenanceTimer: NodeJS.Timeout | null = null;
    const ingestQueue: Array<{
      requestId: string;
      device: ClawSenseDeviceRecord;
      deviceId: string;
      modality: "audio" | "image" | "video";
      body: Buffer;
      fileName: string;
      mime: string | undefined;
      capturedAt?: number;
      note?: string;
      queuedAt: number;
    }> = [];
    let ingestPumpActive = false;
    const MAX_PENDING_INGEST_JOBS = 24;
    const MAX_VIDEO_KEYFRAMES_PER_INGEST = 6;
    const MAX_VIDEO_INGEST_JSON_BYTES = 96 * 1024 * 1024;
    const assistantConversationTurns = new Map<string, AssistantConversationTurn>();

    const publicBaseUrl = (): string =>
      inferPublicBaseUrl({
        preferred: cfg.publicBaseUrl,
        config: api.config,
        gatewayPort: cfg.gatewayPort,
      });
    const artifactUrlBase = (): string => `${stripTrailingSlash(publicBaseUrl())}/api/clawsense/artifacts`;

    const printSetupQr = async (reason: "bootstrap" | "manual"): Promise<ClawSenseSetupToken> => {
      const baseUrl = publicBaseUrl();
      const token = issueSetupToken(cfg.pairingTtlSeconds);
      await stateStore.upsertSetupToken(token);
      const setupCode = createSetupCode(baseUrl, token.token);
      const expiresAtIso = new Date(token.expiresAt).toISOString();

      api.logger.info(`[clawsense] setup token ready (${reason}) expires=${expiresAtIso} baseUrl=${baseUrl}`);
      api.logger.info(`[clawsense] setup code payload: ${setupCode}`);

      qrcode.generate(setupCode, { small: false }, (qr) => {
        api.logger.info(
          `\n[clawsense] 扫码配对二维码如下。若公网地址识别不准确，可在 App 中手工修正 Host。\n${qr}`,
        );
      });

      return token;
    };

    const ensureBootstrapQr = async (): Promise<void> => {
      const devices = await stateStore.listDevices();
      const pending = await stateStore.listSetupTokens();
      const hasValidPending = pending.some((token) => !token.consumedAt && token.expiresAt > Date.now());
      if (devices.length === 0 && !hasValidPending) {
        await printSetupQr("bootstrap");
      }
    };

    const authenticateDevice = async (params: {
      authorization?: string;
      deviceIdHint?: string;
    }): Promise<
      | { ok: true; device: ClawSenseDeviceRecord }
      | { ok: false; reason: string; hint?: string; rePairRequired: boolean }
    > => {
      const secret = parseBearerToken(params.authorization);
      if (!secret) {
        return {
          ok: false,
          reason: "missing_bearer_token",
          hint: "Request must include Authorization: Bearer <deviceSecret>.",
          rePairRequired: false,
        };
      }
      const hashed = hashSecret(secret);
      const devices = await stateStore.listDevices();
      const matchedDevice = devices.find((device) => timingSafeMatches(device.secretHash, hashed));
      if (matchedDevice) {
        return { ok: true, device: matchedDevice };
      }

      const hintedDeviceId = params.deviceIdHint?.trim();
      if (hintedDeviceId) {
        const hintedDevice = devices.find((device) => device.deviceId === hintedDeviceId);
        if (hintedDevice) {
          return {
            ok: false,
            reason: "device_secret_mismatch",
            hint: "Known deviceId but deviceSecret mismatch. Re-pair this device to refresh credentials.",
            rePairRequired: true,
          };
        }
        return {
          ok: false,
          reason: "device_not_registered",
          hint: "Device id is unknown on server. Re-pair this device.",
          rePairRequired: true,
        };
      }

      return {
        ok: false,
        reason: "invalid_device_secret",
        hint: "Device secret is invalid or rotated. Re-pair this device.",
        rePairRequired: true,
      };
    };

    const transcribeAssistantQuery = async (params: {
      body: Buffer;
      fileName: string;
      mime?: string;
    }): Promise<{ queryText: string; provider?: string; failureReason?: string }> => {
      const providers: string[] = [];
      const failureReasons: string[] = [];
      const tempDir = path.join(api.runtime.state.resolveStateDir(), "plugins", "clawsense", "assistant-queries");
      const tempFilePath = path.join(tempDir, `${randomUUID()}-${params.fileName}`);
      try {
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(tempFilePath, params.body);
        try {
          const runtimeResponse = await api.runtime.stt.transcribeAudioFile({
            filePath: tempFilePath,
            mime: params.mime,
            cfg: api.config,
            agentDir: api.runtime.state.resolveStateDir(),
          });
          const runtimeText = (
            typeof runtimeResponse === "string"
              ? runtimeResponse
              : runtimeResponse?.text ?? runtimeResponse?.transcript ?? ""
          ).trim();
          if (runtimeText) {
            return {
              queryText: runtimeText,
              provider: "runtime-stt",
            };
          }
          providers.push("runtime-stt");
          failureReasons.push("runtime_stt_empty");
        } catch (error) {
          const reason = classifyRuntimeSttError(error);
          providers.push("runtime-stt");
          failureReasons.push(reason);
          api.logger.warn(`[clawsense] runtime assistant query stt failed: ${reason}: ${String(error)}`);
        }

        const localAsr = await transcribeAudioWithLocalAsr({
          cfg,
          filePath: tempFilePath,
          resolveStateDir: api.runtime.state.resolveStateDir,
          logger: api.logger,
        });
        providers.push(localAsr.analysisProvider);
        if (localAsr.transcript?.trim()) {
          return {
            queryText: localAsr.transcript.trim(),
            provider: combineAssistantDiagnostics(providers),
            failureReason: combineAssistantDiagnostics(failureReasons),
          };
        }
        if (localAsr.analysisFailureReason !== "query_time_local_asr_disabled") {
          failureReasons.push(localAsr.analysisFailureReason ?? "query_time_local_asr_empty");
        }
      } finally {
        await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
      }

      const fallback = await transcribeAudioWithFallbackModel({
        cfg,
        runtimeConfig: api.config,
        body: params.body,
        fileName: params.fileName,
        mime: params.mime,
      });
      providers.push(fallback.analysisProvider);
      if (fallback.transcript?.trim()) {
        return {
          queryText: fallback.transcript.trim(),
          provider: combineAssistantDiagnostics(providers),
          failureReason: combineAssistantDiagnostics(failureReasons),
        };
      }
      failureReasons.push(fallback.analysisFailureReason ?? "query_time_asr_empty");

      const multimodal = await understandAudioWithPrimaryModel({
        cfg,
        runtimeConfig: api.config,
        body: params.body,
        fileName: params.fileName,
        mime: params.mime,
      });
      providers.push(multimodal.analysisProvider);
      const multimodalText = normalizeSemanticText(multimodal.transcript ?? "");
      if (multimodalText) {
        return {
          queryText: multimodalText,
          provider: combineAssistantDiagnostics(providers),
          failureReason: combineAssistantDiagnostics(failureReasons),
        };
      }
      failureReasons.push(
        multimodal.summary?.trim()
          ? "primary_multimodal_summary_not_query"
          : multimodal.analysisFailureReason ?? "primary_multimodal_empty",
      );

      return {
        queryText: "",
        provider: combineAssistantDiagnostics(providers),
        failureReason: combineAssistantDiagnostics(failureReasons),
      };
    };

    const buildOperationalStatus = async () => {
      const now = Date.now();
      const devices = await stateStore.listDevices();
      const events = await stateStore.listEvents();
      const queueDepth = ingestQueue.length;
      const queueOldest = ingestQueue[0];
      const queueOldestWaitMs = queueOldest ? Math.max(0, now - queueOldest.queuedAt) : 0;
      const heartbeatFreshMs = Math.max(
        90_000,
        cfg.heartbeatIntervalSeconds * 1000 * DEVICE_HEARTBEAT_STALE_FACTOR,
      );
      const activeDevices = devices.filter((device) => {
        const latestAt = device.lastHeartbeatAt ?? device.lastSeenAt ?? 0;
        return latestAt > 0 && now - latestAt <= heartbeatFreshMs;
      });
      const staleDevices = devices.filter((device) => !activeDevices.some((item) => item.deviceId === device.deviceId));

      const recentEvents = events.filter((event) => event.capturedAt >= now - ONE_DAY_MS);
      const recentAudioEvents = recentEvents.filter((event) => event.modality === "audio");
      const recentImageEvents = recentEvents.filter((event) => event.modality === "image");
      const recentVideoEvents = recentEvents.filter((event) => event.modality === "video");
      const degradedRecentEvents = recentEvents.filter((event) => event.analysisStatus === "degraded");
      const pendingTranscriptEvents = recentAudioEvents.filter(
        (event) => !event.transcript?.trim() && event.analysisStatus !== "succeeded",
      );
      const publicUrl = publicBaseUrl();
      const publicHostLooksAlias = /^https?:\/\/(?:lan|0\.0\.0\.0|\*|::)(?::|\/|$)/i.test(publicUrl);
      const effectiveRetrievalEmbeddingBackend = cfg.retrievalEmbeddingBackend === "none" ? "none" : "text";

      return {
        generatedAt: now,
        publicBaseUrl: publicUrl,
        publicHostLooksAlias,
        capabilities: {
          hostModelAudioMode: cfg.hostModelAudioMode,
          hostModelImageMode: cfg.hostModelImageMode,
          hostModelVideoMode: cfg.hostModelVideoMode,
          retrievalEmbeddingBackend: cfg.retrievalEmbeddingBackend,
          effectiveRetrievalEmbeddingBackend,
        },
        queue: {
          depth: queueDepth,
          maxPending: MAX_PENDING_INGEST_JOBS,
          pumpActive: ingestPumpActive,
          oldestQueuedAt: queueOldest?.queuedAt ?? null,
          oldestWaitMs: queueOldest ? queueOldestWaitMs : null,
        },
        devices: {
          total: devices.length,
          active: activeDevices.length,
          stale: staleDevices.length,
          heartbeatFreshMs,
          activeDeviceIds: activeDevices.map((device) => device.deviceId),
        },
        ingest24h: {
          totalEvents: recentEvents.length,
          audioEvents: recentAudioEvents.length,
          imageEvents: recentImageEvents.length,
          videoEvents: recentVideoEvents.length,
          degradedEvents: degradedRecentEvents.length,
          pendingTranscriptEvents: pendingTranscriptEvents.length,
        },
      };
    };

    const buildOperationalDoctor = async () => {
      const status = await buildOperationalStatus();
      const acceptance = await reviewEngine.buildPhaseAcceptance({ lookbackDays: 7 });
      const warnings: string[] = [];
      const nextActions: string[] = [];

      if (status.publicHostLooksAlias) {
        warnings.push(`publicBaseUrl 仍是内网别名：${status.publicBaseUrl}`);
        nextActions.push(
          "配置可访问公网地址：openclaw config set plugins.entries.clawsense.config.publicBaseUrl '\"http://<公网IP>:<port>\"' --strict-json",
        );
      }
      if (status.devices.total > 0 && status.devices.active === 0) {
        warnings.push("当前没有活跃设备心跳。");
        nextActions.push("检查手机端是否仍在前台运行感知服务，并重新配对后再观察 1-2 分钟。");
      }
      if (status.queue.depth >= Math.max(3, Math.floor(status.queue.maxPending * 0.5))) {
        warnings.push(`上传队列积压较高：${status.queue.depth}/${status.queue.maxPending}`);
        nextActions.push("先保持客户端在线并等待队列回落，再做高频录音压测。");
      }
      if (status.ingest24h.totalEvents === 0) {
        warnings.push("最近 24 小时没有任何采集事件。");
        nextActions.push("先确认配对成功，再验证一次音频上传 + 图片上传闭环。");
      }
      if (status.ingest24h.pendingTranscriptEvents >= 10) {
        warnings.push(`待补 transcript 的音频事件较多：${status.ingest24h.pendingTranscriptEvents}`);
        nextActions.push("可手动触发补强：openclaw clawsense backfill-audio today --max 6");
      }
      if (status.capabilities.hostModelImageMode === "metadata-only") {
        warnings.push("hostModelImageMode=metadata-only：图像语义分析已关闭，回答会更依赖音频和人工标注。");
        nextActions.push(
          "若需要恢复图像理解：openclaw config set plugins.entries.clawsense.config.hostModelImageMode '\"multimodal\"' --strict-json",
        );
      }
      if (status.capabilities.retrievalEmbeddingBackend === "none") {
        warnings.push("retrievalEmbeddingBackend=none：语义召回关闭，跨窗口检索能力受限。");
        nextActions.push(
          "若需要恢复语义召回：openclaw config set plugins.entries.clawsense.config.retrievalEmbeddingBackend '\"text\"' --strict-json",
        );
      } else if (status.capabilities.retrievalEmbeddingBackend === "multimodal") {
        warnings.push(
          "retrievalEmbeddingBackend=multimodal：当前版本会回退到 text embedding，原生多模态向量化将在后续版本上线。",
        );
        nextActions.push(
          "若你希望先稳定使用当前能力，建议保持 text：openclaw config set plugins.entries.clawsense.config.retrievalEmbeddingBackend '\"text\"' --strict-json",
        );
      }
      if (status.capabilities.hostModelVideoMode === "none") {
        nextActions.push(
          "如需开启视频输入：openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '\"keyframes\"' --strict-json（或 direct）",
        );
      }
      if (!acceptance.completion.isPhaseReady) {
        warnings.push(
          `阶段验收未完成：${acceptance.completion.passedCriteria}/${acceptance.completion.totalCriteria}（${acceptance.completion.phaseState}）`,
        );
        for (const blocker of acceptance.blockers.slice(0, 2)) {
          if (blocker.topNextAction) {
            nextActions.push(`[${blocker.id}] ${blocker.topNextAction}`);
          }
        }
      }

      return {
        ok: warnings.length === 0,
        warnings,
        nextActions,
        acceptance: {
          lookbackDays: acceptance.lookbackDays,
          phaseState: acceptance.completion.phaseState,
          progressPct: acceptance.completion.progressPct,
          passedCriteria: acceptance.completion.passedCriteria,
          totalCriteria: acceptance.completion.totalCriteria,
          blockers: acceptance.blockers,
        },
        status,
      };
    };

    const recordIngest = async (params: {
      device: ClawSenseDeviceRecord;
      modality: "audio" | "image" | "video";
      body: Buffer;
      fileName: string;
      mime: string | undefined;
      capturedAt?: number;
      note?: string;
    }): Promise<ClawSenseIngestReceipt> => {
      const receipt = await memoryStore.ingest({
        ...params,
        describeImage: async ({ buffer, fileName, mime }) => {
          return await analyzeImageWithPrimaryModel({
            cfg,
            runtimeConfig: api.config,
            buffer,
            fileName,
            mime,
          });
        },
        describeVideo: async ({ buffer, fileName, mime }) => {
          return await analyzeVideoWithPrimaryModel({
            cfg,
            runtimeConfig: api.config,
            buffer,
            fileName,
            mime,
          });
        },
        transcribeAudio: async ({ filePath, mime }) => {
          const response = await api.runtime.stt.transcribeAudioFile({
            filePath,
            mime,
            cfg: api.config,
            agentDir: api.runtime.state.resolveStateDir(),
          });
          return typeof response === "string" ? { text: response } : { text: response.text ?? response.transcript };
        },
      });

      try {
        await api.runtime.system.requestHeartbeatNow();
      } catch (error) {
        api.logger.warn(`[clawsense] requestHeartbeatNow failed: ${String(error)}`);
      }
      return receipt;
    };

    const pumpIngestQueue = (): void => {
      if (ingestPumpActive) {
        return;
      }
      ingestPumpActive = true;
      void (async () => {
        try {
          while (ingestQueue.length > 0) {
            const job = ingestQueue.shift();
            if (!job) {
              continue;
            }
            const startedAt = Date.now();
            api.logger.info(
              `[clawsense] processing queued ${job.modality} ingest requestId=${job.requestId} queueWaitMs=${startedAt - job.queuedAt} queueDepth=${ingestQueue.length}`,
            );
            try {
              await recordIngest(job);
              await stateStore.touchDevice(job.device.deviceId);
              api.logger.info(
                `[clawsense] completed queued ${job.modality} ingest requestId=${job.requestId} durationMs=${Date.now() - startedAt}`,
              );
            } catch (error) {
              api.logger.error(
                `[clawsense] queued ${job.modality} ingest failed requestId=${job.requestId}: ${String(error)}`,
              );
            }
          }
        } finally {
          ingestPumpActive = false;
          if (ingestQueue.length > 0) {
            pumpIngestQueue();
          }
        }
      })();
    };

    const enqueueIngest = (params: {
      device: ClawSenseDeviceRecord;
      modality: "audio" | "image" | "video";
      body: Buffer;
      fileName: string;
      mime: string | undefined;
      capturedAt?: number;
      note?: string;
      requestId?: string;
    }): { accepted: true; requestId: string; queueDepth: number } | { accepted: false; queueDepth: number } => {
      const requestId = params.requestId?.trim() || randomUUID();
      const { requestId: _ignoredRequestId, ...jobParams } = params;
      const result = enqueueIngestJob(ingestQueue, {
        requestId,
        queuedAt: Date.now(),
        deviceId: params.device.deviceId,
        ...jobParams,
      }, {
        maxPendingJobs: MAX_PENDING_INGEST_JOBS,
      });
      if (!result.accepted) {
        return result;
      }
      if (result.action === "replaced") {
        api.logger.info(
          `[clawsense] coalesced queued ${params.modality} ingest requestId=${result.requestId} replaced=${result.affectedRequestId ?? "unknown"} queueDepth=${result.queueDepth}`,
        );
      } else if (result.action === "evicted-visual") {
        api.logger.warn(
          `[clawsense] evicted older queued visual ingest to admit ${params.modality} requestId=${result.requestId} evicted=${result.affectedRequestId ?? "unknown"} queueDepth=${result.queueDepth}`,
        );
      }
      pumpIngestQueue();
      return result;
    };

    api.registerTool(
      createClawSenseContextTool({
        reviewEngine,
        artifactUrlBase,
      }),
    );
    api.registerTool(
      createClawSenseAnnotatePersonTool({
        reviewEngine,
      }),
    );
    api.registerTool(
      createClawSenseAnnotateSpeakerTool({
        reviewEngine,
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/pair", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }

        const payload = await readJson(req, res);
        if (!payload) {
          return true;
        }

        const token =
          typeof payload.setupToken === "string"
            ? payload.setupToken.trim()
            : typeof payload.token === "string"
              ? payload.token.trim()
              : "";

        if (!token) {
          json(res, 400, { ok: false, error: "setupToken required" });
          return true;
        }

        const pending = await stateStore.consumeSetupToken(token);
        if (!pending) {
          json(res, 403, { ok: false, error: "invalid_setup_token" });
          return true;
        }
        if (pending.expiresAt <= Date.now()) {
          json(res, 410, { ok: false, error: "setup_token_expired" });
          return true;
        }

        const device = await stateStore.registerDevice({
          name:
            typeof payload.deviceName === "string" && payload.deviceName.trim()
              ? payload.deviceName.trim()
              : "ClawSense Android",
          platform:
            typeof payload.platform === "string" && payload.platform.trim()
              ? payload.platform.trim()
              : "android",
          appVersion:
            typeof payload.appVersion === "string" && payload.appVersion.trim()
              ? payload.appVersion.trim()
              : undefined,
          fingerprint:
            typeof payload.fingerprint === "string" && payload.fingerprint.trim()
              ? payload.fingerprint.trim()
              : undefined,
        });

        json(res, 200, {
          ok: true,
          deviceId: device.deviceId,
          deviceSecret: device.plainSecret,
          uploadBaseUrl: `${stripTrailingSlash(publicBaseUrl())}/api/clawsense`,
          heartbeatIntervalSec: cfg.heartbeatIntervalSeconds,
          memoryNamespace: cfg.memoryNamespace,
          pairedAt: device.createdAt,
        });
        return true;
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/ingest/audio", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const auth = await authenticateDevice({
          authorization: req.headers.authorization,
          deviceIdHint: readHeaderValue(req.headers["x-clawsense-device-id"]),
        });
        if (!auth.ok) {
          unauthorized(res, {
            reason: auth.reason,
            hint: auth.hint,
            rePairRequired: auth.rePairRequired,
          });
          return true;
        }
        const device = auth.device;
        const payload = await readJson(req, res);
        if (!payload) {
          return true;
        }
        if (typeof payload.audioBase64 !== "string" || !payload.audioBase64.trim()) {
          json(res, 400, { ok: false, error: "audioBase64 required" });
          return true;
        }
        const body = Buffer.from(payload.audioBase64, "base64");
        if (body.length === 0) {
          json(res, 400, { ok: false, error: "invalid_audio_base64" });
          return true;
        }

        const accepted = enqueueIngest({
          device,
          modality: "audio",
          body,
          fileName:
            typeof payload.fileName === "string" && payload.fileName.trim()
              ? payload.fileName.trim()
              : "capture.wav",
          mime: typeof payload.mime === "string" && payload.mime.trim() ? payload.mime.trim() : undefined,
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: typeof payload.note === "string" ? payload.note : undefined,
        });
        if (!accepted.accepted) {
          const retryAfterSec = Math.max(2, Math.min(8, Math.ceil(accepted.queueDepth / 2)));
          res.setHeader("retry-after", String(retryAfterSec));
          json(res, 503, {
            ok: false,
            error: "ingest_queue_full",
            queueDepth: accepted.queueDepth,
            retryAfterSec,
          });
          return true;
        }
        await stateStore.touchDevice(device.deviceId);
        json(res, 202, {
          ok: true,
          queued: true,
          requestId: accepted.requestId,
          queueDepth: accepted.queueDepth,
        });
        return true;
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/ingest/image", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const auth = await authenticateDevice({
          authorization: req.headers.authorization,
          deviceIdHint: readHeaderValue(req.headers["x-clawsense-device-id"]),
        });
        if (!auth.ok) {
          unauthorized(res, {
            reason: auth.reason,
            hint: auth.hint,
            rePairRequired: auth.rePairRequired,
          });
          return true;
        }
        const device = auth.device;
        const payload = await readJson(req, res);
        if (!payload) {
          return true;
        }
        if (typeof payload.imageBase64 !== "string" || !payload.imageBase64.trim()) {
          json(res, 400, { ok: false, error: "imageBase64 required" });
          return true;
        }
        const body = Buffer.from(payload.imageBase64, "base64");
        if (body.length === 0) {
          json(res, 400, { ok: false, error: "invalid_image_base64" });
          return true;
        }

        const accepted = enqueueIngest({
          device,
          modality: "image",
          body,
          fileName:
            typeof payload.fileName === "string" && payload.fileName.trim()
              ? payload.fileName.trim()
              : "snapshot.jpg",
          mime: typeof payload.mime === "string" && payload.mime.trim() ? payload.mime.trim() : undefined,
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: typeof payload.note === "string" ? payload.note : undefined,
        });
        if (!accepted.accepted) {
          const retryAfterSec = Math.max(2, Math.min(8, Math.ceil(accepted.queueDepth / 2)));
          res.setHeader("retry-after", String(retryAfterSec));
          json(res, 503, {
            ok: false,
            error: "ingest_queue_full",
            queueDepth: accepted.queueDepth,
            retryAfterSec,
          });
          return true;
        }
        await stateStore.touchDevice(device.deviceId);
        json(res, 202, {
          ok: true,
          queued: true,
          requestId: accepted.requestId,
          queueDepth: accepted.queueDepth,
        });
        return true;
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/ingest/video", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const auth = await authenticateDevice({
          authorization: req.headers.authorization,
          deviceIdHint: readHeaderValue(req.headers["x-clawsense-device-id"]),
        });
        if (!auth.ok) {
          unauthorized(res, {
            reason: auth.reason,
            hint: auth.hint,
            rePairRequired: auth.rePairRequired,
          });
          return true;
        }
        if (cfg.hostModelVideoMode === "none") {
          json(res, 409, {
            ok: false,
            error: "video_ingest_disabled",
            hostModelVideoMode: cfg.hostModelVideoMode,
            hint:
              "Video ingest is currently disabled. Set plugins.entries.clawsense.config.hostModelVideoMode to keyframes/direct when video mode is available in your deployment.",
          });
          return true;
        }
        const device = auth.device;
        const payload = await readJson(req, res, MAX_VIDEO_INGEST_JSON_BYTES);
        if (!payload) {
          return true;
        }
        if (typeof payload.videoBase64 !== "string" || !payload.videoBase64.trim()) {
          json(res, 400, { ok: false, error: "videoBase64 required" });
          return true;
        }
        const body = Buffer.from(payload.videoBase64, "base64");
        if (body.length === 0) {
          json(res, 400, { ok: false, error: "invalid_video_base64" });
          return true;
        }
        const videoRequestId = randomUUID();
        const videoNoteParts = [
          `videoRequestId=${videoRequestId}`,
          typeof payload.note === "string" ? payload.note.trim() : "",
        ].filter(Boolean);
        const accepted = enqueueIngest({
          device,
          modality: "video",
          body,
          requestId: videoRequestId,
          fileName:
            typeof payload.fileName === "string" && payload.fileName.trim()
              ? payload.fileName.trim()
              : "capture.mp4",
          mime: typeof payload.mime === "string" && payload.mime.trim() ? payload.mime.trim() : undefined,
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: videoNoteParts.join(" "),
        });
        if (!accepted.accepted) {
          const retryAfterSec = Math.max(2, Math.min(8, Math.ceil(accepted.queueDepth / 2)));
          res.setHeader("retry-after", String(retryAfterSec));
          json(res, 503, {
            ok: false,
            error: "ingest_queue_full",
            queueDepth: accepted.queueDepth,
            retryAfterSec,
          });
          return true;
        }
        const keyframes = Array.isArray(payload.keyframes) ? payload.keyframes.slice(0, MAX_VIDEO_KEYFRAMES_PER_INGEST) : [];
        let keyframesAccepted = 0;
        let keyframesDropped = 0;
        for (let index = 0; index < keyframes.length; index += 1) {
          const keyframe = keyframes[index];
          if (!keyframe || typeof keyframe !== "object") {
            keyframesDropped += 1;
            continue;
          }
          const imageBase64 =
            typeof (keyframe as Record<string, unknown>).imageBase64 === "string"
              ? String((keyframe as Record<string, unknown>).imageBase64).trim()
              : "";
          if (!imageBase64) {
            keyframesDropped += 1;
            continue;
          }
          const keyframeBody = Buffer.from(imageBase64, "base64");
          if (keyframeBody.length === 0) {
            keyframesDropped += 1;
            continue;
          }
          const keyframeRecord = keyframe as Record<string, unknown>;
          const keyframeCapturedAt =
            typeof keyframeRecord.capturedAt === "number"
              ? Number(keyframeRecord.capturedAt)
              : typeof payload.capturedAt === "number"
                ? payload.capturedAt
                : undefined;
          const keyframeNoteParts = [
            "active-window",
            `videoKeyframe=1`,
            `keyframe=${index + 1}`,
            `videoRequestId=${videoRequestId}`,
            ...buildVideoKeyframeMarkerNoteParts(keyframeRecord),
            typeof payload.note === "string" ? payload.note.trim() : "",
            typeof keyframeRecord.note === "string"
              ? String(keyframeRecord.note).trim()
              : "",
          ].filter(Boolean);
          const keyframeAccepted = enqueueIngest({
            device,
            modality: "image",
            body: keyframeBody,
            fileName:
              typeof keyframeRecord.fileName === "string" &&
                String(keyframeRecord.fileName).trim()
                ? String(keyframeRecord.fileName).trim()
                : `video-keyframe-${index + 1}.jpg`,
            mime:
              typeof keyframeRecord.mime === "string" &&
                String(keyframeRecord.mime).trim()
                ? String(keyframeRecord.mime).trim()
                : undefined,
            capturedAt: keyframeCapturedAt,
            note: keyframeNoteParts.join(" "),
          });
          if (keyframeAccepted.accepted) {
            keyframesAccepted += 1;
          } else {
            keyframesDropped += 1;
          }
        }
        await stateStore.touchDevice(device.deviceId);
        json(res, 202, {
          ok: true,
          queued: true,
          requestId: accepted.requestId,
          videoRequestId,
          queueDepth: accepted.queueDepth,
          analysisMode: cfg.hostModelVideoMode === "direct" ? "multimodal-pending" : "metadata-only",
          keyframesAccepted,
          keyframesDropped,
        });
        return true;
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/heartbeat", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const auth = await authenticateDevice({
          authorization: req.headers.authorization,
          deviceIdHint: readHeaderValue(req.headers["x-clawsense-device-id"]),
        });
        if (!auth.ok) {
          unauthorized(res, {
            reason: auth.reason,
            hint: auth.hint,
            rePairRequired: auth.rePairRequired,
          });
          return true;
        }
        const device = auth.device;
        const payload = await readJson(req, res);
        if (!payload) {
          return true;
        }
        await stateStore.updateHeartbeat(device.deviceId, {
          batteryPct: typeof payload.batteryPct === "number" ? payload.batteryPct : undefined,
          network:
            typeof payload.network === "string" && payload.network.trim() ? payload.network.trim() : undefined,
          appState:
            typeof payload.appState === "string" && payload.appState.trim() ? payload.appState.trim() : undefined,
          raw: payload,
        });
        json(res, 200, { ok: true, heartbeatIntervalSec: cfg.heartbeatIntervalSeconds });
        return true;
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/recent-context", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const windowHint = coerceRecentContextWindowHint(url.searchParams.get("windowHint") ?? undefined);
        const modeHint = coerceAssistantModeHint(url.searchParams.get("modeHint") ?? undefined);
        const payload = await buildRecentContextPayload({
          reviewEngine,
          artifactUrlBase: "/api/clawsense/artifacts",
          windowHint,
          question: url.searchParams.get("question") ?? undefined,
          deviceId: url.searchParams.get("deviceId") ?? undefined,
          modeHint,
        });
        json(res, 200, {
          ok: true,
          ...payload.recentContext,
        });
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/assistant/query", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const auth = await authenticateDevice({
          authorization: req.headers.authorization,
          deviceIdHint: readHeaderValue(req.headers["x-clawsense-device-id"]),
        });
        if (!auth.ok) {
          unauthorized(res, {
            reason: auth.reason,
            hint: auth.hint,
            rePairRequired: auth.rePairRequired,
          });
          return true;
        }
        const payload = await readJson(req, res);
        if (!payload) {
          return true;
        }
        if (typeof payload.queryAudio !== "string" || !payload.queryAudio.trim()) {
          json(res, 400, { ok: false, error: "queryAudio required" });
          return true;
        }
        const body = Buffer.from(payload.queryAudio, "base64");
        if (body.length === 0) {
          json(res, 400, { ok: false, error: "invalid_query_audio" });
          return true;
        }
        const capturedAt = typeof payload.capturedAt === "number" ? payload.capturedAt : Date.now();
        const fileName =
          typeof payload.fileName === "string" && payload.fileName.trim()
            ? payload.fileName.trim()
            : "assistant-query.wav";
        const mime =
          typeof payload.queryMime === "string" && payload.queryMime.trim()
            ? payload.queryMime.trim()
            : undefined;
        const requestedWindowHint =
          coerceRecentContextWindowHint(
            typeof payload.recentContextWindowHint === "string" ? payload.recentContextWindowHint : undefined,
          ) ?? "last_60s";
        const modeHint = coerceAssistantModeHint(
          typeof payload.modeHint === "string" ? payload.modeHint : undefined,
        );
        const windowHint =
          (modeHint === "meeting" || modeHint === "desk") && requestedWindowHint !== "last_5m"
            ? "last_5m"
            : requestedWindowHint;
        const transcribed = await transcribeAssistantQuery({
          body,
          fileName,
          mime,
        });
        const resolvedQuery = resolveAssistantQueryText({
          queryText: transcribed.queryText,
          modeHint,
        });
        const previousTurn = assistantConversationTurns.get(auth.device.deviceId);
        const shouldUsePreviousRange = shouldUsePreviousTurnEvidenceRange({
          queryText: resolvedQuery.queryText,
          previousTurn,
        });
        const scopedContextPayload = await buildRecentContextPayload({
          reviewEngine,
          artifactUrlBase: "/api/clawsense/artifacts",
          windowHint,
          question: resolvedQuery.queryText,
          deviceId: auth.device.deviceId,
          modeHint,
          timeRangeOverride: shouldUsePreviousRange ? previousTurn?.timeRange : undefined,
          now: capturedAt,
        });
        let recentContext = scopedContextPayload.recentContext;
        if (shouldFallbackAssistantContextToAllDevices(recentContext)) {
          const fallbackContextPayload = await buildRecentContextPayload({
            reviewEngine,
            artifactUrlBase: "/api/clawsense/artifacts",
            windowHint,
            question: resolvedQuery.queryText,
            modeHint,
            timeRangeOverride: shouldUsePreviousRange ? previousTurn?.timeRange : undefined,
            now: capturedAt,
          });
          if (!shouldFallbackAssistantContextToAllDevices(fallbackContextPayload.recentContext)) {
            recentContext = withAssistantDeviceFallbackHint({
              recentContext: fallbackContextPayload.recentContext,
              deviceName: auth.device.name,
            });
          }
        }
        const answered = answerAssistantQuery({
          queryText: resolvedQuery.queryText,
          recentContext,
          previousTurn,
          queryRewriteReason: resolvedQuery.reason,
          rawQueryText: resolvedQuery.rawQueryText,
          answeredAt: Date.now(),
        });
        const modelAnswered =
          (!resolvedQuery.queryText && resolvedQuery.reason) ||
          shouldUseDeterministicAssistantAnswer(resolvedQuery.queryText)
            ? null
            : await tryAnswerAssistantQueryWithModel({
                queryText: resolvedQuery.queryText,
                recentContext,
                fallback: answered,
                previousTurn,
              });
        let finalAnswer = modelAnswered ?? answered;
        finalAnswer = await maybePersistAssistantDraft({
          deviceId: auth.device.deviceId,
          queryText: finalAnswer.queryText,
          answer: finalAnswer,
          recentContext,
        });
        assistantConversationTurns.set(auth.device.deviceId, {
          queryText: finalAnswer.queryText,
          answerText: finalAnswer.answerText,
          answerSpokenText: finalAnswer.answerSpokenText,
          answeredAt: finalAnswer.answeredAt,
          modeUsed: finalAnswer.modeUsed,
          timeRange: recentContext.timeRange,
          actionIntent: finalAnswer.actionIntent,
        });

        json(res, 200, {
          ok: true,
          queryText: finalAnswer.queryText,
          answerText: finalAnswer.answerText,
          answerSpokenText: finalAnswer.answerSpokenText,
          supportingEvidence: finalAnswer.supportingEvidence,
          modeUsed: finalAnswer.modeUsed,
          answeredAt: finalAnswer.answeredAt,
          answerSource: finalAnswer.answerSource ?? "template",
          actionIntent: finalAnswer.actionIntent ?? { type: "none" },
          recentContext: {
            windowHint: recentContext.windowHint,
            timeRange: recentContext.timeRange,
            overview: recentContext.overview,
            sceneSummary: recentContext.sceneSummary,
            attentionHints: recentContext.attentionHints,
            taskHints: recentContext.taskHints,
          },
          stt: {
            provider: transcribed.provider ?? null,
            failureReason: transcribed.failureReason ?? null,
            rawQueryText: resolvedQuery.replaced ? resolvedQuery.rawQueryText : null,
            queryRewriteReason: resolvedQuery.reason ?? null,
            queryDurationMs:
              typeof payload.queryDurationMs === "number" && Number.isFinite(payload.queryDurationMs)
                ? payload.queryDurationMs
                : null,
          },
        });
        return true;
      }),
    );

    async function tryAnswerAssistantQueryWithModel(params: {
      queryText: string;
      recentContext: Awaited<ReturnType<typeof buildRecentContextPayload>>["recentContext"];
      fallback: ReturnType<typeof answerAssistantQuery>;
      previousTurn?: AssistantConversationTurn;
    }): Promise<ReturnType<typeof answerAssistantQuery> | null> {
      const reviewModel = resolveReviewGenerationModel(cfg, api.config);
      const openai = resolveOpenAiClientForProvider(cfg, api.config, reviewModel.providerId);
      if (!openai) {
        return null;
      }
      const prompt = buildAssistantModelPrompt({
        queryText: params.queryText,
        recentContext: params.recentContext,
        templateAnswer: params.fallback,
        previousTurn: params.previousTurn,
      });
      try {
        const completion = await openai.chat.completions.create({
          model: reviewModel.model,
          stream: false,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          temperature: 0.2,
        });
        return mergeAssistantModelAnswer({
          rawText: extractChatCompletionText(completion),
          queryText: params.queryText,
          recentContext: params.recentContext,
          fallback: params.fallback,
          answeredAt: Date.now(),
        });
      } catch (error) {
        api.logger.warn(`[clawsense] assistant model answer failed: ${String(error)}`);
        return null;
      }
    }

    async function maybePersistAssistantDraft(params: {
      deviceId: string;
      queryText: string;
      answer: ReturnType<typeof answerAssistantQuery>;
      recentContext: Awaited<ReturnType<typeof buildRecentContextPayload>>["recentContext"];
    }): Promise<ReturnType<typeof answerAssistantQuery>> {
      const draft = buildAssistantDraftDocument({
        queryText: params.queryText,
        answer: params.answer,
        recentContext: params.recentContext,
      });
      if (!draft) {
        return params.answer;
      }
      try {
        const draftDir = path.join(api.runtime.state.resolveStateDir(), "plugins", "clawsense", "drafts");
        await fs.mkdir(draftDir, { recursive: true });
        const timestamp = new Date(params.answer.answeredAt)
          .toISOString()
          .replace(/[:.]/g, "-");
        const fileName = `${timestamp}-${toSafeSlug(draft.title) || "clawsense-draft"}.md`;
        const filePath = path.join(draftDir, fileName);
        await fs.writeFile(filePath, draft.markdown, "utf8");
        const actionIntent = {
          ...(params.answer.actionIntent ?? { type: "draft_document" as const }),
          type: "draft_document" as const,
          title: params.answer.actionIntent?.title ?? draft.title,
          fileName,
          filePath,
        };
        return {
          ...params.answer,
          answerText: `${params.answer.answerText}\n\n已生成草稿文件：${filePath}`,
          answerSpokenText: `${params.answer.answerSpokenText} 我也已经生成了草稿文件，路径显示在屏幕上。`,
          actionIntent,
        };
      } catch (error) {
        api.logger.warn(`[clawsense] assistant draft document write failed: ${String(error)}`);
        return {
          ...params.answer,
          answerText: `${params.answer.answerText}\n\n我尝试生成草稿文件但写入失败：${String(error)}`,
          actionIntent: {
            ...(params.answer.actionIntent ?? { type: "draft_document" as const }),
            type: "draft_document",
            reason: "draft_write_failed",
          },
        };
      }
    }

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/status", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const payload = await buildOperationalStatus();
        json(res, 200, payload);
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/library", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const payload = await reviewEngine.buildLibrary({
          date: reviewEngine.normalizeDateInput(url.searchParams.get("date") ?? undefined),
          deviceId: url.searchParams.get("deviceId") ?? undefined,
          modality: coerceLibraryModality(url.searchParams.get("modality") ?? undefined),
          artifactUrlBase: "/api/clawsense/artifacts",
        });
        json(res, 200, payload);
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/events", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const payload = await reviewEngine.buildEvents({
          date: reviewEngine.normalizeDateInput(url.searchParams.get("date") ?? undefined),
          deviceId: url.searchParams.get("deviceId") ?? undefined,
          modality: coerceModality(url.searchParams.get("modality") ?? undefined),
        });
        json(res, 200, payload);
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/reviews", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const review = await reviewEngine.getOrGenerateDailyReview(
          reviewEngine.normalizeDateInput(url.searchParams.get("date") ?? undefined),
          {
            force: url.searchParams.get("force") === "1",
          },
        );
        json(res, 200, review);
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/consolidation", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const consolidation = await reviewEngine.getOrGenerateDailyConsolidation(
          reviewEngine.normalizeDateInput(url.searchParams.get("date") ?? undefined),
          {
            force: url.searchParams.get("force") === "1",
          },
        );
        json(res, 200, consolidation);
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/context", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const range = coerceTimestampRange(
          url.searchParams.get("startAt") ?? undefined,
          url.searchParams.get("endAt") ?? undefined,
        );
        if (range === "invalid") {
          json(res, 400, {
            ok: false,
            error: "invalid_time_range",
            hint: "Use startAt/endAt as milliseconds and ensure endAt > startAt.",
          });
          return true;
        }
        const requestedScope = coerceContextScope(url.searchParams.get("scope") ?? undefined);
        if (requestedScope === "custom-range" && !range) {
          json(res, 400, {
            ok: false,
            error: "custom_range_requires_start_end",
            hint: "Provide startAt and endAt query params in milliseconds.",
          });
          return true;
        }
        const scope = range ? "custom-range" : requestedScope;
        const payload = await reviewEngine.buildAssistantContext({
          scope,
          date:
            scope === "today"
              ? reviewEngine.normalizeDateInput(url.searchParams.get("date") ?? undefined)
              : undefined,
          startAt: range?.startAt,
          endAt: range?.endAt,
          question: url.searchParams.get("question") ?? undefined,
          deviceId: url.searchParams.get("deviceId") ?? undefined,
          modality: coerceModality(url.searchParams.get("modality") ?? undefined),
          artifactUrlBase: "/api/clawsense/artifacts",
        });
        json(res, 200, payload);
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/evidence", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const startAt = parseOptionalFiniteNumber(url.searchParams.get("startAt") ?? undefined);
        const endAt = parseOptionalFiniteNumber(url.searchParams.get("endAt") ?? undefined);
        const rawParams: ClawSenseContextToolParams = {
          scope: coerceOptionalContextScope(url.searchParams.get("scope") ?? undefined),
          date: url.searchParams.get("date") ?? undefined,
          focus: coerceContextFocus(url.searchParams.get("focus") ?? undefined),
          question: url.searchParams.get("question") ?? undefined,
          deviceId: url.searchParams.get("deviceId") ?? undefined,
          modality: coerceModality(url.searchParams.get("modality") ?? undefined),
          startAt,
          endAt,
          lookbackDays: parseOptionalFiniteNumber(url.searchParams.get("lookbackDays") ?? undefined),
        };
        const resolved = await resolveClawSenseContext(
          {
            reviewEngine,
            artifactUrlBase,
          },
          rawParams,
        );
        if (!resolved.ok) {
          json(res, 400, resolved.details);
          return true;
        }
        json(res, 200, {
          ok: true,
          text: resolved.text,
          ...resolved.details,
        });
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/followups", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const rawParams: ClawSenseContextToolParams = {
          scope: coerceOptionalContextScope(url.searchParams.get("scope") ?? undefined),
          date: url.searchParams.get("date") ?? undefined,
          focus: coerceContextFocus(url.searchParams.get("focus") ?? undefined),
          question: url.searchParams.get("question") ?? undefined,
          deviceId: url.searchParams.get("deviceId") ?? undefined,
          modality: coerceModality(url.searchParams.get("modality") ?? undefined),
          startAt: parseOptionalFiniteNumber(url.searchParams.get("startAt") ?? undefined),
          endAt: parseOptionalFiniteNumber(url.searchParams.get("endAt") ?? undefined),
          lookbackDays: parseOptionalFiniteNumber(url.searchParams.get("lookbackDays") ?? undefined),
        };
        const resolved = await resolveClawSenseContext(
          {
            reviewEngine,
            artifactUrlBase,
          },
          rawParams,
        );
        if (!resolved.ok) {
          json(res, 400, resolved.details);
          return true;
        }
        json(res, 200, {
          ok: true,
          ...buildFollowupsPayload(
            resolved.details as {
              date: string;
              scope: "today" | "last-hour" | "custom-range";
              question?: string;
              responseHints?: unknown;
            },
            rawParams.question,
          ),
        });
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/artifacts", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const artifactId = url.searchParams.get("id")?.trim();
        if (!artifactId) {
          json(res, 400, { ok: false, error: "artifact_id_required" });
          return true;
        }
        const artifact = await stateStore.getArtifact(artifactId);
        if (!artifact || artifact.deletedAt) {
          json(res, 404, { ok: false, error: "artifact_not_found" });
          return true;
        }
        try {
          const body = await fs.readFile(artifact.storagePath);
          res.statusCode = 200;
          res.setHeader("content-type", artifact.mime ?? inferMimeFromName(artifact.fileName, artifact.modality));
          res.setHeader("cache-control", "private, max-age=60");
          res.end(body);
        } catch (error) {
          json(res, 404, { ok: false, error: "artifact_unreadable", details: String(error) });
        }
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/annotations", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const payload = await readJson(req, res);
        if (!payload) {
          return true;
        }
        const personRef = typeof payload.personRef === "string" ? payload.personRef.trim() : "";
        const displayName = typeof payload.displayName === "string" ? payload.displayName.trim() : "";
        if (!personRef || !displayName) {
          json(res, 400, { ok: false, error: "personRef and displayName required" });
          return true;
        }
        const annotation = await reviewEngine.annotatePerson({
          personRef,
          displayName,
          notes: typeof payload.notes === "string" ? payload.notes.trim() : undefined,
          relationship: typeof payload.relationship === "string" ? payload.relationship.trim() : undefined,
          nextWatchFor: typeof payload.nextWatchFor === "string" ? payload.nextWatchFor.trim() : undefined,
          eventIds:
            Array.isArray(payload.eventIds) && payload.eventIds.every((item) => typeof item === "string")
              ? payload.eventIds
              : undefined,
        });
        json(res, 200, { ok: true, annotation });
        return true;
      }, { auth: "gateway" }),
    );

    api.registerHttpRoute({
      path: "/plugins/clawsense/library",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const url = requestUrl(req);
        const html = await reviewEngine.renderLibraryPage(
          reviewEngine.normalizeDateInput(url.searchParams.get("date") ?? undefined),
          "/api/clawsense/artifacts",
          "/api/clawsense/library",
        );
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(html);
        return true;
      },
    });

    api.registerCli(
      ({ program }) => {
        const clawsense = (program as any).command("clawsense").description("ClawSense 配对、媒体库与回顾命令");

        clawsense.command("pair").description("生成一个新的 10 分钟配对二维码").action(async () => {
          const token = await printSetupQr("manual");
          process.stdout.write(
            `${safeJsonStringify({
              ok: true,
              token: token.token,
              expiresAt: token.expiresAt,
              ttlSeconds: Math.floor((token.expiresAt - token.createdAt) / 1000),
            })}\n`,
          );
        });

        clawsense.command("devices").description("列出已注册设备").action(async () => {
          const devices = await stateStore.listDevices();
          process.stdout.write(
            `${safeJsonStringify({
              ok: true,
              count: devices.length,
              devices: devices.map((device) => ({
                deviceId: device.deviceId,
                name: device.name,
                platform: device.platform,
                appVersion: device.appVersion,
                createdAt: device.createdAt,
                lastSeenAt: device.lastSeenAt,
                lastHeartbeatAt: device.lastHeartbeatAt,
              })),
            })}\n`,
          );
        });

        clawsense.command("status").description("查看 ClawSense 运行状态与接入诊断").action(async () => {
          const payload = await buildOperationalStatus();
          process.stdout.write(`${safeJsonStringify(payload)}\n`);
        });

        clawsense.command("doctor").description("输出 ClawSense 运行诊断和下一步建议").action(async () => {
          const payload = await buildOperationalDoctor();
          process.stdout.write(`${safeJsonStringify(payload)}\n`);
        });

        clawsense.command("media [date]").description("列出某天的媒体库事件").action(async (date?: string) => {
          const normalized = reviewEngine.normalizeDateInput(date === "today" ? undefined : date);
          const payload = await reviewEngine.buildLibrary({
            date: normalized,
            artifactUrlBase: artifactUrlBase(),
          });
          process.stdout.write(`${safeJsonStringify(payload)}\n`);
        });

        clawsense
          .command("library-url [date]")
          .description("输出媒体库访问 URL 与 gateway token 状态（默认 today）")
          .action(async (date?: string) => {
            const normalized = reviewEngine.normalizeDateInput(date === "today" ? undefined : date);
            const runtimeRoot = api.config as Record<string, unknown>;
            const gatewayCfg = (runtimeRoot.gateway as Record<string, unknown> | undefined) ?? {};
            const gatewayAuth = (gatewayCfg.auth as Record<string, unknown> | undefined) ?? {};
            const gatewayToken = typeof gatewayAuth.token === "string" ? gatewayAuth.token.trim() : "";
            const maskedToken =
              gatewayToken.length >= 8
                ? `${gatewayToken.slice(0, 4)}...${gatewayToken.slice(-4)}`
                : gatewayToken.length > 0
                  ? "***"
                  : "<missing>";
            const localUrl = new URL("/plugins/clawsense/library", `http://127.0.0.1:${cfg.gatewayPort}`);
            localUrl.searchParams.set("date", normalized);
            const publicUrl = new URL("/plugins/clawsense/library", publicBaseUrl());
            publicUrl.searchParams.set("date", normalized);
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                date: normalized,
                gatewayPort: cfg.gatewayPort,
                libraryLocalUrl: localUrl.toString(),
                libraryPublicUrl: publicUrl.toString(),
                hasGatewayToken: Boolean(gatewayToken),
                gatewayTokenLength: gatewayToken.length,
                gatewayTokenMasked: maskedToken,
                hints: [
                  "Open libraryLocalUrl on host machine, or libraryPublicUrl on phone/laptop.",
                  "Paste your current gateway token in the media library auth panel.",
                ],
              })}\n`,
            );
          });

        clawsense.command("review [date]").description("生成或查看某天回顾").action(async (date?: string) => {
          const normalized = reviewEngine.normalizeDateInput(date === "today" ? undefined : date);
          const review = await reviewEngine.getOrGenerateDailyReview(normalized);
          process.stdout.write(`${safeJsonStringify(review)}\n`);
        });

        clawsense
          .command("consolidation [date]")
          .description("生成或查看某天 consolidation（任务/人物/项目/学习点的结构化产物）")
          .option("--force", "忽略缓存，强制重算")
          .action(async (date?: string, options?: { force?: boolean }) => {
            const normalized = reviewEngine.normalizeDateInput(date === "today" ? undefined : date);
            const consolidation = await reviewEngine.getOrGenerateDailyConsolidation(normalized, {
              force: Boolean(options?.force),
            });
            process.stdout.write(`${safeJsonStringify(consolidation)}\n`);
          });

        clawsense
          .command("context [scopeOrDate]")
          .description("输出给普通聊天使用的 ClawSense 受控上下文")
          .action(async (scopeOrDate?: string) => {
            const scope = coerceContextScope(scopeOrDate);
            const date =
              scopeOrDate && scopeOrDate !== "today" && scopeOrDate !== "last-hour"
                ? reviewEngine.normalizeDateInput(scopeOrDate)
                : reviewEngine.normalizeDateInput(undefined);
            const payload = await reviewEngine.buildAssistantContext({
              scope,
              date,
              artifactUrlBase: artifactUrlBase(),
            });
            process.stdout.write(`${safeJsonStringify(payload)}\n`);
          });

        clawsense
          .command("evidence [scopeOrDate]")
          .description("输出标准 evidence bundle（含 windows/topEvidence/transcriptSpans/artifactRefs）")
          .option("--focus <focus>", "general | what_happened | watch_for")
          .option("--question <question>", "原始用户问题，可触发语义召回优先级")
          .option("--deviceId <deviceId>", "按设备过滤")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "滚动回看天数（2-30），自动转 custom-range")
          .action(async (
            scopeOrDate?: string,
            options?: {
              focus?: string;
              question?: string;
              deviceId?: string;
              modality?: string;
              startAt?: string;
              endAt?: string;
              lookbackDays?: string;
            },
          ) => {
            const rawParams: ClawSenseContextToolParams = {
              focus: coerceContextFocus(options?.focus),
              question: options?.question,
              deviceId: options?.deviceId,
              modality: coerceModality(options?.modality),
              startAt: parseOptionalFiniteNumber(options?.startAt),
              endAt: parseOptionalFiniteNumber(options?.endAt),
              lookbackDays: parseOptionalFiniteNumber(options?.lookbackDays),
            };
            if (scopeOrDate === "today" || scopeOrDate === "last-hour") {
              rawParams.scope = scopeOrDate;
            } else if (scopeOrDate?.trim()) {
              rawParams.date = reviewEngine.normalizeDateInput(scopeOrDate.trim());
            }
            const resolved = await resolveClawSenseContext(
              {
                reviewEngine,
                artifactUrlBase,
              },
              rawParams,
            );
            process.stdout.write(`${safeJsonStringify(resolved.ok ? {
              ok: true,
              ...resolved.details,
            } : resolved.details)}\n`);
          });

        clawsense
          .command("followups [scopeOrDate]")
          .description("输出音频/视频/历史记忆的结构化追问建议")
          .option("--focus <focus>", "general | what_happened | watch_for", "what_happened")
          .option("--question <question>", "原始用户问题，可触发相关性排序")
          .option("--deviceId <deviceId>", "按设备过滤")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "滚动回看天数（2-30），自动转 custom-range")
          .action(async (
            scopeOrDate?: string,
            options?: {
              focus?: string;
              question?: string;
              deviceId?: string;
              modality?: string;
              startAt?: string;
              endAt?: string;
              lookbackDays?: string;
            },
          ) => {
            const rawParams: ClawSenseContextToolParams = {
              focus: coerceContextFocus(options?.focus),
              question: options?.question,
              deviceId: options?.deviceId,
              modality: coerceModality(options?.modality),
              startAt: parseOptionalFiniteNumber(options?.startAt),
              endAt: parseOptionalFiniteNumber(options?.endAt),
              lookbackDays: parseOptionalFiniteNumber(options?.lookbackDays),
            };
            if (scopeOrDate === "today" || scopeOrDate === "last-hour") {
              rawParams.scope = scopeOrDate;
            } else if (scopeOrDate?.trim()) {
              rawParams.date = reviewEngine.normalizeDateInput(scopeOrDate.trim());
            }
            const resolved = await resolveClawSenseContext(
              {
                reviewEngine,
                artifactUrlBase,
              },
              rawParams,
            );
            if (!resolved.ok) {
              process.stdout.write(`${safeJsonStringify(resolved.details)}\n`);
              return;
            }
            const payload = buildFollowupsPayload(
              resolved.details as {
                date: string;
                scope: "today" | "last-hour" | "custom-range";
                question?: string;
                responseHints?: unknown;
              },
              options?.question,
            );
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                ...payload,
              })}\n`,
            );
          });

        clawsense
          .command("acceptance [lookbackDays]")
          .description("输出当前阶段收尾验收报告（明确离终点还差什么）")
          .action(async (lookbackDaysRaw?: string) => {
            const parsedLookbackDays = Number.parseInt(lookbackDaysRaw ?? "7", 10);
            const payload = await reviewEngine.buildPhaseAcceptance({
              lookbackDays: Number.isFinite(parsedLookbackDays) ? parsedLookbackDays : 7,
            });
            process.stdout.write(`${safeJsonStringify(payload)}\n`);
          });

        clawsense
          .command("annotate-suggestions [scopeOrDate]")
          .description("输出当前时间范围的人物/说话人结构化标注建议")
          .option("--question <question>", "原始问题（用于相关性排序）")
          .option("--focus <focus>", "general | what_happened | watch_for", "what_happened")
          .option("--deviceId <deviceId>", "可选设备筛选")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "滚动回看天数（2-30）")
          .action(async (
            scopeOrDate?: string,
            options?: {
              question?: string;
              focus?: string;
              deviceId?: string;
              modality?: string;
              startAt?: string;
              endAt?: string;
              lookbackDays?: string;
            },
          ) => {
            const rawParams: ClawSenseContextToolParams = {
              focus: coerceContextFocus(options?.focus),
              question: options?.question,
              deviceId: options?.deviceId,
              modality: coerceModality(options?.modality),
              startAt: parseOptionalFiniteNumber(options?.startAt),
              endAt: parseOptionalFiniteNumber(options?.endAt),
              lookbackDays: parseOptionalFiniteNumber(options?.lookbackDays),
            };
            if (scopeOrDate === "today" || scopeOrDate === "last-hour") {
              rawParams.scope = scopeOrDate;
            } else if (scopeOrDate?.trim()) {
              rawParams.date = reviewEngine.normalizeDateInput(scopeOrDate.trim());
            }
            const resolved = await resolveClawSenseContext(
              {
                reviewEngine,
                artifactUrlBase,
              },
              rawParams,
            );
            if (!resolved.ok) {
              process.stdout.write(`${safeJsonStringify(resolved.details)}\n`);
              return;
            }
            const details = resolved.details as {
              date: string;
              scope: "today" | "last-hour" | "custom-range";
              responseHints?: {
                annotationPrompts?: string[];
              };
              evidenceBundle?: {
                annotationSuggestions?: unknown;
                timeRange?: {
                  scope?: string;
                  date?: string;
                  startAt?: number;
                  endAt?: number;
                };
              };
            };
            const suggestions = normalizeCliAnnotationSuggestions(details.evidenceBundle?.annotationSuggestions);
            const availableSuggestionIds = suggestions.people
              .map((item) => item.suggestionId)
              .concat(suggestions.speakers.map((item) => item.suggestionId));
            const timeRange = details.evidenceBundle?.timeRange;
            const applyBaseArgs =
              timeRange?.scope === "custom-range" &&
                Number.isFinite(timeRange.startAt) &&
                Number.isFinite(timeRange.endAt)
                ? `--startAt ${timeRange.startAt} --endAt ${timeRange.endAt}`
                : timeRange?.scope === "last-hour"
                  ? "last-hour"
                  : details.date;
            const applyHints = suggestions.people
              .filter((item) => item.autoApplyEligible)
              .slice(0, 2)
              .map(
                (item) =>
                  `openclaw clawsense annotate-apply-suggestions ${applyBaseArgs} --id ${item.suggestionId} --yes`,
              );
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                date: details.date,
                scope: details.scope,
                annotationSuggestions: suggestions,
                annotationPrompts: details.responseHints?.annotationPrompts ?? [],
                availableSuggestionIds,
                applyHints,
              })}\n`,
            );
          });

        clawsense
          .command("annotate-apply-suggestions [scopeOrDate]")
          .description("按当前证据自动应用高置信人物标注（默认 dry-run，仅 --yes 时写入）")
          .option("--question <question>", "原始问题（用于相关性排序）")
          .option("--focus <focus>", "general | what_happened | watch_for", "what_happened")
          .option("--deviceId <deviceId>", "可选设备筛选")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "滚动回看天数（2-30）")
          .option("--max <count>", "最多应用多少条人物建议", "3")
          .option("--min-confidence <level>", "最小置信度（high | medium）", "high")
          .option("--id <suggestionId>", "仅应用指定建议 ID（可重复或逗号分隔）", collectCommaSeparatedOptionValues, [])
          .option("--include-medium", "包含中置信建议（默认仅高置信）")
          .option("--require-relationship", "仅应用带 relationshipHint 的建议")
          .option("--yes", "确认写入（不带该参数时仅输出预演计划）")
          .action(async (
            scopeOrDate?: string,
            options?: {
              question?: string;
              focus?: string;
              deviceId?: string;
              modality?: string;
              startAt?: string;
              endAt?: string;
              lookbackDays?: string;
              max?: string;
              minConfidence?: string;
              id?: string[];
              includeMedium?: boolean;
              requireRelationship?: boolean;
              yes?: boolean;
            },
          ) => {
            const rawParams: ClawSenseContextToolParams = {
              focus: coerceContextFocus(options?.focus),
              question: options?.question,
              deviceId: options?.deviceId,
              modality: coerceModality(options?.modality),
              startAt: parseOptionalFiniteNumber(options?.startAt),
              endAt: parseOptionalFiniteNumber(options?.endAt),
              lookbackDays: parseOptionalFiniteNumber(options?.lookbackDays),
            };
            if (scopeOrDate === "today" || scopeOrDate === "last-hour") {
              rawParams.scope = scopeOrDate;
            } else if (scopeOrDate?.trim()) {
              rawParams.date = reviewEngine.normalizeDateInput(scopeOrDate.trim());
            }
            const resolved = await resolveClawSenseContext(
              {
                reviewEngine,
                artifactUrlBase,
              },
              rawParams,
            );
            if (!resolved.ok) {
              process.stdout.write(`${safeJsonStringify(resolved.details)}\n`);
              return;
            }
            const details = resolved.details as {
              date: string;
              scope: "today" | "last-hour" | "custom-range";
              evidenceBundle?: {
                annotationSuggestions?: unknown;
              };
            };
            const suggestions = normalizeCliAnnotationSuggestions(details.evidenceBundle?.annotationSuggestions);
            const maxCountRaw = Number.parseInt(options?.max ?? "3", 10);
            const maxCount = Number.isFinite(maxCountRaw) ? Math.max(1, Math.min(10, maxCountRaw)) : 3;
            const includeMedium = Boolean(options?.includeMedium);
            const minConfidence = resolveMinimumConfidence(options?.minConfidence, includeMedium);
            const requireRelationship = Boolean(options?.requireRelationship);
            const applyPlan = buildCliAnnotationApplyPlan({
              suggestions,
              maxCount,
              includeMedium,
              minConfidence,
              requireRelationship,
              selectedSuggestionIds: normalizeCliSuggestionIdSelection(options?.id),
            });
            const selected = applyPlan.selected;
            const skipped = applyPlan.skipped;
            const dryRun = !Boolean(options?.yes);
            if (dryRun) {
              process.stdout.write(
                `${safeJsonStringify({
                  ok: true,
                  dryRun: true,
                  date: details.date,
                  scope: details.scope,
                  includeMedium,
                  minConfidence,
                  requireRelationship,
                  selectedSuggestionIds: applyPlan.selectedSuggestionIds,
                  unknownSuggestionIds: applyPlan.unknownSuggestionIds,
                  unsupportedSelectedSpeakerSuggestions: applyPlan.unsupportedSelectedSpeakerSuggestions,
                  selectedCount: selected.length,
                  skippedCount: skipped.length,
                  suggestions: selected,
                  skipped,
                  hint: "Add --yes to apply selected person annotations.",
                })}\n`,
              );
              return;
            }
            if (selected.length === 0) {
              process.stdout.write(
                `${safeJsonStringify({
                  ok: true,
                  dryRun: false,
                  noOp: true,
                  date: details.date,
                  scope: details.scope,
                  includeMedium,
                  minConfidence,
                  requireRelationship,
                  selectedSuggestionIds: applyPlan.selectedSuggestionIds,
                  unknownSuggestionIds: applyPlan.unknownSuggestionIds,
                  unsupportedSelectedSpeakerSuggestions: applyPlan.unsupportedSelectedSpeakerSuggestions,
                  attemptedCount: 0,
                  appliedCount: 0,
                  skippedCount: skipped.length,
                  applied: [],
                  skipped,
                  hint: "No eligible person suggestions matched current filters. Adjust --id / --min-confidence / --include-medium / --require-relationship.",
                })}\n`,
              );
              return;
            }

            const applied: Array<{
              personRef: string;
              displayName: string;
              confidence: "high" | "medium";
              annotationId: string;
            }> = [];
            for (const item of selected) {
              const annotation = await reviewEngine.annotatePerson({
                personRef: item.personRef,
                displayName: item.displayName,
                relationship: item.relationshipHint,
                notes: `auto-applied from annotate-suggestions: ${item.sourceHint}`,
              });
              applied.push({
                personRef: item.personRef,
                displayName: item.displayName,
                confidence: item.confidence,
                annotationId: annotation.annotationId,
              });
            }

            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                dryRun: false,
                date: details.date,
                scope: details.scope,
                includeMedium,
                minConfidence,
                requireRelationship,
                selectedSuggestionIds: applyPlan.selectedSuggestionIds,
                unknownSuggestionIds: applyPlan.unknownSuggestionIds,
                unsupportedSelectedSpeakerSuggestions: applyPlan.unsupportedSelectedSpeakerSuggestions,
                attemptedCount: selected.length,
                appliedCount: applied.length,
                skippedCount: skipped.length,
                applied,
                skipped,
              })}\n`,
            );
          });

        clawsense
          .command("acceptance-plan [lookbackDays]")
          .description("输出阶段验收推进计划（每条标准对应缺口、动作和可执行命令）")
          .action(async (lookbackDaysRaw?: string) => {
            const parsedLookbackDays = Number.parseInt(lookbackDaysRaw ?? "7", 10);
            const payload = await reviewEngine.buildPhaseAcceptancePlan({
              lookbackDays: Number.isFinite(parsedLookbackDays) ? parsedLookbackDays : 7,
            });
            process.stdout.write(`${safeJsonStringify(payload)}\n`);
          });

        clawsense
          .command("annotate <personRef> <displayName> [notes...]")
          .description("补充人物注释")
          .option("--relationship <relationship>", "人物关系（例如 同事/老板/老师）")
          .option("--nextWatchFor <nextWatchFor>", "下次建议关注事项")
          .option("--notes <notesText>", "备注（与 [notes...] 二选一，优先使用 --notes）")
          .action(async (
            personRef: string,
            displayName: string,
            notes: string[] | undefined,
            options?: {
              relationship?: string;
              nextWatchFor?: string;
              notes?: string;
            },
          ) => {
            const notesFromArgs = Array.isArray(notes) ? notes.join(" ").trim() : "";
            const notesText = options?.notes?.trim() || notesFromArgs || undefined;
            const annotation = await reviewEngine.annotatePerson({
              personRef,
              displayName,
              relationship: options?.relationship?.trim() || undefined,
              nextWatchFor: options?.nextWatchFor?.trim() || undefined,
              notes: notesText,
            });
            process.stdout.write(`${safeJsonStringify({ ok: true, annotation })}\n`);
          });

        clawsense
          .command("annotate-speaker <speakerRef> <displayName>")
          .description("补充说话人注释")
          .option("--relationship <relationship>", "说话人关系（例如 同事/老板/老师）")
          .option("--notes <notesText>", "备注")
          .option("--windowId <windowId>", "来源窗口 ID")
          .option("--deviceId <deviceId>", "来源设备 ID")
          .action(async (
            speakerRef: string,
            displayName: string,
            options?: {
              relationship?: string;
              notes?: string;
              windowId?: string;
              deviceId?: string;
            },
          ) => {
            const annotation = await reviewEngine.annotateSpeaker({
              speakerRef,
              displayName,
              relationship: options?.relationship?.trim() || undefined,
              notes: options?.notes?.trim() || undefined,
              windowId: options?.windowId?.trim() || undefined,
              deviceId: options?.deviceId?.trim() || undefined,
            });
            process.stdout.write(`${safeJsonStringify({ ok: true, annotation })}\n`);
          });

        clawsense
          .command("backfill-audio [date]")
          .description("对某一天的降级音频做一轮轻量 transcript backfill")
          .option("--max <count>", "最多处理多少段音频", "3")
          .action(async (date?: string, options?: { max?: string }) => {
            const normalizedDate = date ? reviewEngine.normalizeDateInput(date) : reviewEngine.normalizeDateInput(undefined);
            const maxArtifacts = Number.parseInt(options?.max ?? "3", 10);
            const result = await reviewEngine.runAudioBackfillTick({
              dates: [normalizedDate],
              maxArtifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : 3,
            });
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                date: normalizedDate,
                ...result,
              })}\n`,
            );
          });
      },
      { commands: ["clawsense"] },
    );

    api.registerService({
      id: "clawsense",
      start: async () => {
        await stateStore.pruneExpiredSetupTokens(DEFAULT_PAIRING_TTL_SECONDS);
        await memoryStore.pruneExpiredArtifacts();
        await ensureBootstrapQr();
        maintenanceTimer = setInterval(() => {
          void reviewEngine.runMaintenanceTick().catch((error) => {
            api.logger.warn(`[clawsense] maintenance tick failed: ${String(error)}`);
          });
        }, 5 * 60 * 1000);
        api.logger.info("[clawsense] service started");
      },
      stop: async () => {
        if (maintenanceTimer) {
          clearInterval(maintenanceTimer);
          maintenanceTimer = null;
        }
        api.logger.info("[clawsense] service stopped");
      },
    });
  },
};

function requestUrl(req: { url?: string }): URL {
  return new URL(req.url ?? "/", "http://clawsense.local");
}

function coerceModality(value: string | undefined): "audio" | "image" | "video" | undefined {
  return value === "audio" || value === "image" || value === "video" ? value : undefined;
}

function coerceLibraryModality(value: string | undefined): "audio" | "image" | "video" | undefined {
  return value === "audio" || value === "image" || value === "video" ? value : undefined;
}

function coerceOptionalContextScope(value: string | undefined): "last-hour" | "today" | undefined {
  if (value === "last-hour") {
    return "last-hour";
  }
  if (value === "today") {
    return "today";
  }
  return undefined;
}

function coerceRecentContextWindowHint(value: string | undefined): RecentContextWindowHint | undefined {
  if (value === "last_15s" || value === "last_60s" || value === "last_5m") {
    return value;
  }
  return undefined;
}

function coerceAssistantModeHint(value: string | undefined): AssistantModeHint | undefined {
  if (value === "auto" || value === "meeting" || value === "desk") {
    return value;
  }
  return undefined;
}

function coerceContextFocus(value: string | undefined): "general" | "what_happened" | "watch_for" | undefined {
  if (value === "what_happened") {
    return "what_happened";
  }
  if (value === "watch_for") {
    return "watch_for";
  }
  if (value === "general") {
    return "general";
  }
  return undefined;
}

function coerceContextScope(value: string | undefined): "last-hour" | "today" | "custom-range" {
  if (value === "last-hour") {
    return "last-hour";
  }
  if (value === "custom-range") {
    return "custom-range";
  }
  return "today";
}

function coerceTimestampRange(
  startAtRaw: string | undefined,
  endAtRaw: string | undefined,
): { startAt: number; endAt: number } | "invalid" | null {
  if (!startAtRaw && !endAtRaw) {
    return null;
  }
  const startAt = Number(startAtRaw);
  const endAt = Number(endAtRaw);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    return "invalid";
  }
  return { startAt, endAt };
}

function parseOptionalFiniteNumber(value: string | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildFollowupsPayload(
  details: {
    date: string;
    scope: "today" | "last-hour" | "custom-range";
    question?: string;
    responseHints?: unknown;
  },
  fallbackQuestion?: string,
): {
  scope: "today" | "last-hour" | "custom-range";
  date: string;
  question?: string;
  audioFollowUps: string[];
  audioFollowUpTargets: unknown[];
  videoFollowUps: string[];
  videoFollowUpTargets: unknown[];
  historyFollowUps: string[];
  evidenceFollowUpTargets: unknown[];
  topPrompts: string[];
} {
  const responseHints = (details.responseHints && typeof details.responseHints === "object")
    ? details.responseHints as {
      audioFollowUps?: unknown;
      audioFollowUpTargets?: unknown;
      videoFollowUps?: unknown;
      videoFollowUpTargets?: unknown;
      historyFollowUps?: unknown;
      evidenceFollowUpTargets?: unknown;
    }
    : {};
  const audioFollowUps = Array.isArray(responseHints.audioFollowUps)
    ? responseHints.audioFollowUps.filter((item): item is string => typeof item === "string")
    : [];
  const audioFollowUpTargets = Array.isArray(responseHints.audioFollowUpTargets)
    ? responseHints.audioFollowUpTargets
    : [];
  const videoFollowUps = Array.isArray(responseHints.videoFollowUps)
    ? responseHints.videoFollowUps.filter((item): item is string => typeof item === "string")
    : [];
  const videoFollowUpTargets = Array.isArray(responseHints.videoFollowUpTargets)
    ? responseHints.videoFollowUpTargets
    : [];
  const historyFollowUps = Array.isArray(responseHints.historyFollowUps)
    ? responseHints.historyFollowUps.filter((item): item is string => typeof item === "string")
    : [];
  const evidenceFollowUpTargets = Array.isArray(responseHints.evidenceFollowUpTargets)
    ? responseHints.evidenceFollowUpTargets
    : [];
  const topPrompts = evidenceFollowUpTargets
    .map((item) => (item && typeof item === "object" && "prompt" in item ? (item as { prompt?: unknown }).prompt : undefined))
    .filter((prompt): prompt is string => typeof prompt === "string" && prompt.trim().length > 0)
    .slice(0, 5);
  return {
    scope: details.scope,
    date: details.date,
    question: details.question ?? fallbackQuestion,
    audioFollowUps,
    audioFollowUpTargets,
    videoFollowUps,
    videoFollowUpTargets,
    historyFollowUps,
    evidenceFollowUpTargets,
    topPrompts,
  };
}

function collectCommaSeparatedOptionValues(
  value: string,
  previous: string[] = [],
): string[] {
  const next = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return previous.concat(next);
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    return first?.trim();
  }
  return undefined;
}

function buildVideoKeyframeMarkerNoteParts(input: Record<string, unknown>): string[] {
  const caption = readStringField(input, ["caption", "keyframeCaption", "frameCaption"]);
  const ocrHints = readOcrHints(input);
  const videoOffsetMs = readVideoKeyframeOffsetMs(input);
  return [
    typeof videoOffsetMs === "number" ? `videoOffsetMs=${Math.max(0, Math.round(videoOffsetMs))}` : "",
    caption ? `caption=${encodeURIComponent(caption)}` : "",
    ocrHints.length > 0 ? `ocr=${encodeURIComponent(ocrHints.join("|"))}` : "",
  ].filter(Boolean);
}

function readVideoKeyframeOffsetMs(input: Record<string, unknown>): number | undefined {
  const directMs = readNumberField(input, ["videoOffsetMs", "offsetMs", "frameOffsetMs", "timeMs"]);
  if (typeof directMs === "number") {
    return directMs;
  }
  const seconds = readNumberField(input, ["videoOffsetSec", "offsetSec", "frameOffsetSec", "timeSec"]);
  if (typeof seconds === "number") {
    return seconds * 1000;
  }
  return undefined;
}

function readNumberField(input: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readStringField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 240);
    }
  }
  return undefined;
}

function readOcrHints(input: Record<string, unknown>): string[] {
  const direct = input.ocrHints;
  if (Array.isArray(direct)) {
    return direct
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  const text = readStringField(input, ["ocr", "ocrText", "frameOcr"]);
  if (!text) {
    return [];
  }
  return text
    .split(/[|｜、;,，]/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function combineAssistantDiagnostics(values: Array<string | undefined>): string | undefined {
  const filtered = values
    .flatMap((value) => (value ?? "").split("|"))
    .map((value) => value.trim())
    .filter(Boolean);
  return filtered.length > 0 ? Array.from(new Set(filtered)).join("|") : undefined;
}

export default plugin as {
  id: string;
  name: string;
  description: string;
  configSchema: typeof clawsenseConfigSchema;
  register: (api: OpenClawPluginApi) => void;
};
