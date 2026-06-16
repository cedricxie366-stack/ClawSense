# AMI ES2002a Expected / Rubric

## Scenario

Office meeting: a team kicks off a project to design a new remote control.

## Must Mention

- The meeting is a project kickoff for designing a remote control.
- The team discusses roles or role ownership, including project management, industrial design, UI/function design, and marketing/requirements.
- The team discusses financial constraints: selling price around 25 Euro and production cost not exceeding about 12.50 Euro.
- The team discusses product requirements or possible features, such as usability, multi-device control, lost remote / locating ideas, touch screen, or international market constraints.
- The answer should include at least one concrete follow-up or uncertainty, such as competitor data, regional market data, cost allocation, or feasibility of proposed features.

## Nice To Mention

- The animal drawing / icebreaker is part of the meeting, but it should not dominate the answer.
- The meeting room / visual scene can be mentioned only as environment context.
- If speaker identities are not annotated, the answer should use role hints or `speaker_*` carefully and invite labeling.

## Must Not Invent

- Do not invent deadlines, customer names, or final product decisions not present in evidence.
- Do not claim the remote design is finalized.
- Do not treat all role names as persisted ClawSense identities unless annotations exist.
- Do not answer only from the image; transcript evidence is required.

## Acceptance Questions

```text
刚才讨论的重点是什么？
过去四个小时我们聊了什么？
最后任务落给谁？
有哪些待确认事项？
```

## Pass Criteria

- `audioCoverage.transcriptReadyWindows >= 1`
- `responseHints.evidenceFollowUpTargets` includes at least one audio target.
- The answer contains the remote-control project topic.
- The answer contains at least one task/follow-up and one gap.
- The answer does not hallucinate unsupported identities or deadlines.
