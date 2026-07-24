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
  type ClawSenseArtifactRecord,
  type ClawSenseCaptureEvent,
  type ClawSenseDeviceRecord,
  type ClawSenseIngestReceipt,
  type ClawSenseMemoryCard,
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
import { inspectLocalAsrConfig, transcribeAudioWithLocalAsr } from "./src/local-asr.js";
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
  resolveAssistantAudioRecheckPlan,
  resolveAssistantQueryText,
  shouldFallbackAssistantContextToAllDevices,
  shouldUseDeterministicAssistantAnswer,
  shouldUsePreviousTurnEvidenceRange,
  type AssistantConversationTurn,
  type AssistantModeHint,
  type RecentContextWindowHint,
  withAssistantDeviceFallbackHint,
} from "./src/realtime-assistant.js";
import { resolveAutoVideoTriggerReason } from "./src/auto-video-trigger.js";

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
    let analysisRecoveryTimer: NodeJS.Timeout | null = null;
    let asrWorkerTimer: NodeJS.Timeout | null = null;
    let asrWorkerActive = false;
    const analysisQueue: Array<{
      requestId: string;
      device: ClawSenseDeviceRecord;
      deviceId: string;
      artifactId: string;
      modality: "audio" | "image" | "video";
      capturedAt?: number;
      note?: string;
      queuedAt: number;
    }> = [];
    let analysisPumpActive = false;
    let analysisCurrent:
      | {
          requestId: string;
          artifactId: string;
          modality: "audio" | "image" | "video";
          startedAt: number;
        }
      | null = null;
    const MAX_PENDING_ANALYSIS_JOBS = 96;
    const MAX_VIDEO_KEYFRAMES_PER_INGEST = 6;
    const MAX_VIDEO_INGEST_JSON_BYTES = 96 * 1024 * 1024;
    const AUTO_VIDEO_DIRECTIVE_DURATION_MS = 6_000;
    const AUTO_VIDEO_DIRECTIVE_TTL_MS = 2 * 60 * 1000;
    const AUTO_VIDEO_DIRECTIVE_COOLDOWN_MS = 10 * 60 * 1000;
    const assistantConversationTurns = new Map<string, AssistantConversationTurn>();
    const autoVideoDirectives = new Map<string, {
      directiveId: string;
      deviceId: string;
      durationMs: number;
      reason: string;
      sourceEventId: string;
      sourceText: string;
      issuedAt: number;
      expiresAt: number;
    }>();

    const runAsrWorkerSafely = async (reason: "startup" | "interval" | "manual"): Promise<void> => {
      if (asrWorkerActive) {
        api.logger.warn(`[clawsense] ASR worker skipped ${reason}; previous tick is still running`);
        return;
      }
      asrWorkerActive = true;
      try {
        const result = await reviewEngine.runAudioBackfillWorkerTick();
        const attempted = result.run?.attempted ?? 0;
        if (attempted > 0 || result.reason !== "no-audio-candidates") {
          api.logger.info(
            `[clawsense] ASR worker ${reason} reason=${result.reason} attempted=${attempted} succeeded=${
              result.run?.succeeded ?? 0
            } failed=${result.run?.failed ?? 0} remaining=${result.queue?.stats.remaining ?? 0}`,
          );
        }
      } catch (error) {
        api.logger.warn(`[clawsense] ASR worker ${reason} failed: ${String(error)}`);
      } finally {
        asrWorkerActive = false;
      }
    };

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

    const pruneAssistantQueryAudioDir = async (dir: string, keepCount: number): Promise<void> => {
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      const files = (
        await Promise.all(
          entries.map(async (name) => {
            const filePath = path.join(dir, name);
            const stat = await fs.stat(filePath).catch(() => null);
            return stat?.isFile() ? { filePath, mtimeMs: stat.mtimeMs } : null;
          }),
        )
      )
        .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
      await Promise.all(
        files.slice(keepCount).map((file) => fs.rm(file.filePath, { force: true }).catch(() => undefined)),
      );
    };

    const transcribeAssistantQuery = async (params: {
      body: Buffer;
      fileName: string;
      mime?: string;
      modeHint?: AssistantModeHint;
    }): Promise<{ queryText: string; provider?: string; failureReason?: string }> => {
      const providers: string[] = [];
      const failureReasons: string[] = [];
      let rejectedTranscript = "";
      const shouldAcceptQueryTranscript = (text: string): boolean =>
        Boolean(
          resolveAssistantQueryText({ queryText: text, modeHint: params.modeHint, explicitQuery: true }).queryText,
        );
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
            if (shouldAcceptQueryTranscript(runtimeText)) {
              return {
                queryText: runtimeText,
                provider: "runtime-stt",
              };
            }
            providers.push("runtime-stt");
            failureReasons.push("runtime_stt_unusable_query");
            rejectedTranscript ||= runtimeText;
          } else {
            providers.push("runtime-stt");
            failureReasons.push("runtime_stt_empty");
          }
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
          const localTranscript = localAsr.transcript.trim();
          if (shouldAcceptQueryTranscript(localTranscript)) {
            return {
              queryText: localTranscript,
              provider: combineAssistantDiagnostics(providers),
              failureReason: combineAssistantDiagnostics(failureReasons),
            };
          }
          failureReasons.push("query_time_local_asr_unusable_query");
          rejectedTranscript ||= localTranscript;
        } else if (localAsr.analysisFailureReason !== "query_time_local_asr_disabled") {
          failureReasons.push(localAsr.analysisFailureReason ?? "query_time_local_asr_empty");
        }
      } finally {
        // Keep the most recent query clips on disk so a failing live query can be
        // replayed against each ASR provider instead of guessing from rawQueryLen.
        if (cfg.assistantQueryAudioKeepCount > 0) {
          await pruneAssistantQueryAudioDir(tempDir, cfg.assistantQueryAudioKeepCount).catch(() => undefined);
        } else {
          await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
        }
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
        const fallbackTranscript = fallback.transcript.trim();
        if (shouldAcceptQueryTranscript(fallbackTranscript)) {
          return {
            queryText: fallbackTranscript,
            provider: combineAssistantDiagnostics(providers),
            failureReason: combineAssistantDiagnostics(failureReasons),
          };
        }
        failureReasons.push("query_time_asr_unusable_query");
        rejectedTranscript ||= fallbackTranscript;
      } else {
        failureReasons.push(fallback.analysisFailureReason ?? "query_time_asr_empty");
      }

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
        const multimodalTextAccepted = shouldAcceptQueryTranscript(multimodalText);
        if (!multimodalTextAccepted) {
          failureReasons.push("primary_multimodal_unusable_query");
          rejectedTranscript ||= multimodalText;
        }
        if (multimodalTextAccepted) {
          return {
            queryText: multimodalText,
            provider: combineAssistantDiagnostics(providers),
            failureReason: combineAssistantDiagnostics(failureReasons),
          };
        }
      }
      failureReasons.push(
        multimodal.summary?.trim()
          ? "primary_multimodal_summary_not_query"
          : multimodal.analysisFailureReason ?? "primary_multimodal_empty",
      );

      return {
        queryText: rejectedTranscript,
        provider: combineAssistantDiagnostics(providers),
        failureReason: combineAssistantDiagnostics(failureReasons),
      };
    };

    const buildVideoConfigStatus = () => {
      const mode = cfg.hostModelVideoMode;
      return {
        hostModelVideoMode: mode,
        ingestEnabled: mode !== "none",
        directVideoUnderstanding: mode === "direct",
        recommendedMvpMode: "keyframes",
        ingestEndpoint: `${stripTrailingSlash(publicBaseUrl())}/api/clawsense/ingest/video`,
        androidM2: {
          supported: true,
          mode: "manual-6s-video-only",
          keyframes: "start/end",
          note: "Android M2 records video-only MP4 clips and uploads start/end keyframes.",
        },
        commands: {
          enableKeyframes:
            "openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '\"keyframes\"' --strict-json",
          enableDirect:
            "openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '\"direct\"' --strict-json",
          disable:
            "openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '\"none\"' --strict-json",
          restartGateway: "openclaw gateway restart --json || openclaw gateway start --json",
        },
        hints:
          mode === "none"
            ? [
                "Video ingest is currently disabled; Android video upload will return 409 video_ingest_disabled.",
                "For the current MVP, use keyframes first. Direct mode should only be used with a provider/model that accepts native video input.",
              ]
            : mode === "keyframes"
              ? [
                  "Video ingest is enabled. Raw MP4 is stored and semantic understanding comes from uploaded keyframes.",
                  "This is the recommended Android M2 validation mode.",
                ]
              : [
                  "Video ingest is enabled and direct video understanding will be attempted first.",
                  "If the provider/model rejects video input, ClawSense will degrade to metadata/keyframe evidence.",
                ],
      };
    };

    const buildOperationalStatus = async () => {
      const now = Date.now();
      const devices = await stateStore.listDevices();
      const events = await stateStore.listEvents();
      const analysisQueueDepth = analysisQueue.length;
      const analysisQueueOldest = analysisQueue[0];
      const analysisQueueOldestWaitMs = analysisQueueOldest ? Math.max(0, now - analysisQueueOldest.queuedAt) : 0;
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
      const publicHost = (() => {
        try {
          return new URL(publicUrl).hostname.trim().toLowerCase();
        } catch {
          return "";
        }
      })();
      const publicHostLooksAlias = ["lan", "localhost", "127.0.0.1", "0.0.0.0", "::", "::1", "*"].includes(
        publicHost,
      );
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
        videoIngest: buildVideoConfigStatus(),
        queue: {
          depth: analysisQueueDepth,
          maxPending: MAX_PENDING_ANALYSIS_JOBS,
          pumpActive: analysisPumpActive,
          oldestQueuedAt: analysisQueueOldest?.queuedAt ?? null,
          oldestWaitMs: analysisQueueOldest ? analysisQueueOldestWaitMs : null,
          kind: "analysis",
          ingestDepth: 0,
          analysisDepth: analysisQueueDepth,
          analysisMaxPending: MAX_PENDING_ANALYSIS_JOBS,
          current: analysisCurrent,
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
      if (status.queue.analysisDepth >= Math.max(6, Math.floor(status.queue.analysisMaxPending * 0.5))) {
        warnings.push(`后台分析队列积压较高：${status.queue.analysisDepth}/${status.queue.analysisMaxPending}`);
        nextActions.push("证据已优先落库；先保持客户端在线并等待后台分析回落，再做高频录音/视频压测。");
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
        warnings.push("hostModelVideoMode=none：Android 视频 M2 已可录制，但服务端会拒绝 /ingest/video。");
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

    const recordPendingIngest = async (params: {
      device: ClawSenseDeviceRecord;
      modality: "audio" | "image" | "video";
      body: Buffer;
      fileName: string;
      mime: string | undefined;
      capturedAt?: number;
      note?: string;
    }): Promise<ClawSenseIngestReceipt> => {
      const receipt = await memoryStore.ingestPending({
        ...params,
      });

      try {
        await api.runtime.system.requestHeartbeatNow();
      } catch (error) {
        api.logger.warn(`[clawsense] requestHeartbeatNow failed: ${String(error)}`);
      }
      return receipt;
    };

    const analyzeIngestArtifact = async (params: {
      artifactId: string;
    }): Promise<void> => {
      const result = await memoryStore.analyzeCaptureArtifact({
        artifactId: params.artifactId,
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
      if (result.event) {
        maybeIssueAutoVideoDirective(result.event);
      }

      try {
        await api.runtime.system.requestHeartbeatNow();
      } catch (error) {
        api.logger.warn(`[clawsense] requestHeartbeatNow failed: ${String(error)}`);
      }
    };

    const maybeIssueAutoVideoDirective = (event: {
      eventId: string;
      deviceId: string;
      modality: "audio" | "image" | "video";
      summary?: string;
      transcript?: string;
      analysisStatus?: "succeeded" | "degraded";
    }): void => {
      if (event.modality === "video" || event.analysisStatus !== "succeeded") {
        return;
      }
      if (analysisQueue.length >= Math.floor(MAX_PENDING_ANALYSIS_JOBS * 0.75)) {
        return;
      }
      const now = Date.now();
      for (const [deviceId, directive] of autoVideoDirectives) {
        if (directive.expiresAt <= now) {
          autoVideoDirectives.delete(deviceId);
        }
      }
      const existing = autoVideoDirectives.get(event.deviceId);
      if (existing && existing.expiresAt > now) {
        return;
      }
      const recentDirective = Array.from(autoVideoDirectives.values()).find(
        (item) => item.deviceId === event.deviceId && now - item.issuedAt < AUTO_VIDEO_DIRECTIVE_COOLDOWN_MS,
      );
      if (recentDirective) {
        return;
      }

      const sourceText = normalizeSemanticText([event.transcript, event.summary].filter(Boolean).join("\n"));
      const reason = resolveAutoVideoTriggerReason(sourceText);
      if (!reason) {
        return;
      }

      const directive = {
        directiveId: randomUUID(),
        deviceId: event.deviceId,
        durationMs: AUTO_VIDEO_DIRECTIVE_DURATION_MS,
        reason,
        sourceEventId: event.eventId,
        sourceText: sourceText.slice(0, 240),
        issuedAt: now,
        expiresAt: now + AUTO_VIDEO_DIRECTIVE_TTL_MS,
      };
      autoVideoDirectives.set(event.deviceId, directive);
      api.logger.info(
        `[clawsense] issued auto-video directive device=${event.deviceId} sourceEventId=${event.eventId} reason=${reason}`,
      );
    };

    const pumpAnalysisQueue = (): void => {
      if (analysisPumpActive) {
        return;
      }
      analysisPumpActive = true;
      void (async () => {
        try {
          while (analysisQueue.length > 0) {
            const job = analysisQueue.shift();
            if (!job) {
              continue;
            }
            const startedAt = Date.now();
            analysisCurrent = {
              requestId: job.requestId,
              artifactId: job.artifactId,
              modality: job.modality,
              startedAt,
            };
            api.logger.info(
              `[clawsense] processing queued ${job.modality} analysis requestId=${job.requestId} artifactId=${job.artifactId} queueWaitMs=${startedAt - job.queuedAt} queueDepth=${analysisQueue.length}`,
            );
            try {
              await analyzeIngestArtifact({ artifactId: job.artifactId });
              await stateStore.touchDevice(job.device.deviceId);
              api.logger.info(
                `[clawsense] completed queued ${job.modality} analysis requestId=${job.requestId} artifactId=${job.artifactId} durationMs=${Date.now() - startedAt}`,
              );
            } catch (error) {
              api.logger.error(
                `[clawsense] queued ${job.modality} analysis failed requestId=${job.requestId} artifactId=${job.artifactId}: ${String(error)}`,
              );
            } finally {
              analysisCurrent = null;
            }
          }
        } finally {
          analysisPumpActive = false;
          if (analysisQueue.length > 0) {
            pumpAnalysisQueue();
          }
        }
      })();
    };

    const enqueueAnalysis = (params: {
      device: ClawSenseDeviceRecord;
      artifactId: string;
      modality: "audio" | "image" | "video";
      capturedAt?: number;
      note?: string;
      requestId?: string;
    }): { accepted: true; requestId: string; queueDepth: number } | { accepted: false; queueDepth: number } => {
      const requestId = params.requestId?.trim() || randomUUID();
      const { requestId: _ignoredRequestId, ...jobParams } = params;
      const result = enqueueIngestJob(analysisQueue, {
        requestId,
        queuedAt: Date.now(),
        deviceId: params.device.deviceId,
        ...jobParams,
      }, {
        maxPendingJobs: MAX_PENDING_ANALYSIS_JOBS,
      });
      if (!result.accepted) {
        return result;
      }
      if (result.action === "replaced") {
        api.logger.info(
          `[clawsense] coalesced queued ${params.modality} analysis requestId=${result.requestId} replaced=${result.affectedRequestId ?? "unknown"} queueDepth=${result.queueDepth}`,
        );
      } else if (result.action === "evicted-visual") {
        api.logger.warn(
          `[clawsense] evicted older queued visual analysis to admit ${params.modality} requestId=${result.requestId} evicted=${result.affectedRequestId ?? "unknown"} queueDepth=${result.queueDepth}`,
        );
      }
      pumpAnalysisQueue();
      return result;
    };

    const requeuePendingAnalysis = async (maxArtifacts = 12): Promise<{
      scanned: number;
      queued: number;
      skippedQueued: number;
      missingArtifacts: number;
      missingDevices: number;
    }> => {
      const queuedArtifactIds = new Set<string>();
      for (const job of analysisQueue) {
        queuedArtifactIds.add(job.artifactId);
      }
      if (analysisCurrent?.artifactId) {
        queuedArtifactIds.add(analysisCurrent.artifactId);
      }

      const devices = await stateStore.listDevices();
      const devicesById = new Map(devices.map((device) => [device.deviceId, device]));
      const pendingEvents = (await stateStore.listEvents())
        .filter((event) => event.artifactId && event.analysisFailureReason === "analysis_pending")
        .sort((a, b) => a.capturedAt - b.capturedAt)
        .slice(0, Math.max(1, maxArtifacts));

      let queued = 0;
      let skippedQueued = 0;
      let missingArtifacts = 0;
      let missingDevices = 0;

      for (const event of pendingEvents) {
        const artifactId = event.artifactId;
        if (!artifactId) {
          continue;
        }
        if (queuedArtifactIds.has(artifactId)) {
          skippedQueued += 1;
          continue;
        }
        const artifact = await stateStore.getArtifact(artifactId);
        if (!artifact || artifact.deletedAt) {
          missingArtifacts += 1;
          continue;
        }
        const device = devicesById.get(event.deviceId);
        if (!device) {
          missingDevices += 1;
          continue;
        }
        const accepted = enqueueAnalysis({
          device,
          artifactId,
          modality: event.modality,
          capturedAt: event.capturedAt,
          note: event.note,
        });
        if (!accepted.accepted) {
          break;
        }
        queued += 1;
        queuedArtifactIds.add(artifactId);
      }

      if (queued > 0) {
        api.logger.info(`[clawsense] requeued ${queued} pending analysis artifact(s)`);
      }

      return {
        scanned: pendingEvents.length,
        queued,
        skippedQueued,
        missingArtifacts,
        missingDevices,
      };
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

        const receipt = await recordPendingIngest({
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
        const accepted = enqueueAnalysis({
          device,
          artifactId: receipt.artifactId ?? receipt.memoryId,
          modality: "audio",
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: typeof payload.note === "string" ? payload.note : undefined,
        });
        if (!accepted.accepted) {
          api.logger.warn(
            `[clawsense] analysis queue full after fast audio ingest artifactId=${receipt.artifactId ?? "unknown"} queueDepth=${accepted.queueDepth}; keeping pending event for late recheck`,
          );
        }
        await stateStore.touchDevice(device.deviceId);
        json(res, 202, {
          ok: true,
          queued: accepted.accepted,
          stored: true,
          analysisQueued: accepted.accepted,
          requestId: accepted.accepted ? accepted.requestId : undefined,
          artifactId: receipt.artifactId,
          eventId: receipt.memoryId,
          queueDepth: accepted.queueDepth,
          analysisQueueDepth: accepted.queueDepth,
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

        const receipt = await recordPendingIngest({
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
        const accepted = enqueueAnalysis({
          device,
          artifactId: receipt.artifactId ?? receipt.memoryId,
          modality: "image",
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: typeof payload.note === "string" ? payload.note : undefined,
        });
        if (!accepted.accepted) {
          api.logger.warn(
            `[clawsense] analysis queue full after fast image ingest artifactId=${receipt.artifactId ?? "unknown"} queueDepth=${accepted.queueDepth}; keeping pending event for late recheck`,
          );
        }
        await stateStore.touchDevice(device.deviceId);
        json(res, 202, {
          ok: true,
          queued: accepted.accepted,
          stored: true,
          analysisQueued: accepted.accepted,
          requestId: accepted.accepted ? accepted.requestId : undefined,
          artifactId: receipt.artifactId,
          eventId: receipt.memoryId,
          queueDepth: accepted.queueDepth,
          analysisQueueDepth: accepted.queueDepth,
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
        const receipt = await recordPendingIngest({
          device,
          modality: "video",
          body,
          fileName:
            typeof payload.fileName === "string" && payload.fileName.trim()
              ? payload.fileName.trim()
              : "capture.mp4",
          mime: typeof payload.mime === "string" && payload.mime.trim() ? payload.mime.trim() : undefined,
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: videoNoteParts.join(" "),
        });
        const accepted = enqueueAnalysis({
          device,
          artifactId: receipt.artifactId ?? receipt.memoryId,
          modality: "video",
          requestId: videoRequestId,
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: videoNoteParts.join(" "),
        });
        if (!accepted.accepted) {
          api.logger.warn(
            `[clawsense] analysis queue full after fast video ingest artifactId=${receipt.artifactId ?? "unknown"} queueDepth=${accepted.queueDepth}; keeping pending event for late recheck`,
          );
        }
        const keyframes = Array.isArray(payload.keyframes) ? payload.keyframes.slice(0, MAX_VIDEO_KEYFRAMES_PER_INGEST) : [];
        let keyframesAccepted = 0;
        let keyframesAnalysisQueued = 0;
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
          const keyframeReceipt = await recordPendingIngest({
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
          keyframesAccepted += 1;
          const keyframeAccepted = enqueueAnalysis({
            device,
            artifactId: keyframeReceipt.artifactId ?? keyframeReceipt.memoryId,
            modality: "image",
            capturedAt: keyframeCapturedAt,
            note: keyframeNoteParts.join(" "),
          });
          if (keyframeAccepted.accepted) {
            keyframesAnalysisQueued += 1;
          } else {
            api.logger.warn(
              `[clawsense] analysis queue full after fast video keyframe ingest artifactId=${keyframeReceipt.artifactId ?? "unknown"} queueDepth=${keyframeAccepted.queueDepth}; keeping pending event for late recheck`,
            );
          }
        }
        await stateStore.touchDevice(device.deviceId);
        json(res, 202, {
          ok: true,
          queued: accepted.accepted,
          stored: true,
          analysisQueued: accepted.accepted,
          requestId: accepted.accepted ? accepted.requestId : videoRequestId,
          artifactId: receipt.artifactId,
          eventId: receipt.memoryId,
          videoRequestId,
          queueDepth: accepted.queueDepth,
          analysisQueueDepth: accepted.queueDepth,
          analysisMode: cfg.hostModelVideoMode === "direct" ? "multimodal-pending" : "metadata-only",
          keyframesAccepted,
          keyframesAnalysisQueued,
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
        const appState =
          typeof payload.appState === "string" && payload.appState.trim() ? payload.appState.trim() : undefined;
        await stateStore.updateHeartbeat(device.deviceId, {
          batteryPct: typeof payload.batteryPct === "number" ? payload.batteryPct : undefined,
          network:
            typeof payload.network === "string" && payload.network.trim() ? payload.network.trim() : undefined,
          appState,
          raw: payload,
        });
        const now = Date.now();
        const directive = autoVideoDirectives.get(device.deviceId);
        const canReceiveCaptureDirective = appState?.startsWith("service") === true;
        const captureDirective = canReceiveCaptureDirective && directive && directive.expiresAt > now
          ? {
              type: "video_clip",
              directiveId: directive.directiveId,
              durationMs: directive.durationMs,
              reason: directive.reason,
              sourceEventId: directive.sourceEventId,
              sourceText: directive.sourceText,
              issuedAt: directive.issuedAt,
              expiresAt: directive.expiresAt,
            }
          : null;
        if (directive && directive.expiresAt <= now) {
          autoVideoDirectives.delete(device.deviceId);
        } else if (canReceiveCaptureDirective && captureDirective) {
          autoVideoDirectives.delete(device.deviceId);
        }
        json(res, 200, {
          ok: true,
          heartbeatIntervalSec: cfg.heartbeatIntervalSeconds,
          captureDirective,
        });
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
          modeHint,
        });
        const resolvedQuery = resolveAssistantQueryText({
          queryText: transcribed.queryText,
          modeHint,
          explicitQuery: true,
        });
        api.logger.info(
          `[clawsense] assistant query stt accepted=${Boolean(resolvedQuery.queryText)} provider=${
            transcribed.provider ?? "none"
          } failure=${transcribed.failureReason ?? "none"} rewrite=${resolvedQuery.reason ?? "none"} rawLen=${
            resolvedQuery.rawQueryText.length
          } rawPreview="${resolvedQuery.rawQueryText.slice(0, 32)}"`,
        );
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
        let contextDeviceId: string | undefined = auth.device.deviceId;
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
            contextDeviceId = undefined;
          }
        }
        const audioRecheck = await maybeRecheckAssistantQueryAudio({
          recentContext,
          queryText: resolvedQuery.queryText,
          deviceId: contextDeviceId,
          windowHint,
          modeHint,
          now: capturedAt,
        });
        if (audioRecheck.recentContext) {
          recentContext = audioRecheck.recentContext;
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
            rawQueryText: resolvedQuery.rawQueryText || null,
            queryRewriteReason: resolvedQuery.reason ?? null,
            queryAccepted: Boolean(resolvedQuery.queryText),
            queryDurationMs:
              typeof payload.queryDurationMs === "number" && Number.isFinite(payload.queryDurationMs)
                ? payload.queryDurationMs
                : null,
          },
          audioRecheck: audioRecheck.diagnostics,
        });
        return true;
      }),
    );

    async function maybeRecheckAssistantQueryAudio(params: {
      recentContext: Awaited<ReturnType<typeof buildRecentContextPayload>>["recentContext"];
      queryText: string;
      deviceId?: string;
      windowHint: RecentContextWindowHint;
      modeHint?: AssistantModeHint;
      now: number;
    }): Promise<{
      recentContext?: Awaited<ReturnType<typeof buildRecentContextPayload>>["recentContext"];
      diagnostics: {
        attempted: boolean;
        refreshed: boolean;
        reason: string | null;
        maxWindows: number;
        resultCount: number;
        transcriptCount: number;
        summaryCount: number;
        failureReasons: string[];
      };
    }> {
      const plan = resolveAssistantAudioRecheckPlan({
        queryText: params.queryText,
        recentContext: params.recentContext,
      });
      const baseDiagnostics = {
        attempted: false,
        refreshed: false,
        reason: plan.reason ?? null,
        maxWindows: plan.maxWindows,
        resultCount: 0,
        transcriptCount: 0,
        summaryCount: 0,
        failureReasons: [] as string[],
      };
      if (!plan.shouldRecheck) {
        return { diagnostics: baseDiagnostics };
      }
      try {
        const scope = params.recentContext.overview?.kind === "day" ? "today" : "custom-range";
        const rechecks = await reviewEngine.recheckAudioEvidence({
          scope,
          date: scope === "today" ? params.recentContext.overview?.date : undefined,
          startAt: scope === "custom-range" ? params.recentContext.timeRange.startAt : undefined,
          endAt: scope === "custom-range" ? params.recentContext.timeRange.endAt : undefined,
          deviceId: params.deviceId,
          artifactUrlBase: "/api/clawsense/artifacts",
          question: params.queryText,
          maxWindows: plan.maxWindows,
        });
        const transcriptCount = rechecks.filter((item) => normalizeSemanticText(item.transcript)).length;
        const summaryCount = rechecks.filter((item) => normalizeSemanticText(item.summary)).length;
        const diagnostics = {
          attempted: true,
          refreshed: transcriptCount > 0 || summaryCount > 0,
          reason: plan.reason ?? null,
          maxWindows: plan.maxWindows,
          resultCount: rechecks.length,
          transcriptCount,
          summaryCount,
          failureReasons: Array.from(
            new Set(
              rechecks
                .map((item) => item.analysisFailureReason?.trim())
                .filter((value): value is string => Boolean(value)),
            ),
          ).slice(0, 6),
        };
        if (!diagnostics.refreshed) {
          return { diagnostics };
        }
        const refreshedContextPayload = await buildRecentContextPayload({
          reviewEngine,
          artifactUrlBase: "/api/clawsense/artifacts",
          windowHint: params.windowHint,
          question: params.queryText,
          deviceId: params.deviceId,
          modeHint: params.modeHint,
          timeRangeOverride:
            scope === "custom-range"
              ? {
                  startAt: params.recentContext.timeRange.startAt,
                  endAt: params.recentContext.timeRange.endAt,
                }
              : undefined,
          now: params.now,
        });
        return {
          recentContext: refreshedContextPayload.recentContext,
          diagnostics,
        };
      } catch (error) {
        return {
          diagnostics: {
            ...baseDiagnostics,
            attempted: true,
            reason: plan.reason ?? null,
            failureReasons: [`assistant_audio_recheck_error:${String(error)}`],
          },
        };
      }
    }

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
      createJsonRoute("/api/clawsense/queue/status", async (req, res) => {
        if (req.method !== "GET") {
          methodNotAllowed(res, ["GET"]);
          return true;
        }
        const payload = await buildOperationalStatus();
        json(res, 200, {
          ok: true,
          generatedAt: payload.generatedAt,
          queue: payload.queue,
          ingest24h: payload.ingest24h,
        });
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

        clawsense.command("queue-status").description("查看 ClawSense 采集落库与后台分析队列").action(async () => {
          const payload = await buildOperationalStatus();
          process.stdout.write(
            `${safeJsonStringify({
              ok: true,
              generatedAt: payload.generatedAt,
              queue: payload.queue,
              ingest24h: payload.ingest24h,
            })}\n`,
          );
        });

        clawsense
          .command("analysis-retry")
          .description("扫描 analysis_pending 媒体并补排后台分析")
          .option("--max <count>", "最多补排多少个 artifact", "12")
          .action(async (options?: { max?: string }) => {
            const maxArtifacts = Number.parseInt(options?.max ?? "12", 10);
            const result = await requeuePendingAnalysis(Number.isFinite(maxArtifacts) ? maxArtifacts : 12);
            process.stdout.write(`${safeJsonStringify({ ok: true, ...result })}\n`);
          });

        clawsense.command("doctor").description("输出 ClawSense 运行诊断和下一步建议").action(async () => {
          const payload = await buildOperationalDoctor();
          process.stdout.write(`${safeJsonStringify(payload)}\n`);
        });

        clawsense.command("video-config").description("输出视频 ingest 配置、推荐模式与开启命令").action(async () => {
          process.stdout.write(`${safeJsonStringify({ ok: true, ...buildVideoConfigStatus() })}\n`);
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
          .option("--question <question>", "原始用户问题；传入后会走聊天工具同款日期/时间窗推断和证据排序")
          .option("--focus <focus>", "general | what_happened | watch_for")
          .option("--deviceId <deviceId>", "按设备过滤")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "滚动回看天数（2-30），自动转 custom-range")
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
            const shouldUseResolvedToolContext = Boolean(
              options?.question ||
                options?.focus ||
                options?.deviceId ||
                options?.modality ||
                options?.startAt ||
                options?.endAt ||
                options?.lookbackDays,
            );
            if (shouldUseResolvedToolContext) {
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
                text: resolved.text,
                ...resolved.details,
              } : resolved.details)}\n`);
              return;
            }
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
          .command("history [scopeOrDate]")
          .description("输出人物 / 项目历史记忆，并带出关联长期记忆卡片")
          .option("--question <question>", "原始用户问题，例如：Amy 之前出现过什么？")
          .option("--type <type>", "all | identity | project", "all")
          .option("--focus <focus>", "general | what_happened | watch_for", "what_happened")
          .option("--deviceId <deviceId>", "按设备过滤")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义当前上下文时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义当前上下文时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "当前上下文滚动回看天数（2-30），自动转 custom-range")
          .action(async (
            scopeOrDate?: string,
            options?: {
              question?: string;
              type?: string;
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
            const type = coerceHistoryType(options?.type);
            const details = resolved.details as {
              date: string;
              scope: "today" | "last-hour" | "custom-range";
              startAt?: number;
              endAt?: number;
              question?: string;
              identityHistory?: unknown[];
              projectHistory?: unknown[];
              responseHints?: {
                historyFollowUps?: unknown;
                evidenceFollowUpTargets?: unknown;
                identityHistory?: unknown[];
                projectHistory?: unknown[];
              };
              evidenceBundle?: {
                identityHistory?: unknown[];
                projectHistory?: unknown[];
              };
            };
            const identityHistory = type === "project"
              ? []
              : Array.isArray(details.responseHints?.identityHistory)
                ? details.responseHints.identityHistory
                : Array.isArray(details.evidenceBundle?.identityHistory)
                  ? details.evidenceBundle.identityHistory
                  : Array.isArray(details.identityHistory)
                    ? details.identityHistory
                    : [];
            const projectHistory = type === "identity"
              ? []
              : Array.isArray(details.responseHints?.projectHistory)
                ? details.responseHints.projectHistory
                : Array.isArray(details.evidenceBundle?.projectHistory)
                  ? details.evidenceBundle.projectHistory
                  : Array.isArray(details.projectHistory)
                    ? details.projectHistory
                    : [];
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                source: "refreshed-context",
                scope: details.scope,
                date: details.date,
                startAt: details.startAt ?? null,
                endAt: details.endAt ?? null,
                question: options?.question ?? details.question ?? null,
                type,
                summary: summarizeHistoryCliPayload(identityHistory, projectHistory),
                historyFollowUps: details.responseHints?.historyFollowUps ?? [],
                evidenceFollowUpTargets: details.responseHints?.evidenceFollowUpTargets ?? [],
                identityHistory,
                projectHistory,
              })}\n`,
            );
          });

        clawsense
          .command("refresh-semantics [date]")
          .description("重算历史事件的 projectRefs/tags 语义索引；默认 dry-run，使用 --apply 写回")
          .option("--apply", "写回 state，并清理受影响日期的 review/consolidation 缓存")
          .option("--max-samples <count>", "最多输出多少条变化样例", "12")
          .action(async (date?: string, options?: { apply?: boolean; maxSamples?: string }) => {
            const normalizedDate = date?.trim()
              ? date.trim() === "today"
                ? reviewEngine.normalizeDateInput(undefined)
                : reviewEngine.normalizeDateInput(date.trim())
              : undefined;
            const maxSamples = Number.parseInt(options?.maxSamples ?? "12", 10);
            const result = await stateStore.refreshEventSemanticSignals({
              date: normalizedDate,
              apply: Boolean(options?.apply),
              maxSamples: Number.isFinite(maxSamples) ? maxSamples : 12,
            });
            process.stdout.write(`${safeJsonStringify(result)}\n`);
          });

        clawsense
          .command("digests [scopeOrDate]")
          .description("输出持久化长对话 rolling digest 索引，便于验证长会议/跨小时追问")
          .option("--question <question>", "原始用户问题；默认先按聊天工具同款逻辑刷新并定位 digest")
          .option("--focus <focus>", "general | what_happened | watch_for", "what_happened")
          .option("--deviceId <deviceId>", "按设备过滤")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "滚动回看天数（2-30），自动转 custom-range")
          .option("--storedOnly", "只读取已写入 state 的 digest，不先刷新生成")
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
              storedOnly?: boolean;
            },
          ) => {
            const explicitStartAt = parseOptionalFiniteNumber(options?.startAt);
            const explicitEndAt = parseOptionalFiniteNumber(options?.endAt);
            const lookbackDays = parseOptionalFiniteNumber(options?.lookbackDays);
            if (!options?.storedOnly) {
              const rawParams: ClawSenseContextToolParams = {
                focus: coerceContextFocus(options?.focus),
                question: options?.question,
                deviceId: options?.deviceId,
                modality: coerceModality(options?.modality),
                startAt: explicitStartAt,
                endAt: explicitEndAt,
                lookbackDays,
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
                startAt?: number;
                endAt?: number;
                rollingDigests?: unknown;
                responseHints?: {
                  rollingDigests?: unknown;
                };
                evidenceBundle?: {
                  rollingDigests?: unknown;
                };
              };
              const digests = Array.isArray(details.responseHints?.rollingDigests)
                ? details.responseHints.rollingDigests
                : Array.isArray(details.evidenceBundle?.rollingDigests)
                  ? details.evidenceBundle.rollingDigests
                  : Array.isArray(details.rollingDigests)
                    ? details.rollingDigests
                    : [];
              process.stdout.write(
                `${safeJsonStringify({
                  ok: true,
                  source: "refreshed-context",
                  scope: details.scope,
                  date: details.date,
                  startAt: details.startAt ?? null,
                  endAt: details.endAt ?? null,
                  question: options?.question,
                  count: digests.length,
                  summary: summarizeConversationDigests(digests),
                  digests,
                })}\n`,
              );
              return;
            }

            const now = Date.now();
            const endAt = explicitEndAt ?? now;
            const startAt = explicitStartAt ?? (lookbackDays ? endAt - lookbackDays * ONE_DAY_MS : undefined);
            const scope =
              scopeOrDate === "last-hour" || scopeOrDate === "custom-range" || scopeOrDate === "today"
                ? scopeOrDate
                : undefined;
            const date =
              scopeOrDate && scopeOrDate !== "last-hour" && scopeOrDate !== "custom-range"
                ? reviewEngine.normalizeDateInput(scopeOrDate === "today" ? undefined : scopeOrDate)
                : undefined;
            const digests = await stateStore.listConversationDigests({
              date,
              scope,
              startAt,
              endAt,
            });
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                source: "stored-state",
                scope: scope ?? null,
                date: date ?? null,
                startAt: startAt ?? null,
                endAt,
                count: digests.length,
                summary: summarizeConversationDigests(digests),
                digests,
              })}\n`,
            );
          });

        clawsense
          .command("memory-cards [scopeOrDate]")
          .description("输出长期记忆卡片（任务/话题/注意/学习），用于验证全天记忆沉淀层")
          .option("--question <question>", "原始用户问题；默认先刷新 context 并按问题匹配卡片")
          .option("--focus <focus>", "general | what_happened | watch_for", "what_happened")
          .option("--kind <kind>", "task | topic | attention | learning")
          .option("--format <format>", "json | markdown", "json")
          .option("--title <title>", "markdown / 草稿标题")
          .option("--includeMarkdown", "JSON 输出里同时包含 markdown 报告")
          .option("--writeDraft", "把记忆卡片报告写入 ClawSense drafts 目录")
          .option("--deviceId <deviceId>", "按设备过滤")
          .option("--modality <modality>", "audio | image | video")
          .option("--startAt <ms>", "自定义时间窗起点（毫秒）")
          .option("--endAt <ms>", "自定义时间窗终点（毫秒）")
          .option("--lookbackDays <days>", "滚动回看天数（2-30），自动转 custom-range")
          .option("--storedOnly", "只读取已写入 state 的卡片，不先刷新生成")
          .action(async (
            scopeOrDate?: string,
            options?: {
              question?: string;
              focus?: string;
              kind?: string;
              format?: string;
              title?: string;
              includeMarkdown?: boolean;
              writeDraft?: boolean;
              deviceId?: string;
              modality?: string;
              startAt?: string;
              endAt?: string;
              lookbackDays?: string;
              storedOnly?: boolean;
            },
          ) => {
            const explicitStartAt = parseOptionalFiniteNumber(options?.startAt);
            const explicitEndAt = parseOptionalFiniteNumber(options?.endAt);
            const lookbackDays = parseOptionalFiniteNumber(options?.lookbackDays);
            const kind = coerceMemoryCardKind(options?.kind);
            const format = coerceMemoryCardsOutputFormat(options?.format);
            if (!options?.storedOnly) {
              const rawParams: ClawSenseContextToolParams = {
                focus: coerceContextFocus(options?.focus),
                question: options?.question,
                deviceId: options?.deviceId,
                modality: coerceModality(options?.modality),
                startAt: explicitStartAt,
                endAt: explicitEndAt,
                lookbackDays,
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
                startAt?: number;
                endAt?: number;
                memoryCards?: unknown;
                memoryCardMatches?: unknown;
                responseHints?: {
                  memoryCards?: unknown;
                  memoryCardMatches?: unknown;
                };
                evidenceBundle?: {
                  memoryCards?: unknown;
                  memoryCardMatches?: unknown;
                };
              };
              const cards = normalizeMemoryCardsForCli(
                Array.isArray(details.responseHints?.memoryCards)
                  ? details.responseHints.memoryCards
                  : Array.isArray(details.evidenceBundle?.memoryCards)
                    ? details.evidenceBundle.memoryCards
                    : Array.isArray(details.memoryCards)
                      ? details.memoryCards
                      : [],
                kind,
              );
              const matches = normalizeMemoryCardsForCli(
                Array.isArray(details.responseHints?.memoryCardMatches)
                  ? details.responseHints.memoryCardMatches
                  : Array.isArray(details.evidenceBundle?.memoryCardMatches)
                    ? details.evidenceBundle.memoryCardMatches
                    : Array.isArray(details.memoryCardMatches)
                      ? details.memoryCardMatches
                      : [],
                kind,
              );
              const markdown = buildMemoryCardsMarkdownReport({
                title: options?.title,
                source: "refreshed-context",
                scope: details.scope,
                date: details.date,
                startAt: details.startAt,
                endAt: details.endAt,
                question: options?.question,
                kind,
                cards,
                matches,
                generatedAt: Date.now(),
              });
              const draft = options?.writeDraft
                ? await writeMemoryCardsMarkdownDraft({
                    stateDir: api.runtime.state.resolveStateDir(),
                    title: markdown.title,
                    markdown: markdown.markdown,
                    createdAt: markdown.generatedAt,
                  })
                : null;
              if (format === "markdown") {
                process.stdout.write(`${appendDraftPathToMarkdown(markdown.markdown, draft)}\n`);
                return;
              }
              process.stdout.write(
                `${safeJsonStringify({
                  ok: true,
                  source: "refreshed-context",
                  scope: details.scope,
                  date: details.date,
                  startAt: details.startAt ?? null,
                  endAt: details.endAt ?? null,
                  question: options?.question,
                  kind: kind ?? null,
                  count: cards.length,
                  matchCount: matches.length,
                  summary: summarizeMemoryCards(cards),
                  markdown: options?.includeMarkdown ? markdown.markdown : undefined,
                  draft,
                  matches,
                  cards,
                })}\n`,
              );
              return;
            }

            const now = Date.now();
            const endAt = explicitEndAt ?? now;
            const startAt = explicitStartAt ?? (lookbackDays ? endAt - lookbackDays * ONE_DAY_MS : undefined);
            const scope =
              scopeOrDate === "last-hour" || scopeOrDate === "custom-range" || scopeOrDate === "today"
                ? scopeOrDate
                : undefined;
            const date =
              scopeOrDate && scopeOrDate !== "last-hour" && scopeOrDate !== "custom-range"
                ? reviewEngine.normalizeDateInput(scopeOrDate === "today" ? undefined : scopeOrDate)
                : undefined;
            const cards = await stateStore.listMemoryCards({
              date,
              scope,
              startAt,
              endAt,
              kind,
            });
            const markdown = buildMemoryCardsMarkdownReport({
              title: options?.title,
              source: "stored-state",
              scope,
              date,
              startAt,
              endAt,
              kind,
              cards,
              matches: [],
              generatedAt: Date.now(),
            });
            const draft = options?.writeDraft
              ? await writeMemoryCardsMarkdownDraft({
                  stateDir: api.runtime.state.resolveStateDir(),
                  title: markdown.title,
                  markdown: markdown.markdown,
                  createdAt: markdown.generatedAt,
                })
              : null;
            if (format === "markdown") {
              process.stdout.write(`${appendDraftPathToMarkdown(markdown.markdown, draft)}\n`);
              return;
            }
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                source: "stored-state",
                scope: scope ?? null,
                date: date ?? null,
                startAt: startAt ?? null,
                endAt,
                kind: kind ?? null,
                count: cards.length,
                summary: summarizeMemoryCards(cards),
                markdown: options?.includeMarkdown ? markdown.markdown : undefined,
                draft,
                cards,
              })}\n`,
            );
          });

        clawsense
          .command("speaker-slots [scopeOrDate]")
          .description("输出 speaker 待标注槽位、任务归属缺口和可复制标注命令")
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
                speakerResolutionPrompts?: unknown;
                taskAttribution?: unknown;
                taskAttributionBuckets?: unknown;
              };
              evidenceBundle?: {
                speakerLayer?: unknown;
                taskAttribution?: unknown;
                annotationSuggestions?: unknown;
              };
            };
            const suggestions = normalizeCliAnnotationSuggestions(details.evidenceBundle?.annotationSuggestions);
            const speakerAnnotations = await stateStore.listSpeakers();
            const payload = buildSpeakerSlotsPayload({
              date: details.date,
              scope: details.scope,
              question: options?.question,
              speakerLayer: details.evidenceBundle?.speakerLayer,
              taskAttribution: details.evidenceBundle?.taskAttribution ?? details.responseHints?.taskAttribution,
              taskAttributionBuckets: details.responseHints?.taskAttributionBuckets,
              speakerResolutionPrompts: details.responseHints?.speakerResolutionPrompts,
              speakerSuggestions: suggestions.speakers,
              speakerAnnotations,
            });
            process.stdout.write(`${safeJsonStringify(payload)}\n`);
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
          .command("asr-status")
          .description("输出本地 ASR 配置与可运行性诊断")
          .action(async () => {
            const inspection = await inspectLocalAsrConfig({
              cfg,
              resolveStateDir: api.runtime.state.resolveStateDir,
            });
            process.stdout.write(`${safeJsonStringify({ ok: true, localAsr: inspection })}\n`);
          });

        clawsense
          .command("audio-diagnostics [date]")
          .description("输出某天音频/ASR/diarization 健康度和下一步回填建议（只读）")
          .option("--max-samples <count>", "最多输出多少个候选样例", "6")
          .action(async (date?: string, options?: { maxSamples?: string }) => {
            const normalizedDate = reviewEngine.normalizeDateInput(date === "today" ? undefined : date);
            const maxSamplesRaw = Number.parseInt(options?.maxSamples ?? "6", 10);
            const [events, artifacts, localAsr, worker] = await Promise.all([
              stateStore.listEventsByDate(normalizedDate),
              stateStore.listArtifacts(),
              inspectLocalAsrConfig({
                cfg,
                resolveStateDir: api.runtime.state.resolveStateDir,
              }),
              reviewEngine.getAudioBackfillWorkerStatus(),
            ]);
            const payload = buildAudioDiagnosticsPayload({
              date: normalizedDate,
              events,
              artifacts,
              localAsr,
              worker,
              maxSamples: Number.isFinite(maxSamplesRaw) ? maxSamplesRaw : 6,
            });
            process.stdout.write(`${safeJsonStringify(payload)}\n`);
          });

        clawsense
          .command("backfill-audio [date]")
          .description("对某一天的降级音频做一轮轻量 transcript backfill")
          .option("--max <count>", "最多处理多少段音频", "3")
          .option("--provider <provider>", "ASR provider: auto/local-asr/compatible-asr", "auto")
          .option("--diarization-provider <provider>", "可选 speaker diarization provider: whisperx/pyannote/funasr/hybrid/local-asr")
          .option("--speaker-model <model>", "可选 speaker 模型，例如 pyannote/speaker-diarization 或 cam++")
          .option("--dry-run", "只运行 ASR 诊断并输出结果，不写回状态")
          .option("--include-transcribed", "允许处理已有 transcript 但缺 transcriptSegments 的音频")
          .action(async (
            date?: string,
            options?: {
              max?: string;
              provider?: string;
              diarizationProvider?: string;
              speakerModel?: string;
              dryRun?: boolean;
              includeTranscribed?: boolean;
            },
          ) => {
            const normalizedDate = date ? reviewEngine.normalizeDateInput(date) : reviewEngine.normalizeDateInput(undefined);
            const maxArtifacts = Number.parseInt(options?.max ?? "3", 10);
            const provider = normalizeAudioBackfillProvider(options?.provider);
            const result = await reviewEngine.runAudioBackfillTick({
              dates: [normalizedDate],
              maxArtifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : 3,
              provider,
              diarizationProvider: options?.diarizationProvider,
              speakerModel: options?.speakerModel,
              dryRun: Boolean(options?.dryRun),
              includeTranscribed: Boolean(options?.includeTranscribed),
            });
            process.stdout.write(
              `${safeJsonStringify({
                ok: true,
                date: normalizedDate,
                ...result,
              })}\n`,
            );
          });

        const asrQueue = clawsense
          .command("asr-queue")
          .description("管理本地 ASR 回填队列（plan/run/status）");

        asrQueue
          .command("plan [date]")
          .description("把某一天待补强音频规划为可恢复的 ASR 队列")
          .option("--max <count>", "最多规划多少段音频", "24")
          .option("--provider <provider>", "ASR provider: auto/local-asr/compatible-asr", "local-asr")
          .option("--diarization-provider <provider>", "可选 speaker diarization provider: whisperx/pyannote/funasr/hybrid/local-asr")
          .option("--speaker-model <model>", "可选 speaker 模型，例如 pyannote/speaker-diarization 或 cam++")
          .option("--dry-run", "队列运行时只做 ASR 诊断，不写回状态")
          .option("--include-transcribed", "允许处理已有 transcript 但缺 transcriptSegments 的音频", true)
          .action(async (
            date?: string,
            options?: {
              max?: string;
              provider?: string;
              diarizationProvider?: string;
              speakerModel?: string;
              dryRun?: boolean;
              includeTranscribed?: boolean;
            },
          ) => {
            const normalizedDate = date ? reviewEngine.normalizeDateInput(date) : reviewEngine.normalizeDateInput(undefined);
            const maxArtifacts = Number.parseInt(options?.max ?? "24", 10);
            const provider = normalizeAudioBackfillProvider(options?.provider ?? "local-asr");
            const queue = await reviewEngine.planAudioBackfillQueue({
              dates: [normalizedDate],
              maxArtifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : 24,
              provider,
              diarizationProvider: options?.diarizationProvider,
              speakerModel: options?.speakerModel,
              dryRun: Boolean(options?.dryRun),
              includeTranscribed: options?.includeTranscribed !== false,
            });
            process.stdout.write(`${safeJsonStringify({ ok: true, queue })}\n`);
          });

        asrQueue
          .command("run [queueId]")
          .description("运行一批 ASR 队列任务")
          .option("--batch <count>", "本次最多运行多少个队列任务", "6")
          .option("--dry-run", "只做 ASR 诊断，不写回状态")
          .action(async (
            queueId?: string,
            options?: {
              batch?: string;
              dryRun?: boolean;
            },
          ) => {
            const batchSize = Number.parseInt(options?.batch ?? "6", 10);
            const result = await reviewEngine.runAudioBackfillQueue({
              queueId,
              batchSize: Number.isFinite(batchSize) ? batchSize : 6,
              dryRun: options?.dryRun,
            });
            process.stdout.write(`${safeJsonStringify({ ok: Boolean(result), result })}\n`);
          });

        asrQueue
          .command("status [queueId]")
          .description("输出 ASR 队列状态")
          .action(async (queueId?: string) => {
            const queue = await reviewEngine.getAudioBackfillQueueStatus(queueId);
            process.stdout.write(`${safeJsonStringify({ ok: Boolean(queue), queue })}\n`);
          });

        const asrWorker = clawsense
          .command("asr-worker")
          .description("运行/查看 ASR 后台 worker（自动规划队列并按批次补强音频）");

        asrWorker
          .command("status")
          .description("输出 ASR worker 与最近队列状态")
          .action(async () => {
            const status = await reviewEngine.getAudioBackfillWorkerStatus();
            process.stdout.write(`${safeJsonStringify({ ok: true, worker: status })}\n`);
          });

        asrWorker
          .command("run-once [date]")
          .description("手动运行一次 ASR worker tick")
          .option("--lookback-days <days>", "未指定 date 时向前规划多少天", String(cfg.asrWorkerLookbackDays))
          .option("--max <count>", "没有活动队列时最多规划多少个 job", String(cfg.asrWorkerMaxJobs))
          .option("--batch <count>", "本次最多运行多少个 job", String(cfg.asrWorkerBatchSize))
          .option("--provider <provider>", "ASR provider: auto/local-asr/compatible-asr", cfg.asrWorkerProvider)
          .option("--diarization-provider <provider>", "可选 speaker diarization provider: whisperx/pyannote/funasr/hybrid/local-asr")
          .option("--speaker-model <model>", "可选 speaker 模型，例如 pyannote/speaker-diarization 或 cam++")
          .option("--dry-run", "只运行 ASR 诊断，不写回事件")
          .option("--include-transcribed", "允许补强已有 transcript 但缺 transcriptSegments 的音频", cfg.asrWorkerIncludeTranscribed)
          .action(async (
            date?: string,
            options?: {
              lookbackDays?: string;
              max?: string;
              batch?: string;
              provider?: string;
              diarizationProvider?: string;
              speakerModel?: string;
              dryRun?: boolean;
              includeTranscribed?: boolean;
            },
          ) => {
            const lookbackDays = Number.parseInt(options?.lookbackDays ?? String(cfg.asrWorkerLookbackDays), 10);
            const maxJobs = Number.parseInt(options?.max ?? String(cfg.asrWorkerMaxJobs), 10);
            const batchSize = Number.parseInt(options?.batch ?? String(cfg.asrWorkerBatchSize), 10);
            const provider = normalizeAudioBackfillProvider(options?.provider ?? cfg.asrWorkerProvider);
            const result = await reviewEngine.runAudioBackfillWorkerTick({
              dates: date ? [reviewEngine.normalizeDateInput(date)] : undefined,
              lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : cfg.asrWorkerLookbackDays,
              maxJobs: Number.isFinite(maxJobs) ? maxJobs : cfg.asrWorkerMaxJobs,
              batchSize: Number.isFinite(batchSize) ? batchSize : cfg.asrWorkerBatchSize,
              provider,
              diarizationProvider: options?.diarizationProvider,
              speakerModel: options?.speakerModel,
              dryRun: Boolean(options?.dryRun),
              includeTranscribed: options?.includeTranscribed !== false,
            });
            process.stdout.write(`${safeJsonStringify({ ok: true, worker: result })}\n`);
          });

        clawsense
          .command("diarization-probe [date]")
          .description("用本地 ASR 的 speaker 模型做只读说话人分离探针")
          .option("--max <count>", "最多探测多少段音频", "3")
          .option("--provider <provider>", "diarization provider: funasr/whisperx/pyannote/hybrid/local-asr", "funasr")
          .option("--speaker-model <model>", "FunASR speaker model，例如 cam++", "cam++")
          .action(async (
            date?: string,
            options?: {
              max?: string;
              provider?: string;
              speakerModel?: string;
            },
          ) => {
            const normalizedDate = date ? reviewEngine.normalizeDateInput(date) : reviewEngine.normalizeDateInput(undefined);
            const maxArtifacts = Number.parseInt(options?.max ?? "3", 10);
            const result = await reviewEngine.runDiarizationProbe({
              dates: [normalizedDate],
              maxArtifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : 3,
              provider: options?.provider,
              speakerModel: options?.speakerModel,
            });
            process.stdout.write(`${safeJsonStringify({ ok: true, date: normalizedDate, ...result })}\n`);
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
        await requeuePendingAnalysis(12);
        maintenanceTimer = setInterval(() => {
          void reviewEngine.runMaintenanceTick().catch((error) => {
            api.logger.warn(`[clawsense] maintenance tick failed: ${String(error)}`);
          });
        }, 5 * 60 * 1000);
        if (cfg.asrWorkerEnabled) {
          void runAsrWorkerSafely("startup");
          asrWorkerTimer = setInterval(() => {
            void runAsrWorkerSafely("interval");
          }, cfg.asrWorkerIntervalSeconds * 1000);
        }
        analysisRecoveryTimer = setInterval(() => {
          void requeuePendingAnalysis(12).catch((error) => {
            api.logger.warn(`[clawsense] pending analysis recovery tick failed: ${String(error)}`);
          });
        }, 60 * 1000);
        api.logger.info("[clawsense] service started");
      },
      stop: async () => {
        if (maintenanceTimer) {
          clearInterval(maintenanceTimer);
          maintenanceTimer = null;
        }
        if (analysisRecoveryTimer) {
          clearInterval(analysisRecoveryTimer);
          analysisRecoveryTimer = null;
        }
        if (asrWorkerTimer) {
          clearInterval(asrWorkerTimer);
          asrWorkerTimer = null;
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

function coerceHistoryType(value: string | undefined): "all" | "identity" | "project" {
  if (value === "identity" || value === "person" || value === "speaker") {
    return "identity";
  }
  if (value === "project" || value === "topic") {
    return "project";
  }
  return "all";
}

function coerceMemoryCardKind(value: string | undefined): ClawSenseMemoryCard["kind"] | undefined {
  if (value === "task" || value === "topic" || value === "attention" || value === "learning") {
    return value;
  }
  return undefined;
}

function coerceMemoryCardsOutputFormat(value: string | undefined): "json" | "markdown" {
  return value === "markdown" ? "markdown" : "json";
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
  topicFollowUps: string[];
  topicFollowUpTargets: unknown[];
  historyFollowUps: string[];
  conversationDigest?: unknown;
  conversationDigestFollowUps: string[];
  conversationDigestFollowUpTargets: unknown[];
  evidenceFollowUpTargets: unknown[];
  topPrompts: string[];
} {
  const responseHints = (details.responseHints && typeof details.responseHints === "object")
    ? details.responseHints as {
      audioFollowUps?: unknown;
      audioFollowUpTargets?: unknown;
      videoFollowUps?: unknown;
      videoFollowUpTargets?: unknown;
      topicFollowUps?: unknown;
      topicFollowUpTargets?: unknown;
      historyFollowUps?: unknown;
      conversationDigest?: unknown;
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
  const topicFollowUps = Array.isArray(responseHints.topicFollowUps)
    ? responseHints.topicFollowUps.filter((item): item is string => typeof item === "string")
    : [];
  const topicFollowUpTargets = Array.isArray(responseHints.topicFollowUpTargets)
    ? responseHints.topicFollowUpTargets
    : [];
  const historyFollowUps = Array.isArray(responseHints.historyFollowUps)
    ? responseHints.historyFollowUps.filter((item): item is string => typeof item === "string")
    : [];
  const conversationDigest = responseHints.conversationDigest;
  const conversationDigestObject =
    conversationDigest && typeof conversationDigest === "object"
      ? conversationDigest as {
        followupPrompts?: unknown;
        topicIndex?: unknown;
      }
      : undefined;
  const conversationDigestFollowUps = Array.isArray(conversationDigestObject?.followupPrompts)
    ? conversationDigestObject.followupPrompts.filter((item): item is string => typeof item === "string")
    : [];
  const conversationDigestFollowUpTargets = Array.isArray(conversationDigestObject?.topicIndex)
    ? conversationDigestObject.topicIndex
        .slice(0, 6)
        .map((item, index) => normalizeConversationDigestFollowUpTarget(item, conversationDigestFollowUps[index], index))
        .filter((item): item is NonNullable<ReturnType<typeof normalizeConversationDigestFollowUpTarget>> => Boolean(item))
    : [];
  const evidenceFollowUpTargets = Array.isArray(responseHints.evidenceFollowUpTargets)
    ? responseHints.evidenceFollowUpTargets
    : [];
  const topPrompts = dedupeStrings(
    evidenceFollowUpTargets
      .map((item) => (item && typeof item === "object" && "prompt" in item ? (item as { prompt?: unknown }).prompt : undefined))
      .filter((prompt): prompt is string => typeof prompt === "string" && prompt.trim().length > 0)
      .concat(conversationDigestFollowUps),
  ).slice(0, 5);
  return {
    scope: details.scope,
    date: details.date,
    question: details.question ?? fallbackQuestion,
    audioFollowUps,
    audioFollowUpTargets,
    videoFollowUps,
    videoFollowUpTargets,
    topicFollowUps,
    topicFollowUpTargets,
    historyFollowUps,
    conversationDigest,
    conversationDigestFollowUps,
    conversationDigestFollowUpTargets,
    evidenceFollowUpTargets,
    topPrompts,
  };
}

function summarizeConversationDigests(digests: unknown[]): {
  digestCount: number;
  topicCount: number;
  transcriptWindowCount: number;
  keywordCount: number;
  taskHintCount: number;
  firstTopicTitle?: string;
} {
  let topicCount = 0;
  let transcriptWindowCount = 0;
  let keywordCount = 0;
  let taskHintCount = 0;
  let firstTopicTitle: string | undefined;
  for (const item of digests) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const digest = item as {
      transcriptWindowCount?: unknown;
      topicIndex?: unknown;
      keywordIndex?: unknown;
    };
    if (typeof digest.transcriptWindowCount === "number" && Number.isFinite(digest.transcriptWindowCount)) {
      transcriptWindowCount += digest.transcriptWindowCount;
    }
    const topicIndex = Array.isArray(digest.topicIndex) ? digest.topicIndex : [];
    topicCount += topicIndex.length;
    for (const topic of topicIndex) {
      if (!firstTopicTitle && topic && typeof topic === "object") {
        const title = (topic as { title?: unknown }).title;
        if (typeof title === "string" && title.trim()) {
          firstTopicTitle = title;
        }
      }
      const taskHints = topic && typeof topic === "object" ? (topic as { taskHints?: unknown }).taskHints : undefined;
      if (Array.isArray(taskHints)) {
        taskHintCount += taskHints.length;
      }
    }
    const keywordIndex = Array.isArray(digest.keywordIndex) ? digest.keywordIndex : [];
    keywordCount += keywordIndex.length;
  }
  return {
    digestCount: digests.length,
    topicCount,
    transcriptWindowCount,
    keywordCount,
    taskHintCount,
    firstTopicTitle,
  };
}

function summarizeHistoryCliPayload(
  identityHistory: unknown[],
  projectHistory: unknown[],
): {
  identityCount: number;
  projectCount: number;
  identityMemoryCardCount: number;
  projectMemoryCardCount: number;
  recentMomentCount: number;
} {
  const identityMemoryCardCount = countNestedArrayItems(identityHistory, "memoryCards");
  const projectMemoryCardCount = countNestedArrayItems(projectHistory, "memoryCards");
  return {
    identityCount: identityHistory.length,
    projectCount: projectHistory.length,
    identityMemoryCardCount,
    projectMemoryCardCount,
    recentMomentCount:
      countNestedArrayItems(identityHistory, "recentMoments") +
      countNestedArrayItems(projectHistory, "recentMoments"),
  };
}

function countNestedArrayItems(items: unknown[], key: string): number {
  return items.reduce<number>((count, item) => {
    if (!item || typeof item !== "object") {
      return count;
    }
    const value = (item as Record<string, unknown>)[key];
    return count + (Array.isArray(value) ? value.length : 0);
  }, 0);
}

function normalizeMemoryCardsForCli(cards: unknown[], kind?: ClawSenseMemoryCard["kind"]): ClawSenseMemoryCard[] {
  return cards
    .filter((item): item is ClawSenseMemoryCard => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const card = item as { cardId?: unknown; kind?: unknown; title?: unknown };
      return typeof card.cardId === "string" && typeof card.kind === "string" && typeof card.title === "string";
    })
    .filter((card) => !kind || card.kind === kind);
}

function summarizeMemoryCards(cards: unknown[]): {
  cardCount: number;
  taskCount: number;
  topicCount: number;
  attentionCount: number;
  learningCount: number;
  keywordCount: number;
  firstCardTitle?: string;
} {
  let taskCount = 0;
  let topicCount = 0;
  let attentionCount = 0;
  let learningCount = 0;
  let keywordCount = 0;
  let firstCardTitle: string | undefined;
  for (const item of cards) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const card = item as {
      kind?: unknown;
      title?: unknown;
      keywords?: unknown;
    };
    if (!firstCardTitle && typeof card.title === "string" && card.title.trim()) {
      firstCardTitle = card.title;
    }
    if (card.kind === "task") {
      taskCount += 1;
    } else if (card.kind === "topic") {
      topicCount += 1;
    } else if (card.kind === "attention") {
      attentionCount += 1;
    } else if (card.kind === "learning") {
      learningCount += 1;
    }
    if (Array.isArray(card.keywords)) {
      keywordCount += card.keywords.length;
    }
  }
  return {
    cardCount: cards.length,
    taskCount,
    topicCount,
    attentionCount,
    learningCount,
    keywordCount,
    firstCardTitle,
  };
}

function buildMemoryCardsMarkdownReport(params: {
  title?: string;
  source: "refreshed-context" | "stored-state";
  scope?: "today" | "last-hour" | "custom-range";
  date?: string;
  startAt?: number | null;
  endAt?: number | null;
  question?: string;
  kind?: ClawSenseMemoryCard["kind"];
  cards: ClawSenseMemoryCard[];
  matches: ClawSenseMemoryCard[];
  generatedAt: number;
}): {
  title: string;
  markdown: string;
  generatedAt: number;
} {
  const summary = summarizeMemoryCards(params.cards);
  const title = normalizeMarkdownTitle(
    params.title ||
      [
        "ClawSense 长期记忆卡片报告",
        params.date ? `(${params.date})` : "",
        params.kind ? `-${formatMemoryCardKindForCli(params.kind)}` : "",
      ].filter(Boolean).join(" "),
  );
  const range = formatMemoryCardsReportRange(params.startAt, params.endAt);
  const matchedIds = new Set(params.matches.map((card) => card.cardId));
  const unmatchedCards = params.cards.filter((card) => !matchedIds.has(card.cardId));
  const taskCards = params.cards.filter((card) => card.kind === "task");
  const attentionCards = params.cards.filter((card) => card.kind === "attention");
  const learningCards = params.cards.filter((card) => card.kind === "learning");
  const topicCards = params.cards.filter((card) => card.kind === "topic");
  const lines = [
    `# ${title}`,
    "",
    `- 生成时间：${new Date(params.generatedAt).toISOString()}`,
    `- 来源：${params.source}`,
    params.date ? `- 日期：${params.date}` : "",
    params.scope ? `- 范围：${params.scope}` : "",
    range ? `- 时间窗：${range}` : "",
    params.question ? `- 问题：${memoryCardMarkdownText(params.question)}` : "",
    params.kind ? `- 类型过滤：${formatMemoryCardKindForCli(params.kind)}` : "",
    "",
    "## 总览",
    "",
    `- 卡片总数：${summary.cardCount}`,
    `- 任务：${summary.taskCount}`,
    `- 话题：${summary.topicCount}`,
    `- 注意事项：${summary.attentionCount}`,
    `- 学习点：${summary.learningCount}`,
    `- 问题匹配卡片：${params.matches.length}`,
    "",
    ...buildMemoryCardMarkdownSection("## 与当前问题最相关", params.matches),
    ...buildMemoryCardMarkdownSection("## 行动项 / 待跟进", taskCards),
    ...buildMemoryCardMarkdownSection("## 值得注意", attentionCards),
    ...buildMemoryCardMarkdownSection("## 学习点", learningCards),
    ...buildMemoryCardMarkdownSection("## 话题索引", topicCards),
    unmatchedCards.length > 0 && params.matches.length > 0 ? "## 其他卡片" : "",
    unmatchedCards.length > 0 && params.matches.length > 0 ? "" : "",
    ...(params.matches.length > 0 ? buildMemoryCardMarkdownItems(unmatchedCards.slice(0, 12)) : []),
    params.cards.length === 0 ? "## 暂无卡片" : "",
    params.cards.length === 0 ? "" : "",
    params.cards.length === 0 ? "- 当前时间范围还没有可沉淀的长期记忆卡片。" : "",
    "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
  return {
    title,
    markdown: lines.join("\n").trimEnd() + "\n",
    generatedAt: params.generatedAt,
  };
}

function buildMemoryCardMarkdownSection(title: string, cards: ClawSenseMemoryCard[]): string[] {
  if (cards.length === 0) {
    return [];
  }
  return [title, "", ...buildMemoryCardMarkdownItems(cards), ""];
}

function buildMemoryCardMarkdownItems(cards: ClawSenseMemoryCard[]): string[] {
  return cards.flatMap((card) => {
    const metadata = [
      formatMemoryCardKindForCli(card.kind),
      card.confidence ? `置信度：${card.confidence}` : "",
      card.status ? `状态：${card.status}` : "",
    ].filter(Boolean).join(" / ");
    const lines = [
      `- **${memoryCardMarkdownText(card.title)}**${metadata ? ` (${metadata})` : ""}`,
      `  - 摘要：${memoryCardMarkdownText(card.summary)}`,
    ];
    const retrieval = formatMemoryCardRetrievalMetadata(card);
    if (retrieval) {
      lines.push(`  - 检索排序：${retrieval}`);
    }
    if (card.keywords.length > 0) {
      lines.push(`  - 关键词：${card.keywords.slice(0, 8).map(memoryCardMarkdownText).join("、")}`);
    }
    const evidence = formatMemoryCardEvidence(card);
    if (evidence.length > 0) {
      lines.push(...evidence.map((item) => `  - ${item}`));
    }
    return lines;
  });
}

function formatMemoryCardRetrievalMetadata(card: ClawSenseMemoryCard): string {
  const match = card as ClawSenseMemoryCard & {
    matchedTerms?: unknown;
    matchReasons?: unknown;
    retrievalRank?: unknown;
    score?: unknown;
  };
  const parts: string[] = [];
  if (typeof match.retrievalRank === "number" && Number.isFinite(match.retrievalRank)) {
    parts.push(`#${match.retrievalRank}`);
  }
  if (typeof match.score === "number" && Number.isFinite(match.score)) {
    parts.push(`score=${match.score}`);
  }
  if (Array.isArray(match.matchedTerms) && match.matchedTerms.length > 0) {
    parts.push(`命中：${match.matchedTerms.filter((term): term is string => typeof term === "string").join("、")}`);
  }
  if (Array.isArray(match.matchReasons) && match.matchReasons.length > 0) {
    parts.push(`理由：${match.matchReasons.filter((reason): reason is string => typeof reason === "string").join("、")}`);
  }
  return parts.join("；");
}

function formatMemoryCardEvidence(card: ClawSenseMemoryCard): string[] {
  const evidence = card.evidence;
  const lines: string[] = [];
  if (evidence.timeRanges.length > 0) {
    lines.push(`证据时间：${evidence.timeRanges.map(memoryCardMarkdownText).join("、")}`);
  } else {
    const range = formatMemoryCardsReportRange(card.startAt, card.endAt);
    if (range) {
      lines.push(`证据时间：${range}`);
    }
  }
  if (evidence.windowIds.length > 0) {
    lines.push(`窗口：${evidence.windowIds.slice(0, 4).map(memoryCardMarkdownText).join("、")}`);
  }
  if (evidence.taskHints.length > 0) {
    lines.push(`任务线索：${evidence.taskHints.slice(0, 3).map(memoryCardMarkdownText).join("；")}`);
  }
  if (evidence.transcriptExcerpts.length > 0) {
    lines.push(`转写摘录：${evidence.transcriptExcerpts.slice(0, 2).map(memoryCardMarkdownText).join(" / ")}`);
  }
  return lines;
}

async function writeMemoryCardsMarkdownDraft(params: {
  stateDir: string;
  title: string;
  markdown: string;
  createdAt: number;
}): Promise<{
  fileName: string;
  filePath: string;
}> {
  const draftDir = path.join(params.stateDir, "plugins", "clawsense", "drafts");
  await fs.mkdir(draftDir, { recursive: true });
  const timestamp = new Date(params.createdAt).toISOString().replace(/[:.]/g, "-");
  const fileName = `${timestamp}-${toSafeSlug(params.title) || "clawsense-memory-cards"}.md`;
  const filePath = path.join(draftDir, fileName);
  await fs.writeFile(filePath, params.markdown, "utf8");
  return { fileName, filePath };
}

function appendDraftPathToMarkdown(
  markdown: string,
  draft: { fileName: string; filePath: string } | null,
): string {
  if (!draft) {
    return markdown.trimEnd();
  }
  return `${markdown.trimEnd()}\n\n---\n\n草稿文件：${draft.filePath}`;
}

function formatMemoryCardsReportRange(startAt?: number | null, endAt?: number | null): string {
  if (typeof startAt === "number" && Number.isFinite(startAt) && typeof endAt === "number" && Number.isFinite(endAt)) {
    return `${new Date(startAt).toISOString()} - ${new Date(endAt).toISOString()}`;
  }
  if (typeof startAt === "number" && Number.isFinite(startAt)) {
    return `from ${new Date(startAt).toISOString()}`;
  }
  if (typeof endAt === "number" && Number.isFinite(endAt)) {
    return `until ${new Date(endAt).toISOString()}`;
  }
  return "";
}

function normalizeMarkdownTitle(value: string): string {
  const normalized = memoryCardMarkdownText(value).replace(/^#+\s*/u, "").trim();
  return normalized || "ClawSense 长期记忆卡片报告";
}

function memoryCardMarkdownText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatMemoryCardKindForCli(kind: ClawSenseMemoryCard["kind"]): string {
  if (kind === "task") {
    return "任务";
  }
  if (kind === "attention") {
    return "注意";
  }
  if (kind === "learning") {
    return "学习点";
  }
  return "话题";
}

function buildSpeakerSlotsPayload(params: {
  date: string;
  scope: "today" | "last-hour" | "custom-range";
  question?: string;
  speakerLayer?: unknown;
  taskAttribution?: unknown;
  taskAttributionBuckets?: unknown;
  speakerResolutionPrompts?: unknown;
  speakerSuggestions: Array<{
    suggestionId: string;
    speakerRef: string;
    slotLabel: string;
    windowId: string;
    timeRange: string;
    confidence: "medium";
    sentenceTemplate: string;
    commandTemplate: string;
    selfSentenceTemplate?: string;
    selfCommandTemplate?: string;
  }>;
  speakerAnnotations: Array<{
    speakerRef: string;
    displayName: string;
    relationship?: string;
    windowId?: string;
    updatedAt?: number;
  }>;
}): {
  ok: true;
  date: string;
  scope: "today" | "last-hour" | "custom-range";
  question?: string;
  status: "ready" | "needs-speaker-labels" | "missing-speaker-evidence";
  summary: {
    suggestedSlotCount: number;
    unresolvedSlotCount: number;
    promptCount: number;
    knownSpeakerCount: number;
    taskNeedsSpeakerLabelCount: number;
    impactedSlotCount: number;
    diarizationRequiredPromptCount: number;
  };
  knownSpeakers: Array<{
    speakerRef: string;
    displayName: string;
    relationship?: string;
    windowId?: string;
    updatedAt?: number;
  }>;
  suggestedSlots: unknown[];
  taskAttribution: unknown;
  taskAttributionBuckets: unknown;
  speakerResolutionPrompts: unknown[];
  speakerSuggestions: typeof params.speakerSuggestions;
  slotTaskImpacts: Array<{
    speakerRef: string;
    slotLabel: string;
    windowId: string;
    timeRange: string;
    displayName?: string;
    relationship?: string;
    impactLevel: "exact-task-owner" | "window-context-only";
    requiresDiarization: boolean;
    unresolvedTaskCount: number;
    sampleTasks: string[];
    naturalLanguageHints: string[];
    commands: {
      markAsMe: string;
      markAsColleague: string;
    };
  }>;
  quickCommands: string[];
  naturalLanguageHints: string[];
} {
  const speakerLayer = params.speakerLayer && typeof params.speakerLayer === "object"
    ? params.speakerLayer as { suggestedSlots?: unknown; status?: unknown }
    : {};
  const suggestedSlots = Array.isArray(speakerLayer.suggestedSlots) ? speakerLayer.suggestedSlots : [];
  const speakerResolutionPrompts = Array.isArray(params.speakerResolutionPrompts)
    ? params.speakerResolutionPrompts
    : params.taskAttribution && typeof params.taskAttribution === "object" &&
        Array.isArray((params.taskAttribution as { speakerResolutionPrompts?: unknown }).speakerResolutionPrompts)
      ? (params.taskAttribution as { speakerResolutionPrompts: unknown[] }).speakerResolutionPrompts
      : [];
  const taskAttributionObject = params.taskAttribution && typeof params.taskAttribution === "object"
    ? params.taskAttribution as { buckets?: unknown; status?: unknown }
    : undefined;
  const taskAttributionBuckets = params.taskAttributionBuckets ?? taskAttributionObject?.buckets;
  const needsSpeakerBucket =
    taskAttributionBuckets && typeof taskAttributionBuckets === "object"
      ? (taskAttributionBuckets as { needsSpeakerLabel?: unknown }).needsSpeakerLabel
      : undefined;
  const taskNeedsSpeakerLabelCount = Array.isArray(needsSpeakerBucket) ? needsSpeakerBucket.length : 0;
  const knownRefs = new Set(params.speakerAnnotations.map((item) => item.speakerRef));
  const unresolvedSlotCount = suggestedSlots.filter((slot) => {
    if (!slot || typeof slot !== "object") {
      return true;
    }
    const speakerRef = (slot as { speakerRef?: unknown }).speakerRef;
    const displayName = (slot as { displayName?: unknown }).displayName;
    if (typeof speakerRef === "string" && knownRefs.has(speakerRef)) {
      return false;
    }
    return typeof displayName !== "string" || looksPendingIdentityLabelForCli(displayName);
  }).length;
  const slotTaskImpacts = buildSpeakerSlotTaskImpacts({
    speakerResolutionPrompts,
    speakerSuggestions: params.speakerSuggestions,
  });
  const promptCommands = speakerResolutionPrompts
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const command = (item as { selfCommandTemplate?: unknown; commandTemplate?: unknown }).selfCommandTemplate ??
        (item as { commandTemplate?: unknown }).commandTemplate;
      return typeof command === "string" && command.trim() ? [command] : [];
    });
  const impactCommands = slotTaskImpacts.flatMap((item) => [item.commands.markAsMe, item.commands.markAsColleague]);
  const suggestionCommands = params.speakerSuggestions
    .slice(0, 4)
    .flatMap((item) => [item.selfCommandTemplate, item.commandTemplate])
    .filter((item): item is string => typeof item === "string")
    .filter((item) => item.trim().length > 0);
  const quickCommands = dedupeStrings(impactCommands.concat(promptCommands, suggestionCommands)).slice(0, 8);
  const naturalLanguageHints = speakerResolutionPrompts
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const prompt = (item as { prompt?: unknown }).prompt;
      const selfSentenceTemplate = (item as { selfSentenceTemplate?: unknown }).selfSentenceTemplate;
      const sentenceTemplate = (item as { sentenceTemplate?: unknown }).sentenceTemplate;
      return [prompt, selfSentenceTemplate, sentenceTemplate]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    })
    .slice(0, 8);
  const status =
    suggestedSlots.length === 0 && params.speakerSuggestions.length === 0 && speakerResolutionPrompts.length === 0
      ? "missing-speaker-evidence"
      : unresolvedSlotCount > 0 || speakerResolutionPrompts.length > 0 || taskNeedsSpeakerLabelCount > 0
        ? "needs-speaker-labels"
        : "ready";
  return {
    ok: true,
    date: params.date,
    scope: params.scope,
    question: params.question,
    status,
    summary: {
      suggestedSlotCount: suggestedSlots.length,
      unresolvedSlotCount,
      promptCount: speakerResolutionPrompts.length,
      knownSpeakerCount: params.speakerAnnotations.length,
      taskNeedsSpeakerLabelCount,
      impactedSlotCount: slotTaskImpacts.length,
      diarizationRequiredPromptCount: speakerResolutionPrompts.filter((item) =>
        item && typeof item === "object" && (item as { requiresDiarization?: unknown }).requiresDiarization === true
      ).length,
    },
    knownSpeakers: params.speakerAnnotations
      .map((item) => ({
        speakerRef: item.speakerRef,
        displayName: item.displayName,
        relationship: item.relationship,
        windowId: item.windowId,
        updatedAt: item.updatedAt,
      }))
      .slice(0, 20),
    suggestedSlots,
    taskAttribution: params.taskAttribution,
    taskAttributionBuckets,
    speakerResolutionPrompts,
    speakerSuggestions: params.speakerSuggestions,
    slotTaskImpacts,
    quickCommands,
    naturalLanguageHints,
  };
}

function buildSpeakerSlotTaskImpacts(params: {
  speakerResolutionPrompts: unknown[];
  speakerSuggestions: Array<{
    speakerRef: string;
    slotLabel: string;
    windowId: string;
    timeRange: string;
    displayName?: string;
    relationship?: string;
    sentenceTemplate: string;
    commandTemplate: string;
    selfSentenceTemplate?: string;
    selfCommandTemplate?: string;
  }>;
}): Array<{
  speakerRef: string;
  slotLabel: string;
  windowId: string;
  timeRange: string;
  displayName?: string;
  relationship?: string;
  impactLevel: "exact-task-owner" | "window-context-only";
  requiresDiarization: boolean;
  unresolvedTaskCount: number;
  sampleTasks: string[];
  naturalLanguageHints: string[];
  commands: {
    markAsMe: string;
    markAsColleague: string;
  };
}> {
  const byRef = new Map<string, {
    speakerRef: string;
    slotLabel: string;
    windowId: string;
    timeRange: string;
    displayName?: string;
    relationship?: string;
    impactLevel: "exact-task-owner" | "window-context-only";
    requiresDiarization: boolean;
    unresolvedTaskCount: number;
    sampleTasks: string[];
    naturalLanguageHints: string[];
    commands: {
      markAsMe: string;
      markAsColleague: string;
    };
  }>();

  const upsert = (slot: {
    speakerRef: string;
    slotLabel: string;
    windowId: string;
    timeRange: string;
    displayName?: string;
    relationship?: string;
    selfSentenceTemplate?: string;
    sentenceTemplate?: string;
    selfCommandTemplate?: string;
    commandTemplate?: string;
  }, prompt: {
    taskCount: number;
    sampleTasks: string[];
    requiresDiarization: boolean;
    naturalLanguageHints: string[];
  }) => {
    const current = byRef.get(slot.speakerRef) ?? {
      speakerRef: slot.speakerRef,
      slotLabel: slot.slotLabel,
      windowId: slot.windowId,
      timeRange: slot.timeRange,
      ...(slot.displayName ? { displayName: slot.displayName } : {}),
      ...(slot.relationship ? { relationship: slot.relationship } : {}),
      impactLevel: prompt.requiresDiarization ? "window-context-only" as const : "exact-task-owner" as const,
      requiresDiarization: prompt.requiresDiarization,
      unresolvedTaskCount: 0,
      sampleTasks: [],
      naturalLanguageHints: [],
      commands: {
        markAsMe:
          slot.selfCommandTemplate ??
          `openclaw clawsense annotate-speaker ${JSON.stringify(slot.speakerRef)} "我" --relationship "本人" --windowId ${JSON.stringify(slot.windowId)}`,
        markAsColleague:
          slot.commandTemplate ??
          `openclaw clawsense annotate-speaker ${JSON.stringify(slot.speakerRef)} "李三" --relationship "同事" --windowId ${JSON.stringify(slot.windowId)}`,
      },
    };
    current.unresolvedTaskCount += prompt.taskCount;
    current.requiresDiarization = current.requiresDiarization || prompt.requiresDiarization;
    current.impactLevel = current.requiresDiarization ? "window-context-only" : "exact-task-owner";
    current.sampleTasks = dedupeStrings(current.sampleTasks.concat(prompt.sampleTasks)).slice(0, 4);
    current.naturalLanguageHints = dedupeStrings(current.naturalLanguageHints.concat(prompt.naturalLanguageHints)).slice(0, 4);
    byRef.set(slot.speakerRef, current);
  };

  for (const rawPrompt of params.speakerResolutionPrompts) {
    if (!rawPrompt || typeof rawPrompt !== "object") {
      continue;
    }
    const prompt = rawPrompt as {
      taskCount?: unknown;
      sampleTasks?: unknown;
      requiresDiarization?: unknown;
      selfSentenceTemplate?: unknown;
      sentenceTemplate?: unknown;
      candidateSpeakerSlots?: unknown;
    };
    const taskCount = typeof prompt.taskCount === "number" && Number.isFinite(prompt.taskCount) ? prompt.taskCount : 0;
    const sampleTasks = Array.isArray(prompt.sampleTasks)
      ? prompt.sampleTasks.filter((item): item is string => typeof item === "string")
      : [];
    const naturalLanguageHints = [prompt.selfSentenceTemplate, prompt.sentenceTemplate].filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    const candidateSlots = Array.isArray(prompt.candidateSpeakerSlots) ? prompt.candidateSpeakerSlots : [];
    for (const rawSlot of candidateSlots) {
      if (!rawSlot || typeof rawSlot !== "object") {
        continue;
      }
      const slot = rawSlot as {
        speakerRef?: unknown;
        slotLabel?: unknown;
        windowId?: unknown;
        timeRange?: unknown;
        displayName?: unknown;
        relationship?: unknown;
        selfSentenceTemplate?: unknown;
        sentenceTemplate?: unknown;
        selfCommandTemplate?: unknown;
        commandTemplate?: unknown;
      };
      if (
        typeof slot.speakerRef !== "string" ||
        typeof slot.slotLabel !== "string" ||
        typeof slot.windowId !== "string" ||
        typeof slot.timeRange !== "string"
      ) {
        continue;
      }
      upsert(
        {
          speakerRef: slot.speakerRef,
          slotLabel: slot.slotLabel,
          windowId: slot.windowId,
          timeRange: slot.timeRange,
          ...(typeof slot.displayName === "string" ? { displayName: slot.displayName } : {}),
          ...(typeof slot.relationship === "string" ? { relationship: slot.relationship } : {}),
          ...(typeof slot.selfSentenceTemplate === "string" ? { selfSentenceTemplate: slot.selfSentenceTemplate } : {}),
          ...(typeof slot.sentenceTemplate === "string" ? { sentenceTemplate: slot.sentenceTemplate } : {}),
          ...(typeof slot.selfCommandTemplate === "string" ? { selfCommandTemplate: slot.selfCommandTemplate } : {}),
          ...(typeof slot.commandTemplate === "string" ? { commandTemplate: slot.commandTemplate } : {}),
        },
        {
          taskCount,
          sampleTasks,
          requiresDiarization: prompt.requiresDiarization === true,
          naturalLanguageHints,
        },
      );
    }
  }

  for (const suggestion of params.speakerSuggestions) {
    if (!byRef.has(suggestion.speakerRef)) {
      byRef.set(suggestion.speakerRef, {
        speakerRef: suggestion.speakerRef,
        slotLabel: suggestion.slotLabel,
        windowId: suggestion.windowId,
        timeRange: suggestion.timeRange,
        impactLevel: "window-context-only",
        requiresDiarization: true,
        unresolvedTaskCount: 0,
        sampleTasks: [],
        naturalLanguageHints: dedupeStrings([
          suggestion.selfSentenceTemplate ?? "",
          suggestion.sentenceTemplate,
        ].filter(Boolean)),
        commands: {
          markAsMe:
            suggestion.selfCommandTemplate ??
            `openclaw clawsense annotate-speaker ${JSON.stringify(suggestion.speakerRef)} "我" --relationship "本人" --windowId ${JSON.stringify(suggestion.windowId)}`,
          markAsColleague: suggestion.commandTemplate,
        },
      });
    }
  }

  return Array.from(byRef.values())
    .sort((left, right) => right.unresolvedTaskCount - left.unresolvedTaskCount || left.slotLabel.localeCompare(right.slotLabel))
    .slice(0, 8);
}

function buildAudioDiagnosticsPayload(params: {
  date: string;
  events: ClawSenseCaptureEvent[];
  artifacts: ClawSenseArtifactRecord[];
  localAsr: unknown;
  worker: unknown;
  maxSamples: number;
}): {
  ok: true;
  date: string;
  counts: {
    totalEvents: number;
    audioEvents: number;
    audioArtifacts: number;
    audioArtifactRecords: number;
    activeAudioArtifactRecords: number;
    deletedAudioArtifactRecords: number;
    missingAudioArtifactRecords: number;
    transcriptReadyEvents: number;
    transcriptSegmentReadyEvents: number;
    speakerTimelineReadyEvents: number;
    degradedAudioEvents: number;
    pendingAnalysisEvents: number;
    backfillNeededEvents: number;
    backfillRunnableEvents: number;
    diarizationNeededEvents: number;
    diarizationRunnableEvents: number;
  };
  coverage: {
    transcriptCoverage: number;
    transcriptSegmentCoverage: number;
    speakerTimelineCoverage: number;
  };
  verdict: {
    transcriptLayer: "ready" | "partial" | "missing";
    diarizationLayer: "ready" | "partial" | "missing";
    needsBackfill: boolean;
    needsDiarization: boolean;
    rawAudioArtifacts: "available" | "deleted" | "missing-record";
  };
  blockers: Array<{
    id: string;
    severity: "info" | "warning" | "blocked";
    message: string;
  }>;
  nextActions: string[];
  retention: {
    earliestRetentionExpiresAt?: number;
    earliestRetentionExpiresAtIso?: string;
    latestRetentionExpiresAt?: number;
    latestRetentionExpiresAtIso?: string;
    firstDeletedAt?: number;
    firstDeletedAtIso?: string;
    lastDeletedAt?: number;
    lastDeletedAtIso?: string;
  };
  topFailureReasons: Array<{ reason: string; count: number }>;
  sampleBackfillCandidates: Array<{
    eventId: string;
    artifactId: string;
    capturedAt: number;
    capturedAtIso: string;
    fileName?: string;
    transcriptReady: boolean;
    transcriptSegmentCount: number;
    speakerTimelineSegmentCount: number;
    rawArtifactAvailable: boolean;
    rawArtifactDeletedAt?: number;
    rawArtifactRetentionExpiresAt?: number;
    analysisStatus?: string;
    analysisFailureReason?: string;
    audioBackfillAttemptCount?: number;
  }>;
  localAsr: unknown;
  worker: unknown;
  recommendedCommands: string[];
} {
  const audioEvents = params.events.filter((event) => event.modality === "audio");
  const artifactsById = new Map(params.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const audioArtifactIds = new Set(audioEvents.map((event) => event.artifactId));
  const audioArtifacts = params.artifacts.filter(
    (artifact) =>
      artifact.modality === "audio" &&
      !artifact.deletedAt &&
      audioArtifactIds.has(artifact.artifactId),
  );
  const transcriptReadyEvents = audioEvents.filter(hasAudioTranscriptReady);
  const transcriptSegmentReadyEvents = audioEvents.filter((event) => countSegments(event.transcriptSegments) > 0);
  const speakerTimelineReadyEvents = audioEvents.filter((event) => countSegments(event.speakerTimelineSegments) > 0);
  const degradedAudioEvents = audioEvents.filter((event) => event.analysisStatus === "degraded");
  const pendingAnalysisEvents = audioEvents.filter((event) =>
    typeof event.analysisFailureReason === "string" && event.analysisFailureReason.includes("analysis_pending"),
  );
  const backfillNeededEvents = audioEvents.filter((event) =>
    !hasAudioTranscriptReady(event) ||
      countSegments(event.transcriptSegments) === 0 ||
      event.analysisStatus === "degraded"
  );
  const backfillRunnableEvents = backfillNeededEvents.filter((event) => {
    const artifact = artifactsById.get(event.artifactId);
    return Boolean(artifact && !artifact.deletedAt);
  });
  const diarizationNeededEvents = audioEvents.filter((event) =>
    hasAudioTranscriptReady(event) && countSegments(event.speakerTimelineSegments) === 0
  );
  const diarizationRunnableEvents = diarizationNeededEvents.filter((event) => {
    const artifact = artifactsById.get(event.artifactId);
    return Boolean(artifact && !artifact.deletedAt);
  });
  const topFailureReasons = summarizeAudioFailureReasons(audioEvents).slice(0, 10);
  const sampleBackfillCandidates = backfillNeededEvents
    .slice()
    .sort((left, right) => left.capturedAt - right.capturedAt)
    .slice(0, Math.max(1, Math.min(20, params.maxSamples)))
    .map((event) => {
      const artifact = artifactsById.get(event.artifactId);
      return {
        eventId: event.eventId,
        artifactId: event.artifactId,
        capturedAt: event.capturedAt,
        capturedAtIso: new Date(event.capturedAt).toISOString(),
        fileName: artifact?.fileName,
        transcriptReady: hasAudioTranscriptReady(event),
        transcriptSegmentCount: countSegments(event.transcriptSegments),
        speakerTimelineSegmentCount: countSegments(event.speakerTimelineSegments),
        rawArtifactAvailable: Boolean(artifact && !artifact.deletedAt),
        ...(artifact?.deletedAt ? { rawArtifactDeletedAt: artifact.deletedAt } : {}),
        ...(artifact?.retentionExpiresAt ? { rawArtifactRetentionExpiresAt: artifact.retentionExpiresAt } : {}),
        analysisStatus: event.analysisStatus,
        analysisFailureReason: event.analysisFailureReason,
        audioBackfillAttemptCount: event.audioBackfillAttemptCount,
      };
    });
  const transcriptCoverage = ratio(transcriptReadyEvents.length, audioEvents.length);
  const transcriptSegmentCoverage = ratio(transcriptSegmentReadyEvents.length, audioEvents.length);
  const speakerTimelineCoverage = ratio(speakerTimelineReadyEvents.length, audioEvents.length);
  const audioArtifactRecords = audioEvents
    .map((event) => artifactsById.get(event.artifactId))
    .filter((artifact): artifact is ClawSenseArtifactRecord => Boolean(artifact && artifact.modality === "audio"));
  const activeAudioArtifactRecords = audioArtifactRecords.filter((artifact) => !artifact.deletedAt);
  const deletedAudioArtifactRecords = audioArtifactRecords.filter((artifact) => artifact.deletedAt);
  const missingAudioArtifactRecords = Math.max(0, audioEvents.length - audioArtifactRecords.length);
  const retention = summarizeRetention(audioArtifactRecords);
  const rawAudioArtifacts =
    activeAudioArtifactRecords.length > 0
      ? "available"
      : deletedAudioArtifactRecords.length > 0
        ? "deleted"
        : "missing-record";
  const countsForDiagnosis = {
    audioEvents: audioEvents.length,
    backfillNeededEvents: backfillNeededEvents.length,
    backfillRunnableEvents: backfillRunnableEvents.length,
    diarizationNeededEvents: diarizationNeededEvents.length,
    diarizationRunnableEvents: diarizationRunnableEvents.length,
  };
  const blockers = buildAudioDiagnosticsBlockers(countsForDiagnosis, rawAudioArtifacts);
  return {
    ok: true,
    date: params.date,
    counts: {
      totalEvents: params.events.length,
      audioEvents: audioEvents.length,
      audioArtifacts: audioArtifacts.length,
      audioArtifactRecords: audioArtifactRecords.length,
      activeAudioArtifactRecords: activeAudioArtifactRecords.length,
      deletedAudioArtifactRecords: deletedAudioArtifactRecords.length,
      missingAudioArtifactRecords,
      transcriptReadyEvents: transcriptReadyEvents.length,
      transcriptSegmentReadyEvents: transcriptSegmentReadyEvents.length,
      speakerTimelineReadyEvents: speakerTimelineReadyEvents.length,
      degradedAudioEvents: degradedAudioEvents.length,
      pendingAnalysisEvents: pendingAnalysisEvents.length,
      backfillNeededEvents: backfillNeededEvents.length,
      backfillRunnableEvents: backfillRunnableEvents.length,
      diarizationNeededEvents: diarizationNeededEvents.length,
      diarizationRunnableEvents: diarizationRunnableEvents.length,
    },
    coverage: {
      transcriptCoverage,
      transcriptSegmentCoverage,
      speakerTimelineCoverage,
    },
    verdict: {
      transcriptLayer: coverageStatus(transcriptCoverage),
      diarizationLayer: coverageStatus(speakerTimelineCoverage),
      needsBackfill: backfillNeededEvents.length > 0,
      needsDiarization: diarizationNeededEvents.length > 0,
      rawAudioArtifacts,
    },
    blockers,
    nextActions: buildAudioDiagnosticsNextActions({
      date: params.date,
      rawAudioArtifacts,
      blockers,
      counts: countsForDiagnosis,
    }),
    retention,
    topFailureReasons,
    sampleBackfillCandidates,
    localAsr: params.localAsr,
    worker: params.worker,
    recommendedCommands: buildAudioDiagnosticsRecommendedCommands(params.date, rawAudioArtifacts),
  };
}

function buildAudioDiagnosticsBlockers(
  counts: {
    audioEvents: number;
    backfillNeededEvents: number;
    backfillRunnableEvents: number;
    diarizationNeededEvents: number;
    diarizationRunnableEvents: number;
  },
  rawAudioArtifacts: "available" | "deleted" | "missing-record",
): Array<{ id: string; severity: "info" | "warning" | "blocked"; message: string }> {
  const blockers: Array<{ id: string; severity: "info" | "warning" | "blocked"; message: string }> = [];
  if (counts.audioEvents === 0) {
    blockers.push({
      id: "no-audio-events",
      severity: "blocked",
      message: "这个日期没有音频事件，无法做 ASR 或 speaker diarization。",
    });
    return blockers;
  }
  if (rawAudioArtifacts === "deleted") {
    blockers.push({
      id: "raw-audio-retention-deleted",
      severity: "blocked",
      message: "这个日期的原始音频 artifact 已被 retention 清理；已有 transcript 仍可用于回顾，但不能直接补跑本地 ASR / diarization。",
    });
  } else if (rawAudioArtifacts === "missing-record") {
    blockers.push({
      id: "raw-audio-artifact-record-missing",
      severity: "blocked",
      message: "音频事件没有可用 artifact 记录；需要先确认 ingest state/runtime 是否选对。",
    });
  }
  if (counts.diarizationNeededEvents > 0 && counts.diarizationRunnableEvents === 0) {
    blockers.push({
      id: "diarization-not-runnable",
      severity: rawAudioArtifacts === "available" ? "warning" : "blocked",
      message: "存在需要 speaker timeline 的音频，但当前没有可补跑 diarization 的原始音频候选。",
    });
  }
  if (counts.backfillNeededEvents > 0 && counts.backfillRunnableEvents === 0) {
    blockers.push({
      id: "backfill-not-runnable",
      severity: rawAudioArtifacts === "available" ? "warning" : "blocked",
      message: "存在需要 ASR backfill 的音频，但当前没有可补跑的原始音频候选。",
    });
  }
  if (blockers.length === 0) {
    blockers.push({
      id: "audio-backfill-runnable",
      severity: "info",
      message: "当前有可用原始音频；可以 dry-run 本地 ASR / diarization 计划。",
    });
  }
  return blockers;
}

function buildAudioDiagnosticsNextActions(params: {
  date: string;
  rawAudioArtifacts: "available" | "deleted" | "missing-record";
  blockers: Array<{ id: string; severity: "info" | "warning" | "blocked"; message: string }>;
  counts: {
    backfillNeededEvents: number;
    diarizationNeededEvents: number;
  };
}): string[] {
  if (params.rawAudioArtifacts === "available") {
    return [
      `先 dry-run：openclaw clawsense asr-queue plan ${params.date} --provider local-asr --include-transcribed --dry-run`,
      params.counts.diarizationNeededEvents > 0
        ? `如需 speaker：openclaw clawsense diarization-probe ${params.date} --provider hybrid --max 1`
        : "speaker timeline 已有覆盖；优先检查 task attribution / speaker 标注。",
      params.counts.backfillNeededEvents > 0
        ? `如需写回：openclaw clawsense backfill-audio ${params.date} --provider local-asr --include-transcribed --dry-run --max 3`
        : "ASR transcript 覆盖已经较好；除非发现缺口，否则先不要重复补跑。",
    ];
  }
  if (params.rawAudioArtifacts === "deleted") {
    return [
      "这一天只能继续使用已保存 transcript / summary 回顾；不能直接从当前 state 补跑本地 ASR 或 diarization。",
      "如果要验证 speaker diarization，请重新导入当天 raw wav，或用新的真机/公开样例录一段仍在 retention 窗口内的音频。",
      "后续采集前把 artifactRetentionDays 设到足够长，并在 retention 到期前运行 audio-diagnostics / diarization-probe。",
    ];
  }
  return [
    "先确认当前命令使用的是正确的 repo-local 或服务器 state。",
    `检查媒体库：openclaw clawsense media ${params.date}`,
    "如果确实没有 artifact 记录，需要重新采集或导入 raw wav 后再跑 ASR / diarization。",
  ];
}

function hasAudioTranscriptReady(event: ClawSenseCaptureEvent): boolean {
  const directTranscript = normalizeSemanticText(event.transcript ?? "");
  if (directTranscript) {
    return true;
  }
  return (event.transcriptSegments ?? []).some((segment) => normalizeSemanticText(segment.text ?? ""));
}

function summarizeRetention(artifacts: ClawSenseArtifactRecord[]): {
  earliestRetentionExpiresAt?: number;
  earliestRetentionExpiresAtIso?: string;
  latestRetentionExpiresAt?: number;
  latestRetentionExpiresAtIso?: string;
  firstDeletedAt?: number;
  firstDeletedAtIso?: string;
  lastDeletedAt?: number;
  lastDeletedAtIso?: string;
} {
  const retentionValues = artifacts
    .map((artifact) => artifact.retentionExpiresAt)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const deletedValues = artifacts
    .map((artifact) => artifact.deletedAt)
    .filter((value): value is number => Number.isFinite(value))
    .sort((left, right) => left - right);
  const earliestRetentionExpiresAt = retentionValues[0];
  const latestRetentionExpiresAt = retentionValues.at(-1);
  const firstDeletedAt = deletedValues[0];
  const lastDeletedAt = deletedValues.at(-1);
  return {
    ...(earliestRetentionExpiresAt
      ? {
          earliestRetentionExpiresAt,
          earliestRetentionExpiresAtIso: new Date(earliestRetentionExpiresAt).toISOString(),
        }
      : {}),
    ...(latestRetentionExpiresAt
      ? {
          latestRetentionExpiresAt,
          latestRetentionExpiresAtIso: new Date(latestRetentionExpiresAt).toISOString(),
        }
      : {}),
    ...(firstDeletedAt
      ? {
          firstDeletedAt,
          firstDeletedAtIso: new Date(firstDeletedAt).toISOString(),
        }
      : {}),
    ...(lastDeletedAt
      ? {
          lastDeletedAt,
          lastDeletedAtIso: new Date(lastDeletedAt).toISOString(),
        }
      : {}),
  };
}

function buildAudioDiagnosticsRecommendedCommands(
  date: string,
  rawAudioArtifacts: "available" | "deleted" | "missing-record",
): string[] {
  const base = [
    "openclaw clawsense asr-status",
    `openclaw clawsense media ${date}`,
  ];
  if (rawAudioArtifacts === "available") {
    return base.concat([
      `openclaw clawsense asr-queue plan ${date} --provider local-asr --include-transcribed --dry-run`,
      `openclaw clawsense backfill-audio ${date} --provider local-asr --include-transcribed --dry-run --max 3`,
      `openclaw clawsense diarization-probe ${date} --provider whisperx --max 1`,
    ]);
  }
  if (rawAudioArtifacts === "deleted") {
    return base.concat([
      "Raw audio artifacts for this date were already pruned by retention; collect new audio or re-import raw wav files before diarization/backfill.",
      "For future tests, run audio-diagnostics within the retention window or increase plugins.entries.clawsense.config.artifactRetentionDays.",
    ]);
  }
  return base.concat([
    "No audio artifact records are linked to this date; confirm ingest state/runtime selection before attempting ASR backfill.",
  ]);
}

function countSegments(segments: unknown): number {
  return Array.isArray(segments) ? segments.length : 0;
}

function ratio(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Number((value / total).toFixed(4));
}

function coverageStatus(value: number): "ready" | "partial" | "missing" {
  if (value >= 0.8) {
    return "ready";
  }
  if (value > 0) {
    return "partial";
  }
  return "missing";
}

function summarizeAudioFailureReasons(events: ClawSenseCaptureEvent[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const raw = event.analysisFailureReason;
    if (!raw) {
      continue;
    }
    for (const reason of raw.split("|").map((item) => item.trim()).filter(Boolean)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function looksPendingIdentityLabelForCli(value: string): boolean {
  return /^(speaker[_\-\s]?\d+|说话人\s*\d+|未知|待确认|unknown|pending)$/iu.test(value.trim());
}

function normalizeConversationDigestFollowUpTarget(
  item: unknown,
  prompt: string | undefined,
  index: number,
): {
  source: "topic";
  kind: "conversation-digest-topic";
  prompt: string;
  segmentId?: string;
  windowId?: string;
  timeRange?: string;
  title?: string;
  keywordHints?: unknown;
  taskSignalCount?: unknown;
} | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const topic = item as {
    segmentId?: unknown;
    windowId?: unknown;
    timeRange?: unknown;
    title?: unknown;
    keywordHints?: unknown;
    taskSignalCount?: unknown;
  };
  const timeRange = typeof topic.timeRange === "string" ? topic.timeRange : undefined;
  const title = typeof topic.title === "string" ? topic.title : undefined;
  const fallbackPrompt = `你可以继续问：“第 ${index + 1} 段${timeRange ? `（${timeRange}` : ""}${title ? `${timeRange ? "，" : "（"}${title}` : ""}${timeRange || title ? "）" : ""}具体讲了什么？”`;
  return {
    source: "topic",
    kind: "conversation-digest-topic",
    prompt: typeof prompt === "string" && prompt.trim() ? prompt : fallbackPrompt,
    segmentId: typeof topic.segmentId === "string" ? topic.segmentId : undefined,
    windowId: typeof topic.windowId === "string" ? topic.windowId : undefined,
    timeRange,
    title,
    keywordHints: topic.keywordHints,
    taskSignalCount: topic.taskSignalCount,
  };
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
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

function normalizeAudioBackfillProvider(value?: string): "auto" | "local-asr" | "compatible-asr" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local-asr" || normalized === "local" || normalized === "funasr" || normalized === "whisper") {
    return "local-asr";
  }
  if (
    normalized === "compatible-asr" ||
    normalized === "compatible" ||
    normalized === "cloud" ||
    normalized === "stt"
  ) {
    return "compatible-asr";
  }
  return "auto";
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
