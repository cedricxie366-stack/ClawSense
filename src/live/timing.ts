/** Monotonic host measurements. Never equate a PCM packet with audible phone playback. */
export class LiveTurnTiming {
  private readonly start = performance.now();
  private readonly spans: Record<string, { totalMs: number; count: number }> = {};
  private readonly marks: Record<string, number> = {};
  private readonly providers: Array<{ stage: string; values: Record<string, number> }> = [];
  constructor(readonly input: "text" | "voice-transcript" | "ambient-transcript") {}
  mark(name: string) { this.marks[name] ??= performance.now() - this.start; }
  provider(stage: "llm" | "tts", values: Record<string, number>) {
    if (this.providers.length >= 64) return;
    const allowed = ["promptTokens", "cachedTokens", "firstTokenMs", "cacheLookupMs", "cacheBytes", "firstAudioMs", "totalMs", "generatedDurationMs", "activeMemoryMiB", "cacheMemoryMiB", "peakMemoryMiB", "wiredLimitMiB", "analysisWaitMs", "parkVisualMs", "requestPreparationMs", "workerQueueMs", "modelLoadMs", "residencyMs"];
    const numeric = Object.fromEntries(allowed.filter(key => typeof values[key] === "number" && Number.isFinite(values[key]) && values[key]! >= 0).map(key => [key, values[key]!]));
    this.providers.push({ stage, values: numeric });
  }
  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const began = performance.now();
    try { return await operation(); }
    finally {
      const span = this.spans[name] ??= { totalMs: 0, count: 0 };
      span.totalMs += performance.now() - began; span.count++;
    }
  }
  snapshot() {
    return { version: 1, input: this.input, endpoint: "host-pcm-emitted", totalMs: performance.now() - this.start,
      milestonesMs: { ...this.marks }, spans: structuredClone(this.spans), providers: structuredClone(this.providers),
      meaning: "Host offsets start at accepted text/transcript; spans may overlap. ASR, transport and audible playback are separate." };
  }
}
