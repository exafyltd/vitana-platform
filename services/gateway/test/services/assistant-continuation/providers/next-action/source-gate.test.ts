/**
 * VTID-03067 (B0d-real Xj) — per-source flag gate tests.
 */

import {
  buildSourceFlagKey,
  isNextActionSourceEnabled,
  withFlagGate,
} from '../../../../../src/services/assistant-continuation/providers/next-action/source-gate';
import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
} from '../../../../../src/services/assistant-continuation/providers/next-action/types';

// ---------------------------------------------------------------------------
// Mock system-controls-service. The gate reads getSystemControl(key) and
// defaults to "enabled" when the row is absent.
// ---------------------------------------------------------------------------

let controlOverride: { enabled: boolean } | null | undefined = null;
let getSystemControlMock = jest.fn();

jest.mock('../../../../../src/services/system-controls-service', () => ({
  getSystemControl: (...args: unknown[]) => getSystemControlMock(...args),
}));

beforeEach(() => {
  controlOverride = null;
  getSystemControlMock = jest.fn(async () => controlOverride);
  // Re-wire the mock for the new fn.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../../../../src/services/system-controls-service');
  mod.getSystemControl = getSystemControlMock;
});

function makeStubSource(opts: {
  key: NextActionSource['key'];
  result?: NextActionSourceResult;
  throws?: boolean;
}): NextActionSource {
  return {
    key: opts.key,
    serves: () => true,
    produce: async () => {
      if (opts.throws) throw new Error('boom');
      return (
        opts.result ?? {
          source: opts.key,
          candidate: {
            source: opts.key,
            priority: 80,
            confidence: 'high',
            userFacingLine: 'unguarded',
            reasons: [],
            dedupeKey: `${opts.key}:1`,
          },
        }
      );
    },
  };
}

function makeCtx(): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang: 'en',
    nowIso: '2026-05-18T08:00:00Z',
    decisionContext: null,
    supabase: {
      from: () => ({}) as never,
      rpc: async () => ({ data: null, error: null }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient,
  };
}

describe('buildSourceFlagKey', () => {
  test('reminder_due → voice.next_action.reminder_due.enabled', () => {
    expect(buildSourceFlagKey('reminder_due')).toBe('voice.next_action.reminder_due.enabled');
  });
  test('continuity_promise_owed → voice.next_action.continuity_promise_owed.enabled', () => {
    expect(buildSourceFlagKey('continuity_promise_owed')).toBe(
      'voice.next_action.continuity_promise_owed.enabled',
    );
  });
});

describe('isNextActionSourceEnabled', () => {
  test('absent row → enabled (default-true safety)', async () => {
    controlOverride = null;
    expect(await isNextActionSourceEnabled('reminder_due')).toBe(true);
  });

  test('row enabled=true → enabled', async () => {
    controlOverride = { enabled: true };
    expect(await isNextActionSourceEnabled('reminder_due')).toBe(true);
  });

  test('row enabled=false → disabled', async () => {
    controlOverride = { enabled: false };
    expect(await isNextActionSourceEnabled('reminder_due')).toBe(false);
  });

  test('getSystemControl throws → enabled (never silence by default)', async () => {
    getSystemControlMock = jest.fn(async () => {
      throw new Error('DB down');
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../../../../src/services/system-controls-service');
    mod.getSystemControl = getSystemControlMock;
    expect(await isNextActionSourceEnabled('reminder_due')).toBe(true);
  });
});

describe('withFlagGate', () => {
  test('passes through when enabled', async () => {
    controlOverride = { enabled: true };
    const gated = withFlagGate(makeStubSource({ key: 'reminder_due' }));
    const r = await gated.produce(makeCtx());
    expect(r.candidate).not.toBeNull();
    expect(r.candidate?.userFacingLine).toBe('unguarded');
  });

  test('returns feature_disabled when disabled (does NOT invoke underlying produce)', async () => {
    controlOverride = { enabled: false };
    let invoked = false;
    const inner: NextActionSource = {
      key: 'autopilot_recommendation',
      serves: () => true,
      produce: async () => {
        invoked = true;
        return {
          source: 'autopilot_recommendation',
          candidate: null,
          skippedReason: 'no_data',
        };
      },
    };
    const gated = withFlagGate(inner);
    const r = await gated.produce(makeCtx());
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('feature_disabled');
    expect(invoked).toBe(false);
  });

  test('preserves key + serves passthrough', () => {
    const inner = makeStubSource({ key: 'diary_missing_relevant' });
    const gated = withFlagGate(inner);
    expect(gated.key).toBe('diary_missing_relevant');
    expect(gated.serves('orb_wake')).toBe(true);
    expect(gated.serves('orb_turn_end')).toBe(true);
  });
});
