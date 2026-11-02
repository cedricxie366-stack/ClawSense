import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canReadDigital, DIGITAL_SOURCE_TYPES, type DigitalAccess, type DigitalSourceType } from "./digital-access.js";
import { coordinatedMutation, coordinatedRead, atomicContextJson } from "./context-coordinator.js";
import { contextFor } from "./context-store.js";
import { currentContextAccess } from "./tool-context.js";

export class DigitalError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
export type DigitalPerson = { personId: string; displayName: string; projectIds: string[]; revision: number; createdAt: number };
export type DigitalIdentity = { identityId: string; personId: string; platform: string; accountRef: string; externalId: string; label: string; status: "confirmed" | "rejected"; revision: number; updatedAt: number };
export type DigitalEvent = {
  eventId: string; clientEventId: string; deviceId: string; workspaceId: string; projectId: string; personId?: string; sessionId?: string;
  sourceType: DigitalSourceType; sourceLevel: "user-shared"; claimedApp?: string;
  capturedAt: number; receivedAt: number; observedEventTime?: number; timeBasis: "unknown" | "user-confirmed";
  coverage: "visible-fragment" | "selected-text" | "selected-contact";
  title: string; text: string; textOrigin: "user-confirmed" | "device-ocr";
  mime?: string; artifactId?: string; contact?: { displayName: string; externalId: string; phone?: string };
  contentHash: string; revision: number; deletedAt?: number;
  correctionHistory?: Array<{ revision: number; actor: string; correctedAt: number; previousText: string; previousPersonId?: string }>;
};
export type DigitalImport = {
  clientEventId: string; projectId: string; personId?: string; sessionId?: string; sourceType: DigitalSourceType;
  capturedAt: number; observedEventTime?: number; title: string; text: string; textOrigin?: "user-confirmed" | "device-ocr";
  claimedApp?: string; imageBase64?: string; mime?: string; contact?: { displayName: string; externalId: string; phone?: string };
};
export type DigitalSnapshot = { snapshotId: string; digest: string; createdAt: number; eventVersions: Array<{ eventId: string; revision: number }>; personVersions: Array<{ personId: string; revision: number }> };
type SourceGrant = { deviceId: string; enabled: boolean; projectIds: string[] };
type DigitalState = { version: 1; revision: number; people: DigitalPerson[]; identities: DigitalIdentity[]; events: DigitalEvent[]; snapshots: DigitalSnapshot[]; grants: SourceGrant[]; setupCapabilities: Array<{ hash: string; expiresAt: number }> };
const chains = new Map<string, Promise<unknown>>();
const MAX_IMAGE = 8 * 1024 * 1024;

/** Separate digital library: legacy whole-library credentials cannot read these artifacts. */
export class DigitalContextStore {
  private readonly root: string;
  private readonly directory: string;
  private readonly file: string;
  constructor(options: { resolveStateDir: () => string; workspaceId: string }) {
    this.root = path.resolve(options.resolveStateDir());
    this.directory = path.join(path.resolve(options.resolveStateDir()), "plugins", "clawsense", "digital");
    this.file = path.join(this.directory, "context.json");
    this.workspaceId = options.workspaceId;
  }
  workspaceId: string;
  setWorkspaceIdentity(workspaceId: string) { validateId(workspaceId); this.workspaceId = workspaceId; }

  async registerPrimarySetup(hash: string, expiresAt: number): Promise<void> {
    await this.mutate((state) => {
      state.setupCapabilities = state.setupCapabilities.filter((item) => item.expiresAt > Date.now());
      state.setupCapabilities.push({ hash, expiresAt });
    });
  }
  async activatePrimaryDevice(hash: string, deviceId: string): Promise<boolean> {
    return this.mutate((state) => {
      const capability = state.setupCapabilities.find((item) => item.hash === hash && item.expiresAt > Date.now());
      if (!capability) return false;
      state.setupCapabilities = state.setupCapabilities.filter((item) => item.hash !== hash);
      state.grants = state.grants.filter((item) => item.deviceId !== deviceId);
      state.grants.push({ deviceId, enabled: true, projectIds: ["*"] }); return true;
    });
  }
  async setDeviceGrant(deviceId: string, enabled: boolean, projectIds: string[]): Promise<void> {
    validateId(deviceId); projectIds.forEach(validateId);
    await this.mutate((state) => {
      state.grants = state.grants.filter((grant) => grant.deviceId !== deviceId);
      state.grants.push({ deviceId, enabled, projectIds });
    });
  }
  async deviceAccess(deviceId: string): Promise<DigitalAccess> {
    const grant = (await this.read()).grants.find((item) => item.deviceId === deviceId && item.enabled);
    if (!grant) throw new DigitalError("primary_device_authorization_required", 403);
    return { actor: `device:${deviceId}`, owner: grant.projectIds.includes("*"), scopes: grant.projectIds.map((projectId) => ({ projectId, allowRaw: true })) };
  }
  async listPeople(access: DigitalAccess): Promise<DigitalPerson[]> {
    const state = await this.read();
    assertLiveDevice(state, access);
    return state.people.filter((person) => access.owner || person.projectIds.some((projectId) => access.scopes.some((scope) => scope.projectId === "*" || scope.projectId === projectId)))
      .map((person) => ({ ...person, projectIds: access.owner ? person.projectIds : person.projectIds.filter((projectId) => access.scopes.some((scope) => scope.projectId === "*" || scope.projectId === projectId)) }));
  }
  async createPerson(displayName: string, projectId: string, access: DigitalAccess): Promise<DigitalPerson> {
    requireOwner(access); validateText(displayName, 200); validateId(projectId);
    return this.mutate((state) => {
      assertLiveDevice(state, access);
      // Equal display names are intentionally not merged.
      const person = { personId: `person_${randomUUID()}`, displayName: displayName.trim(), projectIds: [projectId], revision: 1, createdAt: Date.now() };
      state.people.push(person); return person;
    });
  }
  async linkIdentity(input: { personId: string; platform: string; accountRef: string; externalId: string; label: string; expectedRevision: number; reject?: boolean }, access: DigitalAccess): Promise<DigitalPerson> {
    requireOwner(access);
    [input.personId, input.platform, input.accountRef, input.externalId].forEach(validateId); validateText(input.label, 200);
    return this.mutate((state) => {
      assertLiveDevice(state, access);
      const person = state.people.find((item) => item.personId === input.personId);
      if (!person) throw new DigitalError("person_not_found", 404);
      if (person.revision !== input.expectedRevision) throw new DigitalError("revision_conflict", 409);
      const existing = state.identities.find((item) => item.platform === input.platform && item.accountRef === input.accountRef && item.externalId === input.externalId && item.status === "confirmed");
      if (existing && existing.personId !== input.personId && !input.reject) throw new DigitalError("identity_already_linked_confirm_split_first", 409);
      const status = input.reject ? "rejected" : "confirmed";
      state.identities.push({ identityId: `identity_${randomUUID()}`, personId: input.personId, platform: input.platform, accountRef: input.accountRef, externalId: input.externalId, label: input.label, status, revision: person.revision + 1, updatedAt: Date.now() });
      if (input.reject) state.identities.filter((item) => item.personId === input.personId && item.platform === input.platform && item.accountRef === input.accountRef && item.externalId === input.externalId).forEach((item) => { item.status = "rejected"; });
      person.revision++; return person;
    });
  }
  async import(input: DigitalImport, deviceId: string): Promise<DigitalEvent> {
    const access = await this.deviceAccess(deviceId);
    validateImport(input);
    if (!canReadDigital(access, input.projectId, input.sourceType, true)) throw new DigitalError("source_scope_denied", 403);
    const body = input.imageBase64 ? Buffer.from(input.imageBase64, "base64") : undefined;
    if (body && (!body.length || body.length > MAX_IMAGE || !imageMatches(body, input.mime!))) throw new DigitalError("invalid_shared_image");
    const normalized = { ...input, imageBase64: undefined };
    const contentHash = createHash("sha256").update(JSON.stringify(normalized)).update(body ?? "").digest("hex");
    return this.mutate(async (state) => {
      assertLiveDevice(state, access);
      const existing = state.events.find((event) => event.deviceId === deviceId && event.clientEventId === input.clientEventId);
      if (existing) {
        if (existing.deletedAt) throw new DigitalError("context_deleted", 410);
        if (existing.contentHash !== contentHash) throw new DigitalError("idempotency_conflict", 409);
        return existing;
      }
      if (input.personId) {
        const person = state.people.find((item) => item.personId === input.personId && item.projectIds.includes(input.projectId));
        if (!person) throw new DigitalError("person_project_mismatch");
      }
      const eventId = `digital_${randomUUID()}`;
      if (body) await fs.writeFile(path.join(this.directory, `${eventId}.media`), body, { mode: 0o600, flag: "wx" });
      const event: DigitalEvent = {
        eventId, deviceId, workspaceId: this.workspaceId, clientEventId: input.clientEventId, projectId: input.projectId,
        ...(input.personId ? { personId: input.personId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        sourceType: input.sourceType, sourceLevel: "user-shared", ...(input.claimedApp ? { claimedApp: input.claimedApp } : {}),
        capturedAt: input.capturedAt, receivedAt: Date.now(), ...(input.observedEventTime !== undefined ? { observedEventTime: input.observedEventTime } : {}),
        timeBasis: input.observedEventTime === undefined ? "unknown" : "user-confirmed",
        coverage: input.sourceType === "shared_image" ? "visible-fragment" : input.sourceType === "contact_selection" ? "selected-contact" : "selected-text",
        title: input.title.trim(), text: input.text, textOrigin: input.textOrigin ?? "user-confirmed",
        ...(body ? { mime: input.mime, artifactId: eventId } : {}), ...(input.contact ? { contact: input.contact } : {}),
        contentHash, revision: 1,
      };
      state.events.push(event); return event;
    });
  }
  async query(filters: { projectId?: string; personId?: string; sessionId?: string; query?: string }, access: DigitalAccess): Promise<DigitalEvent[]> {
    return coordinatedRead(this.root, () => this.queryInside(filters, access));
  }
  private async queryInside(filters: { projectId?: string; personId?: string; sessionId?: string; query?: string }, access: DigitalAccess): Promise<DigitalEvent[]> {
    const state = await this.read();
    assertLiveDevice(state, access);
    const query = filters.query?.trim().toLocaleLowerCase();
    const context = contextFor(this.root);
    const personIds = filters.personId && context ? await context.legacyPersonIds(filters.personId, "digital", { ...access, digitalScopes: access.scopes }) : filters.personId ? [filters.personId] : undefined;
    const events = state.events.filter((event) => !event.deletedAt && canReadDigital(access, event.projectId, event.sourceType) &&
      (!filters.projectId || event.projectId === filters.projectId) && (!personIds || (event.personId && personIds.includes(event.personId))) &&
      (!filters.sessionId || event.sessionId === filters.sessionId) && (!query || `${event.title} ${event.text}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 100);
    return context ? (await context.filterLegacy("digital", { ...state, events }, { ...access, digitalScopes: access.scopes })).events : events;
  }
  async getEvent(eventId: string, access: DigitalAccess): Promise<DigitalEvent> {
    const state = await this.read(); assertLiveDevice(state, access);
    const event = state.events.find((item) => item.eventId === eventId && !item.deletedAt);
    if (!event || !canReadDigital(access, event.projectId, event.sourceType)) throw new DigitalError("context_unavailable", 404);
    await contextFor(this.root)?.assertAccess({ kind: "digital-evidence", id: eventId }, "read-analysis", { ...access, digitalScopes: access.scopes });
    return event;
  }
  async readArtifact(eventId: string, access: DigitalAccess): Promise<{ data: Buffer; mime: string }> {
    const event = await this.getEvent(eventId, access);
    if (!event.artifactId || !canReadDigital(access, event.projectId, event.sourceType, true)) throw new DigitalError("raw_context_not_authorized", 403);
    await contextFor(this.root)?.assertAccess({ kind: "digital-artifact", id: eventId }, "read-raw", { ...access, digitalScopes: access.scopes });
    const file = path.join(this.directory, `${event.eventId}.media`);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_IMAGE) throw new DigitalError("artifact_unavailable", 404);
    const data = await fs.readFile(file);
    if (data.length > MAX_IMAGE) throw new DigitalError("artifact_too_large", 413);
    return { data, mime: event.mime! };
  }
  async correctEvent(input: { eventId: string; personId?: string; clearPerson?: boolean; text?: string; expectedRevision: number }, access: DigitalAccess): Promise<DigitalEvent> {
    requireOwner(access);
    return this.mutate((state) => {
      assertLiveDevice(state, access);
      const event = state.events.find((item) => item.eventId === input.eventId && !item.deletedAt);
      if (!event) throw new DigitalError("context_not_found", 404);
      if (event.revision !== input.expectedRevision) throw new DigitalError("revision_conflict", 409);
      if (input.text === undefined && input.personId === undefined && !input.clearPerson) throw new DigitalError("correction_required");
      if (input.clearPerson && input.personId) throw new DigitalError("conflicting_person_correction");
      event.correctionHistory ??= [];
      event.correctionHistory.push({ revision: event.revision, actor: access.actor, correctedAt: Date.now(), previousText: event.text, ...(event.personId ? { previousPersonId: event.personId } : {}) });
      if (input.clearPerson) delete event.personId;
      if (input.personId !== undefined) {
        const person = state.people.find((item) => item.personId === input.personId && item.projectIds.includes(event.projectId));
        if (!person) throw new DigitalError("person_project_mismatch");
        event.personId = input.personId;
      }
      if (input.text !== undefined) { validateText(input.text, 64_000, true); event.text = input.text; event.textOrigin = "user-confirmed"; }
      event.revision++; return event;
    });
  }
  async deleteEvent(eventId: string, access: DigitalAccess): Promise<void> {
    requireOwner(access);
    const context = contextFor(this.root);
    if (context) { await coordinatedMutation(this.root, async () => { assertLiveDevice(await this.read(), access); await context.deleteEvidence({ kind: "digital-evidence", id: eventId }, "evidence-and-derived", { ...access, digitalScopes: access.scopes }); }); return; }
    await this.mutate((state) => {
      assertLiveDevice(state, access);
      const event = state.events.find((item) => item.eventId === eventId);
      if (!event) throw new DigitalError("context_not_found", 404);
      event.deletedAt ??= Date.now(); event.revision++; event.text = ""; event.title = "Deleted context";
      delete event.contact; delete event.correctionHistory; delete event.claimedApp; delete event.observedEventTime;
    });
    await fs.rm(path.join(this.directory, `${eventId}.media`), { force: true });
  }
  async snapshot(eventIds: string[], access: DigitalAccess): Promise<DigitalSnapshot> {
    if (eventIds.length > 100) throw new DigitalError("too_many_context_events");
    return this.mutate((state) => {
      assertLiveDevice(state, access);
      const events = [...new Set(eventIds)].map((id) => {
        const event = state.events.find((item) => item.eventId === id && !item.deletedAt);
        if (!event || !canReadDigital(access, event.projectId, event.sourceType)) throw new DigitalError("context_unavailable", 404);
        return event;
      });
      const people = state.people.filter((person) => events.some((event) => event.personId === person.personId));
      const eventVersions = events.map(({ eventId, revision }) => ({ eventId, revision })).sort((a, b) => a.eventId.localeCompare(b.eventId));
      const personVersions = people.map(({ personId, revision }) => ({ personId, revision })).sort((a, b) => a.personId.localeCompare(b.personId));
      const digest = createHash("sha256").update(JSON.stringify({ eventVersions, personVersions })).digest("hex");
      const previous = state.snapshots.find((item) => item.digest === digest);
      if (previous) return previous;
      const snapshot = { snapshotId: `snapshot_${randomUUID()}`, digest, eventVersions, personVersions, createdAt: Date.now() };
      state.snapshots.push(snapshot); return snapshot;
    });
  }
  async inspectSnapshot(snapshotId: string, access: DigitalAccess): Promise<{ stale: boolean; snapshot: DigitalSnapshot }> {
    const state = await this.read();
    assertLiveDevice(state, access);
    const snapshot = state.snapshots.find((item) => item.snapshotId === snapshotId);
    if (!snapshot) throw new DigitalError("snapshot_not_found", 404);
    let stale = false;
    for (const version of snapshot.eventVersions) {
      const event = state.events.find((item) => item.eventId === version.eventId);
      if (!event || !canReadDigital(access, event.projectId, event.sourceType)) throw new DigitalError("snapshot_not_authorized", 403);
      if (event.deletedAt) throw new DigitalError("context_deleted", 410);
      await contextFor(this.root)?.assertAccess({ kind: "digital-evidence", id: event.eventId }, "read-analysis", { ...access, digitalScopes: access.scopes });
      if (event.revision !== version.revision) stale = true;
    }
    for (const version of snapshot.personVersions) if (state.people.find((person) => person.personId === version.personId)?.revision !== version.revision) stale = true;
    return { stale, snapshot };
  }

  private async read(): Promise<DigitalState> {
    return coordinatedRead(this.root, () => this.readInside());
  }
  private async readInside(): Promise<DigitalState> {
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid_file");
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (value?.version !== 1 || !Number.isInteger(value.revision) || !["people", "identities", "events", "snapshots", "grants", "setupCapabilities"].every((key) => Array.isArray(value[key]))) throw new Error("invalid_state");
      validateState(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, people: [], identities: [], events: [], snapshots: [], grants: [], setupCapabilities: [] };
      throw new DigitalError("digital_store_unreadable", 500);
    }
  }
  private async mutate<T>(operation: (state: DigitalState) => T | Promise<T>): Promise<T> {
    return coordinatedMutation(this.root, () => this.mutateInside(operation));
  }
  private async mutateInside<T>(operation: (state: DigitalState) => T | Promise<T>): Promise<T> {
    const pending = (chains.get(this.file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lock = path.join(this.directory, ".write-lock");
      try { await fs.mkdir(lock, { mode: 0o700 }); } catch { throw new DigitalError("digital_store_busy", 503); }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const state = await this.read();
        const result = await operation(state); state.revision++;
        await atomicContextJson(this.file, state); return result;
      } finally { await fs.rm(temporary, { force: true }); await fs.rmdir(lock); }
    });
    chains.set(this.file, pending);
    try { return await pending; } finally { if (chains.get(this.file) === pending) chains.delete(this.file); }
  }
}

function validateId(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f]/.test(value)) throw new DigitalError("invalid_identifier"); }
function validateText(value: unknown, max: number, empty = false): asserts value is string { if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw new DigitalError("invalid_text"); }
function requireOwner(access: DigitalAccess) { if (!access.owner) throw new DigitalError("owner_confirmation_required", 403); }
function assertLiveDevice(state: DigitalState, access: DigitalAccess) {
  if (!access.actor.startsWith("device:")) return;
  const grant = state.grants.find((item) => item.deviceId === access.actor.slice(7) && item.enabled);
  if (!grant || (access.owner && !grant.projectIds.includes("*")) || access.scopes.some((scope) => !grant.projectIds.includes("*") && !grant.projectIds.includes(scope.projectId))) throw new DigitalError("primary_device_authorization_required", 403);
}
function validateState(state: DigitalState) {
  const safeRecordId = (value: string, prefix: string) => { if (!new RegExp(`^${prefix}_[a-f0-9-]{36}$`).test(value)) throw new Error("invalid_record_id"); };
  for (const person of state.people) { safeRecordId(person.personId, "person"); validateText(person.displayName, 200); person.projectIds.forEach(validateId); if (!Number.isInteger(person.revision) || person.revision < 1) throw new Error("invalid_revision"); }
  for (const event of state.events) {
    safeRecordId(event.eventId, "digital"); validateId(event.deviceId); validateId(event.clientEventId); validateId(event.projectId);
    validateText(event.title, 300); validateText(event.text, 64_000, true);
    if (!(DIGITAL_SOURCE_TYPES as readonly string[]).includes(event.sourceType) || !Number.isInteger(event.revision) || event.revision < 1) throw new Error("invalid_event");
  }
  for (const grant of state.grants) { validateId(grant.deviceId); if (typeof grant.enabled !== "boolean" || !Array.isArray(grant.projectIds)) throw new Error("invalid_grant"); grant.projectIds.forEach(validateId); }
  for (const snapshot of state.snapshots) { safeRecordId(snapshot.snapshotId, "snapshot"); for (const version of snapshot.eventVersions) safeRecordId(version.eventId, "digital"); for (const version of snapshot.personVersions) safeRecordId(version.personId, "person"); }
}
function validateImport(input: DigitalImport) {
  [input.clientEventId, input.projectId].forEach(validateId);
  if (input.personId) validateId(input.personId); if (input.sessionId) validateId(input.sessionId);
  if (!(DIGITAL_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) throw new DigitalError("invalid_source_type");
  validateText(input.title, 300); validateText(input.text, 64_000, true);
  if (!Number.isFinite(input.capturedAt) || input.capturedAt < 0 || input.capturedAt > Date.now() + 300_000) throw new DigitalError("invalid_capture_time");
  if (input.observedEventTime !== undefined && (!Number.isFinite(input.observedEventTime) || input.observedEventTime < 0)) throw new DigitalError("invalid_event_time");
  if (input.textOrigin && !["user-confirmed", "device-ocr"].includes(input.textOrigin)) throw new DigitalError("invalid_text_origin");
  if (input.claimedApp) validateText(input.claimedApp, 200);
  if (input.sourceType === "shared_image" && (!input.imageBase64 || input.imageBase64.length > 12 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(input.mime ?? ""))) throw new DigitalError("image_required");
  if (input.sourceType !== "shared_image" && input.imageBase64) throw new DigitalError("unexpected_image");
  if (input.sourceType === "contact_selection") {
    if (!input.contact) throw new DigitalError("selected_contact_required");
    validateText(input.contact.displayName, 200); validateId(input.contact.externalId); if (input.contact.phone) validateText(input.contact.phone, 100);
  } else if (input.contact) throw new DigitalError("unexpected_contact");
}
function imageMatches(body: Buffer, mime: string): boolean {
  return mime === "image/png" ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    mime === "image/jpeg" ? body[0] === 255 && body[1] === 216 && body[2] === 255 :
      body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP";
}
