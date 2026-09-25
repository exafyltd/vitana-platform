/**
 * VTID-04560 — Vitana role separation regression suite (`npm run test:roles`).
 *
 * Owner rule (2026-09-25): the role whose screens are displayed decides which
 * Vitana assists. This suite pins it at every layer that used to decide it on
 * its own, so the developer can never again be greeted as a community member
 * on the Command Hub (production session live-848f1576, 2026-09-25 09:26 UTC:
 * "you've already completed 9 sessions today — shall I continue the guided
 * journey with the next session on the Five Pillars?").
 *
 * Layers:
 *   1. profile resolution (surface × declared view role × token), device-free;
 *   2. the greeting ladder — both ladders, context resolved or not;
 *   3. the system instruction — persona, context and rule blocks per surface;
 *   4. the text path's engineering context;
 *   5. source contracts — the controller, the envelope and both hosts' widget
 *      wiring, so a refactor cannot quietly drop the declaration.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveAssistantProfile,
  clampRoleToProfile,
  isMemberPlaneRole,
} from '../src/orb/profile/assistant-profile';
import {
  sessionServedRole,
  sessionServedSurface,
  buildWorkSurfaceContextSection,
  extractWorkSurfaceContext,
  workSurfaceGreetingFields,
  WORK_SURFACE_CONTEXT_MARKER,
} from '../src/orb/profile/session-profile';
import {
  computeGreetingDecision,
  type GreetingDecisionContext,
} from '../src/services/conversation/compute-greeting-decision';
import { buildLiveSystemInstruction } from '../src/orb/live/instruction/live-system-instruction';
import { engineeringContextAllowed } from '../src/services/gemini-operator';

/** Phrases that only belong to the member (community) Vitana. */
const COMMUNITY_PHRASES = [
  /guided journey/i,
  /sessions? (completed|today)/i,
  /five pillars/i,
  /PROACTIVE OPENER OVERRIDE/,
  /PROACTIVE LEADERSHIP — RULE 0/,
  /GUIDED JOURNEY — A COHERENT THROUGH-LINE/,
  /USER CONTEXT PROFILE/,
  /navigation guide for the Maxina community/i,
  /You ARE the instruction manual/,
];

function expectNoCommunityContent(text: string): void {
  for (const re of COMMUNITY_PHRASES) {
    expect({ phrase: String(re), found: re.test(text) }).toEqual({ phrase: String(re), found: false });
  }
}

// ---------------------------------------------------------------------------
// 1. Profile resolution
// ---------------------------------------------------------------------------

describe('resolveAssistantProfile — the screen decides, the token verifies', () => {
  const authed = { isAnonymous: false, isExafyAdmin: true };

  test.each([
    ['command-hub', '/command-hub/autopilot/live/', 'developer'],
    ['admin', '/admin/dashboard', 'admin'],
    ['backoffice', '/backoffice/dashboard', 'backoffice'],
    ['commerce', '/commerce/org', 'commerce'],
  ])('work surface %s serves role %s from the first byte', (surface, route, role) => {
    const declared = resolveAssistantProfile({ ...authed, declaredSurface: surface, currentRoute: route });
    expect(declared).toMatchObject({ surface, role, isWorkSurface: true, resolution: 'declared' });
    const fromRoute = resolveAssistantProfile({ ...authed, currentRoute: route });
    expect(fromRoute).toMatchObject({ surface, role, isWorkSurface: true, resolution: 'route' });
  });

  test('the device never changes the surface: a phone on the Command Hub is still the Command Hub', () => {
    // resolveAssistantProfile takes no device input at all — pinned here so it is never added back.
    const p = resolveAssistantProfile({ ...authed, currentRoute: '/command-hub/' });
    expect(p.surface).toBe('command-hub');
    expect(p.role).toBe('developer');
  });

  test('community screens serve the declared member role; a work role there is narrowed to community', () => {
    expect(resolveAssistantProfile({ ...authed, declaredSurface: 'vitanaland', declaredViewRole: 'community' }))
      .toMatchObject({ surface: 'vitanaland', role: 'community', isWorkSurface: false, resolution: 'declared' });
    expect(resolveAssistantProfile({ ...authed, declaredSurface: 'vitanaland', declaredViewRole: 'professional' }).role)
      .toBe('professional');
    for (const work of ['developer', 'admin', 'backoffice', 'infra']) {
      expect(resolveAssistantProfile({ ...authed, declaredSurface: 'vitanaland', declaredViewRole: work }))
        .toMatchObject({ role: 'community', resolution: 'narrowed' });
    }
  });

  test('a declared surface wins over the route (the host knows what it renders)', () => {
    const p = resolveAssistantProfile({ ...authed, declaredSurface: 'command-hub', currentRoute: '/home' });
    expect(p.surface).toBe('command-hub');
  });

  test('an unknown declared surface falls back to the route, never to a crash or undefined', () => {
    const p = resolveAssistantProfile({ ...authed, declaredSurface: 'bogus', currentRoute: '/admin/x' });
    expect(p.surface).toBe('admin');
  });

  test('Command Hub without an exafy_admin claim is unverified — still the developer persona, never community', () => {
    const p = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: false, currentRoute: '/command-hub/' });
    expect(p).toMatchObject({ surface: 'command-hub', role: 'developer', resolution: 'unverified', personaKey: 'dev_orb' });
  });

  test('anonymous sessions stay on the member surface with no role', () => {
    expect(resolveAssistantProfile({ isAnonymous: true, isExafyAdmin: false, currentRoute: '/command-hub/' }))
      .toMatchObject({ surface: 'vitanaland', role: null, resolution: 'anonymous' });
  });

  test('clampRoleToProfile: stored roles never leak across surfaces', () => {
    const hub = resolveAssistantProfile({ ...authed, currentRoute: '/command-hub/' });
    expect(clampRoleToProfile(hub, 'community')).toBe('developer');
    expect(clampRoleToProfile(hub, null)).toBe('developer');
    const member = resolveAssistantProfile({ ...authed, currentRoute: '/home' });
    expect(clampRoleToProfile(member, 'developer')).toBe('community');
    expect(clampRoleToProfile(member, 'admin')).toBe('community');
    expect(clampRoleToProfile(member, 'patient')).toBe('patient');
    expect(clampRoleToProfile(member, null)).toBe('community');
    expect(isMemberPlaneRole('staff')).toBe(true);
    expect(isMemberPlaneRole('developer')).toBe(false);
  });

  test('session helpers read the profile; sessions without one keep the legacy derivation', () => {
    const profile = resolveAssistantProfile({ ...authed, currentRoute: '/command-hub/' });
    expect(sessionServedRole({ assistantProfile: profile, active_role: null })).toBe('developer');
    expect(sessionServedSurface({ assistantProfile: profile, current_route: '/home' })).toBe('command-hub');
    expect(sessionServedRole({ active_role: 'staff' })).toBe('staff');
    expect(sessionServedSurface({ current_route: '/admin/x' })).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// 2. Greeting ladder
// ---------------------------------------------------------------------------

function greetingCtx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'en',
    greetLang: 'en',
    bucket: 'today',
    timeAgo: 'earlier today',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-09-24', // briefing due
    todayTz: '2026-09-25',
    localHour: 11,
    timezone: 'Europe/Berlin',
    timeOfDay: 'morning',
    proactiveLine: "You've already completed 9 sessions today — continue the guided journey?",
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 7,
    recentNbaKeys: [],
    currentRoute: '/command-hub/autopilot/live/',
    currentScreenTitle: null,
    menuPhrases: ['Welcome back.'],
    openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
    guidedTopicNarrationContent: null,
    wakeBriefDecisionId: 'wb-1',
    silenceOnSkipEnabled: true,
    wakeBriefHasSelectedContinuation: true,
    voiceWakeBriefReason: null,
    ...over,
  };
}

describe('greeting ladder — a work surface never reaches a member rung', () => {
  const ladders: Array<[string, Partial<GreetingDecisionContext>]> = [
    ['normal ladder (context resolved)', {}],
    ['safe-fast ladder (context NOT resolved — the 300 ms gate case)', { contextReadyResolved: false, safeFastGreetingLive: true }],
  ];

  test.each(ladders)('developer on the Command Hub opens with work_surface_open — %s', (_label, over) => {
    const d = computeGreetingDecision(greetingCtx({
      ...over,
      surface: 'command-hub',
      workSurfaceRole: 'developer',
      workSurfaceHighlights: ['2 executions awaiting approval', 'staging is 3 commits ahead of production'],
    }));
    expect(d.wakeOpener).toBe('work_surface_open');
    expect(d.directive).toContain('system supervisor');
    expect(d.directive).toContain('2 executions awaiting approval');
    expectNoCommunityContent(d.directive || '');
    expect(d.directive).not.toMatch(/9 sessions/);
  });

  test.each(['admin', 'backoffice', 'commerce'])('%s surface opens with its own role opener', (role) => {
    const d = computeGreetingDecision(greetingCtx({ surface: role, workSurfaceRole: role }));
    expect(d.wakeOpener).toBe('work_surface_open');
    expect(d.diag).toMatchObject({ surface: role, role });
    expectNoCommunityContent(d.directive || '');
  });

  test('no facts loaded → the opener offers to check, it does not invent', () => {
    const d = computeGreetingDecision(greetingCtx({ surface: 'command-hub', workSurfaceRole: 'developer' }));
    expect(d.directive).toMatch(/none loaded yet/);
  });

  test('a genuine transport reconnect stays silent on a work surface too', () => {
    const d = computeGreetingDecision(greetingCtx({
      surface: 'command-hub',
      workSurfaceRole: 'developer',
      openDecision: { mode: 'silent', source: 'native_resume', line: null },
    }));
    expect(d.wakeOpener).toBe('silent_reconnect');
    expect(d.directive).toBeNull();
  });

  test('the member surface is untouched: no surface field, or vitanaland, never takes the work rung', () => {
    expect(computeGreetingDecision(greetingCtx({ currentRoute: '/home' })).wakeOpener).not.toBe('work_surface_open');
    expect(computeGreetingDecision(greetingCtx({ surface: 'vitanaland', currentRoute: '/home' })).wakeOpener)
      .not.toBe('work_surface_open');
  });

  test('workSurfaceGreetingFields feeds the rung from the session; member sessions add nothing', () => {
    const hub = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: true, currentRoute: '/command-hub/' });
    const f = workSurfaceGreetingFields({
      assistantProfile: hub,
      workSurfaceKnowledge: { pulse: { highlights: ['CI red on main'] } },
    });
    expect(f).toEqual({ surface: 'command-hub', workSurfaceRole: 'developer', workSurfaceHighlights: ['CI red on main'] });
    const member = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: true, currentRoute: '/home' });
    expect(workSurfaceGreetingFields({ assistantProfile: member })).toEqual({});
    expect(workSurfaceGreetingFields({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. System instruction
// ---------------------------------------------------------------------------

const MEMBER_BRAIN = [
  '=== USER CONTEXT PROFILE ===',
  '[ACTIVITY_14D] 9 guided journey sessions completed today; Five Pillars next.',
  '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>',
  'Say: continue the guided journey with the Five Pillars session.',
].join('\n');

function buildFor(surface: string, role: string, bootstrap: string): string {
  return buildLiveSystemInstruction(
    'en', 'friendly', bootstrap, role, undefined, undefined, false, null,
    surface === 'command-hub' ? '/command-hub/autopilot/live/' : surface === 'vitanaland' ? '/home' : `/${surface}/x`,
    null, undefined, null, undefined, surface, true, null,
  );
}

describe('system instruction — each surface carries only its own Vitana', () => {
  const workContext = buildWorkSurfaceContextSection(
    resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: true, currentRoute: '/command-hub/' }),
    { systemSnapshot: 'SYSTEM SNAPSHOT: staging 3 commits ahead; 2 executions awaiting approval.' },
  );

  test('Command Hub: developer supervisor conduct, the work context, and no member content even when it is concatenated in', () => {
    const text = buildFor('command-hub', 'developer', MEMBER_BRAIN + workContext);
    expect(text).toContain('WORK SURFACE — DEVELOPER SUPERVISOR');
    expect(text).toContain('staging 3 commits ahead');
    expect(text).toContain('The user\'s role RIGHT NOW is: DEVELOPER');
    expectNoCommunityContent(text);
  });

  test('Command Hub with no work context carries no bootstrap at all (never the member brain)', () => {
    const text = buildFor('command-hub', 'developer', MEMBER_BRAIN);
    expectNoCommunityContent(text);
  });

  test.each(['admin', 'backoffice', 'commerce'])('%s: work conduct block, no member content', (surface) => {
    const text = buildFor(surface, surface, MEMBER_BRAIN);
    expect(text).toContain('WORK SURFACE —');
    expectNoCommunityContent(text);
  });

  test('member surface keeps the member Vitana exactly as before', () => {
    const text = buildFor('vitanaland', 'community', MEMBER_BRAIN);
    expect(text).toContain('PROACTIVE LEADERSHIP — RULE 0');
    expect(text).toContain('Five Pillars');
    expect(text).not.toContain('WORK SURFACE —');
  });

  test('every surface keeps the stop-and-farewell rule', () => {
    for (const s of ['vitanaland', 'command-hub', 'admin']) {
      expect(buildFor(s, s === 'vitanaland' ? 'community' : s === 'command-hub' ? 'developer' : 'admin', '')).toContain('ENDING THE CONVERSATION');
    }
  });

  test('extractWorkSurfaceContext keeps only the marked section', () => {
    expect(extractWorkSurfaceContext(`member stuff${workContext}`).startsWith(WORK_SURFACE_CONTEXT_MARKER)).toBe(true);
    expect(extractWorkSurfaceContext('member stuff only')).toBe('');
    expect(buildWorkSurfaceContextSection(
      resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: true, currentRoute: '/home' }),
      { systemSnapshot: 'x' },
    )).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 4. Text path engineering context
// ---------------------------------------------------------------------------

describe('text path — engineering context only for the console and developer/admin callers', () => {
  test('the Operator Console itself (no custom instruction) keeps it', () => {
    expect(engineeringContextAllowed(undefined, undefined)).toBe(true);
  });
  test.each(['developer', 'admin', 'infra', 'exafy_admin'])('%s caller with a custom instruction keeps it', (role) => {
    expect(engineeringContextAllowed('custom', role)).toBe(true);
  });
  test.each(['community', 'patient', 'professional', 'staff', undefined])('member caller %s never receives it', (role) => {
    expect(engineeringContextAllowed('member ORB instruction', role as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Source contracts
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('source contracts — the wiring cannot silently disappear', () => {
  const controller = read('src/orb/live/session/live-session-controller.ts');
  const orbLive = read('src/routes/orb-live.ts');
  const widget = read('src/frontend/command-hub/orb-widget.js');
  const app = read('src/frontend/command-hub/app.js');

  test('the controller resolves the profile from the declared surface/view_role and stores it on the session', () => {
    expect(controller).toMatch(/resolveAssistantProfile\(\{\s*declaredSurface: \(body as any\)\.surface,\s*declaredViewRole: \(body as any\)\.view_role/);
    expect(controller).toMatch(/const session: GeminiLiveSession = \{\s*sessionId,\s*assistantProfile,/);
    expect(controller).toContain("type: 'orb.session.profile.resolved'");
  });

  test('work surfaces skip the member brain and the member wake-brief', () => {
    expect(controller).toContain('} else if (bootstrapIdentity && assistantProfile.isWorkSurface) {');
    expect(controller).toMatch(/if \(assistantProfile\.isWorkSurface\) \{[\s\S]{0,900}wake-brief skipped on work surface/);
  });

  test('the old route override and phone-means-community rule are gone', () => {
    expect(controller).not.toContain('Overriding role to "developer" for Command Hub session');
    expect(controller).not.toContain('Forcing role to "community" for mobile session');
  });

  test('the setup envelope reads role, surface and tools from the profile', () => {
    expect(orbLive).toContain('sessionServedRole(session),\n                        session.conversationSummary,');
    expect(orbLive).toContain('sessionServedSurface(session),');
    expect(orbLive).toMatch(/tools: buildLiveApiTools\([\s\S]{0,700}sessionServedRole\(session\)[\s\S]{0,200}sessionServedSurface\(session\)/);
    expect(orbLive).not.toContain('undefined, // surface — unchanged (route-based heuristic)');
  });

  test('every greeting context carries the work-surface fields', () => {
    expect((orbLive.match(/\.\.\.workSurfaceGreetingFields\(session as any\)/g) || []).length).toBe(3);
  });

  test('the widget declares surface + view_role and restarts on a role switch', () => {
    expect(widget).toContain('if (_s.surface) startPayload.surface = _s.surface;');
    expect(widget).toContain('if (_s.viewRole) startPayload.view_role = _s.viewRole;');
    expect(widget).toContain('setViewRole: function (role, surface)');
  });

  test('the Command Hub declares the developer surface', () => {
    expect(app).toMatch(/surface: 'command-hub',\s*view_role: 'developer',/);
  });
});

// ---------------------------------------------------------------------------
// 6. Phase 1 (VTID-04561) — one role truth, the registry, env-aware switching
// ---------------------------------------------------------------------------

import { ROLE_REGISTRY, roleEntry, roleGetsPrivilegedVoiceTools, registryCoversAllRoles } from '../src/orb/profile/role-registry';

describe('VTID-04561 role registry — one declarative answer per role', () => {
  test('every Vitana role has an entry', () => {
    expect(registryCoversAllRoles()).toEqual([]);
  });

  test('member-plane roles are served on the member surface by the member ladder; work roles on their surface', () => {
    for (const r of ['community', 'patient', 'professional', 'staff']) {
      expect(ROLE_REGISTRY[r]).toMatchObject({ surface: 'vitanaland', opener: 'member_ladder', memoryScope: 'member' });
    }
    expect(roleEntry('developer')).toMatchObject({ surface: 'command-hub', personaKey: 'dev_orb', opener: 'work_surface', memoryScope: 'developer' });
    expect(roleEntry('admin')).toMatchObject({ surface: 'admin', personaKey: 'admin_orb', opener: 'work_surface' });
    expect(roleEntry('backoffice')).toMatchObject({ surface: 'backoffice', personaKey: 'backoffice_orb' });
    expect(roleEntry('exafy_admin').role).toBe('developer');
    expect(roleEntry('nonsense').role).toBe('community');
  });

  test('privileged voice tools follow the registry, never a member role', () => {
    for (const r of ['developer', 'admin', 'exafy_admin', 'infra']) expect(roleGetsPrivilegedVoiceTools(r)).toBe(true);
    for (const r of ['community', 'patient', 'professional', 'staff', 'backoffice', null, undefined, 'authenticated']) {
      expect(roleGetsPrivilegedVoiceTools(r as any)).toBe(false);
    }
  });

  test('the profile persona comes from the registry', () => {
    const hub = resolveAssistantProfile({ isAnonymous: false, isExafyAdmin: true, currentRoute: '/command-hub/' });
    expect(hub.personaKey).toBe(roleEntry('developer').personaKey);
  });

  test('the tool catalog has no hard-coded privileged-role list left', () => {
    const catalog = read('src/orb/live/tools/live-tool-catalog.ts');
    expect(catalog).not.toContain("['admin', 'exafy_admin', 'developer'].includes(activeRole)");
    expect((catalog.match(/roleGetsPrivilegedVoiceTools\(activeRole\)/g) || []).length).toBe(3);
  });
});

describe('VTID-04561 one role truth — both switchers write both tables', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, '..', '..', 'supabase', 'migrations', '20260925120000_vtid_04561_one_role_truth.sql'),
    'utf8',
  );

  test('set_role_preference (community app) also writes user_active_roles', () => {
    const fn = migration.slice(migration.indexOf('FUNCTION public.set_role_preference'), migration.indexOf('FUNCTION public.me_set_active_role'));
    expect(fn).toContain('INSERT INTO public.role_preferences');
    expect(fn).toContain('INSERT INTO public.user_active_roles');
  });

  test('me_set_active_role (Command Hub) also writes role_preferences', () => {
    const fn = migration.slice(migration.indexOf('FUNCTION public.me_set_active_role'));
    expect(fn).toContain('INSERT INTO public.user_active_roles');
    expect(fn).toContain('INSERT INTO public.role_preferences');
  });

  test('the Command Hub switches into the community app of its own environment', () => {
    const app = read('src/frontend/command-hub/app.js');
    expect(app).not.toContain("'community': 'https://vitanaland.com/comm/events-meetups?tab=hot'");
    const fnSrc = app.slice(app.indexOf('function communityAppOriginForHost'), app.indexOf('var COMMUNITY_APP_ORIGIN'));
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${fnSrc}; return communityAppOriginForHost;`)();
    expect(fn('preview-aws-gateway.vitanaland.com')).toBe('https://preview-aws.vitanaland.com');
    expect(fn('gateway.vitanaland.com')).toBe('https://vitanaland.com');
    expect(app).toContain("'backoffice': COMMUNITY_APP_ORIGIN + '/backoffice/dashboard'");
  });
});
