import fs from "node:fs/promises";
import path from "node:path";
import type { UnifiedContextStore } from "../context-store.js";
import { liveAccess } from "./context.js";
import type { LiveMessage } from "./types.js";

/** Read the bounded conversation checkpoint; recheck every source before returning any text. */
export async function readLiveHistory(root: string, deviceId: string, store?: UnifiedContextStore, projectId = "live", filter: { startAt?: number; endAt?: number; query?: string; publicScene?: boolean } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(deviceId)) throw new Error("invalid_device_id");
  const data = await fs.readFile(path.join(root, "live", "conversations", deviceId + ".json"), "utf8").then(JSON.parse).catch((e) => { if (e.code === "ENOENT") return { history: [] }; throw e; });
  const candidates: LiveMessage[] = (Array.isArray(data.history) ? data.history : []).slice(-200).filter((message: LiveMessage) =>
    ["user", "assistant"].includes(message.role) && typeof message.content === "string" &&
    message.at && message.at >= (filter.startAt ?? 0) && message.at <= (filter.endAt ?? Date.now()) &&
    (!filter.query || message.content.includes(filter.query)) && (!filter.publicScene || message.publicScene));
  const ids = candidates.map(message => message.contextSnapshotId).filter((id): id is string => !!id);
  const states = new Map(store && ids.length ? (await store.inspectSnapshots(ids, liveAccess(deviceId, projectId, filter.publicScene ? "public" : "private"))).map(value => [value.snapshotId, value.state]) : []);
  const history = candidates.flatMap(message => {
    if (!message.contextSnapshotId || !store) return [message];
    const state = states.get(message.contextSnapshotId);
    return state && state !== "unavailable" ? [{ ...message, sourceState: state }] : [];
  });
  return { history, limit: 200, meaning: "近期会话记录；用户陈述与模型回复均不代表本人已确认的事实" };
}
