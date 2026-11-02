import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AnyAgentTool } from "./openclaw-types.js";
import { currentContextAccess } from "./tool-context.js";
import { ContextError, UnifiedContextStore, snapshotView, type ContextRef } from "./context-store.js";
import type { ContextPolicy } from "./context-access.js";
const id = Type.String({ minLength: 1, maxLength: 300 });
const ref = Type.Object({ kind: id, id }, { additionalProperties: false });
const refs = Type.Array(ref, { maxItems: 1000 });
const revision = Type.Integer({ minimum: 1 });
const policy = Type.Object({ projectIds: Type.Array(id, { maxItems: 100 }), audience: Type.Union([Type.Literal("private"), Type.Literal("public")]), processingLocation: Type.Union([Type.Literal("local-only"), Type.Literal("owned-devices"), Type.Literal("selected-external"), Type.Literal("legacy-configured")]), allowedRecipients: Type.Array(id, { maxItems: 100 }) }, { additionalProperties: false });
export function createContextTools(store: UnifiedContextStore): AnyAgentTool[] {
    const tool = (name: string, description: string, properties: Record<string, TSchema>, run: (input: any) => Promise<unknown>, ownerOnly = false): AnyAgentTool => {
        const parameters = Type.Object(properties, { additionalProperties: false });
        return { name, description, parameters, ...(ownerOnly ? { ownerOnly: true } : {}), async execute(_callId, input) {
                try {
                    if (!Value.Check(parameters, input))
                        throw new ContextError("invalid_context_arguments");
                    const payload = await run(input);
                    const details = { ok: true, ...(payload as Record<string, unknown>) };
                    return { content: [{ type: "text", text: JSON.stringify(details) }], details };
                }
                catch (error) {
                    const details = { ok: false, error: error instanceof ContextError ? error.code : "context_operation_failed", statusCode: error instanceof ContextError ? error.statusCode : 500 };
                    return { content: [{ type: "text", text: JSON.stringify(details) }], details };
                }
            } };
    };
    return [
        tool("clawsense_workspace", "Read the persistent workspace identity and an authorized-view revision. Private activity outside your scope is not counted.", {}, async () => store.workspaceView(currentContextAccess())),
        tool("clawsense_context_list", "List authorized metadata references without text, private paths or unauthorized counts. Analysis and raw permissions remain separate.", {}, async () => ({ entries: await store.listRecords(currentContextAccess()) })),
        tool("clawsense_people", "List authorized canonical people and explicitly confirmed relationships. Equal names or legacy IDs never merge people automatically.", {}, async () => ({ people: await store.listPeople(currentContextAccess()) })),
        tool("clawsense_legacy_annotations", "Owner-only review of retained legacy speaker labels and ambiguous person aliases. They do not automatically establish cross-recording identity.", {}, async () => store.legacyAnnotations(currentContextAccess()), true),
        tool("clawsense_person_create", "The authenticated local owner creates a distinct canonical person; names are labels, not unique identifiers.", { displayName: Type.String({ minLength: 1, maxLength: 200 }), projectIds: Type.Array(id, { maxItems: 100 }) }, async (input) => ({ person: await store.createPerson(input.displayName, input.projectIds, currentContextAccess()) }), true),
        tool("clawsense_person_link", "The local owner explicitly confirms or withdraws a cross-source person or account relationship. An agent cannot attest that a human confirmed it. Links are reversible; original aliases remain.", { personId: id, otherPersonId: Type.Optional(id), platform: Type.Optional(id), accountRef: Type.Optional(id), externalId: Type.Optional(id), sourceRefs: Type.Optional(refs), expectedRevision: revision, withdrawLinkId: Type.Optional(id) }, async (input) => ({ link: await store.linkPerson(input, currentContextAccess()) }), true),
        tool("clawsense_speaker_link", "Owner-selected speaker attribution is scoped to one audio event, device and optional interval. The same speaker label in another recording never inherits this identity.", { personId: id, eventId: id, label: id, startMs: Type.Optional(Type.Number({ minimum: 0 })), endMs: Type.Optional(Type.Number({ minimum: 0 })), expectedRevision: revision }, async (input) => ({ link: await store.linkSpeaker(input, currentContextAccess()) }), true),
        tool("clawsense_context_policy", "The local owner assigns project, private/public audience and processing recipient rules to selected evidence. This does not send any content.", { refs, policy }, async (input) => { await store.setPolicy(input.refs as ContextRef[], input.policy as ContextPolicy, currentContextAccess()); return { updated: true }; }, true),
        tool("clawsense_device_context_policy", "Set owner-approved default context policy for future captures from one device. Existing evidence is not silently reassigned.", { deviceId: id, policy }, async (input) => { await store.setDevicePolicy(input.deviceId, input.policy, currentContextAccess()); return { updated: true }; }, true),
        tool("clawsense_context_snapshot", "Create an immutable snapshot of authorized evidence, analysis, identity and encounter versions. An unrelated workspace change does not make all work stale.", { refs }, async (input) => ({ snapshot: snapshotView(await store.snapshot(input.refs, currentContextAccess()), currentContextAccess()) })),
        tool("clawsense_context_snapshot_get", "Check every snapshot dependency and current authorization. Deleted/revoked inputs cannot be read via an old snapshot.", { snapshotId: id }, async (input) => { const result = await store.inspectSnapshot(input.snapshotId, currentContextAccess()); return { ...result, snapshot: snapshotView(result.snapshot, currentContextAccess()) }; }),
        tool("clawsense_analysis_history", "Read authorized versioned machine analysis, keeping earlier ASR/visual interpretations separate from raw recordings and user assertions.", { eventId: id }, async (input) => ({ versions: await store.analysisHistory(input.eventId, currentContextAccess()) })),
        tool("clawsense_result_review", "Only the local owner accepts/rejects saved work, optionally explicitly superseding an earlier result. Accepted does not mean sent or delivered.", { resultId: id, state: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]), expectedRevision: revision, supersedesResultId: Type.Optional(id) }, async (input) => ({ review: await store.reviewResult(input, currentContextAccess()) }), true),
        tool("clawsense_selected_results", "List authorized accepted results that have not been explicitly superseded. Pending or rejected drafts are not default reusable results.", {}, async () => ({ results: await store.selectedResults(currentContextAccess()) })),
        tool("clawsense_context_delete", "Owner deletion first blocks reads with a tombstone. raw-only keeps authorized analysis; evidence-and-derived propagates through managed copies. Pending purge is not complete erasure, and external agent copies remain unknown.", { ref, intent: Type.Union([Type.Literal("raw-only"), Type.Literal("evidence-and-derived")]) }, async (input) => ({ deletion: await store.deleteEvidence(input.ref, input.intent, currentContextAccess()) }), true),
        tool("clawsense_deletion_status", "Read owner-only deletion propagation receipts without deleted content. Failed cleanup is retried and stays unreadable.", {}, async () => ({ deletions: await store.deletionStatus(currentContextAccess()) }), true),
        tool("clawsense_context_export", "Export selected authorized versioned context; does not start capture, speak publicly or send a message. Rechecks source permissions and records the disclosure boundary.", { refs }, async (input) => {
            const access = currentContextAccess();
            const recipient = access.owner ? "owner-export" : `agent:${access.actor}`;
            const disclosureId = await store.disclosure(input.refs, recipient, access.owner ? "local-only" : "selected-external", access);
            const exported = await store.exportContext(input.refs, access);
            return { disclosureId, ...exported, snapshot: snapshotView(exported.snapshot, access) };
        }),
        tool("clawsense_disclosure_receipts", "Owner-only audit of authorized processing attempts and response status. These metadata receipts do not prove provider erasure or successful inference.", {}, async () => ({ receipts: await store.disclosureReceipts(currentContextAccess()) }), true),
    ];
}
