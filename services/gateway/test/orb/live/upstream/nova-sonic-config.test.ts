/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): Nova configuration + readiness tests.
 */

import {
  getNovaSonicConfig,
  isNovaSonicIdentityAllowed,
  isNovaSonicLanguageSupported,
  parseUuidAllowlist,
  NOVA_SONIC_MODEL_ID,
  NOVA_SONIC_REGION,
} from '../../../../src/orb/live/upstream/nova-sonic-config';

const U1 = 'a27552a3-0257-4305-8ed0-351a80fd3701';
const T1 = 'b38663b4-1368-5416-9fe1-462b91fe4812';

describe('getNovaSonicConfig', () => {
  it('defaults to disabled with pinned region/model', () => {
    expect(getNovaSonicConfig({} as NodeJS.ProcessEnv)).toEqual(
      expect.objectContaining({
        enabled: false,
        ready: false,
        region: 'eu-north-1',
        modelId: 'amazon.nova-2-sonic-v1:0',
        connectTimeoutMs: 15000,
        rotationAfterMs: 435000,
        keepWarmMs: 240000,
        modelWarmMs: 90000,
        maxTokens: 4096,
        instructionChunkBytes: 4000,
        issues: [],
      }),
    );
  });

  it('maxTokens is env-tunable and invalid values are a typed issue', () => {
    expect(
      getNovaSonicConfig({ NOVA_SONIC_MAX_TOKENS: '8192' } as NodeJS.ProcessEnv).maxTokens,
    ).toBe(8192);
    const bad = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_MAX_TOKENS: '0',
    } as NodeJS.ProcessEnv);
    expect(bad.issues).toContain('nova_max_tokens_invalid');
    expect(bad.ready).toBe(false);
  });

  it('is ready when enabled with a clean environment', () => {
    const cfg = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_REGION: NOVA_SONIC_REGION,
      NOVA_SONIC_MODEL_ID: NOVA_SONIC_MODEL_ID,
      NOVA_SONIC_CANARY_USER_IDS: ` ${U1.toUpperCase()} , `,
    } as NodeJS.ProcessEnv);
    expect(cfg.ready).toBe(true);
    expect(cfg.enabled).toBe(true);
    expect([...cfg.canaryUserIds]).toEqual([U1]);
  });

  it('a mismatched region/model override fails readiness with typed issues', () => {
    const cfg = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_REGION: 'us-east-1',
      NOVA_SONIC_MODEL_ID: 'amazon.nova-sonic-v1:0',
    } as NodeJS.ProcessEnv);
    expect(cfg.ready).toBe(false);
    expect(cfg.issues).toEqual(
      expect.arrayContaining(['nova_region_invalid', 'nova_model_invalid']),
    );
    // The pinned values are still reported — no silent redirect.
    expect(cfg.region).toBe('eu-north-1');
    expect(cfg.modelId).toBe('amazon.nova-2-sonic-v1:0');
  });

  it('invalid allowlist entries fail readiness rather than broadening access', () => {
    const cfg = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_CANARY_USER_IDS: `${U1},not-a-uuid`,
    } as NodeJS.ProcessEnv);
    expect(cfg.ready).toBe(false);
    expect(cfg.issues).toContain('nova_canary_user_ids_invalid');
    expect(cfg.canaryUserIds.size).toBe(0);
  });

  it('non-numeric timers fail readiness with typed issues', () => {
    const cfg = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_CONNECT_TIMEOUT_MS: 'soon',
      NOVA_SONIC_ROTATION_AFTER_MS: '-5',
      NOVA_SONIC_KEEPWARM_MS: 'often',
      NOVA_SONIC_MODEL_WARM_MS: 'soon',
    } as NodeJS.ProcessEnv);
    expect(cfg.ready).toBe(false);
    expect(cfg.issues).toEqual(
      expect.arrayContaining([
        'nova_connect_timeout_invalid',
        'nova_rotation_after_invalid',
        'nova_keepwarm_invalid',
        'nova_model_warm_invalid',
      ]),
    );
  });

  it('keep-warm accepts 0 as an explicit disable (no issue)', () => {
    const cfg = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_KEEPWARM_MS: '0',
    } as NodeJS.ProcessEnv);
    expect(cfg.keepWarmMs).toBe(0);
    expect(cfg.ready).toBe(true);
    expect(cfg.issues).toEqual([]);
  });

  it('model-execution warm-up is env-tunable and accepts 0 as an explicit disable', () => {
    expect(
      getNovaSonicConfig({ NOVA_SONIC_MODEL_WARM_MS: '30000' } as NodeJS.ProcessEnv).modelWarmMs,
    ).toBe(30000);
    const disabled = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_MODEL_WARM_MS: '0',
    } as NodeJS.ProcessEnv);
    expect(disabled.modelWarmMs).toBe(0);
    expect(disabled.ready).toBe(true);
    expect(disabled.issues).toEqual([]);
  });

  it('instruction chunk size is env-tunable and accepts 0 as an explicit disable', () => {
    expect(
      getNovaSonicConfig({
        NOVA_SONIC_INSTRUCTION_CHUNK_BYTES: '8000',
      } as NodeJS.ProcessEnv).instructionChunkBytes,
    ).toBe(8000);
    const disabled = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_INSTRUCTION_CHUNK_BYTES: '0',
    } as NodeJS.ProcessEnv);
    expect(disabled.instructionChunkBytes).toBe(0);
    expect(disabled.ready).toBe(true);
    expect(disabled.issues).toEqual([]);
  });

  it('non-numeric instruction chunk size fails readiness with a typed issue', () => {
    const bad = getNovaSonicConfig({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_INSTRUCTION_CHUNK_BYTES: 'lots',
    } as NodeJS.ProcessEnv);
    expect(bad.ready).toBe(false);
    expect(bad.issues).toContain('nova_instruction_chunk_invalid');
  });
});

describe('parseUuidAllowlist', () => {
  it('trims, lowercases, drops empties', () => {
    expect([...(parseUuidAllowlist(` ${U1.toUpperCase()},, ${T1} `) ?? [])]).toEqual([U1, T1]);
  });
  it('returns empty set for blank input', () => {
    expect(parseUuidAllowlist(undefined)?.size).toBe(0);
    expect(parseUuidAllowlist('  ')?.size).toBe(0);
  });
  it('returns null on any invalid entry', () => {
    expect(parseUuidAllowlist(`${U1},oops`)).toBeNull();
  });
});

describe('isNovaSonicLanguageSupported', () => {
  it('accepts the four canary languages incl. regional tags', () => {
    for (const l of ['en', 'de', 'fr', 'es', 'de-DE', 'en_US', 'FR']) {
      expect(isNovaSonicLanguageSupported(l)).toBe(true);
    }
  });
  it('rejects everything else', () => {
    for (const l of ['sr', 'ru', 'zh', 'ar', '', undefined, null]) {
      expect(isNovaSonicLanguageSupported(l as any)).toBe(false);
    }
  });
});

describe('isNovaSonicIdentityAllowed', () => {
  const cfg = {
    canaryUserIds: new Set([U1]),
    canaryTenantIds: new Set([T1]),
  };

  it('allows a listed user or tenant (case-insensitive)', () => {
    expect(isNovaSonicIdentityAllowed(cfg, { userId: U1.toUpperCase() })).toBe(true);
    expect(isNovaSonicIdentityAllowed(cfg, { tenantId: T1 })).toBe(true);
  });

  it('denies unlisted identities and anonymous sessions', () => {
    expect(isNovaSonicIdentityAllowed(cfg, { userId: T1 })).toBe(false);
    expect(isNovaSonicIdentityAllowed(cfg, {})).toBe(false);
  });

  it('empty allowlists allow NOBODY', () => {
    const empty = { canaryUserIds: new Set<string>(), canaryTenantIds: new Set<string>() };
    expect(isNovaSonicIdentityAllowed(empty, { userId: U1, tenantId: T1 })).toBe(false);
  });
});

describe('buildNovaSonicHealthPayload', () => {
  const { buildNovaSonicHealthPayload } = require('../../../../src/orb/live/upstream/nova-sonic-config');

  it('reports a disabled-but-clean configuration', () => {
    expect(buildNovaSonicHealthPayload({} as NodeJS.ProcessEnv)).toEqual({
      ok: true,
      configured: true,
      enabled: false,
      ready: false,
      provider: 'nova_sonic',
      model: 'amazon.nova-2-sonic-v1:0',
      region: 'eu-north-1',
      credential_source: 'ecs_task_role',
      supported_languages: ['en', 'de', 'fr', 'es'],
      canary_user_count: 0,
      canary_tenant_count: 0,
      issues: [],
    });
  });

  it('reports counts and typed issues without leaking allowlist contents or secrets', () => {
    const payload = buildNovaSonicHealthPayload({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_CANARY_USER_IDS: 'a27552a3-0257-4305-8ed0-351a80fd3701',
      NOVA_SONIC_REGION: 'us-east-1',
      AWS_SECRET_ACCESS_KEY: 'should-never-appear',
    } as NodeJS.ProcessEnv);
    expect(payload.canary_user_count).toBe(1);
    expect(payload.issues).toEqual(['nova_region_invalid']);
    const flat = JSON.stringify(payload);
    expect(flat).not.toContain('a27552a3');
    expect(flat).not.toContain('should-never-appear');
  });
});
