export type IngestQueueModality = "audio" | "image" | "video";

export type IngestQueueJob = {
  requestId: string;
  queuedAt: number;
  deviceId: string;
  modality: IngestQueueModality;
  capturedAt?: number;
  note?: string;
};

export type IngestQueueEnqueueResult =
  | {
      accepted: true;
      requestId: string;
      queueDepth: number;
      action: "queued" | "replaced" | "evicted-visual";
      affectedRequestId?: string;
    }
  | {
      accepted: false;
      queueDepth: number;
    };

export function enqueueIngestJob<T extends IngestQueueJob>(
  queue: T[],
  job: T,
  options: { maxPendingJobs: number },
): IngestQueueEnqueueResult {
  const replaceIndex = resolveReplaceIndex(queue, job);
  if (replaceIndex !== -1) {
    const replaced = queue.splice(replaceIndex, 1)[0];
    queue.push(job);
    return {
      accepted: true,
      requestId: job.requestId,
      queueDepth: queue.length,
      action: "replaced",
      affectedRequestId: replaced?.requestId,
    };
  }

  if (queue.length >= options.maxPendingJobs) {
    const evictIndex = findEvictableVisualIndex(queue, job.deviceId);
    if (evictIndex !== -1) {
      const evicted = queue.splice(evictIndex, 1)[0];
      queue.push(job);
      return {
        accepted: true,
        requestId: job.requestId,
        queueDepth: queue.length,
        action: "evicted-visual",
        affectedRequestId: evicted?.requestId,
      };
    }
    return {
      accepted: false,
      queueDepth: queue.length,
    };
  }

  queue.push(job);
  return {
    accepted: true,
    requestId: job.requestId,
    queueDepth: queue.length,
    action: "queued",
  };
}

function resolveReplaceIndex<T extends IngestQueueJob>(queue: T[], job: T): number {
  if (job.modality === "image") {
    return findReplaceableImageIndex(queue, job);
  }
  if (job.modality === "audio") {
    return findReplaceableAudioIndex(queue, job);
  }
  return findReplaceableVideoIndex(queue, job);
}

function findReplaceableImageIndex<T extends IngestQueueJob>(queue: T[], job: T): number {
  const bucket = captureBucket(job.note);
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const candidate = queue[index];
    if (
      candidate &&
      candidate.modality === "image" &&
      candidate.deviceId === job.deviceId &&
      captureBucket(candidate.note) === bucket
    ) {
      return index;
    }
  }
  return -1;
}

function findEvictableVisualIndex<T extends IngestQueueJob>(queue: T[], preferredDeviceId: string): number {
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (candidate?.modality === "image" && candidate.deviceId === preferredDeviceId) {
      return index;
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    if (queue[index]?.modality === "image") {
      return index;
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (candidate?.modality === "video" && candidate.deviceId === preferredDeviceId) {
      return index;
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    if (queue[index]?.modality === "video") {
      return index;
    }
  }
  return -1;
}

function findReplaceableAudioIndex<T extends IngestQueueJob>(queue: T[], job: T): number {
  const targetIdentity = deriveAudioIdentity(job);
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const candidate = queue[index];
    if (!candidate || candidate.modality !== "audio" || candidate.deviceId !== job.deviceId) {
      continue;
    }
    if (targetIdentity && deriveAudioIdentity(candidate) === targetIdentity) {
      return index;
    }
    if (
      Number.isFinite(candidate.capturedAt) &&
      Number.isFinite(job.capturedAt) &&
      Math.abs((candidate.capturedAt ?? 0) - (job.capturedAt ?? 0)) <= 1200
    ) {
      return index;
    }
  }
  return -1;
}

function deriveAudioIdentity(job: IngestQueueJob): string | undefined {
  const note = job.note?.trim();
  if (!note) {
    return undefined;
  }
  const session = note.match(/\bsession=([^\s]+)/)?.[1]?.trim();
  const segment = note.match(/\bsegment=([^\s]+)/)?.[1]?.trim();
  if (!session || !segment) {
    return undefined;
  }
  return `${session}::${segment}`;
}

function findReplaceableVideoIndex<T extends IngestQueueJob>(queue: T[], job: T): number {
  const bucket = captureBucket(job.note);
  const requestId = videoRequestId(job.note);
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const candidate = queue[index];
    if (!candidate || candidate.modality !== "video" || candidate.deviceId !== job.deviceId) {
      continue;
    }
    if (requestId && videoRequestId(candidate.note) !== requestId) {
      continue;
    }
    if (captureBucket(candidate.note) === bucket) {
      return index;
    }
    if (requestId) {
      continue;
    }
    if (
      Number.isFinite(candidate.capturedAt) &&
      Number.isFinite(job.capturedAt) &&
      Math.abs((candidate.capturedAt ?? 0) - (job.capturedAt ?? 0)) <= 2000
    ) {
      return index;
    }
  }
  return -1;
}

function captureBucket(note: string | undefined): string {
  const trimmed = note?.trim();
  if (!trimmed) {
    return "generic-image";
  }
  const requestId = videoRequestId(trimmed);
  const keyframeMarker = trimmed.match(/\bkeyframe=([^\s]+)/)?.[1]?.trim();
  if (keyframeMarker) {
    return `video-keyframe:${requestId ?? "unknown"}:${keyframeMarker}`;
  }
  if (requestId) {
    return `video:${requestId}`;
  }
  if (/\bactive-window\b/i.test(trimmed)) {
    return "active-window";
  }
  if (/\bbaseline-snapshot\b/i.test(trimmed)) {
    return "baseline-snapshot";
  }
  return "generic-image";
}

function videoRequestId(note: string | undefined): string | undefined {
  const id = note?.match(/\bvideoRequestId=([^\s]+)/i)?.[1]?.trim();
  return id || undefined;
}
