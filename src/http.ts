import type { IncomingMessage, ServerResponse } from "node:http";

export function createJsonRoute(
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>,
) {
  return {
    path,
    auth: "plugin" as const,
    handler,
  };
}

export async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = 8 * 1024 * 1024,
): Promise<Record<string, unknown> | null> {
  const result = await readJsonBodyWithLimit(req, {
    maxBytes,
    timeoutMs: 30_000,
    emptyObjectOnEmpty: true,
  });
  if (result.ok) {
    if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
      return result.value as Record<string, unknown>;
    }
    json(res, 400, { ok: false, error: "json_object_required" });
    return null;
  }

  const message =
    result.code === "INVALID_JSON"
      ? "invalid_json"
      : result.code === "PAYLOAD_TOO_LARGE"
        ? "payload_too_large"
        : requestBodyErrorToText(result.code);
  json(res, result.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { ok: false, error: message });
  return null;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function methodNotAllowed(res: ServerResponse, allow: string[]): void {
  res.statusCode = 405;
  res.setHeader("allow", allow.join(", "));
  json(res, 405, { ok: false, error: "method_not_allowed", allow });
}

export function unauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("www-authenticate", 'Bearer realm="clawsense"');
  json(res, 401, { ok: false, error: "unauthorized" });
}

export function parseBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

type RequestBodyErrorCode = "INVALID_JSON" | "PAYLOAD_TOO_LARGE" | "REQUEST_TIMEOUT" | "READ_ERROR";

type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; code: RequestBodyErrorCode };

async function readJsonBodyWithLimit(
  req: IncomingMessage,
  options: { maxBytes: number; timeoutMs: number; emptyObjectOnEmpty: boolean },
): Promise<ReadJsonResult> {
  return await new Promise<ReadJsonResult>((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];

    const finish = (result: ReadJsonResult): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      resolve(result);
    };

    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, code: "REQUEST_TIMEOUT" });
    }, options.timeoutMs);

    const onError = () => finish({ ok: false, code: "READ_ERROR" });
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > options.maxBytes) {
        req.destroy();
        finish({ ok: false, code: "PAYLOAD_TOO_LARGE" });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: true, value: options.emptyObjectOnEmpty ? {} : null });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, code: "INVALID_JSON" });
      }
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

function requestBodyErrorToText(code: RequestBodyErrorCode): string {
  if (code === "REQUEST_TIMEOUT") {
    return "request_timeout";
  }
  if (code === "PAYLOAD_TOO_LARGE") {
    return "payload_too_large";
  }
  if (code === "INVALID_JSON") {
    return "invalid_json";
  }
  return "request_body_read_error";
}
