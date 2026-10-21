/**
 * VTID-04543 — the SSE mic-frame route (`/live/stream/send`) no longer
 * resolves the caller's tenant on every 64 ms frame.
 *
 *   1. The owner's resolved identity is remembered per session: N frames
 *      cost one tenant lookup, not N.
 *   2. A request from a different user still goes through the resolver and
 *      is logged as an ownership mismatch and allowed through — exactly the
 *      pre-change behaviour (the route has never rejected on mismatch).
 *   3. The identity the ownership check sees is the one `resolveOrbIdentity`
 *      would have produced.
 *   4. The in-process primary-tenant cache: TTL, positives only, in-flight
 *      dedupe, bounded size.
 */

jest.mock('../../../../src/services/voice-quota-guard', () => ({
  reserveVoiceQuotaAtSessionStart: jest.fn(async () => null),
  recordVoiceMinute: jest.fn(async () => 0),
  triggerDowngrade: jest.fn(async () => undefined),
}));

import {
  configureLiveSessionController,
  handleLiveSessionStart,
  handleLiveStreamSend,
  resolveStreamSendIdentity,
  rememberSessionOwnerIdentity,
  __resetLiveSessionControllerForTests,
  type LiveSessionControllerDeps,
} from '../../../../src/orb/live/session/live-session-controller';
import { liveSessions, sessions, wsClientSessions } from '../../../../src/orb/live/session/live-session-registry';
import { createPrimaryTenantCache } from '../../../../src/orb/live/session/primary-tenant-cache';

const OWNER = 'owner-user-1';
const OTHER = 'other-user-2';

/**
 * A resolver shaped exactly like routes/orb-live.ts's resolveOrbIdentity:
 * JWT tenant wins; otherwise the tenant comes from a lookup (counted).
 */
function makeResolver(tenantByUser: Record<string, string | null>) {
  const lookup = jest.fn(async (userId: string) => tenantByUser[userId] ?? null);
  const resolver = jest.fn(async (req: any) => {
    if (req.identity && req.identity.user_id) {
      if (!req.identity.tenant_id) {
        const t = await lookup(req.identity.user_id);
        if (t) return { ...req.identity, tenant_id: t };
      }
      return req.identity;
    }
    return null;
  });
  return { lookup, resolver };
}

function deps(resolveOrbIdentity: any, over: Partial<LiveSessionControllerDeps> = {}): LiveSessionControllerDeps {
  return {
    resolveOrbIdentity,
    clearResponseWatchdog: () => undefined,
    sendEndOfTurn: () => true,
    validateOrigin: () => true,
    buildClientContext: async () => ({ isMobile: false } as any),
    normalizeLang: (l: string) => l || 'en',
    getVoiceForLang: () => 'v',
    getStoredLanguagePreference: async () => null,
    persistLanguagePreference: () => undefined,
    fetchLastSessionInfo: async () => null,
    fetchOnboardingCohortBlock: async () => '',
    buildBootstrapContextPack: async () => ({}),
    resolveEffectiveRole: async () => 'community',
    terminateExistingSessionsForUser: () => 0,
    emitLiveSessionEvent: async () => undefined,
    describeTimeSince: () => ({ bucket: 'first_time', wasFailure: false }),
    sendAudioToLiveAPI: () => true,
    startResponseWatchdog: () => undefined,
    emitDiag: () => undefined,
    getGoogleAuthReady: () => true,
    ...over,
  };
}

function jwt(userId: string, tenantId: string | null = null) {
  return { user_id: userId, tenant_id: tenantId, email: null, exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null, vitana_id: null };
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function sendReq(sessionId: string, identity: any) {
  return {
    identity,
    query: { session_id: sessionId },
    body: { type: 'audio', data_b64: 'AAAA', mime: 'audio/pcm;rate=16000' },
    headers: {},
  } as any;
}

function makeLiveSession(sessionId: string, identity: any): any {
  return {
    sessionId,
    active: true,
    isAnonymous: false,
    isModelSpeaking: false,
    navigationDispatched: false,
    turnCompleteAt: 0,
    audioInChunks: 0,
    audioInForwarded: 0,
    videoInFrames: 0,
    turn_count: 0,
    modelRespondedThisTurn: true,
    lastActivity: new Date(),
    lastTelemetryEmitTime: Date.now(),
    lastAudioForwardedTime: 0,
    upstreamWs: null,
    sseResponse: null,
    outputTranscriptBuffer: '',
    transcriptTurns: [],
    identity,
  };
}

beforeEach(() => {
  __resetLiveSessionControllerForTests();
  liveSessions.clear();
  sessions.clear();
  wsClientSessions.clear();
});

afterAll(() => {
  __resetLiveSessionControllerForTests();
  liveSessions.clear();
});

describe('VTID-04543: /live/stream/send resolves the owner identity once per session', () => {
  it('session start seeds the cache: N frames after start cost zero further tenant lookups', async () => {
    const { lookup, resolver } = makeResolver({ [OWNER]: 'tenant-A' });
    configureLiveSessionController(deps(resolver));
    const startRes = makeRes();
    await handleLiveSessionStart(
      { identity: jwt(OWNER), headers: {}, body: { guided_topic_id: 'T001' }, query: {}, get: () => undefined } as any,
      startRes,
    );
    const sessionId = startRes.json.mock.calls[0][0].session_id;
    expect(lookup).toHaveBeenCalledTimes(1); // session start's own resolution

    for (let i = 0; i < 25; i++) {
      const res = makeRes();
      await handleLiveStreamSend(sendReq(sessionId, jwt(OWNER)), res);
      expect(res.status).toHaveBeenCalledWith(200);
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(liveSessions.get(sessionId)!.audioInChunks).toBe(25);
  });

  it('a session without a seeded entry resolves on the first frame only', async () => {
    const { lookup, resolver } = makeResolver({ [OWNER]: 'tenant-A' });
    configureLiveSessionController(deps(resolver));
    liveSessions.set('s1', makeLiveSession('s1', { ...jwt(OWNER), tenant_id: 'tenant-A' }));
    for (let i = 0; i < 10; i++) {
      await handleLiveStreamSend(sendReq('s1', jwt(OWNER)), makeRes());
    }
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a user with no tenant anywhere is resolved once and then served the tenant-less JWT identity', async () => {
    const { lookup, resolver } = makeResolver({});
    configureLiveSessionController(deps(resolver));
    liveSessions.set('s1', makeLiveSession('s1', jwt(OWNER)));
    for (let i = 0; i < 5; i++) {
      await handleLiveStreamSend(sendReq('s1', jwt(OWNER)), makeRes());
    }
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a mismatched user is still resolved every time, logged, and allowed through (unchanged behaviour)', async () => {
    const { lookup, resolver } = makeResolver({ [OWNER]: 'tenant-A', [OTHER]: 'tenant-B' });
    configureLiveSessionController(deps(resolver));
    liveSessions.set('s1', makeLiveSession('s1', { ...jwt(OWNER), tenant_id: 'tenant-A' }));
    rememberSessionOwnerIdentity(liveSessions.get('s1')!, OWNER, { ...jwt(OWNER), tenant_id: 'tenant-A' } as any);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 3; i++) {
        const res = makeRes();
        await handleLiveStreamSend(sendReq('s1', jwt(OTHER)), res);
        expect(res.status).toHaveBeenCalledWith(200);
      }
      expect(resolver).toHaveBeenCalledTimes(3);
      expect(lookup).toHaveBeenCalledTimes(3);
      const mismatchLogs = warn.mock.calls.filter((c) => String(c[0]).includes('/send ownership mismatch (allowed)'));
      expect(mismatchLogs).toHaveLength(3);
      expect(String(mismatchLogs[0][0])).toContain(`request_user=${OTHER}`);
      expect(String(mismatchLogs[0][0])).toContain('request_tenant=tenant-B');
    } finally {
      warn.mockRestore();
    }
  });

  it('an owner frame after a mismatched frame is still served from the owner cache', async () => {
    const { lookup, resolver } = makeResolver({ [OWNER]: 'tenant-A', [OTHER]: 'tenant-B' });
    configureLiveSessionController(deps(resolver));
    liveSessions.set('s1', makeLiveSession('s1', { ...jwt(OWNER), tenant_id: 'tenant-A' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await handleLiveStreamSend(sendReq('s1', jwt(OWNER)), makeRes());
      await handleLiveStreamSend(sendReq('s1', jwt(OTHER)), makeRes());
      await handleLiveStreamSend(sendReq('s1', jwt(OWNER)), makeRes());
      await handleLiveStreamSend(sendReq('s1', jwt(OWNER)), makeRes());
    } finally {
      warn.mockRestore();
    }
    expect(lookup.mock.calls.map((c) => c[0])).toEqual([OWNER, OTHER]);
  });

  it('the identity handed to the ownership check equals what the resolver would return', async () => {
    const { resolver } = makeResolver({ [OWNER]: 'tenant-A' });
    const session = makeLiveSession('s1', { ...jwt(OWNER), tenant_id: 'tenant-A' });
    const req = sendReq('s1', jwt(OWNER));
    const fresh = await resolver(req);
    const first = await resolveStreamSendIdentity(req, session, resolver);
    const cached = await resolveStreamSendIdentity(req, session, resolver);
    expect(first).toEqual(fresh);
    expect(cached).toEqual(fresh);

    // JWT that already carries a tenant: the resolver path, unchanged.
    const withTenant = sendReq('s1', jwt(OWNER, 'tenant-jwt'));
    expect(await resolveStreamSendIdentity(withTenant, session, resolver)).toEqual(await resolver(withTenant));

    // Anonymous request: resolver path, unchanged.
    const anon = sendReq('s1', undefined);
    expect(await resolveStreamSendIdentity(anon, session, resolver)).toBeNull();
  });

  it('400 / 404 / inactive answers are unchanged and no longer pay for identity resolution', async () => {
    const { resolver } = makeResolver({ [OWNER]: 'tenant-A' });
    configureLiveSessionController(deps(resolver));
    const r400 = makeRes();
    await handleLiveStreamSend({ identity: jwt(OWNER), query: {}, body: {} } as any, r400);
    expect(r400.status).toHaveBeenCalledWith(400);
    expect(r400.json).toHaveBeenCalledWith({ ok: false, error: 'session_id required' });
    const r404 = makeRes();
    await handleLiveStreamSend(sendReq('missing', jwt(OWNER)), r404);
    expect(r404.status).toHaveBeenCalledWith(404);
    liveSessions.set('dead', { ...makeLiveSession('dead', jwt(OWNER)), active: false });
    const rInactive = makeRes();
    await handleLiveStreamSend(sendReq('dead', jwt(OWNER)), rInactive);
    expect(rInactive.status).toHaveBeenCalledWith(400);
    expect(rInactive.json).toHaveBeenCalledWith({ ok: false, error: 'Session not active' });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('VTID-04543: primary-tenant cache', () => {
  it('caches a resolved tenant for the TTL, then reloads', async () => {
    let now = 1_000;
    const cache = createPrimaryTenantCache({ ttlMs: 5 * 60 * 1000, now: () => now });
    const loader = jest.fn(async () => 'tenant-A');
    expect(await cache.resolve('u1', loader)).toBe('tenant-A');
    now += 4 * 60 * 1000;
    expect(await cache.resolve('u1', loader)).toBe('tenant-A');
    expect(loader).toHaveBeenCalledTimes(1);
    now += 60 * 1000 + 1; // past 5 min
    expect(await cache.resolve('u1', loader)).toBe('tenant-A');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('never caches a null result', async () => {
    const cache = createPrimaryTenantCache();
    const loader = jest.fn(async () => null);
    expect(await cache.resolve('u1', loader)).toBeNull();
    expect(await cache.resolve('u1', loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(0);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = createPrimaryTenantCache();
    let release!: (v: string) => void;
    const loader = jest.fn(() => new Promise<string>((r) => { release = r; }));
    const a = cache.resolve('u1', loader);
    const b = cache.resolve('u1', loader);
    release('tenant-A');
    expect(await Promise.all([a, b])).toEqual(['tenant-A', 'tenant-A']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('is bounded: the oldest entry is evicted first', async () => {
    const cache = createPrimaryTenantCache({ maxEntries: 2 });
    await cache.resolve('u1', async () => 't1');
    await cache.resolve('u2', async () => 't2');
    await cache.resolve('u3', async () => 't3');
    expect(cache.size()).toBe(2);
    const reload = jest.fn(async () => 't1-new');
    expect(await cache.resolve('u1', reload)).toBe('t1-new');
    expect(reload).toHaveBeenCalledTimes(1);
    const noReload = jest.fn(async () => 'x');
    expect(await cache.resolve('u3', noReload)).toBe('t3');
    expect(noReload).not.toHaveBeenCalled();
  });

  it('invalidate() forces the next read', async () => {
    const cache = createPrimaryTenantCache();
    const loader = jest.fn(async () => 'tenant-A');
    await cache.resolve('u1', loader);
    cache.invalidate('u1');
    await cache.resolve('u1', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('VTID-04543: routes/orb-live.ts wires the cache into lookupPrimaryTenant', () => {
  it('lookupPrimaryTenant delegates to the cache and keeps the original two-query body', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(path.resolve(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
    expect(src).toMatch(/async function lookupPrimaryTenant\(userId: string\): Promise<string \| null> \{\s*return primaryTenantCache\.resolve\(userId, \(\) => lookupPrimaryTenantUncached\(userId\)\);/);
    const body = src.slice(src.indexOf('async function lookupPrimaryTenantUncached'));
    expect(body.slice(0, 2000)).toContain(".eq('is_primary', true)");
  });
});
