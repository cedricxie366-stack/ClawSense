# ClawSense-Interact: Evaluating Real-Time Multimodal Agents Grounded in a User's Immediate Physical World

Principal Investigator: `[NAME]`  
Primary contact: `[EMAIL]`  
Location: `[CITY, COUNTRY]`  
Organization: `[Individual applicant / organization name]`

## Summary

Most AI agent benchmarks focus on text, web tasks, desktop control, or short video understanding. We propose a complementary setting: agents that understand the physical world immediately around a human user. These agents are not only operating in a browser, and they are not yet manipulating objects with a robot arm. They are continuously exposed to everyday environments such as desks, classrooms, meetings, whiteboards, screens, conversations, visitors, and physical context changes, and they must interact with the user in real time.

We propose **ClawSense-Interact**, a research platform and evaluation suite for real-time multimodal agents grounded in a user's immediate physical world. The system uses a low-cost Android device as an always-on sensory node, collecting consented audio, periodic images, short video clips, timestamps, and device heartbeat signals. These signals are converted into auditable evidence bundles that can be consumed by multimodal models during live user interaction.

The user can ask natural questions such as:

- "What just happened?"
- "Who came by my desk?"
- "What did we discuss in the last four hours?"
- "What am I looking at now?"
- "What evidence supports your answer?"
- "You got that person wrong; remember this correction."

The central research question is:

> How should we evaluate whether a real-time multimodal agent understands the user's immediate physical world, remains safely steerable by the human, and grounds its answers in inspectable evidence rather than hallucination?

This proposal focuses on evaluation, interaction, safety, and system design rather than training a new foundation model. ClawSense is already a working OpenClaw plugin plus Android client with pairing, audio/image/video ingest, evidence indexing, media review, real-time assistant query, TTS output, follow-up controls, and backpressure-aware upload handling. The grant would let us turn this working prototype into a reproducible research harness and benchmark.

## Research Agenda

### 1. Immediate Physical-World Grounding

The agent must answer questions over the user's actual surroundings, not generic memory or unsupported guesses. We will evaluate:

- current-scene grounding: "What am I looking at?"
- recent-event grounding: "What just happened?"
- temporal-range grounding: "What did we discuss in the past hour / four hours / yesterday?"
- person/task grounding: "Who gave me a task?" or "Who came by?"
- evidence-grounded explanation: "Which audio/image/video evidence supports this answer?"

Metrics:

- evidence selection accuracy
- temporal localization accuracy
- answer groundedness
- unsupported-claim rate
- uncertainty calibration
- user correction rate

### 2. Real-Time Multimodal Interaction

The agent should work with live audio, images, and short video evidence. The user can interrupt, ask follow-ups, request shorter or longer answers, ask the system to read aloud, or stop speaking.

We will evaluate:

- follow-up continuity
- response latency
- TTS usefulness
- interruption handling
- "read full answer" and "stop speaking" control reliability
- real-time evidence refresh over the last seconds to minutes

Metrics:

- latency to evidence availability
- end-to-end voice interaction success
- follow-up state retention
- speech-control success rate
- human-rated usefulness

### 3. Ambient Safety and Intent Boundaries

An always-listening physical-world agent creates safety problems that turn-based text systems do not face. It must distinguish explicit user queries from background speech, meeting audio, videos playing nearby, and its own TTS output. It must not treat every spoken sentence as an instruction.

We will build a safety evaluation suite for:

- no-arm ambient speech: background speech should not trigger assistant queries
- TTS echo drain: the system must not record and respond to its own output
- accidental trigger rejection
- automatic short-video trigger safety
- trigger reason auditing
- queue/backpressure-aware capture limits

Metrics:

- false activation rate
- false rejection rate
- echo contamination rate
- unsafe auto-capture rate
- trigger explanation completeness
- recovery behavior after overload

### 4. Human Steering and Long-Session Memory

The user should be able to steer the system during and after long sessions. Corrections and annotations should improve later responses without turning the system into an opaque memory store.

We will evaluate:

- person/speaker annotation
- project/task correction
- user preference memory
- daily evidence consolidation
- episode reflection
- whether later answers improve after user feedback

Metrics:

- memory hit precision
- stale/incorrect memory rate
- improvement after correction
- repeated-error rate
- user steering effectiveness
- cross-day task/person recall

## System Design

ClawSense-Interact will consist of:

- Android sensory node: audio, images, short video, heartbeat, TTS response surface
- evidence ingest service: fast artifact persistence and asynchronous analysis
- evidence bundle schema: transcript spans, image/video references, timestamps, source IDs, trigger reasons
- live assistant API: current-context and time-range query handling
- safety harness: ambient audio, echo, no-arm, and auto-video backpressure tests
- evaluation dashboard: task success, latency, grounding, safety, correction, memory, and steering metrics
- reproducible public benchmark scenarios: scripted, consented scenes that can be replayed without exposing private personal data

We will not submit or publish private personal recordings. Public releases will use consented scripted data, anonymized evidence bundles, and reproducible scene protocols. Private longitudinal traces may be used only for internal validation with consent.

## Six-Month Timeline

### Month 1: Research Harness and Benchmark Specification

- Harden ClawSense evidence logging for research use.
- Define the task taxonomy and metric schema.
- Produce the first benchmark protocol document.

Deliverables:

- benchmark spec v0
- evidence bundle schema
- safety/privacy protocol

### Month 2: Physical-World Interaction Task Set

- Build scripted office/classroom/desk scenarios.
- Collect consented multimodal traces.
- Implement graders for evidence selection, temporal grounding, and unsupported claims.

Deliverables:

- ClawSense-Interact task set v1
- public scripted scenario templates
- baseline evaluation scripts

### Month 3: Real-Time Interaction and Safety Suite

- Evaluate explicit query vs ambient speech.
- Evaluate TTS echo drain, interruptions, and stop/read-full controls.
- Implement automatic short-video trigger auditing.

Deliverables:

- ambient safety benchmark
- interaction-control benchmark
- safety report v1

### Month 4: Human Steering and Memory Experiments

- Add person/task/project correction tasks.
- Add daily consolidation and episode reflection comparisons.
- Measure whether feedback improves later answers.

Deliverables:

- steering benchmark
- memory ablation report
- correction/recovery metrics

### Month 5: Cross-Model Evaluation and Generalization

- Run baselines across available multimodal and real-time systems.
- Test whether the benchmark generalizes beyond ClawSense/OpenClaw.
- Use Tinker credits for open-model fine-tuning or evaluator/adjudicator experiments where useful.

Deliverables:

- cross-model comparison report
- reproducibility package
- optional fine-tuned evaluator/adapters

### Month 6: Public Release and Final Report

- Release benchmark schema, harness, scripted dataset, and evaluation scripts.
- Publish a technical report with results, lessons, and limitations.
- Document privacy/safety best practices for physical-world interactive agents.

Deliverables:

- open-source ClawSense-Interact harness
- public benchmark release
- final technical report
- demo videos using consented scripted scenes

## Expected Outcomes

By the end of the project, we expect to deliver:

1. A reproducible benchmark for real-time agents grounded in a user's immediate physical world.
2. A safety evaluation suite for ambient multimodal agents.
3. A set of metrics for evidence-grounded, time-aware, steerable interaction.
4. Open-source tooling that other researchers can adapt to their own models and environments.
5. A technical report identifying where current models fail: time-range selection, visual grounding, ambient intent boundaries, evidence citation, long-session memory, and user steering.

## Broader Impact

Physical-world interactive agents could become useful assistants for offices, classrooms, accessibility, field work, and personal knowledge work. They also create privacy and safety risks. This project is designed around consent, inspectable evidence, local-first data handling, trigger auditing, and explicit user control. We aim to make this research useful not only for building more capable systems, but for making them safer and more understandable.
