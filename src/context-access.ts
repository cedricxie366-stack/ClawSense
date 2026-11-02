export const CONTEXT_SOURCES = ["audio", "image", "video", "shared_text", "shared_image", "contact_selection"] as const;
export type ContextSource = typeof CONTEXT_SOURCES[number];
export const CONTEXT_OPERATIONS = ["read-metadata", "read-analysis", "read-raw", "read-result"] as const;
export type ContextOperation = typeof CONTEXT_OPERATIONS[number];
export const CONTEXT_MUTATIONS = ["create-encounter", "update-encounter", "record-user-correction", "create-work", "complete-work", "reanalyze-evidence"] as const;
export type ContextMutation = typeof CONTEXT_MUTATIONS[number];
export type ContextScope = {
    projectId: string;
    encounterIds?: string[];
    sourceKinds?: ContextSource[];
    operations: ContextOperation[];
};
export type ContextAccess = {
    actor: string;
    owner: boolean;
    /** Set only by a transport that has authenticated this paired device. */
    trustedDeviceId?: string;
    /** Undefined preserves a legacy physical grant; [] explicitly denies it. */
    contextScopes?: ContextScope[];
    contextCapabilities?: ContextMutation[];
    digitalScopes?: Array<{
        projectId: string;
        sourceTypes?: string[];
        allowRaw?: boolean;
    }>;
    audience?: "private" | "public";
    processingLocation?: "local-only" | "owned-devices" | "selected-external";
    liveCheck?: () => Promise<boolean>;
};
export type ContextPolicy = {
    projectIds: string[];
    audience: "private" | "public";
    processingLocation: "local-only" | "owned-devices" | "selected-external" | "legacy-configured";
    allowedRecipients: string[];
};
export function normalizeContextScopes(input: unknown): ContextScope[] | undefined {
    if (input === undefined)
        return undefined;
    if (!Array.isArray(input) || input.length > 100)
        throw new Error("invalid_context_scopes");
    return input.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["projectId", "encounterIds", "sourceKinds", "operations"].includes(key)))
            throw new Error("invalid_context_scopes");
        const ids = (values: unknown) => {
            if (!Array.isArray(values) || !values.length || values.some((id) => typeof id !== "string" || !id.trim() || id.length > 300 || /[\u0000-\u001f]/.test(id)))
                throw new Error("invalid_context_scopes");
            return [...new Set(values as string[])];
        };
        if (typeof value.projectId !== "string" || !value.projectId.trim() || value.projectId.length > 300 || /[\u0000-\u001f]/.test(value.projectId))
            throw new Error("invalid_context_scopes");
        const operations = ids(value.operations);
        if (operations.some((op) => !(CONTEXT_OPERATIONS as readonly string[]).includes(op)))
            throw new Error("invalid_context_scopes");
        const sourceKinds = value.sourceKinds === undefined ? undefined : ids(value.sourceKinds);
        if (sourceKinds?.some((kind) => !(CONTEXT_SOURCES as readonly string[]).includes(kind)))
            throw new Error("invalid_context_scopes");
        return { projectId: value.projectId.trim(), operations: operations as ContextOperation[], ...(sourceKinds ? { sourceKinds: sourceKinds as ContextSource[] } : {}), ...(value.encounterIds ? { encounterIds: ids(value.encounterIds) } : {}) };
    });
}
export function normalizeContextCapabilities(input: unknown): ContextMutation[] | undefined {
    if (input === undefined)
        return undefined;
    if (!Array.isArray(input) || input.some((item) => !(CONTEXT_MUTATIONS as readonly unknown[]).includes(item)))
        throw new Error("invalid_context_capabilities");
    return [...new Set(input)] as ContextMutation[];
}
export function canReadContext(access: ContextAccess, policy: ContextPolicy, operation: ContextOperation, source?: ContextSource, encounterIds: string[] = []): boolean {
    if (access.audience === "public" && policy.audience !== "public")
        return false;
    const recipientLocation = access.processingLocation ?? (access.owner ? "local-only" : "selected-external");
    if ((!access.owner || access.actor === "openclaw") && ((policy.processingLocation === "local-only" && recipientLocation !== "local-only") || (policy.processingLocation === "owned-devices" && recipientLocation === "selected-external"))) return false;
    if (access.owner)
        return true;
    const ownedDevice = access.trustedDeviceId !== undefined && access.actor === `device:${access.trustedDeviceId}` && recipientLocation === "owned-devices";
    if (!ownedDevice && policy.allowedRecipients.length && !policy.allowedRecipients.includes(`agent:${access.actor}`) && !policy.allowedRecipients.includes(access.actor))
        return false;
    if (access.contextScopes !== undefined)
        return access.contextScopes.some((scope) => policy.projectIds.some((project) => scope.projectId === "*" || scope.projectId === project) && scope.operations.includes(operation) &&
            (!scope.sourceKinds || source === undefined || scope.sourceKinds.includes(source)) &&
            (!scope.encounterIds || encounterIds.some((id) => scope.encounterIds!.includes(id))));
    if (!source || ["audio", "image", "video"].includes(source))
        return true;
    return (access.digitalScopes ?? []).some((scope) => policy.projectIds.some((project) => scope.projectId === "*" || scope.projectId === project) &&
        (!scope.sourceTypes || scope.sourceTypes.includes(source)) && (operation !== "read-raw" || scope.allowRaw === true));
}
