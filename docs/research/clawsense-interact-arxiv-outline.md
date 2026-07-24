# ClawSense-Interact — arXiv Technical Report Outline

Working title: **ClawSense-Interact: A Benchmark for Real-Time Multimodal Agents as Interactive Partners in the Physical World**

Target style: benchmark + system paper (NeurIPS Evaluations & Datasets track format). Length ~8–9 pages + appendix. Authors: Cedric (independent). License the benchmark + harness open-source.

Legend for drafting status:
- `[NOW]` = can write today from the existing system + proposal.
- `[DATA]` = needs scripted scenes + baseline runs before it can be finalized.

---

## Abstract `[NOW]`
One paragraph. State the gap (agent benchmarks assume turn-taking, a static world, and a human who starts every turn), the setting (always-on agent in a real room), the thesis (interaction here is continuous, asymmetric, time-decaying mutual grounding of attention), the artifact (a working system + a benchmark with three interaction primitives and explicit graders), and the headline finding once baselines exist `[DATA]`.

## 1. Introduction `[NOW]`
- The turn-taking assumption and why it fails in a physical room (decide whether to speak; answers expire; shared pointable space).
- Reframe interactivity as a first-class object, not a wrapper over QA accuracy.
- **Contributions** (bullet list — the spine of the paper):
  1. A formulation of physical-world interaction as three measurable primitives: initiative/interruption, temporal honesty, glanceable-evidence repair.
  2. ClawSense-Interact: an open benchmark with scripted scenes, evidence-bundle schema, task taxonomy, and explicit graders.
  3. A working open-source system (OpenClaw plugin + Android client) that both produces the data and runs the live tasks.
  4. Baseline evaluation across current multimodal/real-time models, with a failure-mode analysis `[DATA]`.
  5. A consent-first, local-first protocol for evaluating always-on agents before deployment.

## 2. Related Work `[NOW]`
- **Egocentric video benchmarks**: EgoLife, TeleEgo, Ego4D, Ego-Exo4D — position as offline QA over recorded video; contrast with live, turn-free interaction + steering.
- **Real-time / voice agents**: latency-focused work; note none score answer *staleness* against a changing scene.
- **Agent steering / human-in-the-loop**: steering during long-horizon tasks; we add the agent's *restraint* (when not to speak) as the dual.
- **Grounding & repair in dialogue**: Clark's grounding-in-communication; cost-of-repair as a quality measure.
- **Long-session memory benchmarks**: LoCoMo, LongMemEval, BEAM — we treat memory as a supporting capability, not the end.
- **Ambient / always-on & privacy**: distinguish explicit intent from background; perception legibility.

## 3. The ClawSense System (data + interaction substrate) `[NOW]`
- Architecture figure: Android sensory node → host ingest → evidence index → live assistant API.
- Sensory node: consented audio (VAD), periodic images, short video clips, timestamps, heartbeat, TTS surface + read-full/stop controls.
- Host: fast artifact persistence, async analysis, media/evidence indexing, daily review, **evidence-bundle export**, follow-up targets, queue/backpressure handling.
- **Evidence bundle schema** (transcript spans, image/video refs, timestamps, source IDs, trigger reasons) — a core reusable artifact; put the full schema in the appendix.
- Note what is verified on real hardware (feasibility).

## 4. Benchmark Design `[NOW]` (tasks) / `[DATA]` (final numbers)
Intro: organized around three interaction primitives + two cross-cutting concerns. For **each** pillar give: definition, task family, inputs/outputs, ground-truth source, and a metrics table.

### 4.1 Pillar A — Initiative & interruption (when to speak)
- Tasks: volunteer-vs-stay-silent, interruption-worth-the-cost, threshold steering.
- Metrics: necessary-interruption recall, false-interruption rate, cost of harmful silence, human-rated timing, steerability of the proactivity threshold.

### 4.2 Pillar B — Temporally honest interaction (answers expire)
- Tasks: current-scene grounding under motion, time-range recall, self-detected staleness.
- Metrics: perception-to-utterance latency budget, answer staleness rate, self-flagged-expiry precision, end-to-end voice success (live), freshness-calibrated groundedness.

### 4.3 Pillar C — Glanceable evidence & one-gesture repair
- Tasks: render answer's supporting clips as SVG/HTML timeline; verify-at-a-glance; correct-in-one-gesture; persistence of correction across days.
- Metrics: turns-to-repair, improvement-after-correction, repeated-error rate, evidence-verification effort, explanation completeness, cross-day recall of corrected labels.

### 4.4 Cross-cutting: ambient safety & perception legibility
- Safety: explicit query vs background speech / meetings / nearby video / own TTS; trigger auditing; backpressure limits. Metrics: false activation, false rejection, echo contamination, unsafe auto-capture, overload recovery.
- Legibility/consent: real-time sensing steering ("stop listening", "forget last 5 min"); visible sensing state.

## 5. Measurement & Construct Validity `[NOW]`
- Scripted scenes give known answers, known evidence spans, and known correct speak/stay-silent timing → objective references.
- Programmatic graders (evidence selection, latency, staleness, trigger safety) read from logs.
- Human-rated qualities (usefulness, repair cost, explanation completeness): fixed rubric, multiple raters, report inter-rater agreement; open-model judge only as pre-screen, reconciled to human labels.
- Baselines across reachable models → absolute scores read as relative differences. Harness runs on any OpenClaw-compatible model.

## 6. Experiments `[DATA]`
- Models evaluated (multimodal + real-time set); hardware/latency setup.
- Main results table per pillar; safety table; ablations (memory, retrieval, correction/repair loop).
- Cross-model comparison; effect of latency budget on staleness; steering on proactivity threshold.

## 7. Analysis & Failure Modes `[DATA]`
- Where models break: when-to-speak, stale answers, evidence citation, repair cost, long-session memory, ambient intent boundaries. Qualitative examples.

## 8. Ethics, Consent & Data Handling `[NOW]`
- Consent-first, scripted/anonymized; no raw private traces released; local-first storage, trigger auditing, deletion tooling; release uses scripted scenes only.

## 9. Limitations `[NOW]`
- Scripted scenes ≠ full real-world distribution; single-node sensing; human-rating cost; current scale; no real-store data in the public release.

## 10. Reproducibility & Release `[NOW]`
- Open-source harness, evidence-bundle schema, scripted scene templates, evaluation scripts, leaderboard plan; versioning.

## 11. Conclusion `[NOW]`
- Restate the reframing; make physical-world interactive agents measurable before deployment.

## Appendices
- A. Evidence-bundle schema (full).
- B. Scripted scene catalogue + authoring protocol.
- C. Metric formal definitions + grader pseudocode.
- D. Human-rating rubric + inter-rater protocol.
- E. System/API details.

---

## Suggested writing order (fastest path to a citable v1)
1. §3 System + §1 Intro/Contributions + Abstract — you can write these now; this alone is a postable v1 ("system + benchmark design").
2. §2 Related Work + §4 task/metric definitions + §5 construct validity.
3. §8–§11 (ethics/limitations/reproducibility/conclusion) — mostly reuse from the proposal.
4. Drop in §6–§7 once even a small baseline run exists; bump to v2.

Reuse map: proposal Summary → §1; proposal "Why feasible" + system → §3; proposal three pillars → §4; proposal "Measurement and construct validity" → §5; proposal ethics lines → §8.
