// VTID-03124 — Phase D.1 of the decision-contract refactor.
//
// Locks the wire-up that makes `orb/upstream/constants.ts` accessors
// resolve through PolicyResolver while preserving byte-identical
// behaviour vs the previous literal `export const` exports when the
// resolver is unseeded.

import {
  getVadSilenceDurationMs,
  getPostTurnCooldownMs,
  getSilenceKeepaliveIntervalMs,
  getSilenceIdleThresholdMs,
  getGreetingResponseTimeoutMs,
  getTurnResponseTimeoutMs,
  getForwardingAckTimeoutMs,
  getMaxConsecutiveModelTurns,
  getMaxConsecutiveToolCalls,
  SILENCE_PCM_BYTES,
} from '../../../src/orb/upstream/constants';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
} from '../../../src/services/decision-contract/policy-resolver';

const NOW_ISO = new Date().toISOString();
const FUTURE_ISO = new Date(Date.now() + 86_400_000).toISOString();

function seedPolicy(key: string, value: number) {
  configurePolicyResolverForTests({
    decisionPolicy: [
      {
        policy_key: key,
        tenant_id: null,
        version: 1,
        value_json: value,
        effective_from: NOW_ISO,
        effective_until: null,
      },
    ],
  });
}

describe('VTID-03124 Phase D.1 voice-threshold accessors', () => {
  afterEach(() => {
    __resetPolicyResolverForTests();
  });

  describe('fallback path — no resolver cache (cold boot)', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('VAD silence duration falls back to byte-identical 850 ms', () => {
      expect(getVadSilenceDurationMs()).toBe(850);
    });

    it('post-turn cooldown falls back to byte-identical 2000 ms', () => {
      expect(getPostTurnCooldownMs()).toBe(2000);
    });

    it('silence keepalive interval falls back to byte-identical 3000 ms', () => {
      expect(getSilenceKeepaliveIntervalMs()).toBe(3000);
    });

    it('silence idle threshold falls back to byte-identical 3000 ms', () => {
      expect(getSilenceIdleThresholdMs()).toBe(3000);
    });

    it('greeting response timeout falls back to byte-identical 8000 ms', () => {
      expect(getGreetingResponseTimeoutMs()).toBe(8000);
    });

    it('turn response timeout falls back to byte-identical 10000 ms', () => {
      expect(getTurnResponseTimeoutMs()).toBe(10000);
    });

    it('forwarding ack timeout falls back to byte-identical 45000 ms', () => {
      expect(getForwardingAckTimeoutMs()).toBe(45000);
    });

    it('max consecutive model turns falls back to byte-identical 3', () => {
      expect(getMaxConsecutiveModelTurns()).toBe(3);
    });

    it('max consecutive tool calls falls back to byte-identical 5', () => {
      expect(getMaxConsecutiveToolCalls()).toBe(5);
    });
  });

  describe('resolver-seeded path — DB row wins over fallback', () => {
    it('VAD silence reads the seeded policy value', () => {
      seedPolicy('voice.vad.silence_duration_ms', 1100);
      expect(getVadSilenceDurationMs()).toBe(1100);
    });

    it('post-turn cooldown reads the seeded policy value', () => {
      seedPolicy('voice.post_turn.cooldown_ms', 1500);
      expect(getPostTurnCooldownMs()).toBe(1500);
    });

    it('greeting watchdog reads the seeded policy value', () => {
      seedPolicy('voice.watchdog.greeting_timeout_ms', 12_000);
      expect(getGreetingResponseTimeoutMs()).toBe(12_000);
    });

    it('forwarding watchdog reads the seeded policy value', () => {
      seedPolicy('voice.watchdog.forwarding_ack_timeout_ms', 30_000);
      expect(getForwardingAckTimeoutMs()).toBe(30_000);
    });

    it('max tool calls reads the seeded policy value', () => {
      seedPolicy('voice.loop_guard.max_consecutive_tool_calls', 7);
      expect(getMaxConsecutiveToolCalls()).toBe(7);
    });
  });

  describe('expired rows do not override the fallback', () => {
    it('expired row is ignored; accessor returns fallback', () => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString();
      configurePolicyResolverForTests({
        decisionPolicy: [
          {
            policy_key: 'voice.vad.silence_duration_ms',
            tenant_id: null,
            version: 1,
            value_json: 9999,
            effective_from: '2020-01-01T00:00:00.000Z',
            effective_until: yesterday, // expired
          },
        ],
      });
      expect(getVadSilenceDurationMs()).toBe(850);
    });

    it('future-dated row is ignored until effective_from', () => {
      configurePolicyResolverForTests({
        decisionPolicy: [
          {
            policy_key: 'voice.vad.silence_duration_ms',
            tenant_id: null,
            version: 1,
            value_json: 9999,
            effective_from: FUTURE_ISO,
            effective_until: null,
          },
        ],
      });
      expect(getVadSilenceDurationMs()).toBe(850);
    });
  });

  describe('higher version wins over lower', () => {
    it('returns value from highest-version effective row', () => {
      configurePolicyResolverForTests({
        decisionPolicy: [
          {
            policy_key: 'voice.vad.silence_duration_ms',
            tenant_id: null,
            version: 1,
            value_json: 700,
            effective_from: NOW_ISO,
            effective_until: null,
          },
          {
            policy_key: 'voice.vad.silence_duration_ms',
            tenant_id: null,
            version: 2,
            value_json: 950,
            effective_from: NOW_ISO,
            effective_until: null,
          },
        ],
      });
      expect(getVadSilenceDurationMs()).toBe(950);
    });
  });

  describe('protocol-derived constants stay literal', () => {
    it('SILENCE_PCM_BYTES is the 250ms @ 16kHz mono 16-bit constant — not a policy knob', () => {
      expect(SILENCE_PCM_BYTES).toBe(8000);
    });
  });
});
