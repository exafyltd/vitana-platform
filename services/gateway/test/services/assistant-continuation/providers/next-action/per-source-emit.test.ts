/**
 * VTID-03066 (B0d-real Xi) — per-source candidate emit tests.
 *
 * The provider now emits one `orb.livekit.next_action.candidate` event
 * per source result on each compose. Tests assert:
 *   - One emit per source row (winner + losers + skipped)
 *   - Each row tagged with winner: true/false
 *   - Priority + confidence + dedupe_key populated for returned rows
 *   - skipped_reason populated for skipped rows
 *   - compose_id is stable across siblings of the same compose
 *   - Never throws — even with garbage input
 */

import {
  emitPerSourceCandidates,
} from '../../../../../src/services/assistant-continuation/providers/next-action/emit-telemetry';
import type { NextActionSourceResult } from '../../../../../src/services/assistant-continuation/providers/next-action/types';

const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];

jest.mock('../../../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (event: { type: string; payload: Record<string, unknown> }) => {
    emitted.push({ type: event.type, payload: event.payload });
    return { ok: true };
  }),
}));

beforeEach(() => {
  emitted.length = 0;
});

function row(
  source: NextActionSourceResult['source'],
  opts: { priority?: number; skipped?: NextActionSourceResult['skippedReason'] } = {},
): NextActionSourceResult {
  if (opts.skipped) {
    return {
      source,
      candidate: null,
      skippedReason: opts.skipped,
      latencyMs: 7,
    };
  }
  return {
    source,
    candidate: {
      source,
      priority: opts.priority ?? 80,
      confidence: 'high',
      userFacingLine: `line from ${source}`,
      reasons: [],
      dedupeKey: `${source}:1`,
    },
    latencyMs: 5,
  };
}

describe('emitPerSourceCandidates', () => {
  test('emits one row per source result', () => {
    emitPerSourceCandidates({
      composeId: 'c-1',
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
      candidates: [
        row('reminder_due', { priority: 85 }),
        row('autopilot_recommendation', { skipped: 'no_eligible_record' }),
        row('vitana_index_pillar', { priority: 68 }),
      ],
      winnerSource: 'reminder_due',
    });
    return Promise.resolve().then(() => {
      expect(emitted).toHaveLength(3);
      for (const e of emitted) {
        expect(e.type).toBe('orb.livekit.next_action.candidate');
        expect(e.payload.compose_id).toBe('c-1');
        expect(e.payload.user_id).toBe('u1');
        expect(e.payload.tenant_id).toBe('t1');
      }
    });
  });

  test('tags winner=true only on the winning source', () => {
    emitPerSourceCandidates({
      composeId: 'c-2',
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
      candidates: [
        row('reminder_due', { priority: 85 }),
        row('autopilot_recommendation', { priority: 80 }),
      ],
      winnerSource: 'reminder_due',
    });
    return Promise.resolve().then(() => {
      const winner = emitted.find((e) => e.payload.source === 'reminder_due')!;
      const loser = emitted.find((e) => e.payload.source === 'autopilot_recommendation')!;
      expect(winner.payload.winner).toBe(true);
      expect(loser.payload.winner).toBe(false);
    });
  });

  test('returned row carries priority + confidence + dedupe_key', () => {
    emitPerSourceCandidates({
      composeId: 'c-3',
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
      candidates: [row('reminder_due', { priority: 85 })],
      winnerSource: 'reminder_due',
    });
    return Promise.resolve().then(() => {
      const ev = emitted[0];
      expect(ev.payload.status).toBe('returned');
      expect(ev.payload.priority).toBe(85);
      expect(ev.payload.confidence).toBe('high');
      expect(ev.payload.dedupe_key).toBe('reminder_due:1');
      expect(ev.payload.skipped_reason).toBeNull();
    });
  });

  test('skipped row carries skipped_reason and null priority', () => {
    emitPerSourceCandidates({
      composeId: 'c-4',
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
      candidates: [row('diary_missing_relevant', { skipped: 'no_eligible_record' })],
      winnerSource: null,
    });
    return Promise.resolve().then(() => {
      const ev = emitted[0];
      expect(ev.payload.status).toBe('skipped');
      expect(ev.payload.skipped_reason).toBe('no_eligible_record');
      expect(ev.payload.priority).toBeNull();
      expect(ev.payload.dedupe_key).toBeNull();
    });
  });

  test('empty candidates array → no emits', () => {
    emitPerSourceCandidates({
      composeId: 'c-5',
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_turn_end',
      candidates: [],
      winnerSource: null,
    });
    return Promise.resolve().then(() => {
      expect(emitted).toHaveLength(0);
    });
  });

  test('never throws — even with garbage candidates', () => {
    expect(() =>
      emitPerSourceCandidates({
        composeId: 'c-6',
        userId: 'u1',
        tenantId: 't1',
        surface: 'orb_wake',
        // @ts-expect-error — bad shape
        candidates: null,
        winnerSource: null,
      }),
    ).not.toThrow();
  });
});
