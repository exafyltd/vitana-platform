/**
 * VTID-04772: LiveKit POC config scaffold tests
 *
 * Covers:
 *   - Flag off (unset / 'false') → isLiveKitPocEnabled() false, getLiveKitPocConfig() null
 *   - Flag on + all vars present → getLiveKitPocConfig() returns config
 *   - Flag on + any var missing → getLiveKitPocConfig() returns null
 *   - No Google/Vertex/GCP references in the module (governance check)
 */

process.env.NODE_ENV = 'test';

import * as fs from 'fs';
import * as path from 'path';

// Helper to set/clear env vars and restore after each test
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// Re-import after env manipulation by using a factory that reads process.env
// at call time (the module functions read process.env on each call, not at
// module load time, so we can test them directly without jest.resetModules).
import {
  isLiveKitPocEnabled,
  getLiveKitPocConfig,
} from '../src/orb/live/poc/livekit-poc-config';

const ALL_VARS = {
  LIVEKIT_POC_ENABLED: 'true',
  LIVEKIT_POC_URL: 'wss://livekit.example.com',
  LIVEKIT_POC_API_KEY: 'test-api-key',
  LIVEKIT_POC_API_SECRET: 'test-api-secret',
};

describe('VTID-04772: LiveKit POC config scaffold', () => {
  describe('isLiveKitPocEnabled()', () => {
    test('returns false when LIVEKIT_POC_ENABLED is unset', () => {
      withEnv({ LIVEKIT_POC_ENABLED: undefined }, () => {
        expect(isLiveKitPocEnabled()).toBe(false);
      });
    });

    test('returns false when LIVEKIT_POC_ENABLED is "false"', () => {
      withEnv({ LIVEKIT_POC_ENABLED: 'false' }, () => {
        expect(isLiveKitPocEnabled()).toBe(false);
      });
    });

    test('returns false when LIVEKIT_POC_ENABLED is empty string', () => {
      withEnv({ LIVEKIT_POC_ENABLED: '' }, () => {
        expect(isLiveKitPocEnabled()).toBe(false);
      });
    });

    test('returns true when LIVEKIT_POC_ENABLED is "true"', () => {
      withEnv({ LIVEKIT_POC_ENABLED: 'true' }, () => {
        expect(isLiveKitPocEnabled()).toBe(true);
      });
    });
  });

  describe('getLiveKitPocConfig()', () => {
    test('returns null when flag is off (unset)', () => {
      withEnv({ ...ALL_VARS, LIVEKIT_POC_ENABLED: undefined }, () => {
        expect(getLiveKitPocConfig()).toBeNull();
      });
    });

    test('returns null when flag is "false"', () => {
      withEnv({ ...ALL_VARS, LIVEKIT_POC_ENABLED: 'false' }, () => {
        expect(getLiveKitPocConfig()).toBeNull();
      });
    });

    test('returns config when flag is on and all vars are present', () => {
      withEnv(ALL_VARS, () => {
        const cfg = getLiveKitPocConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.url).toBe('wss://livekit.example.com');
        expect(cfg!.apiKey).toBe('test-api-key');
        expect(cfg!.apiSecret).toBe('test-api-secret');
      });
    });

    test('returns null when flag is on but LIVEKIT_POC_URL is missing', () => {
      withEnv({ ...ALL_VARS, LIVEKIT_POC_URL: undefined }, () => {
        expect(getLiveKitPocConfig()).toBeNull();
      });
    });

    test('returns null when flag is on but LIVEKIT_POC_URL is empty', () => {
      withEnv({ ...ALL_VARS, LIVEKIT_POC_URL: '' }, () => {
        expect(getLiveKitPocConfig()).toBeNull();
      });
    });

    test('returns null when flag is on but LIVEKIT_POC_API_KEY is missing', () => {
      withEnv({ ...ALL_VARS, LIVEKIT_POC_API_KEY: undefined }, () => {
        expect(getLiveKitPocConfig()).toBeNull();
      });
    });

    test('returns null when flag is on but LIVEKIT_POC_API_SECRET is missing', () => {
      withEnv({ ...ALL_VARS, LIVEKIT_POC_API_SECRET: undefined }, () => {
        expect(getLiveKitPocConfig()).toBeNull();
      });
    });

    test('returns null when flag is on but all coordinate vars are missing', () => {
      withEnv({
        LIVEKIT_POC_ENABLED: 'true',
        LIVEKIT_POC_URL: undefined,
        LIVEKIT_POC_API_KEY: undefined,
        LIVEKIT_POC_API_SECRET: undefined,
      }, () => {
        expect(getLiveKitPocConfig()).toBeNull();
      });
    });
  });

  describe('governance: no Google/Vertex/GCP runtime dependencies in module source', () => {
    test('livekit-poc-config.ts imports no Google/Vertex/GCP packages', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../src/orb/live/poc/livekit-poc-config.ts'),
        'utf8',
      );
      // Must not import from any Google/Vertex/GCP package.
      // (Prohibition comments that mention these words are fine — we only
      // reject actual import statements or require() calls.)
      expect(src).not.toMatch(/from\s+['"]@google-cloud/);
      expect(src).not.toMatch(/from\s+['"]googleapis/);
      expect(src).not.toMatch(/require\s*\(\s*['"]@google-cloud/);
      expect(src).not.toMatch(/require\s*\(\s*['"]googleapis/);
      // Must not reference the Vertex Live API endpoint
      expect(src).not.toMatch(/aiplatform\.googleapis\.com/);
      expect(src).not.toMatch(/generativelanguage\.googleapis\.com/);
    });
  });
});

describe('VTID-04772: voice.model_under_responds spec hint', () => {
  // Import here so the governance check above can run without this import
  // affecting the module-load order.
  const { getVoiceSpecHint } = require('../src/services/voice-spec-hints');

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

  test('getVoiceSpecHint returns a spec for voice.model_under_responds', () => {
    const h = getVoiceSpecHint('voice.model_under_responds');
    expect(h).not.toBeNull();
    expect(h.spec).toBeTruthy();
    expect(h.spec_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('voice.model_under_responds spec has all 9 required sections', () => {
    const h = getVoiceSpecHint('voice.model_under_responds');
    const r = specHasAllRequiredSections(h.spec);
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('voice.model_under_responds spec does not touch deploy (flag-gated additive)', () => {
    const h = getVoiceSpecHint('voice.model_under_responds');
    expect(h.touches_deploy).toBe(false);
  });

  test('voice.model_under_responds spec hash is stable across invocations', () => {
    const a = getVoiceSpecHint('voice.model_under_responds');
    const b = getVoiceSpecHint('voice.model_under_responds');
    expect(a.spec_hash).toBe(b.spec_hash);
  });

  test('voice.model_under_responds spec hash differs from all other class hashes', () => {
    const target = getVoiceSpecHint('voice.model_under_responds').spec_hash;
    const others = [
      'voice.config_missing',
      'voice.config_fallback_active',
      'voice.auth_rejected',
      'voice.model_stall',
      'voice.upstream_disconnect',
      'voice.tts_failed',
      'voice.session_leak',
    ];
    for (const klass of others) {
      const h = getVoiceSpecHint(klass);
      expect(h.spec_hash).not.toBe(target);
    }
  });

  test('voice.model_under_responds spec contains no Google/Vertex/GCP dependency', () => {
    const h = getVoiceSpecHint('voice.model_under_responds');
    const lower = (h.spec as string).toLowerCase();
    // Must not introduce new Vertex/Gemini/GCP dependencies
    expect(lower).not.toMatch(/vertex_project_id/);
    expect(lower).not.toMatch(/gemini live/);
    expect(lower).not.toMatch(/googleapis/);
  });

  test('voice.model_under_responds spec references LIVEKIT_POC_ENABLED flag', () => {
    const h = getVoiceSpecHint('voice.model_under_responds');
    expect(h.spec).toContain('LIVEKIT_POC_ENABLED');
  });

  test('voice.model_under_responds spec summary mentions LiveKit POC', () => {
    const h = getVoiceSpecHint('voice.model_under_responds');
    expect(h.summary.toLowerCase()).toContain('livekit');
  });
});
