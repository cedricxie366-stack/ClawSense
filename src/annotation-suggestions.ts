export type SuggestionConfidenceLevel = "high" | "medium";

export type CliPersonAnnotationSuggestion = {
  suggestionId: string;
  personRef: string;
  displayName: string;
  sourceHint: string;
  confidence: SuggestionConfidenceLevel;
  autoApplyEligible: boolean;
  relationshipHint?: string;
  sentenceTemplate: string;
  commandTemplate: string;
};

export type CliSpeakerAnnotationSuggestion = {
  suggestionId: string;
  speakerRef: string;
  slotLabel: string;
  windowId: string;
  timeRange: string;
  confidence: "medium";
  sentenceTemplate: string;
  commandTemplate: string;
};

export type CliAnnotationSuggestions = {
  people: CliPersonAnnotationSuggestion[];
  speakers: CliSpeakerAnnotationSuggestion[];
};

export type AnnotationApplySkipReason =
  | "requires_include_medium"
  | "below_min_confidence"
  | "requires_relationship_hint"
  | "over_max_limit"
  | "not_selected_by_id";

export type CliAnnotationApplyPlan = {
  selected: CliPersonAnnotationSuggestion[];
  skipped: Array<{
    suggestionId: string;
    personRef: string;
    displayName: string;
    confidence: SuggestionConfidenceLevel;
    reason: AnnotationApplySkipReason;
  }>;
  selectedSuggestionIds: string[];
  unknownSuggestionIds: string[];
  unsupportedSelectedSpeakerSuggestions: Array<{
    suggestionId: string;
    speakerRef: string;
    slotLabel: string;
    reason: "speaker_not_supported";
  }>;
};

export function normalizeCliAnnotationSuggestions(value: unknown): CliAnnotationSuggestions {
  if (!value || typeof value !== "object") {
    return { people: [], speakers: [] };
  }
  const raw = value as {
    people?: unknown;
    speakers?: unknown;
  };
  const people = Array.isArray(raw.people)
    ? raw.people.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const candidate = item as Partial<CliPersonAnnotationSuggestion>;
      if (
        typeof candidate.suggestionId !== "string" ||
        typeof candidate.personRef !== "string" ||
        typeof candidate.displayName !== "string" ||
        typeof candidate.sourceHint !== "string" ||
        typeof candidate.sentenceTemplate !== "string" ||
        typeof candidate.commandTemplate !== "string"
      ) {
        return [];
      }
      const confidence = normalizeSuggestionConfidence(candidate.confidence);
      return [{
        suggestionId: candidate.suggestionId,
        personRef: candidate.personRef,
        displayName: candidate.displayName,
        sourceHint: candidate.sourceHint,
        confidence,
        autoApplyEligible: typeof candidate.autoApplyEligible === "boolean"
          ? candidate.autoApplyEligible
          : confidence === "high",
        relationshipHint: typeof candidate.relationshipHint === "string" ? candidate.relationshipHint : undefined,
        sentenceTemplate: candidate.sentenceTemplate,
        commandTemplate: candidate.commandTemplate,
      }];
    })
    : [];
  const speakers = Array.isArray(raw.speakers)
    ? raw.speakers.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const candidate = item as Partial<CliSpeakerAnnotationSuggestion>;
      if (
        typeof candidate.suggestionId !== "string" ||
        typeof candidate.speakerRef !== "string" ||
        typeof candidate.slotLabel !== "string" ||
        typeof candidate.windowId !== "string" ||
        typeof candidate.timeRange !== "string" ||
        typeof candidate.sentenceTemplate !== "string" ||
        typeof candidate.commandTemplate !== "string"
      ) {
        return [];
      }
      return [{
        suggestionId: candidate.suggestionId,
        speakerRef: candidate.speakerRef,
        slotLabel: candidate.slotLabel,
        windowId: candidate.windowId,
        timeRange: candidate.timeRange,
        confidence: "medium" as const,
        sentenceTemplate: candidate.sentenceTemplate,
        commandTemplate: candidate.commandTemplate,
      }];
    })
    : [];
  return { people, speakers };
}

export function normalizeCliSuggestionIdSelection(
  values: string[] | undefined,
): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

export function resolveMinimumConfidence(raw: string | undefined, includeMedium: boolean): SuggestionConfidenceLevel {
  if (includeMedium) {
    return "medium";
  }
  if (raw === "medium") {
    return "medium";
  }
  return "high";
}

export function isConfidenceAtLeast(
  confidence: SuggestionConfidenceLevel,
  minimum: SuggestionConfidenceLevel,
): boolean {
  const rank: Record<SuggestionConfidenceLevel, number> = {
    high: 2,
    medium: 1,
  };
  return rank[confidence] >= rank[minimum];
}

export function buildCliAnnotationApplyPlan(params: {
  suggestions: CliAnnotationSuggestions;
  maxCount: number;
  includeMedium: boolean;
  minConfidence: SuggestionConfidenceLevel;
  requireRelationship: boolean;
  selectedSuggestionIds: string[];
}): CliAnnotationApplyPlan {
  const selectedSuggestionIds = Array.from(new Set(params.selectedSuggestionIds));
  const selectedSuggestionIdSet = new Set(selectedSuggestionIds);
  const knownSuggestionIds = new Set(
    params.suggestions.people.map((item) => item.suggestionId).concat(
      params.suggestions.speakers.map((item) => item.suggestionId),
    ),
  );
  const unknownSuggestionIds = selectedSuggestionIds.filter((id) => !knownSuggestionIds.has(id));
  const skipped: CliAnnotationApplyPlan["skipped"] = [];
  const selectable: CliPersonAnnotationSuggestion[] = [];
  const unsupportedSelectedSpeakerSuggestions = params.suggestions.speakers
    .filter((item) => selectedSuggestionIdSet.has(item.suggestionId))
    .map((item) => ({
      suggestionId: item.suggestionId,
      speakerRef: item.speakerRef,
      slotLabel: item.slotLabel,
      reason: "speaker_not_supported" as const,
    }));
  for (const item of params.suggestions.people) {
    if (selectedSuggestionIdSet.size > 0 && !selectedSuggestionIdSet.has(item.suggestionId)) {
      skipped.push({
        suggestionId: item.suggestionId,
        personRef: item.personRef,
        displayName: item.displayName,
        confidence: item.confidence,
        reason: "not_selected_by_id",
      });
      continue;
    }
    const meetsDefaultGate = item.autoApplyEligible || params.includeMedium;
    if (!meetsDefaultGate) {
      skipped.push({
        suggestionId: item.suggestionId,
        personRef: item.personRef,
        displayName: item.displayName,
        confidence: item.confidence,
        reason: "requires_include_medium",
      });
      continue;
    }
    if (!isConfidenceAtLeast(item.confidence, params.minConfidence)) {
      skipped.push({
        suggestionId: item.suggestionId,
        personRef: item.personRef,
        displayName: item.displayName,
        confidence: item.confidence,
        reason: "below_min_confidence",
      });
      continue;
    }
    if (params.requireRelationship && !item.relationshipHint) {
      skipped.push({
        suggestionId: item.suggestionId,
        personRef: item.personRef,
        displayName: item.displayName,
        confidence: item.confidence,
        reason: "requires_relationship_hint",
      });
      continue;
    }
    selectable.push(item);
  }
  const selected = selectable.slice(0, params.maxCount);
  for (const item of selectable.slice(params.maxCount)) {
    skipped.push({
      suggestionId: item.suggestionId,
      personRef: item.personRef,
      displayName: item.displayName,
      confidence: item.confidence,
      reason: "over_max_limit",
    });
  }
  return {
    selected,
    skipped,
    selectedSuggestionIds,
    unknownSuggestionIds,
    unsupportedSelectedSpeakerSuggestions,
  };
}

function normalizeSuggestionConfidence(value: unknown): SuggestionConfidenceLevel {
  return value === "medium" ? "medium" : "high";
}
