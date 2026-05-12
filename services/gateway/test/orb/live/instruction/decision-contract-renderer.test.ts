/**
 * VTID-02941 (B0b-min) — decision-contract-renderer tests.
 *
 * Acceptance:
 *   #3 — renderer ONLY accepts AssistantDecisionContext, never raw
 *        compiler output. Enforced by source-level scan + by behavior:
 *        any unrecognized field on the input is ignored (typescript
 *        rejects it at compile time; runtime ignores extras).
 *   #4 — generateSystemInstruction does NOT query memory directly. The
 *        renderer file MUST NOT import from supabase, services, or call
 *        fetch.
 *   #6 — if continuity is null, renderer emits no continuity section.
 *        When source_health is degraded, renderer emits a short hint.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  renderDecisionContract,
} from '../../../../src/orb/live/instruction/decision-contract-renderer';
import type {
  AssistantDecisionContext,
  DecisionContinuity,
} from '../../../../src/orb/context/types';

const RENDERER_PATH = join(
  __dirname,
  '../../../../src/orb/live/instruction/decision-contract-renderer.ts',
);

function emptyContinuity(): DecisionContinuity {
  return {
    open_threads: [],
    promises_owed: [],
    promises_kept_recently: [],
    counts: {
      open_threads_total: 0,
      promises_owed_total: 0,
      promises_overdue: 0,
      threads_mentioned_today: 0,
    },
    recommended_follow_up: 'none',
  };
}

function emptyContext(over: Partial<AssistantDecisionContext> = {}): AssistantDecisionContext {
  return {
    continuity: null,
    source_health: { continuity: { ok: true } },
    ...over,
  };
}

describe('B0b-min — decision-contract-renderer', () => {
  describe('purity — wall enforcement (acceptance #4)', () => {
    let src: string;
    beforeAll(() => {
      src = readFileSync(RENDERER_PATH, 'utf8');
    });

    it('does not import from services/', () => {
      expect(src).not.toMatch(/from\s+['"][^'"]*\.\.\/\.\.\/\.\.\/services\//);
      expect(src).not.toMatch(/from\s+['"][^'"]*services\/continuity/);
    });

    it('does not import supabase or any DB client', () => {
      // Walk only non-comment lines so the wall-comment doesn't trip
      // the source-level guard (the comment mentions "Supabase" by
      // name precisely BECAUSE it must not be imported).
      const nonComment = src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
        .join('\n');
      expect(nonComment).not.toMatch(/\bgetSupabase\b/);
      expect(nonComment).not.toMatch(/from\s+['"][^'"]*lib\/supabase/);
    });

    it('does not call fetch / axios / rpc', () => {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/\baxios\b/);
      expect(src).not.toMatch(/\.rpc\(/);
    });

    it('only imports types from orb/context', () => {
      // Renderer must depend on the contract, never on the implementation.
      expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/context\/types['"]/);
    });
  });

  describe('empty/degrades safely (acceptance #1 + #6)', () => {
    it('returns empty string when continuity is null and source is healthy', () => {
      const out = renderDecisionContract(emptyContext());
      expect(out).toBe('');
    });

    it('emits a degraded hint when continuity is null AND source_health is degraded', () => {
      const out = renderDecisionContract(
        emptyContext({
          source_health: { continuity: { ok: false, reason: 'supabase_unconfigured' } },
        }),
      );
      expect(out).toContain('continuity: source degraded');
      expect(out).toContain('supabase_unconfigured');
    });

    it('emits empty string when continuity surfaces are all empty AND source is healthy', () => {
      const out = renderDecisionContract(
        emptyContext({ continuity: emptyContinuity() }),
      );
      expect(out).toBe('');
    });
  });

  describe('renders distilled surfaces', () => {
    it('renders open threads with age + summary', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              {
                thread_id: 't1',
                topic: 'magnesium dosage',
                summary: 'follow-up on the new bottle',
                days_since_last_mention: 3,
              },
            ],
          },
        }),
      );
      expect(out).toContain('Open threads:');
      expect(out).toContain('magnesium dosage');
      expect(out).toContain('3d since last mention');
      expect(out).toContain('follow-up on the new bottle');
    });

    it('renders promises_owed with overdue tag', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            promises_owed: [
              {
                promise_id: 'p1',
                promise_text: 'send the doc',
                overdue: true,
                decision_id: null,
              },
            ],
          },
        }),
      );
      expect(out).toContain('Promises owed:');
      expect(out).toContain('send the doc [overdue]');
    });

    it('renders recommended_follow_up when not "none"', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 1 },
            ],
            recommended_follow_up: 'mention_open_thread',
          },
        }),
      );
      expect(out).toContain('Recommended follow-up: mention_open_thread');
    });

    it('omits recommended_follow_up when "none"', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 1 },
            ],
            recommended_follow_up: 'none',
          },
        }),
      );
      expect(out).not.toContain('Recommended follow-up');
    });
  });

  describe('header behavior', () => {
    it('emits header by default', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 0 },
            ],
          },
        }),
      );
      expect(out.startsWith('Assistant decision contract:\n')).toBe(true);
    });

    it('omits header when withHeader=false', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 0 },
            ],
          },
        }),
        { withHeader: false },
      );
      expect(out.startsWith('Assistant decision contract:\n')).toBe(false);
      expect(out).toContain('Continuity:');
    });
  });

  describe('raw-field ignorance (acceptance #3 + #7)', () => {
    it('extra unknown fields injected at runtime are NOT surfaced in output', () => {
      // TypeScript would reject this at compile time; we cast to test
      // runtime behavior. The renderer reads only declared fields.
      const sneakyContinuity = {
        ...emptyContinuity(),
        open_threads: [
          {
            thread_id: 't',
            topic: 'short topic',
            summary: null,
            days_since_last_mention: 0,
            // raw fields a future bug might forward:
            last_mentioned_at: '2026-05-10T12:00:00Z',
            session_id_first: 'sess-A',
            session_id_last: 'sess-B',
            raw_message: 'user said this exact sentence',
          },
        ],
      } as unknown as DecisionContinuity;

      const out = renderDecisionContract(emptyContext({ continuity: sneakyContinuity }));
      expect(out).not.toContain('2026-05-10T12:00:00Z');
      expect(out).not.toContain('sess-A');
      expect(out).not.toContain('user said this exact sentence');
    });
  });
});
