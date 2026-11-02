import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { coordinatedMutation, coordinatedRead } from "./context-coordinator.js";
import { contextFor, mutationSignatures } from "./context-store.js";
import { currentContextAccess } from "./tool-context.js";

export type WorkflowErrorCode = "invalid_input" | "not_found" | "revision_conflict" | "forbidden" | "store_corrupt" | "store_busy";

export class WorkflowError extends Error {
  readonly statusCode: number;

  constructor(readonly code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.statusCode = ({ invalid_input: 400, not_found: 404, revision_conflict: 409, forbidden: 403, store_corrupt: 500, store_busy: 503 })[code];
  }
}

export type WorkflowParticipant = { personId: string; displayName: string };
export type WorkflowCorrection = {
  correctionId: string;
  objectId: string;
  sessionId: string;
  kind: "person" | "commitment" | "fact";
  text: string;
  personId?: string;
  assigneeId?: string;
  dueAt?: number;
  action?: string;
  recipientPersonId?: string;
  deadlineLiteral?: string;
  assertionState?: "proposed" | "confirmed" | "contested" | "withdrawn";
  confirmationAuthority?: "owner-confirmation" | "agent-reported-user-confirmation";
  sourceRefs?: Array<{ kind: string; id: string }>;
  sourceEventIds: string[];
  /** Session evidence revision at which this correction became authoritative. */
  revision: number;
  createdAt: number;
  actor: string;
  supersedes?: string;
};
export type WorkflowSession = {
  sessionId: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  deviceId?: string;
  participants: WorkflowParticipant[];
  projectId?: string;
  previousSessionId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  facts: WorkflowCorrection[];
  correctionHistory: WorkflowCorrection[];
};
export type WorkflowWorkItem = {
  workItemId: string;
  sessionId: string;
  title: string;
  instructions: string;
  assignedAgent: string;
  inputRevision: number;
  contextSnapshotId?: string;
  unifiedContextSnapshotId?: string;
  /** Independent optimistic-concurrency revision for this work item. */
  revision: number;
  status: "pending" | "completed";
  /** Computed on every read against the current session, never a cached assertion. */
  stale: boolean;
  createdAt: number;
  createdBy: string;
  completedAt?: number;
  completedBy?: string;
  resultText?: string;
  resultTitle?: string;
};
export type CreateWorkflowSessionParams = {
  title: string;
  startedAt?: number;
  endedAt?: number;
  deviceId?: string;
  participants?: WorkflowParticipant[];
  projectId?: string;
  previousSessionId?: string;
};
export type UpdateWorkflowSessionParams = { title?: string; endedAt?: number; participants?: WorkflowParticipant[] };
export type CorrectWorkflowParams = {
  sessionId: string;
  objectId?: string;
  kind: WorkflowCorrection["kind"];
  text: string;
  personId?: string;
  assigneeId?: string;
  dueAt?: number;
  action?: string;
  recipientPersonId?: string;
  deadlineLiteral?: string;
  assertionState?: WorkflowCorrection["assertionState"];
  sourceRefs?: Array<{ kind: string; id: string }>;
  sourceEventIds?: string[];
  expectedRevision: number;
};
export type CreateWorkflowWorkParams = {
  sessionId: string;
  title: string;
  instructions: string;
  assignedAgent: string;
  inputRevision: number;
  contextSnapshotId?: string;
  unifiedContextSnapshotId?: string;
};
export type CompleteWorkflowWorkParams = {
  workItemId: string;
  resultText: string;
  resultTitle?: string;
  expectedRevision: number;
};
export type WorkflowBriefing = {
  session: WorkflowSession;
  revision: number;
  facts: WorkflowCorrection[];
  correctionHistory: WorkflowCorrection[];
  workItems: WorkflowWorkItem[];
  previousSession?: WorkflowSession;
  previousWorkItems?: WorkflowWorkItem[];
};

type StoredSession = Omit<WorkflowSession, "facts" | "correctionHistory">;
type StoredWork = Omit<WorkflowWorkItem, "stale">;
type WorkflowState = { version: 1; sessions: StoredSession[]; corrections: WorkflowCorrection[]; workItems: StoredWork[] };
const SESSION_INPUT_KEYS = ["title", "startedAt", "endedAt", "deviceId", "participants", "projectId", "previousSessionId"];
const CORRECTION_INPUT_KEYS = ["sessionId", "objectId", "kind", "text", "personId", "assigneeId", "dueAt", "action", "recipientPersonId", "deadlineLiteral", "assertionState", "sourceRefs", "sourceEventIds", "expectedRevision"];
const SESSION_KEYS = ["sessionId", ...SESSION_INPUT_KEYS, "revision", "createdAt", "updatedAt", "createdBy", "updatedBy"];
const CORRECTION_KEYS = ["correctionId", "objectId", "sessionId", "kind", "text", "personId", "assigneeId", "dueAt", "action", "recipientPersonId", "deadlineLiteral", "assertionState", "confirmationAuthority", "sourceRefs", "sourceEventIds", "revision", "createdAt", "actor", "supersedes"];
const WORK_KEYS = ["workItemId", "sessionId", "title", "instructions", "assignedAgent", "inputRevision", "contextSnapshotId", "unifiedContextSnapshotId", "revision", "status", "createdAt", "createdBy", "completedAt", "completedBy", "resultText", "resultTitle"];

/**
 * Runtime-neutral shared workflow store. Actors must come from a trusted adapter,
 * never from model tool arguments. All mutations use an exclusive mkdir lock,
 * including across instances/processes; a crashed writer's lock is deliberately
 * not stolen. Stop writers and inspect/remove workflows.lock before retrying.
 * Raw evidence and the existing state.json are never changed by this store.
 */
export class ClawSenseWorkflowStore {
  private readonly root: string;
  private readonly directory: string;
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(params: { resolveStateDir: () => string }) {
    this.root = path.resolve(params.resolveStateDir());
    this.directory = path.join(path.resolve(params.resolveStateDir()), "plugins", "clawsense");
    this.statePath = path.join(this.directory, "workflows.json");
    this.lockPath = path.join(this.directory, "workflows.lock");
  }

  async createSession(params: CreateWorkflowSessionParams, actor: string): Promise<WorkflowSession> {
    record(params, SESSION_INPUT_KEYS);
    const normalized = sessionInput(params);
    const trustedActor = actorName(actor);
    return this.mutate((state) => {
      if (normalized.previousSessionId) requireSession(state, normalized.previousSessionId);
      const now = Date.now();
      const session: StoredSession = {
        ...normalized,
        sessionId: `session_${randomUUID()}`,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: trustedActor,
        updatedBy: trustedActor,
      };
      state.sessions.push(session);
      return sessionView(state, session);
    });
  }

  async listSessions(params: { personId?: string; projectId?: string } = {}): Promise<WorkflowSession[]> {
    record(params, ["personId", "projectId"]);
    const personId = optionalId(params.personId, "personId");
    const projectId = optionalId(params.projectId, "projectId");
    const state = await this.readState();
    const context = contextFor(this.root);
    const people = personId && context ? await context.legacyPersonIds(personId, "workflow", currentContextAccess()) : personId ? [personId] : undefined;
    return state.sessions
      .filter((session) => !people || session.participants.some((person) => people.includes(person.personId)))
      .filter((session) => !projectId || session.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt || a.sessionId.localeCompare(b.sessionId))
      .map((session) => sessionView(state, session));
  }

  async getSession(sessionId: string): Promise<WorkflowSession> {
    const id = identifier(sessionId, "sessionId");
    const state = await this.readState();
    return sessionView(state, requireSession(state, id));
  }

  async updateSession(sessionId: string, patch: UpdateWorkflowSessionParams, expectedRevision: number, actor: string): Promise<WorkflowSession> {
    const id = identifier(sessionId, "sessionId");
    record(patch, ["title", "endedAt", "participants"]);
    if (Object.values(patch).every((value) => value === undefined)) invalid("Session update must contain at least one field.");
    const title = patch.title === undefined ? undefined : text(patch.title, "title", 300);
    const endedAt = optionalTimestamp(patch.endedAt, "endedAt");
    const people = patch.participants === undefined ? undefined : participants(patch.participants);
    const expected = revision(expectedRevision);
    const trustedActor = actorName(actor);
    return this.mutate((state) => {
      const session = requireSession(state, id);
      assertRevision(session.revision, expected);
      if (endedAt !== undefined && endedAt < session.startedAt) invalid("endedAt must not precede startedAt.");
      if (title !== undefined) session.title = title;
      if (endedAt !== undefined) session.endedAt = endedAt;
      if (people !== undefined) session.participants = people;
      advanceSession(session, trustedActor);
      return sessionView(state, session);
    });
  }

  async correct(params: CorrectWorkflowParams, actor: string): Promise<WorkflowCorrection> {
    record(params, CORRECTION_INPUT_KEYS);
    const sessionId = identifier(params.sessionId, "sessionId");
    const objectId = optionalId(params.objectId, "objectId");
    const content = correctionInput(params);
    const expected = revision(params.expectedRevision);
    const trustedActor = actorName(actor);
    if (params.assertionState === "confirmed" && (trustedActor !== "local-owner" || !currentContextAccess().owner)) throw new WorkflowError("forbidden", "Only an authenticated owner action can confirm an assertion.");
    return this.mutate((state) => {
      const session = requireSession(state, sessionId);
      assertRevision(session.revision, expected);
      const previous = objectId
        ? state.corrections.filter((item) => item.objectId === objectId && item.sessionId === sessionId).at(-1)
        : undefined;
      if (objectId && !previous) throw new WorkflowError("not_found", "Correction object does not exist in this session.");
      if (previous && previous.kind !== content.kind) invalid("A correction cannot change the object's kind.");
      advanceSession(session, trustedActor);
      const correction: WorkflowCorrection = {
        ...content,
        correctionId: `correction_${randomUUID()}`,
        objectId: objectId ?? `object_${randomUUID()}`,
        sessionId,
        revision: session.revision,
        createdAt: session.updatedAt,
        actor: trustedActor,
        assertionState: params.assertionState ?? (trustedActor === "local-owner" && currentContextAccess().owner ? "confirmed" : "proposed"),
        confirmationAuthority: trustedActor === "local-owner" && currentContextAccess().owner ? "owner-confirmation" : "agent-reported-user-confirmation",
        ...(previous ? { supersedes: previous.correctionId } : {}),
      };
      state.corrections.push(correction);
      return correction;
    });
  }

  async createWork(params: CreateWorkflowWorkParams, actor: string): Promise<WorkflowWorkItem> {
    record(params, ["sessionId", "title", "instructions", "assignedAgent", "inputRevision", "contextSnapshotId", "unifiedContextSnapshotId"]);
    const input = {
      sessionId: identifier(params.sessionId, "sessionId"),
      title: text(params.title, "title", 300),
      instructions: text(params.instructions, "instructions", 20_000),
      assignedAgent: actorName(params.assignedAgent),
      inputRevision: revision(params.inputRevision),
      ...(params.contextSnapshotId === undefined ? {} : { contextSnapshotId: identifier(params.contextSnapshotId, "contextSnapshotId") }),
      ...(params.unifiedContextSnapshotId === undefined ? {} : { unifiedContextSnapshotId: identifier(params.unifiedContextSnapshotId, "unifiedContextSnapshotId") }),
    };
    const trustedActor = actorName(actor);
    return this.mutate((state) => {
      const session = requireSession(state, input.sessionId);
      assertRevision(session.revision, input.inputRevision);
      const work: StoredWork = { ...input, workItemId: `work_${randomUUID()}`, revision: 1, status: "pending", createdAt: Date.now(), createdBy: trustedActor };
      state.workItems.push(work);
      return workView(state, work);
    });
  }

  async completeWork(params: CompleteWorkflowWorkParams, actor: string): Promise<WorkflowWorkItem> {
    record(params, ["workItemId", "resultText", "resultTitle", "expectedRevision"]);
    const workItemId = identifier(params.workItemId, "workItemId");
    const resultText = text(params.resultText, "resultText", 200_000);
    const resultTitle = params.resultTitle === undefined ? undefined : text(params.resultTitle, "resultTitle", 300);
    const expected = revision(params.expectedRevision);
    const trustedActor = actorName(actor);
    return this.mutate((state) => {
      const work = requireWork(state, workItemId);
      if (work.assignedAgent !== trustedActor) throw new WorkflowError("forbidden", "Only the assigned agent may complete this work item.");
      assertRevision(work.revision, expected);
      if (work.status !== "pending") throw new WorkflowError("revision_conflict", "Work item is already completed; create a new work item for a revised result.");
      work.status = "completed";
      work.revision += 1;
      work.resultText = resultText;
      if (resultTitle !== undefined) work.resultTitle = resultTitle;
      work.completedAt = Date.now();
      work.completedBy = trustedActor;
      return workView(state, work);
    });
  }

  async getWork(workItemId: string): Promise<WorkflowWorkItem> {
    const id = identifier(workItemId, "workItemId");
    const state = await this.readState();
    return workView(state, requireWork(state, id));
  }

  async briefing(sessionId: string): Promise<WorkflowBriefing> {
    const id = identifier(sessionId, "sessionId");
    // One atomic snapshot: facts, work staleness and revision cannot span different reads.
    const state = await this.readState();
    const session = sessionView(state, requireSession(state, id));
    return {
      session,
      revision: session.revision,
      facts: session.facts,
      correctionHistory: session.correctionHistory,
      workItems: state.workItems.filter((work) => work.sessionId === id).map((work) => workView(state, work)),
      ...(session.previousSessionId ? {
        previousSession: sessionView(state, requireSession(state, session.previousSessionId)),
        previousWorkItems: state.workItems.filter((work) => work.sessionId === session.previousSessionId).map((work) => workView(state, work)),
      } : {}),
    };
  }

  private async readState(internal = false): Promise<WorkflowState> {
    return coordinatedRead(this.root, () => this.readStateInside(internal));
  }
  private async readStateInside(internal = false): Promise<WorkflowState> {
    let raw: string;
    try {
      const stat = await fs.lstat(this.statePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkflowError("store_corrupt", "Workflow state must be a regular file.");
      raw = await fs.readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: [], corrections: [], workItems: [] };
      throw error;
    }
    try {
      const state: unknown = JSON.parse(raw);
      validateState(state);
      const context = contextFor(this.root);
      return !internal && context ? await context.filterLegacy("workflow", state, currentContextAccess()) as WorkflowState : state;
    } catch {
      throw new WorkflowError("store_corrupt", "Workflow state is invalid. Preserve the file and restore or repair it before retrying.");
    }
  }

  private async mutate<T>(operation: (state: WorkflowState) => T): Promise<T> {
    return coordinatedMutation(this.root, () => this.mutateInside(operation));
  }

  private async mutateInside<T>(operation: (state: WorkflowState) => T): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new WorkflowError("store_busy", "Workflow store is locked. Retry later; inspect a persistent workflows.lock only after stopping all writers.");
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    const tempPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(path.join(this.lockPath, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { flag: "wx", mode: 0o600 });
      const state = await this.readState(true);
      const context = contextFor(this.root);
      const before = context ? mutationSignatures("workflow", state) : {};
      const result = operation(state);
      await context?.authorizeMutation("workflow", before, state, currentContextAccess());
      validateState(state);
      const file = await fs.open(tempPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(tempPath, this.statePath);
      return result;
    } finally {
      await fs.rm(tempPath, { force: true });
      await fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }
}

function sessionView(state: WorkflowState, session: StoredSession): WorkflowSession {
  const correctionHistory = state.corrections.filter((item) => item.sessionId === session.sessionId);
  const latest = new Map<string, WorkflowCorrection>();
  for (const item of correctionHistory) latest.set(item.objectId, item);
  const facts = Array.from(latest.values()).map((candidate) => {
    if (candidate.assertionState === "proposed") return correctionHistory.filter((item) => item.objectId === candidate.objectId && item.assertionState === "confirmed").at(-1) ?? candidate;
    return candidate;
  }).filter((item) => item.assertionState !== "withdrawn");
  return { ...session, facts, correctionHistory };
}

function workView(state: WorkflowState, work: StoredWork): WorkflowWorkItem {
  return { ...work, stale: requireSession(state, work.sessionId).revision !== work.inputRevision };
}

function requireSession(state: WorkflowState, id: string): StoredSession {
  const session = state.sessions.find((item) => item.sessionId === id);
  if (!session) throw new WorkflowError("not_found", "Session not found.");
  return session;
}

function requireWork(state: WorkflowState, id: string): StoredWork {
  const work = state.workItems.find((item) => item.workItemId === id);
  if (!work) throw new WorkflowError("not_found", "Work item not found.");
  return work;
}

function advanceSession(session: StoredSession, actor: string): void {
  session.revision += 1;
  session.updatedAt = Date.now();
  session.updatedBy = actor;
}

function assertRevision(current: number, expected: number): void {
  if (current !== expected) throw new WorkflowError("revision_conflict", `Expected revision ${expected}, current revision is ${current}. Read a fresh briefing before writing.`);
}

function invalid(message: string): never {
  throw new WorkflowError("invalid_input", message);
}

function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected an object.");
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid("Unexpected input field.");
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(`${label} must be nonempty text of at most ${limit} characters.`);
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/u.test(result)) invalid(`${label} contains unsupported characters.`);
  return result;
}

function actorName(value: unknown): string {
  const result = text(value, "actor", 128);
  if (/[\r\n\t]/u.test(result)) invalid("actor must be a single-line identity.");
  return result;
}

function optionalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : identifier(value, label);
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) invalid(`${label} must be a nonnegative timestamp in milliseconds.`);
  return value;
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, label);
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("revision must be a positive integer.");
  return value;
}

function participants(value: unknown): WorkflowParticipant[] {
  if (!Array.isArray(value) || value.length > 100) invalid("participants must be an array of at most 100 people.");
  const result = value.map((person) => {
    record(person, ["personId", "displayName"]);
    return { personId: identifier(person.personId, "personId"), displayName: text(person.displayName, "displayName", 200) };
  });
  if (new Set(result.map((person) => person.personId)).size !== result.length) invalid("Participant personId values must be unique.");
  return result;
}

function sessionInput(params: CreateWorkflowSessionParams): Omit<StoredSession, "sessionId" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy"> {
  const startedAt = params.startedAt === undefined ? Date.now() : timestamp(params.startedAt, "startedAt");
  const endedAt = optionalTimestamp(params.endedAt, "endedAt");
  if (endedAt !== undefined && endedAt < startedAt) invalid("endedAt must not precede startedAt.");
  return {
    title: text(params.title, "title", 300), startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(params.deviceId === undefined ? {} : { deviceId: identifier(params.deviceId, "deviceId") }),
    ...(params.projectId === undefined ? {} : { projectId: identifier(params.projectId, "projectId") }),
    ...(params.previousSessionId === undefined ? {} : { previousSessionId: identifier(params.previousSessionId, "previousSessionId") }),
    participants: params.participants === undefined ? [] : participants(params.participants),
  };
}

function correctionInput(params: Pick<CorrectWorkflowParams, "kind" | "text" | "personId" | "assigneeId" | "dueAt" | "action" | "recipientPersonId" | "deadlineLiteral" | "assertionState" | "sourceRefs" | "sourceEventIds">): Pick<WorkflowCorrection, "kind" | "text" | "personId" | "assigneeId" | "dueAt" | "action" | "recipientPersonId" | "deadlineLiteral" | "assertionState" | "sourceRefs" | "sourceEventIds"> {
  if (params.kind !== "person" && params.kind !== "commitment" && params.kind !== "fact") invalid("Unsupported correction kind.");
  if (params.kind === "person" && params.personId === undefined) invalid("person corrections require an explicit personId.");
  if (params.kind !== "commitment" && (params.assigneeId !== undefined || params.dueAt !== undefined)) invalid("assigneeId and dueAt apply only to commitments.");
  const ids = params.sourceEventIds === undefined ? [] : params.sourceEventIds;
  if (!Array.isArray(ids) || ids.length > 128) invalid("sourceEventIds must contain at most 128 IDs.");
  const sourceEventIds = ids.map((id) => identifier(id, "sourceEventId"));
  if (new Set(sourceEventIds).size !== sourceEventIds.length) invalid("sourceEventIds must be unique.");
  if (params.assertionState !== undefined && !["proposed", "confirmed", "contested", "withdrawn"].includes(params.assertionState)) invalid("Unknown assertion state.");
  const sourceRefs = params.sourceRefs?.map((ref) => { record(ref, ["kind", "id"]); return { kind: identifier(ref.kind, "sourceKind"), id: identifier(ref.id, "sourceId") }; });
  if (sourceRefs && sourceRefs.length > 128) invalid("Too many source references.");
  return {
    kind: params.kind, text: text(params.text, "text", 20_000), sourceEventIds,
    ...(params.personId === undefined ? {} : { personId: identifier(params.personId, "personId") }),
    ...(params.assigneeId === undefined ? {} : { assigneeId: identifier(params.assigneeId, "assigneeId") }),
    ...(params.dueAt === undefined ? {} : { dueAt: timestamp(params.dueAt, "dueAt") }),
    ...(params.action === undefined ? {} : { action: text(params.action, "action", 300) }),
    ...(params.recipientPersonId === undefined ? {} : { recipientPersonId: identifier(params.recipientPersonId, "recipientPersonId") }),
    ...(params.deadlineLiteral === undefined ? {} : { deadlineLiteral: text(params.deadlineLiteral, "deadlineLiteral", 300) }),
    ...(params.assertionState === undefined ? {} : { assertionState: params.assertionState }),
    ...(sourceRefs === undefined ? {} : { sourceRefs }),
  };
}

function validateState(value: unknown): asserts value is WorkflowState {
  record(value, ["version", "sessions", "corrections", "workItems"]);
  if (value.version !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.corrections) || !Array.isArray(value.workItems)) invalid("Unsupported workflow state schema.");
  const sessions = new Map<string, StoredSession>();
  for (const entry of value.sessions) {
    record(entry, SESSION_KEYS);
    const id = identifier(entry.sessionId, "sessionId");
    if (sessions.has(id)) invalid("Duplicate session ID.");
    sessionInput(entry as CreateWorkflowSessionParams);
    timestamp(entry.startedAt, "startedAt");
    participants(entry.participants);
    revision(entry.revision);
    timestamp(entry.createdAt, "createdAt");
    timestamp(entry.updatedAt, "updatedAt");
    actorName(entry.createdBy);
    actorName(entry.updatedBy);
    if (Number(entry.updatedAt) < Number(entry.createdAt)) invalid("Invalid session timestamps.");
    if (entry.previousSessionId && !sessions.has(String(entry.previousSessionId))) invalid("Previous session must exist and precede its successor.");
    sessions.set(id, entry as StoredSession);
  }
  const corrections = new Set<string>();
  const latestObjects = new Map<string, WorkflowCorrection>();
  const sessionRevisions = new Map<string, number>();
  for (const entry of value.corrections) {
    record(entry, CORRECTION_KEYS);
    const id = identifier(entry.correctionId, "correctionId");
    const objectId = identifier(entry.objectId, "objectId");
    const sessionId = identifier(entry.sessionId, "sessionId");
    const session = sessions.get(sessionId);
    if (!session || corrections.has(id)) invalid("Invalid correction reference.");
    correctionInput(entry as CorrectWorkflowParams);
    if (!Array.isArray(entry.sourceEventIds)) invalid("Missing sourceEventIds.");
    const itemRevision = revision(entry.revision);
    if (itemRevision < 2 || itemRevision > session.revision || itemRevision <= (sessionRevisions.get(sessionId) ?? 1)) invalid("Invalid correction revision.");
    timestamp(entry.createdAt, "createdAt");
    actorName(entry.actor);
    const previous = latestObjects.get(objectId);
    if (previous && (previous.sessionId !== sessionId || previous.kind !== entry.kind || entry.supersedes !== previous.correctionId)) invalid("Invalid superseded correction chain.");
    if (!previous && entry.supersedes !== undefined) invalid("Unknown superseded correction.");
    corrections.add(id);
    latestObjects.set(objectId, entry as WorkflowCorrection);
    sessionRevisions.set(sessionId, itemRevision);
  }
  const works = new Set<string>();
  for (const entry of value.workItems) {
    record(entry, WORK_KEYS);
    const id = identifier(entry.workItemId, "workItemId");
    const session = sessions.get(identifier(entry.sessionId, "sessionId"));
    if (!session || works.has(id)) invalid("Invalid work reference.");
    text(entry.title, "title", 300);
    text(entry.instructions, "instructions", 20_000);
    const assignedAgent = actorName(entry.assignedAgent);
    if (revision(entry.inputRevision) > session.revision) invalid("Invalid work input revision.");
    if (entry.contextSnapshotId !== undefined) identifier(entry.contextSnapshotId, "contextSnapshotId");
    if (entry.unifiedContextSnapshotId !== undefined) identifier(entry.unifiedContextSnapshotId, "unifiedContextSnapshotId");
    timestamp(entry.createdAt, "createdAt");
    actorName(entry.createdBy);
    if (entry.status === "pending") {
      if (entry.revision !== 1 || [entry.completedAt, entry.completedBy, entry.resultText, entry.resultTitle].some((item) => item !== undefined)) invalid("Invalid pending work state.");
    } else if (entry.status === "completed") {
      if (entry.revision !== 2 || actorName(entry.completedBy) !== assignedAgent) invalid("Invalid completed work identity.");
      if (timestamp(entry.completedAt, "completedAt") < Number(entry.createdAt)) invalid("Invalid completion time.");
      text(entry.resultText, "resultText", 200_000);
      if (entry.resultTitle !== undefined) text(entry.resultTitle, "resultTitle", 300);
    } else invalid("Unknown work status.");
    works.add(id);
  }
}
