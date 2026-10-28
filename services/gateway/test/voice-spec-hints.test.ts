/**
 * VTID-01960: Voice Spec Hints + Spec Memory Gate Tests
 *
 * Verifies:
 *   - getVoiceSpecHint returns deterministic specs for known classes.
 *   - Spec hashes are stable (same input always produces same hash).
 *   - Spec body validates against the 9-section format the existing
 *     self-healing-spec-service.ts validator expects.
 *   - parseVoiceClassFromEndpoint round-trips with the synthetic prefix.
 *   - lookupSpecMemory blocks on probe_failed / rollback / recurring success.
 *   - lookupSpecMemory allows on partial / no-recent / signature-not-firing.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  getVoiceSpecHint,
  parseVoiceClassFromEndpoint,
} from '../src/services/voice-spec-hints';
import { lookupSpecMemory } from '../src/services/voice-spec-memory';

// 9 sections that the existing self-healing-spec-service.ts validateSpecSections
// helper checks for. Voice deterministic specs must include all 9 or the
// validator will reject and force the buildDeterministicSpec generic fallback.
const REQUIRED_SECTIONS = [
  'Goal',
  'Non-negotiable Governance Rules Touched',
  'Scope',
  'Changes',
  'Files to Modify',
  'Acceptance Criteria',
  'Verification Steps',
  'Rollback Plan',
  'Risk Level',
];

function specHasAllRequiredSections(spec: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const patterns = [
      new RegExp(`^##?\\s*\\d*\\.?\\s*${section}`, 'im'),
      new RegExp(`^##?\\s*${section}`, 'im'),
    ];
    if (!patterns.some((p) => p.test(spec))) missing.push(section);
  }
  return { ok: missing.length === 0, missing };
}

describe('VTID-01960: Voice Spec Hints', () => {
  describe('parseVoiceClassFromEndpoint', () => {
    test('extracts class from voice-error://<class>', () => {
      expect(parseVoiceClassFromEndpoint('voice-error://voice.config_missing')).toBe(
        'voice.config_missing',
      );
      expect(parseVoiceClassFromEndpoint('voice-error://voice.auth_rejected')).toBe(
        'voice.auth_rejected',
      );
    });

    test('returns null for non-voice endpoints', () => {
      expect(parseVoiceClassFromEndpoint('/api/v1/orb/health')).toBeNull();
      expect(parseVoiceClassFromEndpoint('https://example.com')).toBeNull();
      expect(parseVoiceClassFromEndpoint('')).toBeNull();
    });
  });

  describe('getVoiceSpecHint coverage', () => {
    test('returns deterministic spec for voice.config_missing', () => {
      const h = getVoiceSpecHint('voice.config_missing');
      expect(h).not.toBeNull();
      expect(h!.summary).toMatch(/EXEC-DEPLOY/i);
      expect(h!.touches_deploy).toBe(true);
    });

    test('returns deterministic spec for voice.config_fallback_active', () => {
      const h = getVoiceSpecHint('voice.config_fallback_active');
      expect(h).not.toBeNull();
      expect(h!.touches_deploy).toBe(true);
    });

    test('returns deterministic spec for voice.auth_rejected (read-only)', () => {
      const h = getVoiceSpecHint('voice.auth_rejected');
      expect(h).not.toBeNull();
      expect(h!.touches_deploy).toBe(false);
    });

    test('returns stub spec for voice.model_stall', () => {
      expect(getVoiceSpecHint('voice.model_stall')).not.toBeNull();
    });

    test('returns stub spec for voice.upstream_disconnect', () => {
      expect(getVoiceSpecHint('voice.upstream_disconnect')).not.toBeNull();
    });

    test('returns stub spec for voice.tts_failed', () => {
      expect(getVoiceSpecHint('voice.tts_failed')).not.toBeNull();
    });

    test('returns stub spec for voice.session_leak', () => {
      expect(getVoiceSpecHint('voice.session_leak')).not.toBeNull();
    });

    test('returns null for Gemini-fallback classes', () => {
      expect(getVoiceSpecHint('voice.tool_loop')).toBeNull();
      expect(getVoiceSpecHint('voice.audio_one_way')).toBeNull();
      expect(getVoiceSpecHint('voice.permission_denied')).toBeNull();
      expect(getVoiceSpecHint('voice.unknown')).toBeNull();
    });

    test('returns null for unrecognized class', () => {
      expect(getVoiceSpecHint('voice.bogus_class')).toBeNull();
    });
  });

  describe('spec hash stability', () => {
    test('same class produces identical spec_hash across invocations', () => {
      const a = getVoiceSpecHint('voice.config_missing');
      const b = getVoiceSpecHint('voice.config_missing');
      const c = getVoiceSpecHint('voice.config_missing');
      expect(a!.spec_hash).toBe(b!.spec_hash);
      expect(b!.spec_hash).toBe(c!.spec_hash);
      expect(a!.spec_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('different classes produce different spec_hash', () => {
      const a = getVoiceSpecHint('voice.config_missing')!.spec_hash;
      const b = getVoiceSpecHint('voice.auth_rejected')!.spec_hash;
      const c = getVoiceSpecHint('voice.config_fallback_active')!.spec_hash;
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    });
  });

  describe('spec body shape (validates against 9-section requirement)', () => {
    const checkClasses = [
      'voice.config_missing',
      'voice.config_fallback_active',
      'voice.auth_rejected',
      'voice.model_stall',
      'voice.upstream_disconnect',
      'voice.tts_failed',
      'voice.session_leak',
    ];

    for (const klass of checkClasses) {
      test(`${klass} spec body has all 9 required sections`, () => {
        const h = getVoiceSpecHint(klass)!;
        const r = specHasAllRequiredSections(h.spec);
        expect(r.missing).toEqual([]);
        expect(r.ok).toBe(true);
      });
    }
  });
});

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('VTID-01960: Spec Memory Gate (lookupSpecMemory)', () => {
  beforeEach(() => mockFetch.mockReset());

  test('no recent rows → allow', async () => {
    mockFetch.mockResolvedValue(jsonResp([]));
    const d = await lookupSpecMemory('hashA', 'sigA', true);
    expect(d.block).toBe(false);
    expect(d.reason).toBe('allow');
  });

  test('probe_failed in window → block (recent_failure)', async () => {
    mockFetch.mockResolvedValue(
      jsonResp([
        {
          spec_hash: 'hashA',
          normalized_signature: 'sigA',
          attempted_at: new Date().toISOString(),
          outcome: 'probe_failed',
        },
      ]),
    );
    const d = await lookupSpecMemory('hashA', 'sigA', true);
    expect(d.block).toBe(true);
    expect(d.reason).toBe('recent_failure');
    expect(d.matched?.outcome).toBe('probe_failed');
  });

  test('rollback in window → block (recent_rollback)', async () => {
    mockFetch.mockResolvedValue(
      jsonResp([
        {
          spec_hash: 'hashA',
          normalized_signature: 'sigA',
          attempted_at: new Date().toISOString(),
          outcome: 'rollback',
        },
      ]),
    );
    const d = await lookupSpecMemory('hashA', 'sigA', true);
    expect(d.block).toBe(true);
    expect(d.reason).toBe('recent_rollback');
  });

  test('success in window AND signature firing → block (recurring_after_success)', async () => {
    mockFetch.mockResolvedValue(
      jsonResp([
        {
          spec_hash: 'hashA',
          normalized_signature: 'sigA',
          attempted_at: new Date().toISOString(),
          outcome: 'success',
        },
      ]),
    );
    const d = await lookupSpecMemory('hashA', 'sigA', true);
    expect(d.block).toBe(true);
    expect(d.reason).toBe('recurring_after_success');
  });

  test('success in window but signature NOT firing → allow', async () => {
    mockFetch.mockResolvedValue(
      jsonResp([
        {
          spec_hash: 'hashA',
          normalized_signature: 'sigA',
          attempted_at: new Date().toISOString(),
          outcome: 'success',
        },
      ]),
    );
    const d = await lookupSpecMemory('hashA', 'sigA', false);
    expect(d.block).toBe(false);
    expect(d.reason).toBe('allow');
  });

  test('partial in window → allow (telemetry only)', async () => {
    mockFetch.mockResolvedValue(
      jsonResp([
        {
          spec_hash: 'hashA',
          normalized_signature: 'sigA',
          attempted_at: new Date().toISOString(),
          outcome: 'partial',
        },
      ]),
    );
    const d = await lookupSpecMemory('hashA', 'sigA', true);
    expect(d.block).toBe(false);
    expect(d.reason).toBe('allow');
  });

  test('Supabase fetch fails → memory_unavailable, do not block', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    const d = await lookupSpecMemory('hashA', 'sigA', true);
    expect(d.block).toBe(false);
    expect(d.reason).toBe('memory_unavailable');
  });

  test('probe_failed beats older success when both present', async () => {
    const recent = new Date().toISOString();
    const older = new Date(Date.now() - 3600_000).toISOString();
    mockFetch.mockResolvedValue(
      jsonResp([
        { spec_hash: 'hashA', normalized_signature: 'sigA', attempted_at: recent, outcome: 'probe_failed' },
        { spec_hash: 'hashA', normalized_signature: 'sigA', attempted_at: older, outcome: 'success' },
      ]),
    );
    const d = await lookupSpecMemory('hashA', 'sigA', true);
    expect(d.block).toBe(true);
    expect(d.reason).toBe('recent_failure');
  });
});
