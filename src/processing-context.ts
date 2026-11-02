import { AsyncLocalStorage } from "node:async_hooks";
import { ContextError, contextFor, type ContextRef, type UnifiedContextStore } from "./context-store.js";
import { currentContextAccess } from "./tool-context.js";
import type { ContextAccess, ContextPolicy } from "./context-access.js";
type Processing = {
    store: UnifiedContextStore;
    refs: ContextRef[];
    access: ContextAccess;
    preliminaryPolicy?: ContextPolicy;
};
const active = new AsyncLocalStorage<Processing>();
export async function withRequestProcessing<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const store = contextFor(root);
    if (!store || active.getStore())
        return operation();
    return active.run({ store, refs: [], access: currentContextAccess(), preliminaryPolicy: await store.devicePolicy("*") }, operation);
}
export function noteContextReads(refs: ContextRef[]): void {
    const context = active.getStore();
    if (!context)
        return;
    for (const ref of refs)
        if (!context.refs.some((item) => item.kind === ref.kind && item.id === ref.id))
            context.refs.push(ref);
}
export async function withEvidenceProcessing<T>(root: string, refs: ContextRef[], operation: () => Promise<T>): Promise<T> {
    const store = contextFor(root);
    if (!store)
        return operation();
    return active.run({ store, refs, access: currentContextAccess() }, operation);
}
export async function withDeviceProcessing<T>(root: string, deviceId: string, operation: () => Promise<T>): Promise<T> {
    const store = contextFor(root);
    if (!store)
        return operation();
    return active.run({ store, refs: [], access: currentContextAccess(), preliminaryPolicy: await store.devicePolicy(deviceId) }, operation);
}
export async function assertOpaqueRuntimeProcessing(recipient: string): Promise<void> {
    const context = active.getStore();
    if (!context)
        return;
    const policies = context.preliminaryPolicy ? [context.preliminaryPolicy] : await context.store.policies(context.refs, context.access);
    if (policies.some((policy) => policy.processingLocation !== "legacy-configured" && !policy.allowedRecipients.includes(recipient)))
        throw new ContextError("runtime_processing_not_authorized", 403);
}
/** OpenAI-compatible transport; the actual recipient is the URL origin, not the SDK name. */
export async function contextAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const context = active.getStore();
    if (!context)
        return fetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const recipient = `provider:${url.origin}`;
    const location = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? "owned-devices" : "selected-external";
    if (context.preliminaryPolicy) {
        const policy = context.preliminaryPolicy;
        if (policy.processingLocation === "local-only" || (policy.processingLocation !== "legacy-configured" && (location === "selected-external" && (policy.processingLocation !== "selected-external" || !policy.allowedRecipients.includes(recipient)))))
            throw new ContextError("external_processing_not_authorized", 403);
    }
    const disclosureId = await context.store.disclosure(context.refs, recipient, location, context.access);
    try {
        const response = await fetch(input, init);
        await context.store.disclosureOutcome(disclosureId, response.status);
        await context.store.checkLive(context.access);
        await context.store.policies(context.refs, context.access);
        return response;
    }
    catch (error) {
        await context.store.disclosureOutcome(disclosureId).catch(() => { });
        throw error;
    }
}
