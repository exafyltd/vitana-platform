/**
 * VTID-02941 (B0b-min) — end-to-end through the minimal spine.
 *
 * Compose: stub continuity-fetcher → compileContinuityContext (real) →
 * distill (real) → render (real). Proves the full pipeline produces a
 * stable, distilled prompt section from raw Supabase-shaped rows
 * without leaking any of those rows into the rendered string.
 *
 * Acceptance #8 (operator parity): Command Hub preview and actual
 * prompt contract use the same compiler path. The Command Hub preview
 * is `compileContinuityContext` → JSON. The prompt contract is
 * `compileContinuityContext` → distillContinuityForDecision →
 * renderDecisionContract. Both paths start at the same compiler with
 * the same input, satisfying the parity check.
 */

import { compileContinuityContext } from '../../../src/services/continuity/compile-continuity-context';
import { compileInteractionStyleContext } from '../../../src/services/interaction-style/compile-interaction-style-context';
import { distillContinuityForDecision } from '../../../src/orb/context/providers/continuity-decision-provider';
import { distillInteractionStyleForDecision } from '../../../src/orb/context/providers/interaction-style-decision-provider';
import { renderDecisionContract } from '../../../src/orb/live/instruction/decision-contract-renderer';
import type { AssistantDecisionContext } from '../../../src/orb/context/types';
import type {
  AssistantPromiseRow,
  OpenThreadRow,
} from '../../../src/services/continuity/types';

const NOW = Date.parse('2026-05-13T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function thread(over: Partial<OpenThreadRow>): OpenThreadRow {
  return {
    thread_id: 't',
    topic: 'topic',
    summary: null,
    status: 'open',
    session_id_first: 'sess-FIRST',
    session_id_last: 'sess-LAST',
    last_mentioned_at: new Date(NOW - 1 * DAY).toISOString(),
    resolved_at: null,
    created_at: new Date(NOW - 5 * DAY).toISOString(),
    updated_at: new Date(NOW - 1 * DAY).toISOString(),
    ...over,
  };
}

function promise(over: Partial<AssistantPromiseRow>): AssistantPromiseRow {
  return {
    promise_id: 'p',
    thread_id: null,
    session_id: 'sess-PROMISE-RAW',
    promise_text: 'text',
    due_at: null,
    status: 'owed',
    decision_id: null,
    kept_at: null,
    created_at: new Date(NOW - 3 * DAY).toISOString(),
    updated_at: new Date(NOW - 1 * DAY).toISOString(),
    ...over,
  };
}

describe('B0b-min — end-to-end spine', () => {
  it('renders a coherent prompt section AND drops every raw row field', () => {
    const continuityCtx = compileContinuityContext({
      threadsResult: {
        ok: true,
        rows: [
          thread({
            thread_id: 'thread-A',
            topic: 'magnesium routine',
            summary: 'discussed dosage after dinner',
            last_mentioned_at: new Date(NOW - 2 * DAY).toISOString(),
          }),
        ],
      },
      promisesResult: {
        ok: true,
        rows: [
          promise({
            promise_id: 'promise-A',
            promise_text: "I'll send the supplement comparison",
            due_at: new Date(NOW - 1 * DAY).toISOString(),
            status: 'owed',
            decision_id: 'dec-42',
          }),
          promise({
            promise_id: 'promise-B',
            promise_text: 'shared the article on circadian rhythm',
            status: 'kept',
            kept_at: new Date(NOW - 2 * DAY).toISOString(),
          }),
        ],
      },
      nowMs: NOW,
    });

    const decision: AssistantDecisionContext = {
      continuity: distillContinuityForDecision({ continuity: continuityCtx }),
      concept_mastery: null,
      journey_stage: null,
      pillar_momentum: null,
      interaction_style: null,
      source_health: {
        continuity: { ok: true },
        concept_mastery: { ok: true },
        journey_stage: { ok: true },
        pillar_momentum: { ok: true },
        interaction_style: { ok: true },
      },
    };
    const rendered = renderDecisionContract(decision);

    // ---- Coherent prompt section ----
    expect(rendered).toContain('Assistant decision contract:');
    expect(rendered).toContain('Continuity:');
    expect(rendered).toContain('Open threads:');
    expect(rendered).toContain('magnesium routine');
    expect(rendered).toContain('Promises owed:');
    expect(rendered).toContain("I'll send the supplement comparison [overdue]");
    expect(rendered).toContain('Promises kept recently:');
    expect(rendered).toContain('shared the article on circadian rhythm');
    expect(rendered).toContain('Recommended follow-up: address_overdue_promise');

    // ---- Raw row fields MUST NOT appear ----
    // Session ids
    expect(rendered).not.toContain('sess-FIRST');
    expect(rendered).not.toContain('sess-LAST');
    expect(rendered).not.toContain('sess-PROMISE-RAW');
    // Raw timestamps
    expect(rendered).not.toContain('2026-05-');
    expect(rendered).not.toContain('T12:00:00');
    expect(rendered).not.toContain('T00:00:00');
    // Status values (we said "owed/kept/broken/cancelled" — the renderer
    // expresses them as [overdue] tag or section header only)
    expect(rendered).not.toMatch(/\bstatus:\s*"?\w+"?/i);
  });

  it('empty fetcher results render to empty string (acceptance #1 — safe defaults)', () => {
    const continuityCtx = compileContinuityContext({
      threadsResult: { ok: true, rows: [] },
      promisesResult: { ok: true, rows: [] },
      nowMs: NOW,
    });
    const decision: AssistantDecisionContext = {
      continuity: distillContinuityForDecision({ continuity: continuityCtx }),
      concept_mastery: null,
      journey_stage: null,
      pillar_momentum: null,
      interaction_style: null,
      source_health: {
        continuity: { ok: true },
        concept_mastery: { ok: true },
        journey_stage: { ok: true },
        pillar_momentum: { ok: true },
        interaction_style: { ok: true },
      },
    };
    expect(renderDecisionContract(decision)).toBe('');
  });

  it('degraded source produces a hint section, no crash (acceptance #6)', () => {
    const continuityCtx = compileContinuityContext({
      threadsResult: { ok: false, rows: [], reason: 'supabase_unconfigured' },
      promisesResult: { ok: false, rows: [], reason: 'supabase_unconfigured' },
      nowMs: NOW,
    });
    // Even though continuityCtx has empty surfaces, source_health came back
    // degraded. The renderer reads source_health from the decision, so we
    // pass a degraded shape directly.
    const decision: AssistantDecisionContext = {
      continuity: null,
      concept_mastery: null,
      journey_stage: null,
      pillar_momentum: null,
      interaction_style: null,
      source_health: {
        continuity: { ok: false, reason: 'supabase_unconfigured' },
        concept_mastery: { ok: true },
        journey_stage: { ok: true },
        pillar_momentum: { ok: true },
        interaction_style: { ok: true },
      },
    };
    const rendered = renderDecisionContract(decision);
    expect(rendered).toContain('continuity: source degraded');
    expect(rendered).toContain('supabase_unconfigured');
  });

  it('B6: interaction_style renders only distilled enums + drops timestamps', () => {
    const interactionCtx = compileInteractionStyleContext({
      fetchResult: {
        ok: true,
        row: {
          value: {
            response_style: 'concise',
            pace: 'normal',
            tone: 'direct',
            explanation_depth: 'minimal',
            confidence: 0.91,
          },
          confidence: 0.91,
          updated_at: '2026-05-13T10:00:00Z',
          last_seen_at: '2026-05-13T10:00:00Z',
        },
      },
    });
    const decision: AssistantDecisionContext = {
      continuity: null,
      concept_mastery: null,
      journey_stage: null,
      pillar_momentum: null,
      interaction_style: distillInteractionStyleForDecision({
        interactionStyle: interactionCtx,
      }),
      source_health: {
        continuity: { ok: true },
        concept_mastery: { ok: true },
        journey_stage: { ok: true },
        pillar_momentum: { ok: true },
        interaction_style: { ok: true },
      },
    };
    const rendered = renderDecisionContract(decision);

    // Distilled section present
    expect(rendered).toContain('Interaction style:');
    expect(rendered).toContain('response style: concise');
    expect(rendered).toContain('pace: normal');
    expect(rendered).toContain('tone: direct');
    expect(rendered).toContain('explanation depth: minimal');
    expect(rendered).toContain('confidence: high');

    // Forbidden raw fields MUST NOT leak through the renderer.
    expect(rendered).not.toContain('2026-05-13');
    expect(rendered).not.toContain('T10:00:00');
    expect(rendered).not.toContain('0.91');
    expect(rendered).not.toContain('last_updated_at');
    expect(rendered).not.toContain('last_seen_at');
  });

  it('B6: degraded interaction_style source produces a hint, no crash', () => {
    const decision: AssistantDecisionContext = {
      continuity: null,
      concept_mastery: null,
      journey_stage: null,
      pillar_momentum: null,
      interaction_style: null,
      source_health: {
        continuity: { ok: true },
        concept_mastery: { ok: true },
        journey_stage: { ok: true },
        pillar_momentum: { ok: true },
        interaction_style: { ok: false, reason: 'supabase_unconfigured' },
      },
    };
    const rendered = renderDecisionContract(decision);
    expect(rendered).toContain('interaction_style: source degraded');
    expect(rendered).toContain('supabase_unconfigured');
  });
});
