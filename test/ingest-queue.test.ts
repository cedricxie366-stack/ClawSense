import { describe, expect, it } from "vitest";
import { enqueueIngestJob, type IngestQueueJob } from "../src/ingest-queue.js";

describe("enqueueIngestJob", () => {
  it("coalesces repeated image snapshots for the same device and capture bucket", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "img-1",
        deviceId: "device-1",
        modality: "image",
        note: "active-window",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "img-2",
        deviceId: "device-1",
        modality: "image",
        note: "active-window",
      }),
      { maxPendingJobs: 24 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "replaced",
      affectedRequestId: "img-1",
      queueDepth: 1,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["img-2"]);
  });

  it("does not coalesce image keyframes from different videos even with the same keyframe index", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "img-1",
        deviceId: "device-1",
        modality: "image",
        note: "active-window videoRequestId=req-123 videoKeyframe=1 keyframe=1",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "img-2",
        deviceId: "device-1",
        modality: "image",
        note: "active-window videoRequestId=req-456 videoKeyframe=1 keyframe=1",
      }),
      { maxPendingJobs: 24 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "queued",
      queueDepth: 2,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["img-1", "img-2"]);
  });

  it("coalesces retries for the same video keyframe", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "kf-1a",
        deviceId: "device-1",
        modality: "image",
        note: "active-window videoRequestId=req-123 videoKeyframe=1 keyframe=1",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "kf-1b",
        deviceId: "device-1",
        modality: "image",
        note: "active-window videoRequestId=req-123 videoKeyframe=1 keyframe=1",
      }),
      { maxPendingJobs: 24 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "replaced",
      affectedRequestId: "kf-1a",
      queueDepth: 1,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["kf-1b"]);
  });

  it("does not coalesce distinct video keyframes from the same device", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "kf-1",
        deviceId: "device-1",
        modality: "image",
        note: "active-window keyframe=1",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "kf-2",
        deviceId: "device-1",
        modality: "image",
        note: "active-window keyframe=2",
      }),
      { maxPendingJobs: 24 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "queued",
      queueDepth: 2,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["kf-1", "kf-2"]);
  });

  it("evicts an older queued image to make room for audio when the queue is full", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "img-1",
        deviceId: "device-1",
        modality: "image",
      }),
      createJob({
        requestId: "audio-1",
        deviceId: "device-1",
        modality: "audio",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "audio-2",
        deviceId: "device-1",
        modality: "audio",
      }),
      { maxPendingJobs: 2 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "evicted-visual",
      affectedRequestId: "img-1",
      queueDepth: 2,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["audio-1", "audio-2"]);
  });

  it("rejects new work only when the queue is full of audio jobs with nothing evictable", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "audio-1",
        deviceId: "device-1",
        modality: "audio",
      }),
      createJob({
        requestId: "audio-2",
        deviceId: "device-1",
        modality: "audio",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "audio-3",
        deviceId: "device-1",
        modality: "audio",
      }),
      { maxPendingJobs: 2 },
    );

    expect(result).toEqual({
      accepted: false,
      queueDepth: 2,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["audio-1", "audio-2"]);
  });

  it("coalesces retried audio segments for the same session marker", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "audio-1",
        deviceId: "device-1",
        modality: "audio",
        note: "csAudio:v2 session=conv-1 segment=3 sessionStart=1773933964520 boundary=silence",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "audio-2",
        deviceId: "device-1",
        modality: "audio",
        note: "csAudio:v2 session=conv-1 segment=3 sessionStart=1773933964520 boundary=silence",
      }),
      { maxPendingJobs: 24 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "replaced",
      affectedRequestId: "audio-1",
      queueDepth: 1,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["audio-2"]);
  });

  it("coalesces nearby video retries for the same device", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "video-1",
        deviceId: "device-1",
        modality: "video",
        capturedAt: 1_000,
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "video-2",
        deviceId: "device-1",
        modality: "video",
        capturedAt: 2_200,
      }),
      { maxPendingJobs: 24 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "replaced",
      affectedRequestId: "video-1",
      queueDepth: 1,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["video-2"]);
  });

  it("does not coalesce distinct parent videos when videoRequestId differs", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "video-1",
        deviceId: "device-1",
        modality: "video",
        capturedAt: 1_000,
        note: "videoRequestId=req-1",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "video-2",
        deviceId: "device-1",
        modality: "video",
        capturedAt: 2_000,
        note: "videoRequestId=req-2",
      }),
      { maxPendingJobs: 24 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "queued",
      queueDepth: 2,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["video-1", "video-2"]);
  });

  it("admits duplicate audio retries even when queue is full by replacing the older copy", () => {
    const queue: Array<IngestQueueJob> = [
      createJob({
        requestId: "audio-1",
        deviceId: "device-1",
        modality: "audio",
        note: "csAudio:v2 session=conv-1 segment=1 sessionStart=1773933964520 boundary=silence",
      }),
      createJob({
        requestId: "audio-2",
        deviceId: "device-1",
        modality: "audio",
        note: "csAudio:v2 session=conv-2 segment=1 sessionStart=1773933969999 boundary=silence",
      }),
    ];

    const result = enqueueIngestJob(
      queue,
      createJob({
        requestId: "audio-3",
        deviceId: "device-1",
        modality: "audio",
        note: "csAudio:v2 session=conv-1 segment=1 sessionStart=1773933964520 boundary=silence",
      }),
      { maxPendingJobs: 2 },
    );

    expect(result).toMatchObject({
      accepted: true,
      action: "replaced",
      affectedRequestId: "audio-1",
      queueDepth: 2,
    });
    expect(queue.map((job) => job.requestId)).toEqual(["audio-2", "audio-3"]);
  });
});

function createJob(overrides: Partial<IngestQueueJob>): IngestQueueJob {
  return {
    requestId: overrides.requestId ?? "job-1",
    queuedAt: overrides.queuedAt ?? 1,
    deviceId: overrides.deviceId ?? "device-1",
    modality: overrides.modality ?? "image",
    capturedAt: overrides.capturedAt,
    note: overrides.note,
  };
}
