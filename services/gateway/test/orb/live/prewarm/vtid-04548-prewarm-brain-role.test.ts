/**
 * VTID-04548 — the prewarm warms the brain cache for the role (and
 * timezone) the next session start will build with, keyed exactly as the
 * session start looks it up.
 *
 * Before: POST /live/session/prewarm always warmed `role:'community'` with no
 * timezone. A Command Hub session builds for `developer`, and every session
 * passes the browser's timezone — so the warm either missed (developer) or,
 * because the timezone was not in the cache key, was served to the session
 * with the wrong zone rendered into it.
 *
 * The key equality is asserted with the cache's own key function
 * (`brainCacheKey`) against the exact input `buildBaseSessionContext` — the
 * session start's builder — hands to the brain.
 */

jest.mock('../../../../src/services/vitana-brain', () => ({
  buildBrainSystemInstruction: jest.fn(),
}));

import { buildBrainSystemInstruction } from '../../../../src/services/vitana-brain';
import {
  brainCacheKey,
  buildBrainSystemInstructionCached,
  warmBrainCache,
  _resetBrainCacheForTests,
} from '../../../../src/services/vitana-brain-cache';
import {
  buildBaseSessionContext,
  prewarmBrainInput,
  resolveBrainRole,
  resolveSessionActiveRole,
} from '../../../../src/orb/live/session/session-context-builder';
import { pickEffectiveRole } from '../../../../src/services/orchestrator/active-role';

const identity = { user_id: 'u-1', tenant_id: 't-1', email: 'x@example.com' } as any;
const legacy = jest.fn(async () => ({ contextInstruction: 'LEGACY' }));

/** The brain input the session start actually builds with, captured from the real builder. */
async function sessionBrainInput(opts: { route?: string; isMobile?: boolean; timezone?: string | null }) {
  const brainRole = resolveBrainRole({
    isMobile: opts.isMobile,
    route: opts.route || '',
    identityRole: (identity as any).active_role || null,
  });
  let captured: any = null;
  await buildBaseSessionContext(
    { identity, sessionId: 'live-abc', brainRole, timezone: opts.timezone, useBrain: true },
    {
      legacy,
      buildBrain: async (input) => {
        captured = input;
        return { instruction: 'I', contextPack: {} as any, coreInstruction: 'C' };
      },
    },
  );
  return captured;
}

describe('VTID-04548 prewarm resolves the session role', () => {
  it('the Command Hub warms developer', () => {
    const { brainRole, input } = prewarmBrainInput({ identity, route: '/command-hub/autopilot', isMobile: false });
    expect(brainRole).toBe('developer');
    expect(input.role).toBe('developer');
  });

  it('mobile warms community, even on a Command Hub route', () => {
    expect(prewarmBrainInput({ identity, route: '/command-hub', isMobile: true }).brainRole).toBe('community');
    expect(prewarmBrainInput({ identity, route: '/home', isMobile: true }).brainRole).toBe('community');
  });

  it('no route (a prewarm that does not send one) keeps the old community warm', () => {
    expect(prewarmBrainInput({ identity }).brainRole).toBe('community');
  });

  it('role_preferences wins for the session active_role (the rule both paths now share)', () => {
    // resolveEffectiveRole = pickEffectiveRole(role_preferences, user_tenants.active_role)
    const fetched = pickEffectiveRole('admin', 'community');
    expect(fetched).toBe('admin');
    expect(resolveSessionActiveRole({ fetchedRole: fetched, route: '/admin', isMobile: false }).role).toBe('admin');
    // Unset preference falls back to user_tenants.active_role.
    expect(resolveSessionActiveRole({ fetchedRole: pickEffectiveRole(null, 'professional') }).role).toBe('professional');
  });

  it('active_role: the Command Hub lifts a missing/community role to developer, mobile forces community', () => {
    expect(resolveSessionActiveRole({ fetchedRole: null, route: '/command-hub' })).toEqual({ role: 'developer', override: 'command_hub' });
    expect(resolveSessionActiveRole({ fetchedRole: 'community', route: '/command-hub/x' })).toEqual({ role: 'developer', override: 'command_hub' });
    expect(resolveSessionActiveRole({ fetchedRole: 'admin', route: '/command-hub' })).toEqual({ role: 'admin', override: null });
    expect(resolveSessionActiveRole({ fetchedRole: 'admin', route: '/command-hub', isMobile: true })).toEqual({ role: 'community', override: 'mobile' });
    expect(resolveSessionActiveRole({ fetchedRole: 'community', isMobile: true })).toEqual({ role: 'community', override: null });
  });

  it('the brain role is not moved by role_preferences: the session start has no app role on the identity either', () => {
    // Pins the fact the prewarm mirrors: live-session-controller.ts passes
    // `(bootstrapIdentity as any).active_role` and SupabaseIdentity has no
    // such field, so the brain builds for community off the Command Hub.
    expect(prewarmBrainInput({ identity, route: '/admin' }).brainRole)
      .toBe(resolveBrainRole({ route: '/admin', identityRole: (identity as any).active_role || null }));
  });
});

describe('VTID-04548 the warmed key is the key the session start looks up', () => {
  const cases: Array<{ name: string; route?: string; isMobile?: boolean; timezone?: string | null }> = [
    { name: 'community, Berlin', route: '/home', timezone: 'Europe/Berlin' },
    { name: 'Command Hub, New York', route: '/command-hub/voice', timezone: 'America/New_York' },
    { name: 'mobile on the Command Hub route', route: '/command-hub', isMobile: true, timezone: 'Asia/Tokyo' },
    { name: 'no timezone', route: '/discover', timezone: null },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const session = await sessionBrainInput(c);
      const warmed = prewarmBrainInput({ identity, route: c.route, isMobile: c.isMobile, timezone: c.timezone }).input;
      expect(brainCacheKey(warmed)).toBe(brainCacheKey(session));
    });
  }

  it('a different timezone is a different key', () => {
    const a = prewarmBrainInput({ identity, route: '/home', timezone: 'Europe/Berlin' }).input;
    const b = prewarmBrainInput({ identity, route: '/home', timezone: 'UTC' }).input;
    const none = prewarmBrainInput({ identity, route: '/home' }).input;
    expect(brainCacheKey(a)).not.toBe(brainCacheKey(b));
    expect(brainCacheKey(a)).not.toBe(brainCacheKey(none));
  });
});

describe('VTID-04548 warm → session hit, end to end through the cache', () => {
  const FLAG = 'FEATURE_ORB_BRAIN_CACHE_ENV';
  const prev = process.env[FLAG];
  const mockBuild = buildBrainSystemInstruction as jest.Mock;
  beforeEach(() => {
    _resetBrainCacheForTests();
    mockBuild.mockReset();
    mockBuild.mockImplementation(async (input: any) => ({
      instruction: `role=${input.role} tz=${input.user_timezone || 'UTC'}`,
      contextPack: {},
      coreInstruction: 'C',
    }));
    process.env[FLAG] = 'staging+prod';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('a Command Hub prewarm makes the Command Hub session a cache hit with the right role and zone', async () => {
    const { input } = prewarmBrainInput({ identity, route: '/command-hub', timezone: 'Europe/Berlin' });
    warmBrainCache(input);
    await new Promise((r) => setTimeout(r, 0));
    const r = await buildBaseSessionContext(
      { identity, sessionId: 'live-1', brainRole: 'developer', timezone: 'Europe/Berlin', useBrain: true },
      { legacy, buildBrain: (i) => buildBrainSystemInstructionCached(i) },
    );
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(r.contextInstruction).toBe('role=developer tz=Europe/Berlin');
  });

  it('a prewarm for another zone is NOT served to the session (it builds its own)', async () => {
    warmBrainCache(prewarmBrainInput({ identity, route: '/home' }).input); // no zone
    await new Promise((r) => setTimeout(r, 0));
    const r = await buildBaseSessionContext(
      { identity, sessionId: 'live-2', brainRole: 'community', timezone: 'Europe/Berlin', useBrain: true },
      { legacy, buildBrain: (i) => buildBrainSystemInstructionCached(i) },
    );
    expect(mockBuild).toHaveBeenCalledTimes(2);
    expect(r.contextInstruction).toBe('role=community tz=Europe/Berlin');
  });

  it('prewarming again after a route switch warms the new role; the old key stays valid', async () => {
    warmBrainCache(prewarmBrainInput({ identity, route: '/home', timezone: 'UTC' }).input);
    warmBrainCache(prewarmBrainInput({ identity, route: '/command-hub', timezone: 'UTC' }).input);
    // Re-warming an already-warm key is a hit, not a rebuild.
    warmBrainCache(prewarmBrainInput({ identity, route: '/command-hub', timezone: 'UTC' }).input);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockBuild).toHaveBeenCalledTimes(2);
    expect(mockBuild.mock.calls.map((c) => c[0].role).sort()).toEqual(['community', 'developer']);
  });
});
