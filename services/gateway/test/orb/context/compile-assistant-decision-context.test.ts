/**
 * VTID-02941 (B0b-min) — compileAssistantDecisionContext orchestrator tests.
 *
 * Acceptance:
 *   #1 — empty continuity produces a valid AssistantDecisionContext with
 *        safe empty defaults
 *   #6 — if the continuity compiler throws, prompt still renders with
 *        sourceHealth=degraded and no crash
 *
 * The orchestrator MUST:
 *   - never throw upward
 *   - attach reason on source_health when the provider fails
 *   - return continuity:null when source health is degraded
 *   - accept provider overrides for tests
 */

import { compileAssistantDecisionContext } from '../../../src/orb/context/compile-assistant-decision-context';
import type { DecisionContinuity } from '../../../src/orb/context/types';

describe('B0b-min — compileAssistantDecisionContext', () => {
  describe('happy path with provider override', () => {
    it('attaches the provider output to .continuity', async () => {
      const stub: DecisionContinuity = {
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
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: { continuity: async () => stub },
      });
      expect(out.continuity).toEqual(stub);
      expect(out.source_health.continuity.ok).toBe(true);
    });
  });

  describe('provider throws (acceptance #6)', () => {
    it('returns continuity:null + source_health.ok=false + reason', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => {
            throw new Error('boom');
          },
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.source_health.continuity.ok).toBe(false);
      expect(out.source_health.continuity.reason).toBe('boom');
    });
  });

  describe('provider returns null (acceptance #1)', () => {
    it('attaches null + ok:true (provider deliberately suppressed)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: { continuity: async () => null },
      });
      expect(out.continuity).toBeNull();
      expect(out.source_health.continuity.ok).toBe(true);
    });
  });

  describe('always returns a typed shape', () => {
    it('source_health.continuity is always present', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: { continuity: async () => null },
      });
      expect(out.source_health).toBeDefined();
      expect(out.source_health.continuity).toBeDefined();
    });

    it('result has only known top-level keys (no leakage)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: { continuity: async () => null },
      });
      const keys = Object.keys(out).sort();
      expect(keys).toEqual(['continuity', 'source_health']);
    });
  });
});
