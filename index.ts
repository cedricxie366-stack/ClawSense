import qrcode from "qrcode-terminal";
import { ClawSenseMemoryStore } from "./src/memory-store.js";
import type { OpenClawPluginApi } from "./src/openclaw-types.js";
import {
  DEFAULT_PAIRING_TTL_SECONDS,
  clawsenseConfigSchema,
  resolveClawSenseConfig,
} from "./src/config.js";
import {
  createJsonRoute,
  json,
  methodNotAllowed,
  parseBearerToken,
  readJson,
  unauthorized,
} from "./src/http.js";
import {
  type ClawSenseDeviceRecord,
  type ClawSenseIngestReceipt,
  type ClawSenseSetupToken,
  ClawSenseStateStore,
} from "./src/state-store.js";
import { resolveOpenAiClient } from "./src/openai-client.js";
import {
  createSetupCode,
  hashSecret,
  inferPublicBaseUrl,
  issueSetupToken,
  safeJsonStringify,
  timingSafeMatches,
} from "./src/utils.js";

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
    const openai = resolveOpenAiClient(cfg, api.config);
    const memoryStore = new ClawSenseMemoryStore({
      cfg,
      runtimeConfig: api.config,
      logger: api.logger,
      stateStore,
    });

    const printSetupQr = async (reason: "bootstrap" | "manual"): Promise<ClawSenseSetupToken> => {
      const publicBaseUrl = inferPublicBaseUrl({
        preferred: cfg.publicBaseUrl,
        config: api.config,
        gatewayPort: cfg.gatewayPort,
      });
      const token = issueSetupToken(cfg.pairingTtlSeconds);
      await stateStore.upsertSetupToken(token);
      const setupCode = createSetupCode(publicBaseUrl, token.token);
      const expiresAtIso = new Date(token.expiresAt).toISOString();

      api.logger.info(
        `[clawsense] setup token ready (${reason}) expires=${expiresAtIso} baseUrl=${publicBaseUrl}`,
      );
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

    const authenticateDevice = async (authorization?: string): Promise<ClawSenseDeviceRecord | null> => {
      const secret = parseBearerToken(authorization);
      if (!secret) {
        return null;
      }
      const hashed = hashSecret(secret);
      const devices = await stateStore.listDevices();
      const matched = devices.find((device) => timingSafeMatches(device.secretHash, hashed));
      return matched ?? null;
    };

    const recordIngest = async (params: {
      device: ClawSenseDeviceRecord;
      modality: "audio" | "image";
      body: Buffer;
      fileName: string;
      mime: string | undefined;
      capturedAt?: number;
      note?: string;
    }): Promise<ClawSenseIngestReceipt> => {
      const receipt = await memoryStore.ingest({
        ...params,
        describeImage: async ({ buffer, fileName, mime }) => {
          if (!openai) {
            throw new Error(
              "ClawSense vision requires OPENAI_API_KEY, plugin.openaiApiKey, or models.providers.openai.apiKey",
            );
          }
          const imageUrl = `data:${mime ?? "image/jpeg"};base64,${buffer.toString("base64")}`;
          const response = await openai.responses.create({
            model: cfg.visionModel,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text:
                      "Describe this image as a first-person wearable memory. Focus on people, scene, visible text, objects, and why it may matter later.",
                  },
                  {
                    type: "input_image",
                    image_url: imageUrl,
                    detail: "auto",
                  },
                ],
              },
            ],
          });
          return { text: response.output_text.trim() };
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
          uploadBaseUrl: `${inferPublicBaseUrl({
            preferred: cfg.publicBaseUrl,
            config: api.config,
            gatewayPort: cfg.gatewayPort,
          }).replace(/\/+$/, "")}/api/clawsense`,
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
        const device = await authenticateDevice(req.headers.authorization);
        if (!device) {
          unauthorized(res);
          return true;
        }
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

        const receipt = await recordIngest({
          device,
          modality: "audio",
          body,
          fileName:
            typeof payload.fileName === "string" && payload.fileName.trim()
              ? payload.fileName.trim()
              : "capture.wav",
          mime:
            typeof payload.mime === "string" && payload.mime.trim() ? payload.mime.trim() : undefined,
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: typeof payload.note === "string" ? payload.note : undefined,
        });

        await stateStore.touchDevice(device.deviceId);
        json(res, 200, { ok: true, receipt });
        return true;
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/ingest/image", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const device = await authenticateDevice(req.headers.authorization);
        if (!device) {
          unauthorized(res);
          return true;
        }
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

        const receipt = await recordIngest({
          device,
          modality: "image",
          body,
          fileName:
            typeof payload.fileName === "string" && payload.fileName.trim()
              ? payload.fileName.trim()
              : "snapshot.jpg",
          mime:
            typeof payload.mime === "string" && payload.mime.trim() ? payload.mime.trim() : undefined,
          capturedAt: typeof payload.capturedAt === "number" ? payload.capturedAt : undefined,
          note: typeof payload.note === "string" ? payload.note : undefined,
        });

        await stateStore.touchDevice(device.deviceId);
        json(res, 200, { ok: true, receipt });
        return true;
      }),
    );

    api.registerHttpRoute(
      createJsonRoute("/api/clawsense/heartbeat", async (req, res) => {
        if (req.method !== "POST") {
          methodNotAllowed(res, ["POST"]);
          return true;
        }
        const device = await authenticateDevice(req.headers.authorization);
        if (!device) {
          unauthorized(res);
          return true;
        }
        const payload = await readJson(req, res);
        if (!payload) {
          return true;
        }
        await stateStore.updateHeartbeat(device.deviceId, {
          batteryPct: typeof payload.batteryPct === "number" ? payload.batteryPct : undefined,
          network:
            typeof payload.network === "string" && payload.network.trim()
              ? payload.network.trim()
              : undefined,
          appState:
            typeof payload.appState === "string" && payload.appState.trim()
              ? payload.appState.trim()
              : undefined,
          raw: payload,
        });
        json(res, 200, { ok: true, heartbeatIntervalSec: cfg.heartbeatIntervalSeconds });
        return true;
      }),
    );

    api.registerCli(
      ({ program }) => {
        const clawsense = program.command("clawsense").description("ClawSense 配对与状态命令");

        clawsense
          .command("pair")
          .description("生成一个新的 10 分钟配对二维码")
          .action(async () => {
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

        clawsense
          .command("devices")
          .description("列出已注册设备")
          .action(async () => {
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
      },
      { commands: ["clawsense"] },
    );

    api.registerService({
      id: "clawsense",
      start: async () => {
        await stateStore.pruneExpiredSetupTokens(DEFAULT_PAIRING_TTL_SECONDS);
        await ensureBootstrapQr();
        api.logger.info("[clawsense] service started");
      },
      stop: async () => {
        api.logger.info("[clawsense] service stopped");
      },
    });
  },
};

export default plugin as {
  id: string;
  name: string;
  description: string;
  configSchema: typeof clawsenseConfigSchema;
  register: (api: OpenClawPluginApi) => void;
};
