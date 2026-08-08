/**
 * VTID-03501 — Nova Sonic global promotion path (GCP cutover build 4 of 4).
 *
 * Promotes Nova out of the identity allowlist onto every session, behind
 * `NOVA_SONIC_GLOBAL_ENABLED`, default OFF.
 *
 * The load-bearing assertions here are about LABELLING as much as gating: a
 * globally-promoted session must not report itself as a canary session, or
 * every canary-scoped dashboard and alert silently starts describing the whole
 * user base while still being read as "4 users".
 */

import {
  getNovaSonicConfig,
  isNovaSonicIdentityAllowed,
  buildNovaSonicHealthPayload,
} from '../../../../src/orb/live/upstream/nova-sonic-config';
import { selectUpstreamProvider } from '../../../../src/orb/live/upstream/upstream-provider-selector';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function cfg(env: Record<string, string | undefined>) {
  return getNovaSonicConfig(env as NodeJS.ProcessEnv);
}

describe('VTID-03501 globalEnabled parsing', () => {
  it('defaults to false — deploying this code promotes nobody', () => {
    expect(cfg({}).globalEnabled).toBe(false);
  });

  it('requires the exact string "true"', () => {
    expect(cfg({ NOVA_SONIC_GLOBAL_ENABLED: 'true' }).globalEnabled).toBe(true);
    // A promotion this consequential must not ride on loose parsing.
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', '']) {
      expect(cfg({ NOVA_SONIC_GLOBAL_ENABLED: v }).globalEnabled).toBe(false);
    }
  });
});

describe('VTID-03501 identity gate', () => {
  it('still allows NOBODY when global is off and allowlists are empty', () => {
    const c = cfg({});
    expect(isNovaSonicIdentityAllowed(c, { userId: USER, tenantId: null })).toBe(false);
  });

  it('allows EVERY identity when global is on', () => {
    const c = cfg({ NOVA_SONIC_GLOBAL_ENABLED: 'true' });
    expect(isNovaSonicIdentityAllowed(c, { userId: OTHER, tenantId: null })).toBe(true);
    expect(isNovaSonicIdentityAllowed(c, { userId: null, tenantId: null })).toBe(true);
  });

  it('leaves allowlist semantics untouched, so turning global off restores the exact prior population', () => {
    const on = cfg({ NOVA_SONIC_GLOBAL_ENABLED: 'true', NOVA_SONIC_CANARY_USER_IDS: USER });
    const off = cfg({ NOVA_SONIC_CANARY_USER_IDS: USER });
    expect(isNovaSonicIdentityAllowed(on, { userId: OTHER })).toBe(true);
    // Same allowlist, global off → only the allowlisted user comes back.
    expect(isNovaSonicIdentityAllowed(off, { userId: OTHER })).toBe(false);
    expect(isNovaSonicIdentityAllowed(off, { userId: USER })).toBe(true);
  });
});

describe('VTID-03501 selector labelling', () => {
  const base = {
    envProvider: undefined,
    systemConfigProvider: undefined,
    livekitCredentials: {},
    identity: { userId: USER, tenantId: null },
  } as never;

  it('a globally-promoted session reports nova_global_enabled and canary=false', () => {
    const d = selectUpstreamProvider({
      ...(base as object),
      nova: {
        enabled: true,
        identityAllowed: true,
        languageSupported: true,
        runtime: 'aws-ecs',
        globalEnabled: true,
      },
    } as never);
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_global_enabled');
    // The critical one: a promoted session is NOT a canary session.
    expect(d.canary).toBe(false);
  });

  it('an allowlisted session still reports nova_canary_allowlisted and canary=true', () => {
    const d = selectUpstreamProvider({
      ...(base as object),
      nova: {
        enabled: true,
        identityAllowed: true,
        languageSupported: true,
        runtime: 'aws-ecs',
        globalEnabled: false,
      },
    } as never);
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_canary_allowlisted');
    expect(d.canary).toBe(true);
  });

  it('global promotion does NOT bypass the other hard gates', () => {
    // Language and runtime gates must still bite — promotion widens WHO gets
    // Nova, never WHAT Nova is allowed to run on.
    const unsupportedLang = selectUpstreamProvider({
      ...(base as object),
      nova: {
        enabled: true,
        identityAllowed: true,
        languageSupported: false,
        runtime: 'aws-ecs',
        globalEnabled: true,
      },
    } as never);
    expect(unsupportedLang.provider).toBe('vertex');

    const gcpRuntime = selectUpstreamProvider({
      ...(base as object),
      nova: {
        enabled: true,
        identityAllowed: true,
        languageSupported: true,
        runtime: 'gcp-cloud-run',
        globalEnabled: true,
      },
    } as never);
    expect(gcpRuntime.provider).toBe('vertex');
  });

  it('global promotion cannot resurrect a disabled Nova', () => {
    const d = selectUpstreamProvider({
      ...(base as object),
      nova: {
        enabled: false,
        identityAllowed: true,
        languageSupported: true,
        runtime: 'aws-ecs',
        globalEnabled: true,
      },
    } as never);
    expect(d.provider).toBe('vertex');
  });
});

describe('VTID-03501 health payload', () => {
  it('reports global_enabled so the canary counts cannot mislead', () => {
    // Without this the endpoint says "canary_user_count: 4" while Nova is
    // actually serving everyone.
    const payload = buildNovaSonicHealthPayload({
      NOVA_SONIC_ENABLED: 'true',
      NOVA_SONIC_GLOBAL_ENABLED: 'true',
    } as NodeJS.ProcessEnv);
    expect(payload.global_enabled).toBe(true);
    expect(payload.canary_user_count).toBe(0);
  });

  it('reports global_enabled=false by default', () => {
    const payload = buildNovaSonicHealthPayload({ NOVA_SONIC_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(payload.global_enabled).toBe(false);
  });
});
