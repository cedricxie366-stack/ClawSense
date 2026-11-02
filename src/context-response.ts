import type { AgentToolResult } from "./openclaw-types.js";
const PRIVATE_FIELDS = new Set(["sourcePath", "storagePath", "storageRelPath", "filePath", "plainSecret", "secretHash", "tokenHash", "localAsrModelDir", "mediaRoot", "memoryDbPath", "configFile"]);
export function sanitizeContextValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeContextValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELDS.has(key)).map(([key, entry]) => [key, sanitizeContextValue(entry)]));
  return value;
}
export function sanitizeAgentResponse(result: AgentToolResult): AgentToolResult {
  return { ...result, ...(result.details === undefined ? {} : { details: sanitizeContextValue(result.details) }), content: result.content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    try { return { ...block, text: JSON.stringify(sanitizeContextValue(JSON.parse(block.text))) }; } catch { return block; }
  }) };
}
