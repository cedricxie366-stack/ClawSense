export const DIGITAL_SOURCE_TYPES = ["shared_text", "shared_image", "contact_selection"] as const;
export type DigitalSourceType = typeof DIGITAL_SOURCE_TYPES[number];
export type DigitalScope = { projectId: string; sourceTypes?: DigitalSourceType[]; allowRaw?: boolean };
export type DigitalAccess = { owner: boolean; actor: string; scopes: DigitalScope[]; contextScopes?: ContextScope[]; processingLocation?: "local-only" | "owned-devices" | "selected-external"; liveCheck?: () => Promise<boolean> };

export function normalizeDigitalScopes(value: unknown): DigitalScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error("invalid_digital_scopes");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some((key) => !["projectId", "sourceTypes", "allowRaw"].includes(key)) ||
      typeof item.projectId !== "string" || !item.projectId.trim() || item.projectId.length > 200 ||
      (item.allowRaw !== undefined && typeof item.allowRaw !== "boolean") ||
      (item.sourceTypes !== undefined && (!Array.isArray(item.sourceTypes) || !item.sourceTypes.length ||
        item.sourceTypes.some((type: unknown) => !(DIGITAL_SOURCE_TYPES as readonly unknown[]).includes(type))))) throw new Error("invalid_digital_scopes");
    return { projectId: item.projectId.trim(), ...(item.sourceTypes ? { sourceTypes: [...new Set(item.sourceTypes)] as DigitalSourceType[] } : {}), allowRaw: item.allowRaw === true };
  });
}

export function canReadDigital(access: DigitalAccess, projectId: string, sourceType: DigitalSourceType, raw = false): boolean {
  if (access.contextScopes !== undefined) return canReadContext(access, { projectIds: [projectId], audience: "private", processingLocation: "legacy-configured", allowedRecipients: [] }, raw ? "read-raw" : "read-analysis", sourceType);
  return access.owner || access.scopes.some((scope) => (scope.projectId === "*" || scope.projectId === projectId) &&
    (!scope.sourceTypes || scope.sourceTypes.includes(sourceType)) && (!raw || scope.allowRaw === true));
}
import { canReadContext, type ContextScope } from "./context-access.js";
