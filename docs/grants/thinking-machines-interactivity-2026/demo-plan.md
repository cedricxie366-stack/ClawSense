# Scripted Demo Plan

Goal: produce a 60-90 second public demo that proves the project is real without exposing private personal recordings.

## Demo Story

Scenario: a retail consultation or desk/classroom-style scripted scene. The preferred first public demo is a lightweight retail consultation because it shows physical context, multi-party speech, visual product evidence, customer intent, and follow-up value in one compact story.

1. Android phone is paired as a ClawSense sensory node.
2. The phone observes a short scripted interaction:
   - a visible product, shelf card, poster, document, or whiteboard is in view
   - a scripted customer asks a short question or expresses a need
   - a scripted staff member responds with product or follow-up information
3. The user asks by voice:
   - "What just happened?"
   - "What did the customer ask about?"
   - "What did I need to follow up on?"
   - "Which evidence supports that?"
4. ClawSense answers using audio/image/video evidence.
5. The phone reads a short spoken answer.
6. The user says a correction:
   - "That person is Alex, remember that."
7. The follow-up answer reflects the correction.

## Required Shots

- Android pairing or running state, with no secrets visible.
- Sensing service running.
- A short scripted physical scene.
- Optional retail scene: product display, shelf card, mock customer question, and staff response.
- Media library/evidence page showing anonymized evidence timeline.
- Assistant query response showing grounded answer and evidence.
- TTS playback or visible TTS completed status.
- Optional: no-arm ambient validation summary.

## Privacy Rules

- Use scripted participants and written consent.
- Do not show API keys, gateway tokens, QR setup tokens, device secrets, private messages, or real personal data.
- If screen capture is used, use a mock document or public web page.
- If retail context is used, use mock products, public product pages, or explicitly authorized materials.
- Blur faces unless participants explicitly consent to public display.
- Prefer exporting anonymized evidence bundles over raw private media.

## Suggested Demo Questions

- "What just happened?"
- "Who gave me a task?"
- "What did the customer ask about?"
- "Which product was mentioned?"
- "What follow-up opportunity did the staff need to remember?"
- "What am I looking at now?"
- "What did we discuss in the last few minutes?"
- "What evidence supports your answer?"
- "You got that name wrong; remember this person as Alex."

## Success Criteria

- The answer cites the correct time window.
- The answer uses both audio and visual evidence when available.
- The system avoids unsupported claims.
- TTS does not trigger a second assistant query.
- A user correction is visibly accepted or recorded.
