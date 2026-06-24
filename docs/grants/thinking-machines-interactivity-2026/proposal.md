# ClawSense-Interact: Evaluating Real-Time Agents as Interactive Partners in the Physical World

Principal Investigator: `[NAME]`  
Primary contact: `[EMAIL]`  
Location: `[CITY, COUNTRY]`  
Organization: `[Individual applicant / organization name]`

## Summary

Almost every agent benchmark today assumes the same interaction shape: the human starts each turn, the agent answers, and the world holds still in between. ClawSense-Interact studies a setting where none of that holds. An always-on agent that follows the physical world around a user does not simply wait for turns. It must continuously decide *whether to speak at all*, its answers go stale as the room changes, and it shares a physical space the user can point at. We argue that interaction in the physical world is not turn-taking question answering; it is **continuous, asymmetric, and time-decaying mutual grounding of attention between a human and an agent**.

This speaks directly to the program's premise that interactivity must scale with intelligence rather than stay secondary to it. Among the example settings in the call, ClawSense makes the turn-taking assumption especially visible and testable. The agent is not just navigating a browser, and it is not yet controlling a robot arm; it is trying to be a useful partner in everyday spaces: desks, classrooms, meetings, whiteboards, screens, conversations, retail product displays, sales consultations, visitors, and changing physical context.

**ClawSense-Interact** is a research platform and evaluation suite that treats a real-time multimodal agent as an interactive partner grounded in a user's immediate physical world. It uses a low-cost Android device as a sensory node, collecting consented audio, periodic images, short video clips, timestamps, and device heartbeat signals. These signals are converted into auditable evidence bundles that multimodal models can use during live interaction.

The initial benchmark scenarios cover office, classroom, desk, and scripted retail consultation settings. Retail is a useful testbed because it puts many hard problems in one scene: noisy speech, multiple participants, visual product context, ambiguous customer needs, staff response quality, follow-up opportunities, and strict privacy boundaries.

The user can ask natural questions such as:

- "What just happened?"
- "Who came by my desk?"
- "What did we discuss in the last four hours?"
- "What am I looking at now?"
- "What evidence supports your answer?"
- "You got that person wrong; remember this correction."
- "What did the customer ask about, and how did the salesperson respond?"
- "Which products, objections, or follow-up opportunities were mentioned?"

The central research question is:

> How should we evaluate a real-time multimodal agent as an *interactive partner* in the physical world — one that knows when to speak, whose answers stay temporally honest, and whose understanding can be repaired by the human in a single gesture — rather than as a question-answering system measured only by accuracy?

The project focuses on evaluation, interaction, safety, and system design rather than training a new foundation model. ClawSense is already a working OpenClaw plugin and Android client with pairing, audio/image/video ingest, evidence indexing, media review, real-time assistant query, TTS output, follow-up controls, and backpressure-aware upload handling. The grant would turn this prototype into a benchmark package that others can run against the same scripted scenes, evidence bundles, and metrics.

The project is led as an individual research effort. I work day-to-day on AI products in a large-scale duty-free retail group, which gives the project a realistic validation pathway: frontline salesperson-customer conversation is one of the densest real settings for these interaction problems, and while the group is not prioritizing this direction itself, it encourages me to pursue it independently and to explore future collaboration. I treat this as a feasibility and impact asset rather than a committed partnership. The grant work will begin with consented scripted sessions, anonymized evidence bundles, and privacy-preserving evaluation, and any future real-store pilot would require explicit consent and organizational approval.

## Research Agenda

The agenda is organized around three interaction primitives that the turn-taking paradigm leaves untested. Physical-world grounding and long-session memory are not dropped — they are treated as supporting capabilities measured inside each pillar rather than as ends in themselves.

### Pillar A — Initiative and Interruption: When Should the Agent Speak?

A turn-based assistant never has to decide whether to talk, because the human always starts. An always-on agent does. We study proactivity calibration: when to volunteer information, when to stay silent, and when an interruption is worth the cost of the user's attention. This reframes human steering as bidirectional — not only the human steering the agent, but the agent's restraint in claiming the human's attention, and the user's ability to tune that threshold.

The benchmark will evaluate:

- proactive offers: should the agent surface a follow-up, a missed task, or a relevant fact unprompted?
- silence under ambiguity: staying quiet when a prompt is not warranted
- interruption timing during meetings, consultations, and focused work
- user control over the proactivity threshold (more eager / more reserved)

Metrics:

- necessary-interruption recall
- false-interruption rate
- cost of harmful silence (a needed prompt withheld)
- interruption-timing usefulness (human-rated)
- steerability of the proactivity threshold

### Pillar B — Temporally Honest Interaction: Answers Expire

In the physical world, latency is not only a UX cost; it changes what is true. An answer to "what am I looking at?" delivered three seconds late may describe a scene that no longer exists. We treat interaction quality as a joint function of latency and evidence freshness, and require the agent to recognize when its own answer has gone stale.

The benchmark will evaluate:

- perception-to-utterance latency under live conditions
- staleness detection: knowing when the evidence behind an answer has expired
- current-scene vs recent-event vs time-range grounding ("now", "just happened", "the last four hours")
- follow-up continuity and "read full answer" / "stop speaking" control reliability

Metrics:

- perception-to-utterance latency budget
- answer staleness rate (evidence already expired at speak time)
- self-flagged-expiry precision
- end-to-end voice interaction success under live conditions
- freshness-calibrated groundedness

### Pillar C — Glanceable Evidence and One-Gesture Repair

Trust in a live setting cannot rest on a paragraph the user has no time to read. We render evidence bundles as interactive SVG/HTML evidence timelines — the exact audio/image/video clips an answer rests on — so the user can verify at a glance and correct in one gesture, reusing ClawSense's existing correction loop ("that person is Alex, remember that"). We adopt a conversational-grounding view (after Clark): interaction quality is the *cost of repair*, not single-shot accuracy.

The benchmark will evaluate:

- evidence-grounded explanation: "Which audio/image/video evidence supports this answer?"
- glanceable evidence UI: can the user confirm or reject an answer at a glance?
- one-gesture repair of person, task, project, and preference labels
- whether a correction improves later answers without creating stale or opaque memory

Metrics:

- turns-to-repair and improvement after correction
- repeated-error rate
- evidence-verification effort (operations/glance to confirm)
- explanation completeness of the rendered evidence UI
- evidence selection accuracy and unsupported-claim rate
- cross-day recall of corrected person/task labels

### Cross-Cutting: Ambient Safety and Perception Legibility

Two concerns run through all three pillars. **Ambient safety and intent boundaries:** an always-listening agent must separate an explicit query from background speech, meeting audio, videos playing nearby, and its own TTS output, with auditable trigger reasons and backpressure-aware capture limits. Metrics: false activation rate, false rejection rate, echo contamination rate, unsafe auto-capture rate, trigger explanation completeness, and recovery after overload. **Perception legibility and consent:** the user can steer the agent's sensing in real time ("stop listening", "forget the last five minutes"), and the agent must keep its sensing state visible, treating privacy as a real-time interaction contract rather than a static setting. This matters especially for retail and customer-service scenes, where the system must not over-record, over-infer, or expose sensitive conversation details.

### Measurement and Construct Validity

Every metric above is tied to an explicit grader and ground truth so that scores mean what they claim. Scripted scenes are authored with known answers, known evidence spans, and a known correct timing for when the agent should and should not speak, giving objective references for grounding, temporal localization, and interruption decisions. Programmatic graders score evidence selection, latency, staleness, and trigger safety directly from logs; subjective qualities (usefulness, repair cost, explanation completeness) use a fixed rubric with multiple human raters and reported inter-rater agreement, with an open-model judge used only as a pre-screen that is always reconciled against human labels. Every task ships with simple baselines across available multimodal and real-time models so that absolute numbers are interpretable as relative differences, and the harness runs against any OpenClaw-compatible model to keep the benchmark general and reproducible.

## System Design

ClawSense-Interact consists of:

- Android sensory node: audio, images, short video, heartbeat, TTS response surface
- evidence ingest service: fast artifact persistence and asynchronous analysis
- evidence bundle schema: transcript spans, image/video references, timestamps, source IDs, trigger reasons
- live assistant API: current-context and time-range query handling, with proactive-offer hooks
- evidence-timeline renderer: SVG/HTML rendering of the clips behind each answer for glanceable verification and one-gesture correction
- safety harness: ambient audio, echo, no-arm, and auto-video backpressure tests
- evaluation dashboard: initiative/interruption, latency and staleness, grounding, repair cost, safety, memory, and steering metrics
- public benchmark scenarios: scripted, consented scenes that can be replayed without exposing private personal data
- optional domain scenario packs for retail sales consultation and frontline service training

The project will not submit or publish private personal recordings. Public releases will use consented scripted data, anonymized evidence bundles, and reproducible scene protocols. Private longitudinal traces may be used only for internal validation with consent.

## Six-Month Timeline

### Month 1: Research Harness and Benchmark Specification

- Harden ClawSense evidence logging for research use.
- Define the task taxonomy and metric schema.
- Produce the first benchmark protocol document.

Deliverables:

- benchmark spec v0
- evidence bundle schema
- safety/privacy protocol

### Month 2: Pillar C — Glanceable Evidence and Repair

- Build scripted office/classroom/desk and retail sales consultation scenarios.
- Build the SVG/HTML evidence-timeline renderer.
- Implement correction/repair tasks and graders for evidence selection and unsupported claims.

Deliverables:

- ClawSense-Interact task set v1 and scripted/retail scenario templates
- evidence-UI renderer
- repair benchmark with cost-of-repair metrics

### Month 3: Pillar B — Temporally Honest Interaction

- Instrument perception-to-utterance latency and evidence freshness.
- Add staleness detection for expired answers.
- Evaluate live voice interaction, follow-ups, and stop/read-full controls.

Deliverables:

- latency–freshness benchmark
- staleness graders
- interaction-control report

### Month 4: Pillar A plus Cross-Cutting Safety

- Build proactivity-calibration tasks (necessary vs false interruption, silence cost, threshold steering).
- Run ambient-safety and perception-legibility tests (explicit query vs ambient speech, TTS echo drain, trigger auditing, consent controls).

Deliverables:

- interruption benchmark
- ambient-safety report
- perception-legibility tests

### Month 5: Cross-Model Evaluation and Generalization

- Run baselines across available multimodal and real-time systems.
- Test whether the benchmark generalizes beyond ClawSense/OpenClaw.
- Use Tinker credits for open-model fine-tuning or evaluator/adjudicator experiments where they help the evaluation.

Deliverables:

- cross-model comparison report
- reproducibility package
- optional fine-tuned evaluator/adapters

### Month 6: Public Release and Final Report

- Release benchmark schema, harness, scripted dataset, and evaluation scripts.
- Publish a technical report with results, lessons, and limitations.
- Document privacy/safety practices for physical-world interactive agents.

Deliverables:

- open-source ClawSense-Interact harness
- public benchmark release
- final technical report
- demo videos using consented scripted scenes

## Expected Outcomes

By the end of the project, the expected outputs are:

1. A reproducible benchmark that treats a real-time physical-world agent as an interactive partner rather than a question-answering system.
2. The first task sets for three under-studied interaction primitives: agent initiative and interruption timing, temporally honest (expiring) answers, and glanceable-evidence one-gesture repair.
3. A safety and perception-legibility evaluation suite for always-on multimodal agents.
4. Open-source tooling that other researchers can adapt to their own models and environments.
5. A technical report identifying where current models fail: when-to-speak, answer staleness, evidence citation, repair cost, long-session memory, and user steering.

## Broader Impact

Physical-world interactive agents could become useful assistants for offices, classrooms, accessibility, field work, and personal knowledge work. They also create privacy and safety risks. This project is built around consent, inspectable evidence, local-first data handling, trigger auditing, and explicit user control. The goal is to make these systems easier to evaluate before they are used in real environments.

Retail and frontline service are especially important long-term contexts. A safe, evidence-grounded physical-world agent could help staff review customer needs, improve training, identify missed follow-up opportunities, and connect real customer interactions to business value without relying on unsupported inference or hidden surveillance. The grant work would stay in scripted and consented research settings first, establishing evaluation and safety foundations before any real-world deployment.
