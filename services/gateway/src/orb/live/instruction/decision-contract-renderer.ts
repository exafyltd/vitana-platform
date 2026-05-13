/**
 * VTID-02941 (B0b-min) — decision-contract-renderer.
 * VTID-02950 (F2)     — adds concept-mastery section.
 * VTID-02954 (F3)     — adds journey-stage section.
 *
 * Single responsibility: take an `AssistantDecisionContext` and
 * produce a prompt section string the static system instruction can
 * append.
 *
 * The renderer ONLY reads `AssistantDecisionContext`. It MUST NOT:
 *   - call providers
 *   - query the database
 *   - read memory tables
 *   - touch Supabase directly
 *   - import from `services/continuity/*`, `services/concept-mastery/*`,
 *     `services/journey-stage/*`, or any compiler module
 *
 * Type-level enforcement: the only argument is `AssistantDecisionContext`.
 * A test asserts the renderer source file contains no `import` from
 * `services/`, `lib/supabase`, or `fetch`.
 *
 * Empty / degraded handling:
 *   - `decision.<field> === null` → no section for that field is emitted.
 *   - `source_health.<field>.ok === false` → a small "[<field>: source
 *     degraded — <reason>]" hint appears so the prompt remains
 *     informative without inventing data.
 *   - Empty arrays → that subsection is omitted, but the overall
 *     section still renders if any subsection has content.
 */

import type {
  AssistantDecisionContext,
  DecisionConceptMastery,
  DecisionContinuity,
  DecisionJourneyStage,
} from '../../context/types';

export interface RenderDecisionContractOptions {
  /**
   * When true (default), the renderer prefixes a stable section header
   * so logs/tests can find the appended block. When false, it omits
   * the header (useful for inline tests).
   */
  withHeader?: boolean;
}

/**
 * Renders `decision` as a prompt section string. Returns `''` when the
 * decision context has no signal to surface AND no source health to
 * report — i.e., when appending an empty string would just be noise.
 */
export function renderDecisionContract(
  decision: AssistantDecisionContext,
  opts: RenderDecisionContractOptions = {},
): string {
  const withHeader = opts.withHeader !== false;

  const lines: string[] = [];

  // ---- continuity ----
  const continuitySection = renderContinuity(decision.continuity);
  const continuityHealth = decision.source_health.continuity;

  if (continuitySection) {
    lines.push(continuitySection);
  } else if (continuityHealth && continuityHealth.ok === false) {
    lines.push(
      `[continuity: source degraded — ${continuityHealth.reason ?? 'unknown_reason'}]`,
    );
  }

  // ---- concept mastery (F2) ----
  const conceptSection = renderConceptMastery(decision.concept_mastery);
  const conceptHealth = decision.source_health.concept_mastery;

  if (conceptSection) {
    lines.push(conceptSection);
  } else if (conceptHealth && conceptHealth.ok === false) {
    lines.push(
      `[concept_mastery: source degraded — ${conceptHealth.reason ?? 'unknown_reason'}]`,
    );
  }

  // ---- journey stage (F3) ----
  const journeySection = renderJourneyStage(decision.journey_stage);
  const journeyHealth = decision.source_health.journey_stage;

  if (journeySection) {
    lines.push(journeySection);
  } else if (journeyHealth && journeyHealth.ok === false) {
    lines.push(
      `[journey_stage: source degraded — ${journeyHealth.reason ?? 'unknown_reason'}]`,
    );
  }

  if (lines.length === 0) return '';

  const body = lines.join('\n');
  return withHeader ? `Assistant decision contract:\n${body}` : body;
}

// ---------------------------------------------------------------------------
// Continuity sub-section
// ---------------------------------------------------------------------------

function renderContinuity(continuity: DecisionContinuity | null): string {
  if (!continuity) return '';

  const subs: string[] = [];

  if (continuity.open_threads.length > 0) {
    const lines = continuity.open_threads.map((t) => {
      const age = t.days_since_last_mention === null
        ? ''
        : ` (${t.days_since_last_mention}d since last mention)`;
      const summary = t.summary ? ` — ${t.summary}` : '';
      return `  - ${t.topic}${age}${summary}`;
    });
    subs.push(['Open threads:', ...lines].join('\n'));
  }

  if (continuity.promises_owed.length > 0) {
    const lines = continuity.promises_owed.map((p) => {
      const overdueTag = p.overdue ? ' [overdue]' : '';
      return `  - ${p.promise_text}${overdueTag}`;
    });
    subs.push(['Promises owed:', ...lines].join('\n'));
  }

  if (continuity.promises_kept_recently.length > 0) {
    const lines = continuity.promises_kept_recently.map(
      (p) => `  - ${p.promise_text}`,
    );
    subs.push(['Promises kept recently:', ...lines].join('\n'));
  }

  if (continuity.recommended_follow_up !== 'none') {
    subs.push(`Recommended follow-up: ${continuity.recommended_follow_up}`);
  }

  if (subs.length === 0) return '';
  return ['Continuity:', ...subs].join('\n');
}

// ---------------------------------------------------------------------------
// Concept Mastery sub-section (F2)
// ---------------------------------------------------------------------------

function renderConceptMastery(cm: DecisionConceptMastery | null): string {
  if (!cm) return '';

  const subs: string[] = [];

  if (cm.concepts_explained.length > 0) {
    const lines = cm.concepts_explained.map((c) => {
      const age = c.days_since_last_explained === null
        ? ''
        : ` (${c.days_since_last_explained}d ago)`;
      return `  - ${c.concept_key} [${c.frequency}, hint=${c.repetition_hint}]${age}`;
    });
    subs.push(['Concepts explained:', ...lines].join('\n'));
  }

  if (cm.concepts_mastered.length > 0) {
    const lines = cm.concepts_mastered.map(
      (c) => `  - ${c.concept_key} [confidence=${c.confidence}]`,
    );
    subs.push(['Concepts mastered:', ...lines].join('\n'));
  }

  if (cm.dyk_cards_seen.length > 0) {
    const lines = cm.dyk_cards_seen.map((d) => {
      const age = d.days_since_last_seen === null
        ? ''
        : ` (${d.days_since_last_seen}d ago)`;
      return `  - ${d.card_key} [${d.frequency}]${age}`;
    });
    subs.push(['DYK cards seen:', ...lines].join('\n'));
  }

  if (cm.recommended_cadence !== 'none') {
    subs.push(`Recommended cadence: ${cm.recommended_cadence}`);
  }

  if (subs.length === 0) return '';
  return ['Concept mastery:', ...subs].join('\n');
}

// ---------------------------------------------------------------------------
// Journey Stage sub-section (F3)
// ---------------------------------------------------------------------------

function renderJourneyStage(js: DecisionJourneyStage | null): string {
  if (!js) return '';

  // Single compact line covers the most important signals; warnings
  // and lower-priority buckets append below if present. No raw
  // numbers, no raw timestamps, no free-text — all enum buckets.
  const lines: string[] = [
    `  - stage: ${js.stage}`,
    `  - tone: ${js.tone_hint}`,
    `  - explanation depth: ${js.explanation_depth}`,
  ];

  if (js.vitana_index_tier !== 'unknown') {
    lines.push(`  - Vitana Index tier: ${js.vitana_index_tier} [${js.tier_tenure}]`);
  }

  if (js.activity_recency !== 'unknown') {
    lines.push(`  - activity recency: ${js.activity_recency}`);
  }

  if (js.usage_volume !== 'none') {
    lines.push(`  - usage volume: ${js.usage_volume}`);
  }

  lines.push(`  - confidence: ${js.journey_confidence}`);

  if (js.warnings.length > 0) {
    lines.push(`  - warnings: ${js.warnings.join(', ')}`);
  }

  return ['Journey stage:', ...lines].join('\n');
}
