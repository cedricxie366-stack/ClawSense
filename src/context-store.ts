import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicContextJson, workspaceCoordinator, contextRoot } from "./context-coordinator.js";
import { canReadContext, type ContextAccess, type ContextOperation, type ContextPolicy, type ContextSource } from "./context-access.js";
import { noteContextReads } from "./processing-context.js";
export class ContextError extends Error {
    constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
export type ContextRef = {
    kind: string;
    id: string;
    revision?: number;
};
export type ContextRecord = ContextRef & {
    key: string;
    revision: number;
    digest: string;
    sourceStore: "physical" | "workflow" | "digital" | "unified";
    sourceKind?: ContextSource;
    policy: ContextPolicy;
    dependencies: string[];
    encounterIds?: string[];
    deleted?: boolean;
    rawState?: "available" | "expired" | "deleted" | "missing";
    retentionExpiresAt?: number;
    capturedAt?: number;
    receivedAt?: number;
    occurredAt?: number;
    timeBasis?: string;
    authority?: string;
};
type AnalysisVersion = {
    revision: number;
    payloadHash: string;
    recordedAt: number;
    producedAt?: number;
    productionTimeBasis?: "host-analysis-commit" | "legacy-production-time-unknown";
    body?: Record<string, unknown>;
};
export type UnifiedPerson = {
    personId: string;
    displayName: string;
    projectIds: string[];
    revision: number;
    createdAt: number;
    updatedAt?: number;
};
type Alias = {
    source: string;
    legacyId: string;
    personId: string;
    labels: string[];
    ambiguous: boolean;
};
type IdentityLink = {
    linkId: string;
    personId: string;
    otherPersonId?: string;
    platform?: string;
    accountRef?: string;
    externalId?: string;
    speakerScope?: {
        eventId: string;
        deviceId: string;
        label: string;
        startMs?: number;
        endMs?: number;
    };
    sourceRefs: ContextRef[];
    state: "confirmed" | "withdrawn";
    revision: number;
    decidedBy: string;
    authority: string;
    decidedAt: number;
};
export type UnifiedSnapshot = {
    snapshotId: string;
    digest: string;
    createdAt: number;
    contextSequence: number;
    policyEpochAtRead: number;
    deletionEpochAtRead: number;
    dependencies: Array<ContextRef & {
        revision: number;
    }>;
    actor: string;
};
export type ResultReview = {
    resultId: string;
    workItemId: string;
    revision: number;
    state: "pending" | "accepted" | "rejected";
    decidedBy?: string;
    decidedAt?: number;
    authority?: string;
    supersedesResultId?: string;
    reviewedContextSnapshotId?: string;
    contentState: "available" | "purge-pending" | "purged";
    history: Array<{
        revision: number;
        state: string;
        actor: string;
        at: number;
    }>;
};
type Tombstone = {
    tombstoneId: string;
    target: ContextRef;
    intent: "raw-only" | "evidence-and-derived";
    createdAt: number;
    actor: string;
    propagation: "pending" | "managed-copies-purged";
    dedupeKeys: string[];
    affected: string[];
    attempts: number;
    error?: string;
};
type ContextState = {
    version: 1;
    workspaceId: string;
    contextSequence: number;
    policyEpoch: number;
    deletionEpoch: number;
    records: Record<string, ContextRecord>;
    analyses: Record<string, AnalysisVersion[]>;
    aliases: Alias[];
    people: UnifiedPerson[];
    links: IdentityLink[];
    snapshots: UnifiedSnapshot[];
    reviews: ResultReview[];
    tombstones: Tombstone[];
    policyOverrides: Record<string, ContextPolicy>;
    devicePolicies: Record<string, ContextPolicy>;
    sourceFingerprints: Record<string, string>;
    disclosures: Array<{
        disclosureId: string;
        at: number;
        actor: string;
        recipient: string;
        processingLocation: string;
        audience: string;
        refs: ContextRef[];
        digest: string;
        responseStatus?: number;
        responseAt?: number;
        responseUnknown?: boolean;
    }>;
    managedCopies?: Array<{ copyId: string; relativePath: string; refs: ContextRef[]; kind: "query-audio" | "draft" | "checkpoint"; contentState: "available" | "purged" }>;
};
export type LegacyContextState = Record<string, any>;
const instances = new Map<string, UnifiedContextStore>();
const keyOf = (ref: ContextRef) => `${ref.kind}:${ref.id}`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const latestLinks = (state: ContextState) => [...new Map(state.links.map((link) => [link.linkId, link])).values()];
const projectPolicy = (projects: string[] = []): ContextPolicy => ({ projectIds: [...new Set(projects)], audience: "private", processingLocation: "legacy-configured", allowedRecipients: [] });
const ownerRequired = (access: ContextAccess) => { if (!access.owner || access.actor !== "local-owner")
    throw new ContextError("owner_confirmation_required", 403); };
function identifier(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f]/.test(value))
    throw new ContextError("invalid_context_identifier"); }
/** Common catalog; source bodies remain in their original stores. All writes share a coordinator. */
export class UnifiedContextStore {
    readonly root: string;
    readonly file: string;
    private readonly coordinator;
    private purgeIndex?: (eventIds: string[]) => Promise<void>;
    private readonly purgeObservers: Array<() => void> = [];
    private readonly changeObservers: Array<() => void> = [];
    private observedSequence?: number;
    private readonly managedRoots: string[];
    private reconciledSignature?: string;
    private inspectionCache?: { signature: string; state: ContextState };
    constructor(root: string) {
        this.root = contextRoot(root);
        this.file = path.join(this.root, "plugins", "clawsense", "unified", "context.json");
        this.coordinator = workspaceCoordinator(this.root);
        this.managedRoots = ["media", "digital", "assistant-queries", "drafts", "unified/checkpoints"].map((suffix) => path.join(this.root, "plugins", "clawsense", suffix));
        this.managedRoots.push(path.join(this.root, "live", "conversations"), path.join(this.root, "live", "work"));
        this.coordinator.observe({ before: () => this.reconcile(), after: () => this.reconcile() });
        instances.set(this.root, this);
    }
    registerIndexPurger(purger: (eventIds: string[]) => Promise<void>) { this.purgeIndex = purger; }
    registerPurgeObserver(observer: () => void) { this.purgeObservers.push(observer); }
    registerChangeObserver(observer: () => void) { this.changeObservers.push(observer); }
    registerManagedMediaRoot(root: string) { this.managedRoots.push(path.resolve(root)); }
    async initialize(): Promise<void> { await this.coordinator.run(async () => { await this.resumeDeletionsInside(); }); }
    async release(): Promise<void> { this.inspectionCache = undefined; await this.coordinator.release(); }
    async setWorkspaceForMigration(workspaceId: string): Promise<void> { identifier(workspaceId); const state = await this.read(); if (state.workspaceId !== workspaceId) throw new ContextError("workspace_identity_mismatch"); }
    async resetDeletionPropagationForReplay(): Promise<void> { const s = await this.read(); for (const t of s.tombstones) t.propagation = "pending"; await atomicContextJson(this.file, s); }
    async consistent<T>(operation: () => Promise<T>): Promise<T> { return this.coordinator.run(operation); }
    async workspace(): Promise<{
        workspaceId: string;
        contextSequence: number;
        policyEpoch: number;
        deletionEpoch: number;
    }> {
        return this.coordinator.run(async () => { const s = await this.read(); return { workspaceId: s.workspaceId, contextSequence: s.contextSequence, policyEpoch: s.policyEpoch, deletionEpoch: s.deletionEpoch }; });
    }
    async workspaceView(access: ContextAccess): Promise<Record<string, unknown>> { const workspace = await this.workspace(); if (access.owner && access.audience !== "public")
        return workspace; const visible = await this.listRecords(access); return { workspaceId: workspace.workspaceId, viewRevision: hash(visible.map((entry) => entry.ref).sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) }; }
    private async read(): Promise<ContextState> {
        try {
            const info = await fs.lstat(this.file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024)
                throw new Error("invalid_context_file");
            const state = JSON.parse(await fs.readFile(this.file, "utf8"));
            if (state.version !== 1 || typeof state.workspaceId !== "string" || !state.records || !state.analyses || !state.policyOverrides || !state.devicePolicies || !["aliases", "people", "links", "snapshots", "reviews", "tombstones", "disclosures"].every((k) => Array.isArray(state[k])) || !Number.isSafeInteger(state.contextSequence))
                throw new Error("invalid_context_state");
            for (const versions of Object.values(state.analyses) as AnalysisVersion[][]) for (const version of versions) {
                if (version.recordedAt === undefined) {
                    version.recordedAt = version.producedAt ?? 0;
                    delete version.producedAt;
                    version.productionTimeBasis = "legacy-production-time-unknown";
                }
            }
            return state;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return { version: 1, workspaceId: `workspace_${randomUUID()}`, contextSequence: 0, policyEpoch: 0, deletionEpoch: 0, records: {}, analyses: {}, aliases: [], people: [], links: [], snapshots: [], reviews: [], tombstones: [], policyOverrides: {}, devicePolicies: {}, sourceFingerprints: {}, disclosures: [] };
            throw new ContextError("context_store_unreadable", 500);
        }
    }
    /** Read-only inspection under the existing coordinator. Never hand this
     * object to mutations or callers; rights are checked anew on every use. */
    private async inspectionState(): Promise<ContextState> {
        const signature = await this.sourceSignature();
        if (this.inspectionCache?.signature === signature) return this.inspectionCache.state;
        this.inspectionCache = undefined;
        const state = await this.read();
        // An out-of-band replacement while reading must not cache old contents
        // under a new identity. The coordinator still reconciles after failure.
        if (signature !== await this.sourceSignature()) throw new ContextError("context_changed_retry", 409);
        this.inspectionCache = { signature, state };
        return state;
    }
    private async source(store: string): Promise<LegacyContextState | undefined> {
        const suffix = store === "physical" ? ["state.json"] : store === "workflow" ? ["workflows.json"] : ["digital", "context.json"];
        const file = path.join(this.root, "plugins", "clawsense", ...suffix);
        try {
            for (let i = 1; i <= suffix.length; i++)
                if ((await fs.lstat(path.join(this.root, "plugins", "clawsense", ...suffix.slice(0, i)))).isSymbolicLink())
                    throw new Error("context_source_symlink");
            const info = await fs.lstat(file);
            if (!info.isFile() || info.size > 256 * 1024 * 1024)
                throw new Error("invalid_context_source");
            const state = JSON.parse(await fs.readFile(file, "utf8"));
            if (!state || ![1, 2].includes(state.version) || (store !== "physical" && state.version !== 1))
                throw new Error("unsupported_source_schema");
            return state;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
            throw new ContextError("context_source_unreadable", 500);
        }
    }
    private async reconcile(): Promise<void> {
        const signature = await this.sourceSignature();
        if (this.inspectionCache?.signature !== signature) this.inspectionCache = undefined;
        if (signature === this.reconciledSignature) return;
        const s = await this.read(), existed = await fs.access(this.file).then(() => true, () => false);
        const physical = await this.source("physical"), workflow = await this.source("workflow"), digital = await this.source("digital");
        let changed = !existed;
        const present = new Set<string>();
        const aliasDigests = new Map<string, Set<string>>();
        const aliasSources = new Map<string, string>();
        const add = (kind: string, id: string, store: ContextRecord["sourceStore"], value: unknown, options: Partial<ContextRecord> = {}) => {
            if (!id)
                return;
            const key = keyOf({ kind, id });
            present.add(key);
            const previous = s.records[key];
            if (previous && previous.retentionExpiresAt === undefined && options.retentionExpiresAt !== undefined) {
                previous.retentionExpiresAt = options.retentionExpiresAt;
                changed = true;
            }
            const digest = hash(value);
            const policy = s.policyOverrides[key] ?? options.policy ?? previous?.policy ?? projectPolicy();
            const deleted = this.deleted(s, key) || options.deleted === true;
            if (!previous || previous.digest !== digest || previous.deleted !== deleted || previous.rawState !== options.rawState || hash(previous.dependencies) !== hash(options.dependencies ?? []) || hash(previous.policy) !== hash(policy)) {
                changed = true;
                s.records[key] = { key, kind, id, sourceStore: store, dependencies: [], ...options, policy, deleted, digest, revision: (previous?.revision ?? 0) + 1 };
            }
            return s.records[key];
        };
        const alias = (source: string, id: string, label: string, projects: string[], legacyDigest?: string) => {
            if (!id)
                return;
            let item = s.aliases.find((a) => a.source === source && a.legacyId === id);
            if (!item) {
                item = { source, legacyId: id, personId: `person_${hash([s.workspaceId, source, id]).slice(0, 32)}`, labels: [], ambiguous: false };
                s.aliases.push(item);
                changed = true;
            }
            if (label && !item.labels.includes(label)) {
                item.labels.push(label);
                item.ambiguous = item.labels.length > 1;
                changed = true;
            }
            let person = s.people.find((p) => p.personId === item!.personId);
            if (!person) {
                person = { personId: item.personId, displayName: label || "未命名人物", projectIds: projects, revision: 1, createdAt: Date.now() };
                s.people.push(person);
                changed = true;
            }
            const merged = [...new Set([...person.projectIds, ...projects])];
            if (hash(merged) !== hash(person.projectIds)) {
                person.projectIds = merged;
                person.revision++;
                person.updatedAt = Date.now();
                changed = true;
            }
            const digests = aliasDigests.get(person.personId) ?? new Set<string>();
            if (legacyDigest)
                digests.add(legacyDigest);
            aliasDigests.set(person.personId, digests);
            aliasSources.set(person.personId, source);
        };
        for (const a of list(physical?.artifacts)) {
            const presentRaw = typeof a.storagePath === "string" && await fs.lstat(a.storagePath).then((info) => info.isFile() && !info.isSymbolicLink(), (error) => { if (error.code === "ENOENT") return false; throw error; });
            add("artifact", a.artifactId, "physical", { deletedAt: a.deletedAt, retentionExpiresAt: a.retentionExpiresAt, sizeBytes: a.sizeBytes, contentHash: a.contentHash }, { sourceKind: a.modality, rawState: a.deletedAt ? "deleted" : a.retentionExpiresAt <= Date.now() ? "expired" : presentRaw ? "available" : "missing", retentionExpiresAt: a.retentionExpiresAt, capturedAt: a.capturedAt, policy: s.records[keyOf({ kind: "artifact", id: a.artifactId })]?.policy ?? s.devicePolicies[a.deviceId] ?? s.devicePolicies["*"] });
        }
        for (const e of list(physical?.events)) {
            const policy = s.policyOverrides[keyOf({ kind: "evidence", id: e.eventId })] ?? s.records[keyOf({ kind: "evidence", id: e.eventId })]?.policy ?? s.devicePolicies[e.deviceId] ?? s.devicePolicies["*"] ?? projectPolicy();
            const identityRefs = latestLinks(s).filter((l) => l.state === "confirmed" && l.speakerScope?.eventId === e.eventId).flatMap((l) => [`person:${l.personId}`, `identity-link:${l.linkId}`]);
            const personRefs = list(e.peopleRefs).flatMap((id) => { const alias = s.aliases.find((a) => a.source === "physical" && a.legacyId === id); return alias ? [`person:${alias.personId}`] : []; });
            add("evidence", e.eventId, "physical", { deviceId: e.deviceId, artifactId: e.artifactId, windowId: e.windowId, capturedAt: e.capturedAt, receivedAt: e.receivedAt, peopleRefs: e.peopleRefs, projectRefs: e.projectRefs, note: e.note }, { sourceKind: e.modality, capturedAt: e.capturedAt, receivedAt: e.receivedAt, timeBasis: e.receivedAt ? "captured-and-received" : "legacy-received-time-unknown", dependencies: [keyOf({ kind: "artifact", id: e.artifactId }), ...personRefs, ...identityRefs], policy });
            const body = { summary: e.summary, transcript: e.transcript, transcriptSegments: e.transcriptSegments, speakerTimelineSegments: e.speakerTimelineSegments, analysisProvider: e.analysisProvider, analysisStatus: e.analysisStatus, analysisFailureReason: e.analysisFailureReason, sttProvider: e.sttProvider, analysisProducedAt: e.analysisProducedAt };
            const analysis = add("analysis", e.eventId, "physical", body, { sourceKind: e.modality, dependencies: [keyOf({ kind: "evidence", id: e.eventId })], policy });
            if (analysis && !this.deleted(s, analysis.key)) {
                const history = s.analyses[analysis.key] ??= [];
                if (!history.some((v) => v.revision === analysis.revision)) {
                    history.push({ revision: analysis.revision, payloadHash: analysis.digest, recordedAt: Date.now(), ...(e.analysisProducedAt ? { producedAt: e.analysisProducedAt, productionTimeBasis: "host-analysis-commit" as const } : { productionTimeBasis: "legacy-production-time-unknown" as const }), body });
                    changed = true;
                }
            }
            const artifact = s.records[keyOf({ kind: "artifact", id: e.artifactId })];
            if (artifact && !s.policyOverrides[artifact.key] && hash(artifact.policy) !== hash(policy)) {
                artifact.policy = policy;
                artifact.revision++;
                changed = true;
            }
        }
        for (const p of list(physical?.people))
            alias("physical", p.personRef, p.displayName, list(physical?.events).filter((e) => list(e.peopleRefs).includes(p.personRef)).flatMap((e) => s.records[keyOf({ kind: "evidence", id: e.eventId })]?.policy.projectIds ?? []), hash(p));
        for (const speaker of list(physical?.speakers))
            add("speaker", speaker.speakerRef, "physical", speaker, { authority: "legacy-unscoped-speaker-label", policy: projectPolicy() });
        for (const p of list(digital?.people))
            alias("digital", p.personId, p.displayName, p.projectIds, hash([p, ...list(digital?.identities).filter((i) => i.personId === p.personId)]));
        for (const e of list(digital?.events)) {
            const policy = projectPolicy([e.projectId]);
            const person = s.aliases.find((a) => a.source === "digital" && a.legacyId === e.personId);
            add("digital-evidence", e.eventId, "digital", e, { sourceKind: e.sourceType, capturedAt: e.capturedAt, receivedAt: e.receivedAt, occurredAt: e.observedEventTime, timeBasis: e.timeBasis, authority: "device-reported-source", deleted: !!e.deletedAt, policy, dependencies: person ? [keyOf({ kind: "person", id: person.personId })] : [] });
            if (e.artifactId)
                add("digital-artifact", e.eventId, "digital", { deletedAt: e.deletedAt, rawDeletedAt: e.rawDeletedAt, contentHash: e.contentHash }, { sourceKind: e.sourceType, rawState: e.deletedAt || e.rawDeletedAt ? "deleted" : "available", dependencies: [keyOf({ kind: "digital-evidence", id: e.eventId })], policy });
        }
        for (const session of list(workflow?.sessions)) {
            for (const p of list(session.participants))
                alias("workflow", p.personId, p.displayName, session.projectId ? [session.projectId] : [], hash(p));
            const dependencies = list(physical?.events).filter((e) => (!session.deviceId || session.deviceId === e.deviceId) && e.capturedAt >= session.startedAt && e.capturedAt <= (session.endedAt ?? Date.now())).flatMap((e) => [keyOf({ kind: "evidence", id: e.eventId }), keyOf({ kind: "analysis", id: e.eventId })]);
            dependencies.push(...list(digital?.events).filter((e) => e.sessionId === session.sessionId).map((e) => keyOf({ kind: "digital-evidence", id: e.eventId })));
            dependencies.push(...list(session.participants).flatMap((p) => { const a = s.aliases.find((a) => a.source === "workflow" && a.legacyId === p.personId); return a ? [keyOf({ kind: "person", id: a.personId })] : []; }));
            add("encounter", session.sessionId, "workflow", session, { policy: projectPolicy(session.projectId ? [session.projectId] : []), dependencies });
        }
        for (const correction of list(workflow?.corrections)) {
            const encounter = s.records[keyOf({ kind: "encounter", id: correction.sessionId })];
            add("assertion", correction.correctionId, "workflow", correction, { policy: encounter?.policy, dependencies: [keyOf({ kind: "encounter", id: correction.sessionId }), ...list(correction.sourceEventIds).map((id) => keyOf({ kind: "evidence", id })), ...list(correction.sourceRefs).map(keyOf)], authority: correction.confirmationAuthority ?? (correction.actor === "local-owner" ? "owner-confirmation" : "agent-reported-user-confirmation") });
        }
        for (const work of list(workflow?.workItems)) {
            const encounter = s.records[keyOf({ kind: "encounter", id: work.sessionId })];
            const snapshot = s.snapshots.find((snap) => snap.snapshotId === work.unifiedContextSnapshotId);
            const dependencies = snapshot ? snapshot.dependencies.map(keyOf) : [keyOf({ kind: "encounter", id: work.sessionId }), ...(encounter?.dependencies ?? [])];
            add("work", work.workItemId, "workflow", work, { policy: encounter?.policy, dependencies });
            if (work.status === "completed") {
                const resultId = `result_${hash([s.workspaceId, work.workItemId, work.completedAt]).slice(0, 32)}`;
                add("result", resultId, "workflow", { workItemId: work.workItemId, resultText: work.resultText, resultTitle: work.resultTitle }, { policy: encounter?.policy, dependencies });
                if (!s.reviews.some((r) => r.resultId === resultId)) {
                    s.reviews.push({ resultId, workItemId: work.workItemId, revision: 1, state: "pending", contentState: "available", history: [] });
                    changed = true;
                }
            }
        }
        for (const person of s.people)
            add("person", person.personId, "unified", { ...person, legacyDigest: aliasDigests.has(person.personId) ? hash([...aliasDigests.get(person.personId)!].sort()) : undefined }, { policy: projectPolicy(person.projectIds), sourceKind: aliasSources.get(person.personId) === "digital" ? "contact_selection" : undefined });
        const encounters = Object.values(s.records).filter((record) => record.kind === "encounter" && !record.deleted);
        for (const record of Object.values(s.records)) record.encounterIds = [...new Set([...(record.kind === "encounter" ? [record.id] : []), ...encounters.filter((encounter) => encounter.dependencies.includes(record.key) || record.dependencies.includes(encounter.key)).map((encounter) => encounter.id)])];
        for (const link of latestLinks(s)) {
            const person = s.people.find((p) => p.personId === link.personId);
            add("identity-link", link.linkId, "unified", link, { policy: projectPolicy(person?.projectIds), dependencies: link.sourceRefs.map(keyOf), authority: link.authority });
        }
        for (const [key, record] of Object.entries(s.records))
            if (record.sourceStore !== "unified" && !present.has(key) && !record.deleted) {
                record.deleted = true;
                record.revision++;
                changed = true;
            }
        let fingerprintsChanged = false;
        for (const [kind, source] of [["physical", physical], ["workflow", workflow], ["digital", digital]] as const)
            if (source) {
                const fingerprint = hash(source);
                if (s.sourceFingerprints[kind] !== fingerprint) {
                    s.sourceFingerprints[kind] = fingerprint;
                    fingerprintsChanged = true;
                }
            }
        if (changed)
            s.contextSequence++;
        // Snapshot/checkpoint writes change the file identity, but not the legacy catalog.
        // Rewriting it again here adds fsync/JSON work and invalidates hot-path metadata.
        if (changed || fingerprintsChanged) await atomicContextJson(this.file, s);
        this.reconciledSignature = await this.sourceSignature();
        this.observeSequence(s.contextSequence);
    }
    private observeSequence(sequence: number) { const previous = this.observedSequence; this.observedSequence = sequence; if (previous !== undefined && previous !== sequence) for (const observer of this.changeObservers) queueMicrotask(observer); }
    private async sourceIdentity() { const files = [this.file, ...["state.json", "workflows.json", "digital/context.json"].map((file) => path.join(this.root, "plugins", "clawsense", file))]; const values = await Promise.all(files.map(async (file) => { const info = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; }); if (info?.isSymbolicLink()) throw new ContextError("context_source_unreadable", 500); return info ? [info.ino, info.size, info.mtimeMs, info.ctimeMs] : null; })); return { signature: hash(values), legacy: hash(values.slice(1)), catalog: values[0] }; }
    private async sourceSignature(): Promise<string> { return (await this.sourceIdentity()).signature; }
    /** Only snapshot/copy metadata: never use this path for policy, identity or source edits. */
    private async writeSnapshotMetadata(s: ContextState): Promise<void> {
        const before = await this.sourceIdentity();
        const known = before.signature === this.reconciledSignature;
        let written: { ino: number; size: number; mtimeMs: number } | undefined;
        await atomicContextJson(this.file, s, identity => { written = identity; });
        const after = await this.sourceIdentity();
        const catalog = after.catalog;
        // An external replacement must not be mistaken for our own metadata
        // commit. Source edits still use the full reconciliation and rights path.
        if (known && written && catalog && after.legacy === before.legacy &&
            catalog[0] === written.ino && catalog[1] === written.size && catalog[2] === written.mtimeMs) {
            this.reconciledSignature = after.signature;
            this.observeSequence(s.contextSequence);
        }
    }
    private deleted(s: ContextState, key: string): boolean { return s.tombstones.some((t) => t.intent === "evidence-and-derived" && t.affected.includes(key)); }
    private async live(access: ContextAccess) { if (access.liveCheck && !(await access.liveCheck()))
        throw new ContextError("context_access_revoked", 403); }
    private assertReadable(s: ContextState, key: string, operation: ContextOperation, access: ContextAccess, dependencies = false) {
        const record = s.records[key];
        if (!record || record.deleted || this.deleted(s, key))
            throw new ContextError("context_unavailable", 404);
        if (record.kind === "person" && !access.owner && access.contextScopes === undefined && !s.aliases.some((a) => a.personId === record.id && ["physical", "workflow"].includes(a.source)) && !(access.digitalScopes ?? []).some((scope) => record.policy.projectIds.some((project) => scope.projectId === "*" || scope.projectId === project)))
            throw new ContextError("context_unavailable", 404);
        if (!canReadContext(access, record.policy, operation, record.sourceKind, record.encounterIds ?? []))
            throw new ContextError("context_unavailable", 404);
        if (operation === "read-raw" && this.rawState(record) && this.rawState(record) !== "available")
            throw new ContextError("raw_context_unavailable", 404);
        if (dependencies)
            for (const dep of record.dependencies) {
                const dependency = s.records[dep];
                if (dependency?.kind === "artifact") {
                    if (this.deleted(s, dep))
                        throw new ContextError("context_unavailable", 404);
                    continue;
                }
                this.assertReadable(s, dep, dependency?.kind === "encounter" || dependency?.kind === "person" ? "read-metadata" : "read-analysis", access);
            }
        return record;
    }
    async assertAccess(ref: ContextRef, operation: ContextOperation, access: ContextAccess, dependencies = false): Promise<ContextRecord> {
        return this.coordinator.run(async () => { await this.live(access); return this.assertReadable(await this.read(), keyOf(ref), operation, access, dependencies); });
    }
    async setPolicy(refs: ContextRef[], policy: ContextPolicy, access: ContextAccess): Promise<void> {
        ownerRequired(access);
        validatePolicy(policy);
        await this.coordinator.run(async () => { const s = await this.read(); for (const ref of refs) {
            const r = s.records[keyOf(ref)];
            if (!r)
                throw new ContextError("context_not_found", 404);
            s.policyOverrides[r.key] = structuredClone(policy);
            r.policy = structuredClone(policy);
            r.revision++;
        } s.policyEpoch++; s.contextSequence++; await atomicContextJson(this.file, s); });
    }
    async setDevicePolicy(deviceId: string, policy: ContextPolicy, access: ContextAccess): Promise<void> { ownerRequired(access); identifier(deviceId); validatePolicy(policy); await this.coordinator.run(async () => { const s = await this.read(); s.devicePolicies[deviceId] = structuredClone(policy); s.policyEpoch++; await atomicContextJson(this.file, s); }); }
    async listPeople(access: ContextAccess): Promise<Array<UnifiedPerson & {
        aliases: Alias[];
        links: IdentityLink[];
    }>> {
        return this.coordinator.run(async () => { await this.live(access); const s = await this.read(); const readable = (id: string) => { try {
            this.assertReadable(s, keyOf({ kind: "person", id }), "read-metadata", access);
            return true;
        }
        catch (error) {
            if (!(error instanceof ContextError))
                throw error;
            return false;
        } }; return s.people.filter((p) => readable(p.personId)).map((p) => ({ ...p, projectIds: access.owner ? p.projectIds : p.projectIds.filter((id) => access.contextScopes?.some((scope) => scope.projectId === "*" || scope.projectId === id) || access.digitalScopes?.some((scope) => scope.projectId === "*" || scope.projectId === id)), aliases: access.owner ? s.aliases.filter((a) => a.personId === p.personId) : [], links: s.links.filter((link) => link.personId === p.personId && (!link.otherPersonId || readable(link.otherPersonId)) && (!link.externalId || canReadContext(access, projectPolicy(p.projectIds), "read-metadata", "contact_selection")) && !link.sourceRefs.some((ref) => { try {
                this.assertReadable(s, keyOf(ref), "read-metadata", access);
                return false;
            }
            catch (error) {
                if (!(error instanceof ContextError))
                    throw error;
                return true;
            } })) })); });
    }
    async createPerson(displayName: string, projectIds: string[], access: ContextAccess): Promise<UnifiedPerson> {
        ownerRequired(access);
        if (!displayName.trim() || displayName.length > 200)
            throw new ContextError("invalid_person_label");
        projectIds.forEach(identifier);
        return this.coordinator.run(async () => { const s = await this.read(); const person = { personId: `person_${randomUUID()}`, displayName: displayName.trim(), projectIds: [...new Set(projectIds)], revision: 1, createdAt: Date.now() }; s.people.push(person); s.records[keyOf({ kind: "person", id: person.personId })] = { key: keyOf({ kind: "person", id: person.personId }), kind: "person", id: person.personId, revision: 1, digest: hash(person), sourceStore: "unified", policy: projectPolicy(person.projectIds), dependencies: [] }; s.contextSequence++; await atomicContextJson(this.file, s); return person; });
    }
    async linkPerson(input: {
        personId: string;
        otherPersonId?: string;
        platform?: string;
        accountRef?: string;
        externalId?: string;
        sourceRefs?: ContextRef[];
        expectedRevision: number;
        withdrawLinkId?: string;
    }, access: ContextAccess): Promise<IdentityLink> {
        ownerRequired(access);
        return this.coordinator.run(async () => {
            const s = await this.read(), person = s.people.find((p) => p.personId === input.personId);
            if (!person)
                throw new ContextError("person_not_found", 404);
            if (person.revision !== input.expectedRevision)
                throw new ContextError("revision_conflict", 409);
            for (const ref of input.sourceRefs ?? [])
                this.assertReadable(s, keyOf(ref), "read-metadata", access);
            let link: IdentityLink;
            if (input.withdrawLinkId) {
                const previous = latestLinks(s).find((l) => l.linkId === input.withdrawLinkId && l.personId === person.personId);
                if (!previous)
                    throw new ContextError("identity_link_not_found", 404);
                link = { ...previous, state: "withdrawn", revision: previous.revision + 1, decidedAt: Date.now(), decidedBy: access.actor };
                s.links.push(link);
            }
            else {
                if (input.otherPersonId && !s.people.some((p) => p.personId === input.otherPersonId && p.personId !== person.personId))
                    throw new ContextError("other_person_not_found");
                if (!input.otherPersonId && ![input.platform, input.accountRef, input.externalId].every((id) => typeof id === "string" && id.trim()))
                    throw new ContextError("identity_target_required");
                if (latestLinks(s).some((l) => l.state === "confirmed" && input.externalId && l.platform === input.platform && l.accountRef === input.accountRef && l.externalId === input.externalId && l.personId !== person.personId))
                    throw new ContextError("identity_already_linked", 409);
                link = { linkId: `link_${randomUUID()}`, personId: person.personId, otherPersonId: input.otherPersonId, platform: input.platform, accountRef: input.accountRef, externalId: input.externalId, sourceRefs: input.sourceRefs ?? [], state: "confirmed", revision: 1, decidedBy: access.actor, authority: "owner-confirmation", decidedAt: Date.now() };
                s.links.push(link);
            }
            person.revision++;
            person.updatedAt = Date.now();
            if (link.otherPersonId) {
                const other = s.people.find((p) => p.personId === link.otherPersonId)!;
                other.revision++;
                other.updatedAt = Date.now();
            }
            s.contextSequence++;
            await atomicContextJson(this.file, s);
            return link;
        });
    }
    async linkSpeaker(input: {
        personId: string;
        eventId: string;
        label: string;
        startMs?: number;
        endMs?: number;
        expectedRevision: number;
    }, access: ContextAccess): Promise<IdentityLink> {
        ownerRequired(access);
        identifier(input.label);
        return this.coordinator.run(async () => {
            const s = await this.read(), person = s.people.find((p) => p.personId === input.personId);
            if (!person)
                throw new ContextError("person_not_found", 404);
            if (person.revision !== input.expectedRevision)
                throw new ContextError("revision_conflict", 409);
            this.assertReadable(s, `evidence:${input.eventId}`, "read-analysis", access);
            const event = list((await this.source("physical"))?.events).find((e) => e.eventId === input.eventId && e.modality === "audio");
            if (!event)
                throw new ContextError("speaker_audio_evidence_required");
            if ((input.startMs !== undefined && (!Number.isFinite(input.startMs) || input.startMs < 0)) || (input.endMs !== undefined && (!Number.isFinite(input.endMs) || input.endMs <= (input.startMs ?? 0))))
                throw new ContextError("invalid_speaker_range");
            if (latestLinks(s).some((l) => l.state === "confirmed" && l.speakerScope?.eventId === input.eventId && l.speakerScope?.label === input.label && l.personId !== input.personId))
                throw new ContextError("speaker_scope_already_linked", 409);
            const link: IdentityLink = { linkId: `link_${randomUUID()}`, personId: person.personId, speakerScope: { eventId: input.eventId, deviceId: event.deviceId, label: input.label, startMs: input.startMs, endMs: input.endMs }, sourceRefs: [{ kind: "evidence", id: input.eventId }], state: "confirmed", revision: 1, decidedBy: access.actor, authority: "owner-selected-speaker-link", decidedAt: Date.now() };
            s.links.push(link);
            person.revision++;
            person.updatedAt = Date.now();
            s.contextSequence++;
            await atomicContextJson(this.file, s);
            return link;
        });
    }
    async snapshot(refs: ContextRef[], access: ContextAccess): Promise<UnifiedSnapshot> {
        if (refs.length > 1000)
            throw new ContextError("too_many_context_dependencies");
        return this.coordinator.run(async () => {
            await this.live(access);
            const s = await this.read();
            return this.snapshotInside(s, refs, access);
        });
    }
    private async snapshotInside(s: ContextState, refs: ContextRef[], access: ContextAccess): Promise<UnifiedSnapshot> {
            const dependencies = new Map<string, ContextRef & {
                revision: number;
            }>();
            const include = (ref: ContextRef) => { const key = keyOf(ref); if (dependencies.has(key))
                return; const r = this.assertReadable(s, key, rOperation(ref.kind), access); dependencies.set(key, { kind: r.kind, id: r.id, revision: r.revision }); if (r.kind !== "encounter")
                for (const k of r.dependencies) {
                    const d = s.records[k];
                    if (d)
                        include(d);
                } };
            refs.forEach(include);
            const values = [...dependencies.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
            const digest = hash(values);
            const snapshot = { snapshotId: `context_${randomUUID()}`, digest, dependencies: values, contextSequence: s.contextSequence, policyEpochAtRead: s.policyEpoch, deletionEpochAtRead: s.deletionEpoch, actor: access.actor, createdAt: Date.now() };
            s.snapshots.push(snapshot);
            await this.writeSnapshotMetadata(s);
            return snapshot;
    }
    async inspectSnapshot(snapshotId: string, access: ContextAccess): Promise<{
        state: "current" | "stale";
        snapshot: UnifiedSnapshot;
        changedRefs: ContextRef[];
    }> {
        return this.coordinator.run(async () => { await this.live(access); const s = await this.inspectionState(); const snap = s.snapshots.find((item) => item.snapshotId === snapshotId); if (!snap)
            throw new ContextError("context_snapshot_unavailable", 404); const changedRefs: ContextRef[] = []; for (const ref of snap.dependencies) {
            const r = this.assertReadable(s, keyOf(ref), rOperation(ref.kind), access);
            if (r.revision !== ref.revision)
                changedRefs.push(ref);
        } return { state: changedRefs.length ? "stale" : "current", snapshot: structuredClone(snap), changedRefs: structuredClone(changedRefs) }; });
    }
    async inspectSnapshots(snapshotIds: string[], access: ContextAccess): Promise<Array<{ snapshotId: string; state: "current" | "stale" | "unavailable"; snapshot?: UnifiedSnapshot }>> {
      return this.coordinator.run(async () => { await this.live(access); const s = await this.inspectionState(); return [...new Set(snapshotIds)].map(snapshotId => {
        try { const snapshot = s.snapshots.find(item=>item.snapshotId===snapshotId); if (!snapshot) return { snapshotId, state: "unavailable" as const };
          const stale = snapshot.dependencies.some(ref=>this.assertReadable(s,keyOf(ref),rOperation(ref.kind),access).revision!==ref.revision);
          // some() must not skip permission checks after the first stale source.
          for (const ref of snapshot.dependencies) this.assertReadable(s,keyOf(ref),rOperation(ref.kind),access);
          return { snapshotId, state: stale ? "stale" as const : "current" as const, snapshot: structuredClone(snapshot) };
        } catch (error) { if (!(error instanceof ContextError)) throw error; return { snapshotId, state: "unavailable" as const }; }
      }); });
    }
    async workReview(workItemId: string, access: ContextAccess): Promise<ResultReview | undefined> { return this.coordinator.run(async () => { await this.live(access); const s = await this.read(); const result = s.reviews.find((r) => r.workItemId === workItemId); if (result)
        this.assertReadable(s, keyOf({ kind: "result", id: result.resultId }), "read-result", access, true); return result; }); }
    async reviewResult(input: {
        resultId: string;
        state: "accepted" | "rejected";
        expectedRevision: number;
        supersedesResultId?: string;
    }, access: ContextAccess): Promise<ResultReview> {
        ownerRequired(access);
        return this.coordinator.run(async () => {
          const s = await this.read(), review = s.reviews.find((r) => r.resultId === input.resultId);
          if (!review) throw new ContextError("result_not_found", 404);
          this.assertReadable(s, keyOf({ kind: "result", id: input.resultId }), "read-result", access, true);
          if (review.revision !== input.expectedRevision) throw new ContextError("revision_conflict", 409);
          if (!["accepted", "rejected"].includes(input.state)) throw new ContextError("invalid_review_state");
          if (input.state === "accepted" && !(await this.isResultCurrent(review.workItemId, access))) throw new ContextError("result_source_stale", 409);
          if (input.state === "accepted" && !review.reviewedContextSnapshotId) {
            const snapshot = await this.snapshotInside(s, [{ kind: "result", id: review.resultId }], access);
            review.reviewedContextSnapshotId = snapshot.snapshotId;
          }
          if (input.supersedesResultId) {
            const previous = s.reviews.find((r) => r.resultId === input.supersedesResultId);
            if (!previous || previous.resultId === review.resultId)
                throw new ContextError("superseded_result_not_found");
            this.assertReadable(s, keyOf({ kind: "result", id: previous.resultId }), "read-result", access, true);
            let ancestor: ResultReview | undefined = previous;
            const seen = new Set<string>();
            while (ancestor) { if (ancestor.resultId === review.resultId || seen.has(ancestor.resultId)) throw new ContextError("result_supersession_cycle", 409); seen.add(ancestor.resultId); ancestor = s.reviews.find((r) => r.resultId === ancestor!.supersedesResultId); }
            review.supersedesResultId = previous.resultId;
        } review.history.push({ revision: ++review.revision, state: input.state, actor: access.actor, at: Date.now() }); review.state = input.state; review.decidedBy = access.actor; review.decidedAt = Date.now(); review.authority = "owner-confirmation"; s.contextSequence++; await atomicContextJson(this.file, s); return review; });
    }
    async selectedResults(access: ContextAccess): Promise<ResultReview[]> {
      return this.coordinator.run(async () => {
        await this.live(access); const s = await this.read();
        const superseded = new Set(s.reviews.filter((r) => r.state === "accepted").map((r) => r.supersedesResultId));
        const selected: ResultReview[] = [];
        for (const review of s.reviews.filter((r) => r.state === "accepted" && r.contentState === "available" && !superseded.has(r.resultId))) {
          try { this.assertReadable(s, `result:${review.resultId}`, "read-result", access, true); if (await this.isResultCurrent(review.workItemId, access)) selected.push(review); }
          catch (error) { if (!(error instanceof ContextError)) throw error; }
        }
        return selected;
      });
    }
    async disclosure(refs: ContextRef[], recipient: string, processingLocation: "local-only" | "owned-devices" | "selected-external", access: ContextAccess): Promise<string> {
        identifier(recipient);
        return this.coordinator.run(async () => { await this.live(access); const s = await this.read(); for (const ref of refs) {
            const r = this.assertReadable(s, keyOf(ref), rOperation(ref.kind), access);
            if ((r.policy.processingLocation === "local-only" && processingLocation !== "local-only") || (processingLocation === "selected-external" && r.policy.processingLocation !== "legacy-configured" && (r.policy.processingLocation !== "selected-external" || !r.policy.allowedRecipients.includes(recipient))))
                throw new ContextError("external_processing_not_authorized", 403);
        } const disclosureId = `disclosure_${randomUUID()}`; s.disclosures.push({ disclosureId, at: Date.now(), actor: access.actor, recipient, processingLocation, audience: access.audience ?? "private", refs, digest: hash(refs) }); await atomicContextJson(this.file, s); return disclosureId; });
    }
    async analysisHistory(eventId: string, access: ContextAccess): Promise<AnalysisVersion[]> { return this.coordinator.run(async () => { const s = await this.read(); this.assertReadable(s, keyOf({ kind: "analysis", id: eventId }), "read-analysis", access); return s.analyses[keyOf({ kind: "analysis", id: eventId })] ?? []; }); }
    async assertCaptureNotDeleted(deviceId: string, capturedAt: number, modality: string): Promise<void> { await this.coordinator.run(async () => { const s = await this.read(); if (s.tombstones.some((t) => t.dedupeKeys.includes(hash([deviceId, capturedAt, modality]))))
        throw new ContextError("capture_deleted", 410); }); }
    async deleteEvidence(ref: ContextRef, intent: Tombstone["intent"], access: ContextAccess): Promise<Tombstone> {
        if (!access.owner || (access.actor !== "local-owner" && !access.actor.startsWith("device:")))
            throw new ContextError("owner_deletion_required", 403);
        return this.coordinator.run(async () => {
            const s = await this.read();
            const target = s.records[keyOf(ref)];
            if (!target)
                throw new ContextError("context_not_found", 404);
            const previous = s.tombstones.find((t) => keyOf(t.target) === target.key && t.intent === intent);
            if (previous) {
                await this.resumeDeletionsInside();
                return previous;
            }
            const affected = new Set<string>([target.key]);
            const physical = await this.source("physical");
            const event = list(physical?.events).find((e) => e.eventId === ref.id || e.artifactId === ref.id);
        const workflow = await this.source("workflow");
        if (event && intent === "evidence-and-derived") {
          const related = list(workflow?.sessions).filter((session) => (!session.deviceId || session.deviceId === event.deviceId) && event.capturedAt >= session.startedAt && event.capturedAt <= (session.endedAt ?? Date.now())).map((session) => session.sessionId);
          for (const correction of list(workflow?.corrections)) if (related.includes(correction.sessionId) && !list(correction.sourceEventIds).length && !list(correction.sourceRefs).length) affected.add(`assertion:${correction.correctionId}`);
        }
        if (event && intent === "evidence-and-derived") {
                affected.add(keyOf({ kind: "evidence", id: event.eventId }));
                affected.add(keyOf({ kind: "analysis", id: event.eventId }));
                affected.add(keyOf({ kind: "artifact", id: event.artifactId }));
            }
            if (intent === "evidence-and-derived") {
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const r of Object.values(s.records))
                    if (r.kind !== "encounter" && !affected.has(r.key) && r.dependencies.some((key) => affected.has(key))) {
                            affected.add(r.key);
                            changed = true;
                        }
                }
            }
            if (!["artifact", "evidence", "digital-evidence", "digital-artifact", "live-observation"].includes(ref.kind)) throw new ContextError("unsupported_deletion_target");
            if (ref.kind === "live-observation" && intent !== "evidence-and-derived") throw new ContextError("live_observation_has_no_raw_file");
            const tombstone: Tombstone = { tombstoneId: `tombstone_${randomUUID()}`, target: ref, intent, createdAt: Date.now(), actor: access.actor, propagation: "pending", dedupeKeys: event ? [hash([event.deviceId, event.capturedAt, event.modality])] : [], affected: [...affected], attempts: 0 };
            s.tombstones.push(tombstone);
            s.deletionEpoch++;
            s.contextSequence++;
            await atomicContextJson(this.file, s);
            if (intent === "evidence-and-derived") for (const observer of this.purgeObservers) observer();
            await this.resumeDeletionsInside();
            return (await this.read()).tombstones.find((t) => t.tombstoneId === tombstone.tombstoneId)!;
        });
    }
    async resumeDeletions(): Promise<void> { await this.coordinator.run(() => this.resumeDeletionsInside()); }
    private async resumeDeletionsInside(): Promise<void> {
        const s = await this.read();
        for (const tombstone of s.tombstones.filter((t) => t.propagation === "pending")) {
            tombstone.attempts++;
            try {
                const physical = await this.source("physical"), digital = await this.source("digital"), workflow = await this.source("workflow");
                const affected = new Set(tombstone.affected);
                const events = list(physical?.events).filter((e) => affected.has(keyOf({ kind: "evidence", id: e.eventId })) || affected.has(keyOf({ kind: "artifact", id: e.artifactId })));
                const ids = events.map((e) => e.eventId), windows = events.map((e) => e.windowId), dates = events.map((e) => new Date(e.capturedAt).toISOString().slice(0, 10));
                const files: string[] = [];
                for (const a of list(physical?.artifacts))
                    if (affected.has(keyOf({ kind: "artifact", id: a.artifactId })) || events.some((e) => e.artifactId === a.artifactId)) {
                        a.deletedAt ??= Date.now();
                        a.deletionReason = tombstone.intent;
                        if (typeof a.storagePath === "string")
                            files.push(a.storagePath);
                    }
                if (physical && tombstone.intent === "evidence-and-derived") {
                    for (const e of events) {
                        e.summary = "Deleted evidence";
                        delete e.transcript;
                        delete e.transcriptSegments;
                        delete e.speakerTimelineSegments;
                        delete e.note;
                        e.peopleRefs = [];
                        e.tags = [];
                        e.analysisStatus = "degraded";
                        e.analysisFailureReason = "evidence_deleted";
                    }
                    physical.journal = list(physical.journal).filter((j) => !ids.includes(j.eventId ?? j.memoryId));
                    physical.reviews = list(physical.reviews).filter((r) => !dates.includes(r.date));
                    physical.consolidations = list(physical.consolidations).filter((r) => !dates.includes(r.date));
                    physical.conversationDigests = list(physical.conversationDigests).filter((r) => !events.some((e) => e.capturedAt >= r.startAt && e.capturedAt <= r.endAt));
                    physical.memoryCards = list(physical.memoryCards).filter((r) => !list(r.sourceEventIds).some((id) => ids.includes(id)) && !list(r.sourceWindowIds).some((id) => windows.includes(id)));
                }
                if (digital)
                    for (const e of list(digital.events))
                        if (affected.has(keyOf({ kind: "digital-evidence", id: e.eventId })) || affected.has(keyOf({ kind: "digital-artifact", id: e.eventId }))) {
                            if (e.artifactId)
                                files.push(path.join(this.root, "plugins", "clawsense", "digital", `${e.eventId}.media`));
                            if (tombstone.intent === "evidence-and-derived") {
                                e.deletedAt ??= Date.now();
                                e.revision++;
                                e.text = "";
                                e.title = "Deleted context";
                                delete e.contact;
                                delete e.claimedApp;
                                delete e.correctionHistory;
                            }
                    else e.rawDeletedAt ??= Date.now();
                        }
                if (workflow && tombstone.intent === "evidence-and-derived") {
                    const sessionIds = list(workflow.sessions).filter((session) => affected.has(keyOf({ kind: "encounter", id: session.sessionId }))).map((session) => session.sessionId);
                    for (const c of list(workflow.corrections))
                        if (sessionIds.includes(c.sessionId) || affected.has(keyOf({ kind: "assertion", id: c.correctionId })))
                            c.text = "Deleted source context";
                    for (const work of list(workflow.workItems))
                        if (sessionIds.includes(work.sessionId) || affected.has(keyOf({ kind: "work", id: work.workItemId }))) {
                            work.instructions = "Deleted source context";
                            work.title = "Deleted source context";
                            if (work.status === "completed") {
                                work.resultText = "Deleted source context";
                                work.resultTitle = "Deleted source context";
                            }
                        }
                    for (const session of list(workflow.sessions))
                        if (sessionIds.includes(session.sessionId))
                            session.title = "Deleted source context";
                }
                if (physical)
                    await atomicContextJson(path.join(this.root, "plugins", "clawsense", "state.json"), physical);
                if (digital)
                    await atomicContextJson(path.join(this.root, "plugins", "clawsense", "digital", "context.json"), digital);
                if (workflow)
                    await atomicContextJson(path.join(this.root, "plugins", "clawsense", "workflows.json"), workflow);
                for (const file of files) {
                    const info = await fs.lstat(file).catch((e) => { if (e.code === "ENOENT")
                        return null; throw e; });
                    if (info?.isSymbolicLink() || (info && !info.isFile()))
                        throw new Error("unsafe_managed_media");
                    if (info) { const real = await fs.realpath(file); if (!this.managedRoots.some((root) => real.startsWith(root + path.sep))) throw new Error("unowned_managed_media"); await fs.unlink(file); }
                }
                if (tombstone.intent === "evidence-and-derived") {
                    if (ids.length && this.purgeIndex)
                        await this.purgeIndex(ids);
                    else if (ids.length && await fs.access(path.join(this.root, "plugins", "clawsense", "memory-index")).then(() => true, () => false))
                        throw new Error("managed_index_purge_unavailable");
                    for (const key of affected) {
                        for (const version of s.analyses[key] ?? [])
                            delete version.body;
                        const r = s.records[key];
                        if (r)
                            r.deleted = true;
                    }
                    for (const review of s.reviews)
                        if (affected.has(keyOf({ kind: "result", id: review.resultId })))
                            review.contentState = "purged";
                    for (const link of s.links)
                        if (link.sourceRefs.some((ref) => affected.has(keyOf(ref)))) {
                            link.state = "withdrawn";
                            delete link.accountRef;
                            delete link.externalId;
                        }
                    for (const copy of s.managedCopies ?? []) if (copy.contentState === "available" && copy.refs.some((ref) => affected.has(keyOf(ref)))) { const file = path.resolve(this.root, copy.relativePath); if (!this.managedRoots.some((root) => file.startsWith(root + path.sep))) throw new Error("unsafe_managed_copy"); await fs.rm(file, { force: true }); copy.contentState = "purged"; }
                }
                tombstone.propagation = "managed-copies-purged";
                delete tombstone.error;
            }
            catch {
                tombstone.error = "managed_purge_retry_required";
            }
            await atomicContextJson(this.file, s);
        }
    }
    async filterLegacy(store: "physical" | "workflow" | "digital", state: LegacyContextState, access: ContextAccess): Promise<LegacyContextState> {
        return this.coordinator.run(async () => {
            await this.live(access);
            const s = await this.read();
            const next = structuredClone(state);
            const allowed = (kind: string, id: string, op: ContextOperation = "read-analysis") => { try {
                this.assertReadable(s, keyOf({ kind, id }), op, access, kind === "work" || kind === "assertion");
                return true;
            }
            catch (error) {
                if (!(error instanceof ContextError))
                    throw error;
                return false;
            } };
            if (store === "physical") {
                next.events = list(next.events).filter((e) => allowed("evidence", e.eventId));
                next.events.forEach((e: any) => { e.analysisRevision = s.records[keyOf({ kind: "analysis", id: e.eventId })]?.revision; });
                const personVisible = (id: string) => { try {
                    this.assertReadable(s, `person:${id}`, "read-metadata", access);
                    return true;
                }
                catch (error) {
                    if (!(error instanceof ContextError))
                        throw error;
                    return false;
                } };
                for (const e of next.events) {
                    e.peopleRefs = [...new Set([...list(e.peopleRefs).filter((id) => { const a = s.aliases.find((a) => a.source === "physical" && a.legacyId === id); return !a || personVisible(a.personId); }), ...latestLinks(s).filter((l) => l.state === "confirmed" && l.speakerScope?.eventId === e.eventId && l.speakerScope?.deviceId === e.deviceId && personVisible(l.personId)).map((l) => l.personId)])];
                }
                next.speakers = [];
                for (const person of s.people) {
                    const eventIds = next.events.filter((e: any) => list(e.peopleRefs).includes(person.personId)).map((e: any) => e.eventId);
                    if (eventIds.length)
                        next.people.push({ annotationId: `unified:${person.personId}`, personRef: person.personId, displayName: person.displayName, eventIds, createdAt: person.createdAt, updatedAt: person.updatedAt ?? person.createdAt });
                }
                noteContextReads(next.events.map((e: any) => ({ kind: "analysis", id: e.eventId })));
                next.artifacts = list(next.artifacts).filter((a) => allowed("artifact", a.artifactId, "read-metadata"));
                next.journal = list(next.journal).filter((j) => allowed("evidence", j.eventId ?? j.memoryId));
                if (!access.owner || access.audience === "public" || access.processingLocation === "selected-external") {
                    const deviceIds = new Set(next.events.map((e: any) => e.deviceId));
                    next.devices = list(next.devices).filter((d) => deviceIds.has(d.deviceId));
                    next.setupTokens = [];
                    next.people = list(next.people).filter((p) => next.events.some((e: any) => list(e.peopleRefs).includes(p.personRef)));
                    for (const field of ["reviews", "consolidations", "conversationDigests", "memoryCards"])
                        next[field] = [];
                }
            }
            else if (store === "workflow") {
                next.sessions = list(next.sessions).filter((session) => allowed("encounter", session.sessionId, "read-metadata"));
                const visibleSessionIds = new Set(next.sessions.map((session: any) => session.sessionId));
                for (const session of next.sessions)
                    if (session.previousSessionId && !visibleSessionIds.has(session.previousSessionId)) {
                        delete session.previousSessionId;
                        session.previousContextUnavailable = true;
                    }
                const ids = new Set(next.sessions.map((session: any) => session.sessionId));
                next.corrections = list(next.corrections).filter((c) => ids.has(c.sessionId) && allowed("assertion", c.correctionId));
                next.workItems = list(next.workItems).filter((work) => ids.has(work.sessionId) && allowed("work", work.workItemId, "read-result"));
            }
            else {
                next.events = list(next.events).filter((event) => allowed("digital-evidence", event.eventId));
                noteContextReads(next.events.map((e: any) => ({ kind: "digital-evidence", id: e.eventId })));
            }
            return next;
        });
    }
    async legacyPersonIds(personId: string, source: "physical" | "workflow" | "digital", access: ContextAccess): Promise<string[]> {
        return this.coordinator.run(async () => {
            await this.live(access);
            const s = await this.read();
            const seed = s.aliases.find((a) => a.source === source && a.legacyId === personId)?.personId ?? personId;
            try {
                this.assertReadable(s, `person:${seed}`, "read-metadata", access);
            }
            catch (error) {
                if (!(error instanceof ContextError))
                    throw error;
                return [];
            }
            if (s.aliases.some((a) => a.personId === seed && a.ambiguous))
                throw new ContextError("legacy_identity_requires_review", 409);
            const group = new Set([seed]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const link of latestLinks(s).filter((l) => l.state === "confirmed" && l.otherPersonId))
                    if (group.has(link.personId) || group.has(link.otherPersonId!)) {
                        const size = group.size;
                        group.add(link.personId);
                        group.add(link.otherPersonId!);
                        changed ||= group.size > size;
                    }
            }
            return s.aliases.filter((a) => a.source === source && group.has(a.personId) && canReadContext(access, s.records[keyOf({ kind: "person", id: a.personId })]?.policy ?? projectPolicy(), "read-metadata")).map((a) => a.legacyId);
        });
    }
    async canonicalLegacyPerson(source: "physical" | "workflow" | "digital", legacyId: string, access: ContextAccess): Promise<string | undefined> {
      return this.coordinator.run(async () => { const s = await this.read(); const alias = s.aliases.find(a => a.source === source && a.legacyId === legacyId); if (!alias) return; this.assertReadable(s, `person:${alias.personId}`, "read-metadata", access); return alias.personId; });
    }
    async refsForEncounter(sessionId: string, access: ContextAccess): Promise<ContextRef[]> {
        return this.coordinator.run(async () => { await this.live(access); const s = await this.read(), encounter = this.assertReadable(s, keyOf({ kind: "encounter", id: sessionId }), "read-metadata", access); return [encounter, ...encounter.dependencies.map((key) => s.records[key]).filter((r) => { if (!r || r.deleted)
                return false; try {
                this.assertReadable(s, r.key, rOperation(r.kind), access);
                return true;
            }
            catch (error) {
                if (!(error instanceof ContextError))
                    throw error;
                return false;
            } })].map(({ kind, id }) => ({ kind, id })); });
    }
    async exportContext(refs: ContextRef[], access: ContextAccess): Promise<{
        workspaceId: string;
        snapshot: UnifiedSnapshot;
        entries: unknown[];
    }> {
        return this.coordinator.run(async () => {
            await this.live(access);
            const s = await this.read();
            const physical = await this.source("physical"), digital = await this.source("digital"), workflow = await this.source("workflow");
            const entries = refs.map((ref) => {
                const record = this.assertReadable(s, keyOf(ref), rOperation(ref.kind), access, ref.kind === "result" || ref.kind === "work");
                let body: unknown;
                if (ref.kind === "analysis" || ref.kind === "evidence") {
                    const event = list(physical?.events).find((e) => e.eventId === ref.id);
                    if (event) {
                        const { sourcePath: _path, ...safe } = event;
                        body = safe;
                    }
                }
                else if (ref.kind === "digital-evidence")
                    body = list(digital?.events).find((e) => e.eventId === ref.id);
                else if (ref.kind === "encounter")
                    body = list(workflow?.sessions).find((e) => e.sessionId === ref.id);
                else if (ref.kind === "work" || ref.kind === "result") {
                    const workId = ref.kind === "work" ? ref.id : s.reviews.find((r) => r.resultId === ref.id)?.workItemId;
                    body = list(workflow?.workItems).find((e) => e.workItemId === workId);
                }
                else if (ref.kind === "person")
                    body = s.people.find((p) => p.personId === ref.id);
                else if (ref.kind === "assertion")
                    body = list(workflow?.corrections).find((c) => c.correctionId === ref.id);
                else if (ref.kind === "live-observation")
                    body = s.analyses[record.key]?.at(-1)?.body;
                return { ref: { ...ref, revision: record.revision }, source: { workspaceId: s.workspaceId, projectIds: record.policy.projectIds.filter(id => access.owner || access.contextScopes?.some(scope => scope.projectId === "*" || scope.projectId === id)), sourceKind: record.sourceKind, capturedAt: record.capturedAt, receivedAt: record.receivedAt, occurredAt: record.occurredAt, timeBasis: record.timeBasis, authority: record.authority }, body };
            });
            return { workspaceId: s.workspaceId, snapshot: await this.snapshot(refs, access), entries };
        });
    }
    async deletionStatus(access: ContextAccess) { ownerRequired(access); return this.coordinator.run(async () => (await this.read()).tombstones.map(({ dedupeKeys: _keys, affected, ...job }) => ({ ...job, managedAffectedCount: affected.length, externalCopies: "unknown" }))); }
    async listRecords(access: ContextAccess): Promise<Array<{
        ref: ContextRef;
        sourceKind?: ContextSource;
        capturedAt?: number;
        receivedAt?: number;
        occurredAt?: number;
        rawState?: string;
    }>> { return this.coordinator.run(async () => { await this.live(access); const s = await this.read(); return Object.values(s.records).filter((record) => { try {
        this.assertReadable(s, record.key, "read-metadata", access);
        return true;
    }
    catch (error) {
        if (!(error instanceof ContextError))
            throw error;
        return false;
    } }).map((r) => ({ ref: { kind: r.kind, id: r.id, revision: r.revision }, sourceKind: r.sourceKind, capturedAt: r.capturedAt, receivedAt: r.receivedAt, occurredAt: r.occurredAt, rawState: this.rawState(r) })); }); }
    private rawState(record: ContextRecord): ContextRecord["rawState"] {
        return record.rawState === "available" && record.retentionExpiresAt !== undefined && record.retentionExpiresAt <= Date.now() ? "expired" : record.rawState;
    }
    async legacyAnnotations(access: ContextAccess) { ownerRequired(access); return this.coordinator.run(async () => { const physical = await this.source("physical"), s = await this.read(); return { speakers: list(physical?.speakers).map((speaker) => ({ ...speaker, interpretation: "Legacy annotation candidate, not a globally confirmed voice identity; confirm one event/device/interval using speaker_link." })), ambiguousPeople: s.aliases.filter((a) => a.ambiguous) }; }); }
    async registerManagedCopy(file: string, refs: ContextRef[], kind: "query-audio" | "draft" | "checkpoint"): Promise<void> {
      const resolved = path.resolve(file); if (!this.managedRoots.some((root) => resolved.startsWith(root + path.sep))) throw new ContextError("unowned_managed_copy");
      await this.coordinator.run(async () => { const s = await this.read(); const copies = s.managedCopies ??= []; const relativePath = path.relative(this.root, resolved); const previous = copies.find((copy) => copy.relativePath === relativePath); if (previous) { previous.refs = refs; previous.kind = kind; previous.contentState = "available"; } else copies.push({ copyId: `copy_${randomUUID()}`, relativePath, refs, kind, contentState: "available" }); await this.writeSnapshotMetadata(s); });
    }
    async refsInRange(startAt: number, endAt: number, access: ContextAccess, deviceId?: string): Promise<ContextRef[]> { return this.coordinator.run(async () => { const s = await this.read(); const physical = await this.source("physical"); return list(physical?.events).filter((event) => event.capturedAt >= startAt && event.capturedAt <= endAt && (!deviceId || event.deviceId === deviceId)).flatMap((event) => { try { this.assertReadable(s, `analysis:${event.eventId}`, "read-analysis", access); return [{ kind: "analysis", id: event.eventId }]; } catch (error) { if (!(error instanceof ContextError)) throw error; return []; } }); }); }
    async devicePolicy(deviceId: string): Promise<ContextPolicy> { return this.coordinator.run(async () => { const s = await this.read(); return s.devicePolicies[deviceId] ?? s.devicePolicies["*"] ?? projectPolicy(); }); }
    /** Live observations have provenance and policy, but are never owner-confirmed facts. No raw image is stored here. */
    async recordLiveObservation(deviceId: string, projectId: string, input: { text: string; capturedAt: number; digest: string; modality: "image" | "audio" }, access: ContextAccess): Promise<ContextRef> {
      if (access.trustedDeviceId !== deviceId || access.actor !== `device:${deviceId}`) throw new ContextError("trusted_device_required", 403);
      identifier(projectId);
      if (!input.text.trim() || input.text.length > 16000 || !Number.isFinite(input.capturedAt) || !/^[a-f0-9]{64}$/.test(input.digest)) throw new ContextError("invalid_live_observation");
      return this.coordinator.run(async () => {
        await this.live(access); const s = await this.read();
        const policy = s.devicePolicies[deviceId] ?? s.devicePolicies["*"] ?? projectPolicy();
        if (!policy.projectIds.includes(projectId) || !canReadContext(access, policy, "read-analysis", input.modality)) throw new ContextError("context_access_revoked", 403);
        const id = `live_${randomUUID()}`, key = `live-observation:${id}`;
        s.records[key] = { kind: "live-observation", id, key, revision: 1, digest: input.digest, sourceStore: "unified", sourceKind: input.modality, capturedAt: input.capturedAt, receivedAt: Date.now(), timeBasis: "device-reported-capture", authority: input.modality === "image" ? "model-observation" : "user-stated-unconfirmed", policy: structuredClone(policy), dependencies: [] };
        s.analyses[key] = [{ revision: 1, payloadHash: hash(input.text), recordedAt: Date.now(), body: { text: input.text, deviceId } }];
        s.contextSequence++; await atomicContextJson(this.file, s); return { kind: "live-observation", id, revision: 1 };
      });
    }
    async policies(refs: ContextRef[], access: ContextAccess): Promise<ContextPolicy[]> { return this.coordinator.run(async () => { await this.live(access); const s = await this.read(); return refs.map((ref) => this.assertReadable(s, keyOf(ref), rOperation(ref.kind), access).policy); }); }
    async checkLive(access: ContextAccess): Promise<void> { await this.live(access); }
    async disclosureOutcome(disclosureId: string, responseStatus?: number): Promise<void> { await this.coordinator.run(async () => { const s = await this.read(); const receipt = s.disclosures.find((d) => d.disclosureId === disclosureId); if (receipt) {
        receipt.responseAt = Date.now();
        receipt.responseStatus = responseStatus;
        receipt.responseUnknown = responseStatus === undefined;
        await atomicContextJson(this.file, s);
    } }); }
    async disclosureReceipts(access: ContextAccess) { ownerRequired(access); return this.coordinator.run(async () => (await this.read()).disclosures); }
    async validateDeviceCache(snapshotId: string, deviceId: string): Promise<{ snapshotId: string; state: "current" | "stale" | "unavailable" }> {
      return this.coordinator.run(async () => {
        const s = await this.read(); const snapshot = s.snapshots.find((snap) => snap.snapshotId === snapshotId && snap.actor === `device:${deviceId}`);
        if (!snapshot) return { snapshotId, state: "unavailable" };
        try { const result = await this.inspectSnapshot(snapshotId, { owner: true, actor: `device:${deviceId}`, processingLocation: "owned-devices" }); return { snapshotId, state: result.state }; }
        catch (error) { if (!(error instanceof ContextError)) throw error; return { snapshotId, state: "unavailable" }; }
      });
    }
    async isResultCurrent(workItemId: string, access: ContextAccess): Promise<boolean> { return this.coordinator.run(async () => { const s = await this.read(); const workflow = await this.source("workflow"); const work = list(workflow?.workItems).find((w) => w.workItemId === workItemId); if (!work)
        return false; const session = list(workflow?.sessions).find((session) => session.sessionId === work.sessionId); if (!session || session.revision !== work.inputRevision)
        return false; if (work.unifiedContextSnapshotId)
        return (await this.inspectSnapshot(work.unifiedContextSnapshotId, access)).state === "current";
        const review = s.reviews.find((r) => r.workItemId === workItemId);
        return review?.reviewedContextSnapshotId ? (await this.inspectSnapshot(review.reviewedContextSnapshotId, access)).state === "current" : true; }); }
    async authorizeMutation(store: "physical" | "workflow", before: Record<string, string>, next: LegacyContextState, access: ContextAccess): Promise<void> {
        await this.live(access);
        if (access.owner || access.contextScopes === undefined)
            return;
        const s = await this.read();
        const requireCapability = (capability: import("./context-access.js").ContextMutation) => { if (!access.contextCapabilities?.includes(capability))
            throw new ContextError("context_mutation_not_authorized", 403); };
        if (store === "workflow") {
            for (const session of list(next.sessions))
                if (before[`encounter:${session.sessionId}`] !== hash(session)) {
                    if (before[`encounter:${session.sessionId}`] && before[`encounter-metadata:${session.sessionId}`] === hash(sessionMetadata(session))) continue;
                    requireCapability(before[`encounter:${session.sessionId}`] ? "update-encounter" : "create-encounter");
                    if (!session.projectId || !canReadContext(access, projectPolicy([session.projectId]), "read-metadata"))
                        throw new ContextError("context_mutation_not_authorized", 403);
                    if (before[`encounter:${session.sessionId}`])
                        this.assertReadable(s, `encounter:${session.sessionId}`, "read-metadata", access);
                }
            for (const correction of list(next.corrections))
                if (before[`assertion:${correction.correctionId}`] !== hash(correction)) {
                    requireCapability("record-user-correction");
                    this.assertReadable(s, `encounter:${correction.sessionId}`, "read-metadata", access);
                    for (const id of list(correction.sourceEventIds))
                        this.assertReadable(s, `evidence:${id}`, "read-analysis", access);
                    if (correction.actor !== access.actor)
                        throw new ContextError("untrusted_correction_actor", 403);
                }
            for (const work of list(next.workItems))
                if (before[`work:${work.workItemId}`] !== hash(work)) {
                    requireCapability(before[`work:${work.workItemId}`] ? "complete-work" : "create-work");
                    this.assertReadable(s, `encounter:${work.sessionId}`, "read-metadata", access);
                    if (before[`work:${work.workItemId}`])
                        this.assertReadable(s, `work:${work.workItemId}`, "read-result", access, true);
                }
        }
        else {
            for (const event of list(next.events))
                if (before[`evidence:${event.eventId}`] !== hash(event)) {
                    requireCapability("reanalyze-evidence");
                    this.assertReadable(s, `evidence:${event.eventId}`, "read-raw", access);
                }
            for (const person of list(next.people))
                if (before[`person:${person.personRef}`] !== hash(person)) {
                    requireCapability("record-user-correction");
                    if (!list(next.events).some((e) => list(e.peopleRefs).includes(person.personRef) && canReadContext(access, s.records[`evidence:${e.eventId}`]?.policy ?? projectPolicy(), "read-analysis", e.modality)))
                        throw new ContextError("context_mutation_not_authorized", 403);
                }
            if (["devices", "setupTokens", "artifacts", "speakers"].some((field) => before[`array:${field}`] !== hash(next[field] ?? [])))
                throw new ContextError("context_mutation_not_authorized", 403);
        }
    }
}
function rOperation(kind: string): ContextOperation { return kind === "artifact" || kind === "digital-artifact" || kind === "person" || kind === "encounter" ? "read-metadata" : kind === "work" || kind === "result" ? "read-result" : "read-analysis"; }
function validatePolicy(policy: ContextPolicy) {
    if (!policy || !Array.isArray(policy.projectIds) || !Array.isArray(policy.allowedRecipients) || !["private", "public"].includes(policy.audience) || !["local-only", "owned-devices", "selected-external", "legacy-configured"].includes(policy.processingLocation))
        throw new ContextError("invalid_context_policy");
    [...policy.projectIds, ...policy.allowedRecipients].forEach(identifier);
}
export function contextFor(root: string): UnifiedContextStore | undefined { return instances.get(contextRoot(root)); }
export function snapshotView(snapshot: UnifiedSnapshot, access: ContextAccess): Record<string, unknown> { if (access.owner && access.audience !== "public")
    return snapshot; const { contextSequence: _sequence, policyEpochAtRead: _policy, deletionEpochAtRead: _deletion, ...publicView } = snapshot; return publicView; }
export function unifiedContext(root: string): UnifiedContextStore { return contextFor(root) ?? new UnifiedContextStore(root); }
export async function seedContextForMigration(root: string, workspaceId: string): Promise<void> {
  identifier(workspaceId);
  const file = path.join(contextRoot(root), "plugins", "clawsense", "unified", "context.json");
  if (await fs.access(file).then(() => true, () => false)) throw new ContextError("context_seed_already_exists");
  await atomicContextJson(file, { version: 1, workspaceId, contextSequence: 0, policyEpoch: 0, deletionEpoch: 0, records: {}, analyses: {}, aliases: [], people: [], links: [], snapshots: [], reviews: [], tombstones: [], policyOverrides: {}, devicePolicies: {}, sourceFingerprints: {}, disclosures: [], managedCopies: [] });
}
export function mutationSignatures(store: "physical" | "workflow", state: LegacyContextState): Record<string, string> {
    const output: Record<string, string> = {};
    const fields = store === "workflow" ? [["sessions", "encounter", "sessionId"], ["corrections", "assertion", "correctionId"], ["workItems", "work", "workItemId"]] : [["events", "evidence", "eventId"], ["people", "person", "personRef"]];
    for (const [field, kind, id] of fields)
        for (const value of list(state[field]))
            output[`${kind}:${value[id]}`] = hash(value);
    if (store === "workflow") for (const session of list(state.sessions)) output[`encounter-metadata:${session.sessionId}`] = hash(sessionMetadata(session));
    if (store === "physical")
        for (const field of ["devices", "setupTokens", "artifacts", "speakers"])
            output[`array:${field}`] = hash(state[field] ?? []);
    return output;
}
function sessionMetadata(session: LegacyContextState): unknown { const { revision: _revision, updatedAt: _updated, updatedBy: _actor, ...metadata } = session; return metadata; }
