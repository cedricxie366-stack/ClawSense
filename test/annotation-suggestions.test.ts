import { describe, expect, it } from "vitest";
import {
  buildCliAnnotationApplyPlan,
  normalizeCliAnnotationSuggestions,
  normalizeCliSuggestionIdSelection,
  resolveMinimumConfidence,
} from "../src/annotation-suggestions.js";

describe("annotation suggestion helpers", () => {
  it("normalizes annotation suggestions and ignores invalid entries", () => {
    const normalized = normalizeCliAnnotationSuggestions({
      people: [
        {
          suggestionId: "person:amy",
          personRef: "person_amy",
          displayName: "Amy",
          sourceHint: "窗口：10:00-10:15",
          confidence: "high",
          sentenceTemplate: "人物 Amy 可能是老板",
          commandTemplate: "openclaw clawsense annotate person_amy Amy --relationship 老板",
        },
        {
          suggestionId: "broken",
          personRef: "missing_fields",
        },
      ],
      speakers: [
        {
          suggestionId: "speaker:1",
          speakerRef: "speaker_1",
          slotLabel: "speaker_1",
          windowId: "window-1",
          timeRange: "10:00-10:15",
          sentenceTemplate: "speaker_1 可能是 Amy",
          commandTemplate: "openclaw clawsense annotate-speaker speaker_1 Amy",
        },
      ],
    });

    expect(normalized.people).toEqual([
      expect.objectContaining({
        suggestionId: "person:amy",
        confidence: "high",
        autoApplyEligible: true,
      }),
    ]);
    expect(normalized.speakers).toEqual([
      expect.objectContaining({
        suggestionId: "speaker:1",
        confidence: "medium",
      }),
    ]);
  });

  it("builds apply plan with include-medium gate and max limit", () => {
    const suggestions = normalizeCliAnnotationSuggestions({
      people: [
        {
          suggestionId: "person:high-a",
          personRef: "person_high_a",
          displayName: "High A",
          sourceHint: "window-a",
          confidence: "high",
          autoApplyEligible: true,
          sentenceTemplate: "high-a",
          commandTemplate: "cmd-a",
        },
        {
          suggestionId: "person:high-b",
          personRef: "person_high_b",
          displayName: "High B",
          sourceHint: "window-b",
          confidence: "high",
          autoApplyEligible: true,
          sentenceTemplate: "high-b",
          commandTemplate: "cmd-b",
        },
        {
          suggestionId: "person:medium-c",
          personRef: "person_medium_c",
          displayName: "Medium C",
          sourceHint: "window-c",
          confidence: "medium",
          autoApplyEligible: false,
          sentenceTemplate: "medium-c",
          commandTemplate: "cmd-c",
        },
      ],
      speakers: [],
    });

    const plan = buildCliAnnotationApplyPlan({
      suggestions,
      maxCount: 1,
      includeMedium: false,
      minConfidence: resolveMinimumConfidence(undefined, false),
      requireRelationship: false,
      selectedSuggestionIds: [],
    });

    expect(plan.selected.map((item) => item.suggestionId)).toEqual(["person:high-a"]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ suggestionId: "person:high-b", reason: "over_max_limit" }),
        expect.objectContaining({ suggestionId: "person:medium-c", reason: "requires_include_medium" }),
      ]),
    );
  });

  it("respects explicit suggestion IDs and reports unknown/speaker-only selections", () => {
    const suggestions = normalizeCliAnnotationSuggestions({
      people: [
        {
          suggestionId: "person:amy",
          personRef: "person_amy",
          displayName: "Amy",
          sourceHint: "window-amy",
          confidence: "high",
          autoApplyEligible: true,
          sentenceTemplate: "amy",
          commandTemplate: "cmd-amy",
        },
      ],
      speakers: [
        {
          suggestionId: "speaker:1",
          speakerRef: "speaker_1",
          slotLabel: "speaker_1",
          windowId: "window-1",
          timeRange: "10:00-10:15",
          sentenceTemplate: "speaker1",
          commandTemplate: "cmd-speaker-1",
        },
      ],
    });

    const plan = buildCliAnnotationApplyPlan({
      suggestions,
      maxCount: 3,
      includeMedium: false,
      minConfidence: "high",
      requireRelationship: false,
      selectedSuggestionIds: normalizeCliSuggestionIdSelection([
        "person:amy",
        "speaker:1",
        "missing:id",
      ]),
    });

    expect(plan.selected.map((item) => item.suggestionId)).toEqual(["person:amy"]);
    expect(plan.unknownSuggestionIds).toEqual(["missing:id"]);
    expect(plan.unsupportedSelectedSpeakerSuggestions).toEqual([
      expect.objectContaining({
        suggestionId: "speaker:1",
        reason: "speaker_not_supported",
      }),
    ]);
  });

  it("enforces relationship requirement before selecting person suggestions", () => {
    const suggestions = normalizeCliAnnotationSuggestions({
      people: [
        {
          suggestionId: "person:no-relationship",
          personRef: "person_no_relationship",
          displayName: "No Relationship",
          sourceHint: "window-a",
          confidence: "high",
          autoApplyEligible: true,
          sentenceTemplate: "no-rel",
          commandTemplate: "cmd-no-rel",
        },
        {
          suggestionId: "person:with-relationship",
          personRef: "person_with_relationship",
          displayName: "With Relationship",
          sourceHint: "window-b",
          confidence: "high",
          autoApplyEligible: true,
          relationshipHint: "同事",
          sentenceTemplate: "with-rel",
          commandTemplate: "cmd-with-rel",
        },
      ],
      speakers: [],
    });

    const plan = buildCliAnnotationApplyPlan({
      suggestions,
      maxCount: 3,
      includeMedium: false,
      minConfidence: "high",
      requireRelationship: true,
      selectedSuggestionIds: [],
    });

    expect(plan.selected.map((item) => item.suggestionId)).toEqual(["person:with-relationship"]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          suggestionId: "person:no-relationship",
          reason: "requires_relationship_hint",
        }),
      ]),
    );
  });
});
