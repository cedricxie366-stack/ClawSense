import { AsyncLocalStorage } from "node:async_hooks";
import type { DigitalAccess, DigitalScope } from "./digital-access.js";
import type { ContextAccess, ContextScope, ContextMutation } from "./context-access.js";

// Identity belongs to the authenticated transport, never to model-supplied arguments.
const identity = new AsyncLocalStorage<DigitalAccess & Omit<ContextAccess, "digitalScopes">>();

export function runWithAgentIdentity<T>(actor: string, operation: () => T, permissions?: { owner: boolean; trustedDeviceId?: string; digitalScopes?: DigitalScope[]; contextScopes?: ContextScope[]; contextCapabilities?: ContextMutation[]; audience?: "private" | "public"; processingLocation?: ContextAccess["processingLocation"]; liveCheck?: () => Promise<boolean> }): T {
  return identity.run({ actor, owner: permissions?.owner ?? actor === "local-owner", trustedDeviceId: permissions?.trustedDeviceId, scopes: permissions?.digitalScopes ?? [], contextScopes: permissions?.contextScopes, contextCapabilities: permissions?.contextCapabilities, audience: permissions?.audience, processingLocation: permissions?.processingLocation ?? (actor === "local-owner" ? "local-only" : actor.startsWith("device:") ? "owned-devices" : "selected-external"), liveCheck: permissions?.liveCheck }, operation);
}

export function currentAgentIdentity(): string {
  return identity.getStore()?.actor ?? "openclaw";
}

export function currentDigitalAccess(): DigitalAccess {
  return identity.getStore() ?? { actor: "openclaw", owner: true, scopes: [] };
}

export function currentContextAccess(): ContextAccess {
  const access = identity.getStore();
  return access ? { ...access, digitalScopes: access.scopes } : { actor: "openclaw", owner: true, processingLocation: "local-only" };
}

export function runWithContextAudience<T>(audience: "private" | "public", operation: () => T): T { const current = identity.getStore() ?? { actor: "openclaw", owner: true, scopes: [], processingLocation: "local-only" as const }; return identity.run({ ...current, audience }, operation); }
