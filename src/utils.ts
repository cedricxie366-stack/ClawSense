import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ClawSenseSetupToken } from "./state-store.js";
import type { OpenClawConfig } from "./openclaw-types.js";

export function issueSetupToken(ttlSeconds: number): ClawSenseSetupToken {
  const token = randomBytes(24).toString("base64url");
  const createdAt = Date.now();
  return {
    token,
    tokenHash: hashSecret(token),
    createdAt,
    expiresAt: createdAt + ttlSeconds * 1000,
  };
}

export function createDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createSetupCode(baseUrl: string, token: string): string {
  return Buffer.from(JSON.stringify({ url: stripTrailingSlash(baseUrl), token }), "utf8").toString(
    "base64url",
  );
}

export function inferPublicBaseUrl(params: {
  preferred?: string;
  config: OpenClawConfig;
  gatewayPort: number;
}): string {
  const preferred = params.preferred?.trim();
  if (preferred) {
    return stripTrailingSlash(withProtocol(preferred));
  }

  const config = params.config as Record<string, unknown>;
  const gateway = (config.gateway ?? {}) as Record<string, unknown>;
  const explicitUrl = typeof gateway.publicBaseUrl === "string" ? gateway.publicBaseUrl : undefined;
  if (explicitUrl?.trim()) {
    return stripTrailingSlash(withProtocol(explicitUrl));
  }

  const bind = typeof gateway.bind === "string" ? gateway.bind.trim() : "";
  if (bind) {
    return stripTrailingSlash(withProtocol(bind));
  }

  const host = process.env.CLAWSENSE_PUBLIC_HOST?.trim() || "127.0.0.1";
  return `http://${host}:${params.gatewayPort}`;
}

export function withProtocol(value: string): string {
  return value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function timingSafeMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
