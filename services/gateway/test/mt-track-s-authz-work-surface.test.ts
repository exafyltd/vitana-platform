/**
 * VTID-05453 (mt-track-s-authz / work-surface-permission).
 *
 * A declared ORB work surface is served only to a caller who holds a permitted role for that screen. Every other
 * caller talks to the member Vitana: no admin briefing, no work-surface tools. Each screen's permission mirrors that
 * screen's own gate:
 *   command-hub → developer | admin | infra | staff   (routes/command-hub.ts COMMAND_HUB_ROLES)
 *   admin       → admin | developer | infra
 *   backoffice  → backoffice | admin | developer | infra
 * Commerce is unchanged. An unreadable permitted set fails closed. 'permitted' is a new ProfileResolution member.
 *
 * Layers, in the order a request meets them:
 *   1. the pure verifier, per screen (verifyWorkSurfaceProfile, needsWorkSurfacePermit);
 *   2. the session start (handleLiveSessionStart): member surface, no admin briefing, warning event, the route does
 *      not lift the brain role or bind the operator thread, commerce unchanged;
 *   3. the LiveKit token mint (resolveLiveKitServedProfile and POST /orb/livekit/token);
 *   4. the text path (servedTurnRole, and the tool set it selects);
 *   5. source contracts for the wiring of the three routes.
 */

// ---------------------------------------------------------------------------
// Module mocks (hoisted). Names start with `mock` so the factories may use them.
// ---------------------------------------------------------------------------

const mockAdminBriefingText = 'ADMIN-BRIEFING-VTID-05453';
const mockAccessTokenCtor = jest.fn();
const mockAddGrant = jest.fn();
const mockToJwt = jest.fn(async () => 'mock.livekit.jwt');
jest.mock('livekit-server-sdk', () => ({
  AccessToken: jest.fn().mockImplementation((apiKey: string, apiSecret: string, options: any) => {
    mockAccessTokenCtor(apiKey, apiSecret, options);
    return { addGrant: mockAddGrant, toJwt: mockToJwt };
  }),
}));

// A chainable Supabase stand-in. Each table answers with `mockReplies[table]`, default `{ data: null, error: null }`.
const mockReplies: Record<string, { data: unknown; error: unknown }> = {};
function mockChain(table: string): any {
  const reply = () => Promise.resolve(mockReplies[table] ?? { data: null, error: null });
  const b: any = {
    select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b, gte: () => b, lte: () => b,
    neq: () => b, is: () => b, insert: () => b, upsert: () => b, update: () => b, delete: () => b,
    maybeSingle: reply,
    single: reply,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => reply().then(res, rej),
  };
  return b;
}
const mockSupabase: any = {
  from: (table: string) => mockChain(table),
  rpc: () => Promise.resolve({ data: null, error: null }),
};
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

const mockFetchPermittedRoles = jest.fn();
jest.mock('../src/lib/permitted-roles', () => {
  const actual = jest.requireActual('../src/lib/permitted-roles');
  return { ...actual, fetchPermittedRoles: (...a: any[]) => mockFetchPermittedRoles(...a) };
});

const mockEmitOasisEvent = jest.fn(async (_event: any) => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (event: any) => mockEmitOasisEvent(event),
}));

jest.mock('../src/services/voice-quota-guard', () => ({
  reserveVoiceQuotaAtSessionStart: jest.fn(async () => ({
    feature: 'voice_live_minutes', paywall_action: 'allow', quota: 600, used: 10, remaining: 590,
    reset_at: null, start_on_standard_tier: false, deferred_for_vulnerability: false,
  })),
  recordVoiceMinute: jest.fn(async () => 0),
  triggerDowngrade: jest.fn(async () => undefined),
}));

jest.mock('../src/services/system-controls-service', () => {
  const actual = jest.requireActual('../src/services/system-controls-service');
  return { ...actual, isVitanaBrainOrbEnabled: jest.fn(async () => false) };
});

jest.mock('../src/services/admin-scanners/briefing', () => {
  const actual = jest.requireActual('../src/services/admin-scanners/briefing');
  return { ...actual, fetchAdminBriefingBlock: jest.fn(async () => mockAdminBriefingText) };
});

jest.mock('../src/routes/autopilot-recommendations', () => ({
  buildAutopilotOfferBlock: jest.fn(async () => ''),
}));

jest.mock('../src/services/assistant-continuation/providers/login-briefing', () => ({
  computeFastProactiveOpener: jest.fn(async () => 'PROACTIVE-LINE'),
}));

jest.mock('../src/services/assistant-continuation/providers/new-day-return', () => {
  const actual = jest.requireActual('../src/services/assistant-continuation/providers/new-day-return');
  return { ...actual, localHourInTimezone: jest.fn(() => 10) };
});

jest.mock('../src/services/assistant-continuation/providers/new-day-overview-payload', () => {
  const actual = jest.requireActual('../src/services/assistant-continuation/providers/new-day-overview-payload');
  return {
    ...actual,
    fetchGuidedJourney: jest.fn(async () => null),
    buildGuidedJourneyStandingInstruction: jest.fn(() => ''),
  };
});

jest.mock('../src/services/wake-cadence-signals', () => {
  const actual = jest.requireActual('../src/services/wake-cadence-signals');
  return {
    ...actual,
    fetchWakeCadenceSignals: jest.fn(async () => ({ sessions_today_count: 1 })),
    recordWakeSessionStart: jest.fn(async () => undefined),
  };
});

jest.mock('../src/orb/context/compile-assistant-decision-context', () => ({
  compileAssistantDecisionContext: jest.fn(async () => ({})),
}));

jest.mock('../src/services/wake-brief-wiring', () => ({
  decideWakeBriefForSession: jest.fn(async () => null),
}));

jest.mock('../src/services/journey/user-journey-service', () => ({
  getJourneyState: jest.fn(async () => null),
  ensureUserJourneyRow: jest.fn(async () => undefined),
  updateSessionEndState: jest.fn(async () => undefined),
}));

jest.mock('../src/services/user-context-profiler', () => ({
  fetchLifeCompass: jest.fn(async () => null),
}));

jest.mock('../src/services/journey-foundation/journey-foundation-state', () => ({
  buildJourneyFoundationSnapshot: jest.fn(async () => null),
}));

jest.mock('../src/orb/live/instruction/wake-decision-snapshot', () => {
  const actual = jest.requireActual('../src/orb/live/instruction/wake-decision-snapshot');
  return { ...actual, logWakeDecisionSnapshot: jest.fn() };
});

jest.mock('../src/routes/agents-registry', () => ({
  recordAgentHeartbeat: jest.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after the mocks above).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import * as jose from 'jose';
import {
  resolveAssistantProfile,
  verifyWorkSurfaceProfile,
  needsWorkSurfacePermit,
  servedTurnRole,
  clampRoleToProfile,
  type AssistantProfile,
} from '../src/orb/profile/assistant-profile';
import { WORK_SURFACE_CONTEXT_MARKER } from '../src/orb/profile/session-profile';
import { getGeminiToolDefinitions } from '../src/services/tool-registry';
import {
  configureLiveSessionController,
  handleLiveSessionStart,
  __resetLiveSessionControllerForTests,
  type LiveSessionControllerDeps,
} from '../src/orb/live/session/live-session-controller';
import { liveSessions } from '../src/orb/live/session/live-session-registry';

const actualPermittedRoles = jest.requireActual('../src/lib/permitted-roles');
const SRC = path.join(__dirname, '..', 'src');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** The roles the switcher knows (lib/permitted-roles.ts SWITCHER_ROLES). */
const SWITCHER = ['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'];

/** Owner rule per screen (plan §4, handover 2026-11-03). */
const PERMITTED_FOR: Record<'command-hub' | 'admin' | 'backoffice', string[]> = {
  'command-hub': ['developer', 'admin', 'infra', 'staff'],
  admin: ['admin', 'developer', 'infra'],
  backoffice: ['backoffice', 'admin', 'developer', 'infra'],
};

const WORK_ROLE: Record<'command-hub' | 'admin' | 'backoffice', string> = {
  'command-hub': 'developer',
  admin: 'admin',
  backoffice: 'backoffice',
};

beforeEach(() => {
  mockFetchPermittedRoles.mockReset();
  mockFetchPermittedRoles.mockImplementation(actualPermittedRoles.fetchPermittedRoles);
  for (const k of Object.keys(mockReplies)) delete mockReplies[k];
  mockEmitOasisEvent.mockClear();
});

// ---------------------------------------------------------------------------
// 1. The verifier, per screen
// ---------------------------------------------------------------------------

describe('each screen mirrors its own gate', () => {
  it('the Command Hub role set is the one routes/command-hub.ts admits', () => {
    const src = readSrc('routes/command-hub.ts');
    const m = src.match(/const COMMAND_HUB_ROLES = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const admitted = (m as RegExpMatchArray)[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect([...admitted].sort()).toEqual([...PERMITTED_FOR['command-hub']].sort());
  });
});

describe.each(['command-hub', 'admin', 'backoffice'] as const)('verifyWorkSurfaceProfile — %s', (surface) => {
  const declared = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, declaredSurface: surface });

  for (const role of PERMITTED_FOR[surface]) {
    it(`kept for a caller with the permitted role ${role}, resolution "permitted"`, () => {
      const v = verifyWorkSurfaceProfile(declared, { isExafyAdmin: false, permittedRoles: ['community', role] });
      expect(v).toMatchObject({ surface, isWorkSurface: true, resolution: 'permitted' });
      expect(v.role).toBe(WORK_ROLE[surface]);
    });
  }

  for (const role of SWITCHER.filter((r) => !PERMITTED_FOR[surface].includes(r))) {
    it(`narrowed to the member surface for ${role} alone`, () => {
      const v = verifyWorkSurfaceProfile(declared, { isExafyAdmin: false, permittedRoles: ['community', role] });
      expect(v).toMatchObject({ surface: 'vitanaland', isWorkSurface: false, role: null, personaKey: null, resolution: 'narrowed' });
      expect(v.declared).toEqual(declared.declared);
    });
  }

  it('fails closed when the permitted set is unreadable (null)', () => {
    const v = verifyWorkSurfaceProfile(declared, { isExafyAdmin: false, permittedRoles: null });
    expect(v).toMatchObject({ surface: 'vitanaland', isWorkSurface: false, resolution: 'narrowed' });
  });

  it('an empty permitted set is refused', () => {
    const v = verifyWorkSurfaceProfile(declared, { isExafyAdmin: false, permittedRoles: [] });
    expect(v).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
  });

  it('the exafy_admin claim is not a role: permitted ["exafy_admin"] is refused for a non-exafy caller', () => {
    const v = verifyWorkSurfaceProfile(declared, { isExafyAdmin: false, permittedRoles: ['exafy_admin'] });
    expect(v).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
  });

  it('exafy_admin keeps the resolver value, whatever the permitted set says', () => {
    const exafy = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: true, declaredSurface: surface });
    expect(verifyWorkSurfaceProfile(exafy, { isExafyAdmin: true, permittedRoles: null })).toEqual(exafy);
    expect(verifyWorkSurfaceProfile(exafy, { isExafyAdmin: true, permittedRoles: [] })).toEqual(exafy);
    expect(verifyWorkSurfaceProfile(exafy, { isExafyAdmin: true, permittedRoles: null }).resolution).toBe('declared');
  });

  it('a route-derived surface (no declaration) is verified the same way', () => {
    const route = resolveAssistantProfile({
      isAnonymous: false,
      isExafyAdmin: false,
      currentRoute: surface === 'command-hub' ? '/command-hub/tasks' : surface === 'admin' ? '/admin/users' : '/backoffice/orders',
    });
    expect(route.surface).toBe(surface);
    const permitted = verifyWorkSurfaceProfile(route, { isExafyAdmin: false, permittedRoles: [PERMITTED_FOR[surface][0]] });
    expect(permitted.resolution).toBe('permitted');
    const refused = verifyWorkSurfaceProfile(route, { isExafyAdmin: false, permittedRoles: ['community'] });
    expect(refused).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
  });
});

describe('verifyWorkSurfaceProfile — commerce, member and anonymous are unchanged', () => {
  it('commerce keeps its surface and role for every permitted input, including unreadable', () => {
    const commerce = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, declaredSurface: 'commerce' });
    expect(commerce).toMatchObject({ surface: 'commerce', role: 'commerce', isWorkSurface: true, resolution: 'declared' });
    for (const permittedRoles of [null, [], ['community'], ['community', 'admin']]) {
      expect(verifyWorkSurfaceProfile(commerce, { isExafyAdmin: false, permittedRoles })).toEqual(commerce);
    }
  });

  it('the member surface and an anonymous session pass through untouched', () => {
    const member = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, declaredSurface: 'vitanaland', declaredViewRole: 'community' });
    const anon = resolveAssistantProfile({ isAnonymous: true, isExafyAdmin: false, declaredSurface: 'command-hub' });
    expect(verifyWorkSurfaceProfile(member, { isExafyAdmin: false, permittedRoles: null })).toEqual(member);
    expect(verifyWorkSurfaceProfile(anon, { isExafyAdmin: false, permittedRoles: null })).toEqual(anon);
    expect(anon.resolution).toBe('anonymous');
  });

  it('needsWorkSurfacePermit: only a signed-in, non-exafy caller on a work surface other than commerce', () => {
    const hub = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, declaredSurface: 'command-hub' });
    const commerce = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, declaredSurface: 'commerce' });
    const member = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, declaredSurface: 'vitanaland' });
    expect(needsWorkSurfacePermit(hub, { isAnonymous: false, isExafyAdmin: false })).toBe(true);
    expect(needsWorkSurfacePermit(hub, { isAnonymous: false, isExafyAdmin: true })).toBe(false);
    expect(needsWorkSurfacePermit(hub, { isAnonymous: true, isExafyAdmin: false })).toBe(false);
    expect(needsWorkSurfacePermit(commerce, { isAnonymous: false, isExafyAdmin: false })).toBe(false);
    expect(needsWorkSurfacePermit(member, { isAnonymous: false, isExafyAdmin: false })).toBe(false);
  });

  it('a narrowed profile is served the member role from the stored role, never the work role', () => {
    const refused = verifyWorkSurfaceProfile(
      resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, declaredSurface: 'command-hub' }),
      { isExafyAdmin: false, permittedRoles: ['community'] },
    );
    expect(clampRoleToProfile(refused, 'developer')).toBe('community');
    expect(clampRoleToProfile(refused, 'patient')).toBe('patient');
    expect(clampRoleToProfile(refused, null)).toBe('community');
  });
});

// ---------------------------------------------------------------------------
// 2. The session start (handleLiveSessionStart)
// ---------------------------------------------------------------------------

const USER = 'user-vtid-05453';
const TENANT = 'tenant-vtid-05453';
const MEMBER = { user_id: USER, tenant_id: TENANT, email: 'member@example.com', exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null, vitana_id: null };
const EXAFY = { ...MEMBER, exafy_admin: true, vitana_id: '@exafy' };

function makeDeps(): LiveSessionControllerDeps {
  return {
    resolveOrbIdentity: jest.fn(async (req: any) => (req.identity ? { ...req.identity } : null)) as any,
    clearResponseWatchdog: () => undefined,
    sendEndOfTurn: () => true,
    validateOrigin: () => true,
    buildClientContext: jest.fn(async () => ({
      city: 'Cologne', country: 'DE', timezone: 'Europe/Berlin', localTime: 'Friday afternoon, 15:00',
      timeOfDay: 'afternoon', device: 'Desktop', isMobile: false, lang: 'en',
    })) as any,
    normalizeLang: (l: string) => (l || 'en').slice(0, 2).toLowerCase(),
    getVoiceForLang: (l: string) => `voice-${l}`,
    getStoredLanguagePreference: jest.fn(async () => 'en') as any,
    persistLanguagePreference: jest.fn(() => undefined) as any,
    fetchLastSessionInfo: jest.fn(async () => null) as any,
    fetchOnboardingCohortBlock: jest.fn(async () => '') as any,
    buildBootstrapContextPack: jest.fn(async () => ({
      contextInstruction: 'BASE CONTEXT', contextPack: undefined, latencyMs: 1, skippedReason: undefined,
    })) as any,
    resolveEffectiveRole: jest.fn(async () => 'community') as any,
    terminateExistingSessionsForUser: () => 0,
    emitLiveSessionEvent: jest.fn(async () => undefined) as any,
    describeTimeSince: () => ({ bucket: 'first_time', wasFailure: false }),
    sendAudioToLiveAPI: () => true,
    startResponseWatchdog: () => undefined,
    emitDiag: () => undefined,
    getGoogleAuthReady: () => true,
  } as LiveSessionControllerDeps;
}

function makeReq(identity: unknown, body: Record<string, unknown>) {
  return {
    identity,
    headers: { 'user-agent': 'jest-agent', origin: 'https://test.example' },
    body,
    query: {},
    get: () => undefined,
  } as any;
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const flush = () => new Promise((r) => setImmediate(r));

async function startSession(identity: unknown, body: Record<string, unknown>) {
  __resetLiveSessionControllerForTests();
  configureLiveSessionController(makeDeps());
  const res = makeRes();
  await handleLiveSessionStart(makeReq(identity, body), res);
  const payload = res.json.mock.calls[0][0];
  const session: any = liveSessions.get(payload.session_id);
  if (session?.contextReadyPromise) await session.contextReadyPromise;
  if (session?.greetingFactsReady) await session.greetingFactsReady;
  for (let i = 0; i < 5; i++) await flush();
  return { payload, session };
}

function profileEvents(): any[] {
  return mockEmitOasisEvent.mock.calls.map((c) => c[0]).filter((e: any) => e?.type === 'orb.session.profile.resolved');
}

describe('session start — a declared work surface is served only to a permitted caller', () => {
  it('command-hub declared by a caller without a permitted role: member surface, no admin briefing, warning event', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community'] });
    const { session } = await startSession(MEMBER, { surface: 'command-hub', view_role: 'developer' });
    expect(session.assistantProfile).toMatchObject({ surface: 'vitanaland', isWorkSurface: false, resolution: 'narrowed' });
    expect(session.active_role).toBe('community');
    expect(session.contextBuilder).not.toBe('work_surface');
    expect(session.contextInstruction).not.toContain(WORK_SURFACE_CONTEXT_MARKER);
    expect(session.contextInstruction).not.toContain(mockAdminBriefingText);
    expect(session.contextExtras?.adminBriefing ?? null).toBeNull();
    expect(mockFetchPermittedRoles).toHaveBeenCalledWith(expect.anything(), USER, TENANT);
    const [ev] = profileEvents();
    expect(ev).toMatchObject({ status: 'warning', payload: expect.objectContaining({ surface: 'vitanaland', resolution: 'narrowed', declared_surface: 'command-hub' }) });
  });

  it('admin declared by a caller without a permitted role: member surface, no admin briefing', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community', 'staff'] });
    const { session } = await startSession(MEMBER, { surface: 'admin', view_role: 'admin' });
    expect(session.assistantProfile).toMatchObject({ surface: 'vitanaland', isWorkSurface: false, resolution: 'narrowed' });
    expect(session.active_role).toBe('community');
    expect(session.contextInstruction).not.toContain(mockAdminBriefingText);
    expect(session.contextExtras?.adminBriefing ?? null).toBeNull();
    expect(profileEvents()[0]).toMatchObject({ status: 'warning' });
  });

  it('a permitted caller keeps the work surface, resolution "permitted", with the admin context', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community', 'backoffice'] });
    const { session } = await startSession(MEMBER, { surface: 'backoffice', view_role: 'backoffice' });
    expect(session.assistantProfile).toMatchObject({ surface: 'backoffice', isWorkSurface: true, resolution: 'permitted' });
    expect(session.active_role).toBe('backoffice');
    expect(session.contextInstruction).toContain(WORK_SURFACE_CONTEXT_MARKER);
    expect(session.contextInstruction).toContain(mockAdminBriefingText);
    expect(profileEvents()[0]).toMatchObject({ status: 'info' });
  });

  it('an unreadable permitted set (roles null) is served the member surface', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: null, error: 'permitted_roles_read_failed' });
    const { session, payload } = await startSession(MEMBER, { surface: 'command-hub', view_role: 'developer' });
    expect(payload.session_id).toBeTruthy();
    expect(session.assistantProfile).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
    expect(session.active_role).toBe('community');
  });

  it('a permitted-roles read that rejects is served the member surface and the session still starts', async () => {
    mockFetchPermittedRoles.mockRejectedValue(new Error('database unreachable'));
    const { session, payload } = await startSession(MEMBER, { surface: 'admin', view_role: 'admin' });
    expect(payload.session_id).toBeTruthy();
    expect(session.assistantProfile).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
  });

  it('exafy_admin keeps the declared surface and never reads the permitted set', async () => {
    const { session } = await startSession(EXAFY, { surface: 'command-hub', view_role: 'developer' });
    expect(session.assistantProfile).toMatchObject({ surface: 'command-hub', role: 'developer', isWorkSurface: true, resolution: 'declared' });
    expect(mockFetchPermittedRoles).not.toHaveBeenCalled();
  });

  it('an anonymous session is unchanged and reads nothing', async () => {
    const { session } = await startSession(undefined, { surface: 'command-hub', view_role: 'developer' });
    expect(session.assistantProfile).toMatchObject({ surface: 'vitanaland', resolution: 'anonymous' });
    expect(mockFetchPermittedRoles).not.toHaveBeenCalled();
  });

  it('commerce is unchanged: served without a permitted-roles read', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: [] });
    const { session } = await startSession(MEMBER, { surface: 'commerce' });
    expect(session.assistantProfile).toMatchObject({ surface: 'commerce', role: 'commerce', isWorkSurface: true, resolution: 'declared' });
    expect(session.active_role).toBe('commerce');
    expect(mockFetchPermittedRoles).not.toHaveBeenCalled();
  });

  it('a refused caller on a Command Hub route is not lifted to the developer brain by the route', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community'] });
    const { session } = await startSession(MEMBER, { current_route: '/command-hub/tasks' });
    expect(session.assistantProfile).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
    expect(session.contextBrainRole).toBe('community');
    expect(session.active_role).toBe('community');
  });

  it('a refused caller cannot bind an operator thread; a permitted developer still can', async () => {
    const thread = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community'] });
    const refused = await startSession(MEMBER, { current_route: '/command-hub/tasks', operator_thread_id: thread });
    expect(refused.session.operator_thread_id).toBeUndefined();
    const legit = await startSession(EXAFY, { current_route: '/command-hub/tasks', operator_thread_id: thread });
    expect(legit.session.operator_thread_id).toBe(thread);
  });

  it('a refused caller whose stored role is developer is served the member role, not the work role', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community'] });
    const deps = makeDeps();
    (deps as any).resolveEffectiveRole = jest.fn(async () => 'developer');
    __resetLiveSessionControllerForTests();
    configureLiveSessionController(deps);
    const res = makeRes();
    await handleLiveSessionStart(makeReq(MEMBER, { surface: 'command-hub', view_role: 'developer' }), res);
    const session: any = liveSessions.get(res.json.mock.calls[0][0].session_id);
    for (let i = 0; i < 5; i++) await flush();
    expect(session.active_role).toBe('community');
  });
});

// ---------------------------------------------------------------------------
// 3. The LiveKit token mint
// ---------------------------------------------------------------------------

describe('LiveKit mint — resolveLiveKitServedProfile', () => {
  const base = { isAnonymous: false, isExafyAdmin: false, storedRole: null as string | null, userId: USER, tenantId: TENANT };

  it('a declared admin surface without a permitted role is served the member surface', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community'] });
    const r = await resolveLiveKitServedProfile({ ...base, body: { surface: 'admin', view_role: 'admin' } });
    expect(r.profile).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
    expect(r.role).toBe('community');
  });

  it('a permitted caller keeps the admin surface with role admin', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: ['community', 'admin'] });
    const r = await resolveLiveKitServedProfile({ ...base, body: { surface: 'admin', view_role: 'admin' } });
    expect(r.profile).toMatchObject({ surface: 'admin', resolution: 'permitted' });
    expect(r.role).toBe('admin');
  });

  it('an unreadable permitted set fails closed to the member surface', async () => {
    mockFetchPermittedRoles.mockResolvedValue({ roles: null, error: 'permitted_roles_read_failed' });
    const r = await resolveLiveKitServedProfile({ ...base, body: { surface: 'command-hub' } });
    expect(r.profile).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
  });

  it('a rejected read fails closed to the member surface', async () => {
    mockFetchPermittedRoles.mockRejectedValue(new Error('boom'));
    const r = await resolveLiveKitServedProfile({ ...base, body: { surface: 'backoffice' } });
    expect(r.profile).toMatchObject({ surface: 'vitanaland', resolution: 'narrowed' });
  });

  it('exafy_admin, anonymous and commerce never read the permitted set', async () => {
    await resolveLiveKitServedProfile({ ...base, isExafyAdmin: true, body: { surface: 'admin' } });
    await resolveLiveKitServedProfile({ ...base, isAnonymous: true, userId: null, tenantId: null, body: { surface: 'admin' } });
    const commerce = await resolveLiveKitServedProfile({ ...base, body: { surface: 'commerce' } });
    expect(mockFetchPermittedRoles).not.toHaveBeenCalled();
    expect(commerce).toMatchObject({ role: 'commerce' });
    expect(commerce.profile).toMatchObject({ surface: 'commerce', resolution: 'declared' });
  });
});

const JWT_SECRET = 'test-vtid-05453-jwt-secret';
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
process.env.SUPABASE_URL = 'http://localhost:54321';

// Loaded after the environment is set: the auth middleware reads the JWT secret when the router loads.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orbLiveKit = require('../src/routes/orb-livekit') as typeof import('../src/routes/orb-livekit');
const { resolveLiveKitServedProfile } = orbLiveKit;

async function signToken(opts: { sub: string; exafyAdmin?: boolean }): Promise<string> {
  const key = new TextEncoder().encode(JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    email: 'caller@example.com',
    app_metadata: { active_tenant_id: TENANT, exafy_admin: opts.exafyAdmin === true },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

const livekitRouter = orbLiveKit.default;
const mintApp = express();
mintApp.use(express.json());
mintApp.use('/api/v1', livekitRouter);

describe('LiveKit mint — POST /orb/livekit/token', () => {
  beforeEach(() => {
    mockAccessTokenCtor.mockClear();
    process.env.VOICE_ACTIVE_PROVIDER = 'livekit';
    process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
    process.env.LIVEKIT_API_KEY = 'test-api-key';
    process.env.LIVEKIT_API_SECRET = 'test-api-secret';
  });

  const metadata = () => JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);

  it('a non-exafy caller without a permitted admin role is minted a member session', async () => {
    mockReplies.user_permitted_roles = { data: [], error: null };
    const token = await signToken({ sub: USER });
    const res = await request(mintApp).post('/api/v1/orb/livekit/token').set('Authorization', `Bearer ${token}`).send({ surface: 'admin', view_role: 'admin' });
    expect(res.status).toBe(200);
    expect(metadata()).toMatchObject({ surface: 'vitanaland', role: 'community' });
  });

  it('a non-exafy caller with a permitted admin role is minted the admin session', async () => {
    mockReplies.user_permitted_roles = { data: [{ role: 'admin' }], error: null };
    const token = await signToken({ sub: USER });
    const res = await request(mintApp).post('/api/v1/orb/livekit/token').set('Authorization', `Bearer ${token}`).send({ surface: 'admin', view_role: 'admin' });
    expect(res.status).toBe(200);
    expect(metadata()).toMatchObject({ surface: 'admin', role: 'admin' });
  });

  it('an unreadable permitted set mints the member session', async () => {
    mockReplies.user_permitted_roles = { data: null, error: { message: 'permission denied' } };
    const token = await signToken({ sub: USER });
    const res = await request(mintApp).post('/api/v1/orb/livekit/token').set('Authorization', `Bearer ${token}`).send({ surface: 'command-hub' });
    expect(res.status).toBe(200);
    expect(metadata()).toMatchObject({ surface: 'vitanaland', role: 'community' });
  });

  it('exafy_admin keeps the declared admin surface', async () => {
    const token = await signToken({ sub: USER, exafyAdmin: true });
    const res = await request(mintApp).post('/api/v1/orb/livekit/token').set('Authorization', `Bearer ${token}`).send({ surface: 'admin', view_role: 'admin' });
    expect(res.status).toBe(200);
    expect(metadata()).toMatchObject({ surface: 'admin', role: 'admin' });
  });

  it('commerce is minted as before', async () => {
    const token = await signToken({ sub: USER });
    const res = await request(mintApp).post('/api/v1/orb/livekit/token').set('Authorization', `Bearer ${token}`).send({ surface: 'commerce' });
    expect(res.status).toBe(200);
    expect(metadata()).toMatchObject({ surface: 'commerce', role: 'commerce' });
  });
});

// ---------------------------------------------------------------------------
// 4. The text path
// ---------------------------------------------------------------------------

describe('text path — servedTurnRole', () => {
  it('user and community pass through as before', () => {
    expect(servedTurnRole('user', { isExafyAdmin: false, effectiveRole: null })).toBe('user');
    expect(servedTurnRole('community', { isExafyAdmin: false, effectiveRole: 'patient' })).toBe('community');
  });

  it('a privileged body role the caller does not hold is served as user', () => {
    expect(servedTurnRole('developer', { isExafyAdmin: false, effectiveRole: 'community' })).toBe('user');
    expect(servedTurnRole('admin', { isExafyAdmin: false, effectiveRole: null })).toBe('user');
    expect(servedTurnRole('backoffice', { isExafyAdmin: false, effectiveRole: 'developer' })).toBe('user');
  });

  it('the role the caller holds (case-insensitive) is served; exafy_admin is served as asked', () => {
    expect(servedTurnRole('developer', { isExafyAdmin: false, effectiveRole: 'developer' })).toBe('developer');
    expect(servedTurnRole('DEVELOPER', { isExafyAdmin: false, effectiveRole: 'developer' })).not.toBe('user');
    expect(servedTurnRole('developer', { isExafyAdmin: true, effectiveRole: null })).toBe('developer');
  });

  it('a denied developer role yields the user tool set, not the developer one', () => {
    const served = servedTurnRole('developer', { isExafyAdmin: false, effectiveRole: 'community' });
    expect(getGeminiToolDefinitions(served)).toEqual(getGeminiToolDefinitions('user'));
    expect(getGeminiToolDefinitions('developer').functionDeclarations.length)
      .toBeGreaterThan(getGeminiToolDefinitions('user').functionDeclarations.length);
  });
});

// ---------------------------------------------------------------------------
// 5. Source contracts for the wiring
// ---------------------------------------------------------------------------

describe('source contracts — the three routes call the verifier', () => {
  it('the session start verifies the declared profile before any consumer reads it', () => {
    const controller = readSrc('orb/live/session/live-session-controller.ts');
    expect(controller).toMatch(/fetchPermittedRoles\(/);
    expect(controller).toMatch(/verifyWorkSurfaceProfile\(/);
    expect(controller).toMatch(/\.catch\(\(\) => \(\{ roles: null \}\)\)/);
  });

  it('the LiveKit mint serves the verified profile', () => {
    const src = readSrc('routes/orb-livekit.ts');
    expect(src).toMatch(/const \{ profile: assistantProfile, role \} = await resolveLiveKitServedProfile\(/);
  });

  it('the LiveKit context bootstrap builds both instructions for the verified surface', () => {
    const src = readSrc('routes/orb-livekit.ts');
    expect(src).toMatch(/const \{ profile: servedProfile \} = await resolveLiveKitServedProfile\(/);
    expect(src.match(/servedProfile\.surface,/g)?.length).toBe(2);
  });

  it('the text turn and stream serve the clamped role and resolve the effective role', () => {
    const src = readSrc('routes/conversation.ts');
    expect(src).toMatch(/import \{ resolveEffectiveRole \} from '\.\/orb-live';/);
    expect(src).toMatch(/const role = await turnRoleServed\(/);
    expect(src).toMatch(/const servedRole = await turnRoleServed\(/);
    expect(src).toMatch(/userRole: servedRole/);
    expect(src).toMatch(/role: servedRole,/);
    expect(src).toMatch(/getGeminiToolDefinitions\(role\)/);
  });

  it('the developer_assistant gate is unchanged', () => {
    const src = readSrc('routes/conversation.ts');
    expect(src).toMatch(/if \(channel === 'developer_assistant'\) \{/);
    expect(src).toMatch(/const allowedDevRoles = \['developer', 'admin'\];/);
  });
});
