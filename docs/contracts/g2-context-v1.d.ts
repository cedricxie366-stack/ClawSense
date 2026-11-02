/** G2 draft contract. Not imported by the application or exposed as an API. */
export type SourceKind = "physical-audio" | "physical-image" | "physical-video" | "shared-text" | "shared-image" | "selected-contact";
export type ObjectKind = "person" | "identity-link" | "encounter" | "evidence" | "artifact" | "analysis" | "assertion" | "result" | "snapshot";
export interface ObjectRef {
  workspaceId: string;
  kind: ObjectKind;
  objectId: string;
  revision: number;
}
export interface ActorContext {
  /** Filled by authenticated transport, never by a model tool argument. */
  principalId: string;
  principalKind: "owner" | "agent" | "device";
  grantId?: string;
  grantRevision?: number;
}
export interface Workspace {
  schemaVersion: 1;
  workspaceId: string;
  ownerPrincipalId: string;
  revision: number;
  policyEpoch: number;
  deletionEpoch: number;
}
export interface Person {
  workspaceId: string;
  personId: string;
  revision: number;
  displayName: string;
  projectIds: string[];
  state: "active" | "retired";
}
export interface IdentityLink {
  workspaceId: string;
  linkId: string;
  personId: string;
  revision: number;
  subject:
    | { kind: "external"; platform: string; accountRef: string; externalIdRef: string }
    | { kind: "speaker"; deviceId: string; evidenceId: string; speakerLabel: string; startMs?: number; endMs?: number }
    | { kind: "legacy-alias"; store: "physical" | "workflow" | "digital"; legacyIdRef: string };
  status: "proposed" | "confirmed" | "rejected" | "withdrawn";
  decisionActor?: ActorContext;
  decisionAt?: number;
  evidenceRefs: ObjectRef[];
}
export interface EventTime {
  /** Recording/share time and host receipt time are not interchangeable. */
  capturedAt: number;
  receivedAt: number;
  occurredAt?: { startAt: number; endAt?: number; precision: "instant" | "minute" | "day" | "range"; basis: "user-confirmed" | "connector-verified" | "model-inferred"; timezone?: string; evidenceRefs: ObjectRef[] };
  clockQuality: "unknown" | "device-reported" | "checked";
}
export interface Evidence {
  workspaceId: string;
  evidenceId: string;
  revision: number;
  deviceId: string;
  sourceKind: SourceKind;
  sourceTrust: "device-reported" | "user-shared" | "connector-verified";
  projectId?: string;
  encounterIds: string[];
  personLinkRefs: ObjectRef[];
  time: EventTime;
  coverage: "audio-segment" | "still-image" | "video-clip" | "visible-fragment" | "selected-text" | "selected-contact";
  artifactRefs: ObjectRef[];
  analysisRefs: ObjectRef[];
  state: "active" | "deleted";
}
export interface Artifact {
  workspaceId: string;
  artifactId: string;
  revision: number;
  evidenceId: string;
  modality: "audio" | "image" | "video";
  mime: string;
  sizeBytes: number;
  contentHash?: string;
  /** Host-private location reference, not an absolute path given to agents. */
  storageRef?: string;
  rawState: "available" | "expired" | "deleted" | "missing";
  retentionExpiresAt?: number;
  tombstoneId?: string;
}
export interface Encounter {
  workspaceId: string;
  encounterId: string;
  revision: number;
  projectId?: string;
  participantLinkRefs: ObjectRef[];
  evidenceRefs: ObjectRef[];
  startedAt: number;
  endedAt?: number;
  previousEncounterId?: string;
  state: "open" | "closed";
}
export interface Analysis {
  workspaceId: string;
  analysisId: string;
  revision: number;
  evidenceRef: ObjectRef;
  kind: "asr" | "ocr" | "vision" | "speaker-timeline" | "summary";
  status: "pending" | "succeeded" | "degraded" | "failed";
  payloadHash: string;
  providerRef?: string;
  producedAt: number;
}
export interface Assertion {
  workspaceId: string;
  assertionId: string;
  revision: number;
  subjectPersonId?: string;
  action?: string;
  recipientPersonId?: string;
  value: string;
  deadline?: { literal: string; resolvedAt?: number; timezone?: string; resolutionBasisRef?: ObjectRef };
  sourceRefs: ObjectRef[];
  state: "proposed" | "confirmed" | "contested" | "withdrawn";
  authority: "model-inference" | "agent-reported-user-confirmation" | "owner-confirmation";
  recordedBy: ActorContext;
  supersedesAssertionId?: string;
}
export type ReadOperation = "read-metadata" | "read-analysis" | "read-raw" | "read-result";
export interface ContextScope {
  workspaceId: string;
  projectId: string;
  encounterIds?: string[];
  sourceKinds: SourceKind[];
  operations: ReadOperation[];
}
export interface AccessGrant {
  workspaceId: string;
  grantId: string;
  principalId: string;
  revision: number;
  scopes: ContextScope[];
  mutationCapabilities: Array<"capture-ingest" | "digital-share" | "propose-assertion" | "record-user-correction" | "confirm-identity" | "review-result">;
  revokedAt?: number;
}
export interface ContextSnapshot {
  workspaceId: string;
  snapshotId: string;
  createdAt: number;
  digest: string;
  dependencies: ObjectRef[];
  /** Material revision watermark for the read, not a global dirty flag. */
  contextSequence: number;
  consumedBy: ActorContext;
  policyEpochAtRead: number;
  deletionEpochAtRead: number;
}
export type SnapshotInspection =
  | { state: "current"; snapshotId: string }
  | { state: "stale"; snapshotId: string; changedRefs: ObjectRef[] }
  | { state: "unavailable"; reason: "not-authorized" | "source-deleted" | "dependency-missing" };
export interface WorkResult {
  workspaceId: string;
  resultId: string;
  workItemId: string;
  revision: number;
  producedBy: ActorContext;
  sourceSnapshotId: string;
  review: { state: "pending" | "accepted" | "rejected"; revision: number; decidedBy?: ActorContext; decidedAt?: number };
  supersedesResultId?: string;
  /** Stored content reference; authorization is checked again on every read. */
  bodyRef?: string;
  contentState: "available" | "blocked" | "purge-pending" | "purged";
}
export interface Tombstone {
  workspaceId: string;
  tombstoneId: string;
  targetKind: ObjectKind;
  targetId: string;
  intent: "raw-only" | "evidence-and-derived";
  revision: number;
  deletionEpoch: number;
  dedupeKeys: string[];
  createdAt: number;
  propagation: "pending" | "managed-copies-purged" | "external-copies-unknown";
}
export interface MigrationAlias {
  workspaceId: string;
  store: "physical" | "workflow" | "digital";
  legacyIdRef: string;
  targetRef: ObjectRef;
  decision: "preserve-legacy-record" | "owner-confirmed-cross-source-link";
}
