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

// ---------------------------------------------------------------------------
// VTID-04562 — the developer Vitana's knowledge: atlas, snapshot, loader, tools
// ---------------------------------------------------------------------------

import { DOMAIN_ATLAS, domainsForRoute, findDomain, renderAtlasIndex } from '../src/orb/developer/domain-atlas';
import {
  assembleSnapshot, buildSystemSnapshot, getSystemSnapshot, resetSystemSnapshotCache,
  type SnapshotAutopilot, type SystemSnapshotDeps,
} from '../src/orb/developer/system-snapshot';
import { loadDeveloperKnowledge, renderRecentDevMemory } from '../src/orb/developer/developer-knowledge';
import { buildWorkSurfaceKnowledge } from '../src/orb/profile/work-surface-context';
import { dev_domain_atlas, dev_system_status, DEVELOPER_KNOWLEDGE_TOOL_DECLARATIONS } from '../src/services/orb-tools/developer-knowledge-tools';
import { DEVELOPER_DOMAIN_TOOL_DECLARATIONS, ORB_TOOL_REGISTRY } from '../src/services/orb-tools-shared';
import { WORK_SURFACE_CONDUCT_BLOCK } from '../src/orb/live/instruction/live-system-instruction';

function listRouteFiles(): string[] {
  const root = path.join(ROOT, 'src', 'routes');
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const r = rel ? `${rel}/${f}` : f;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

const CLEAN_AUTOPILOT: SnapshotAutopilot = {
  kill_switch: false, provider_outage: 'clear', awaiting_approval: 0, active: 1,
  success_rate_7d: 80, failed_7d: 1, total_7d: 5, open_findings: 3, top_failure: null, alerts: [],
};

describe('VTID-04562 domain atlas — a map that cannot silently fall behind the code', () => {
  test('every gateway route file is claimed by at least one domain (drift guard)', () => {
    const files = listRouteFiles();
    expect(files.length).toBeGreaterThan(100);
    const unclaimed = files.filter((f) => domainsForRoute(f).length === 0);
    expect(unclaimed).toEqual([]);
  });

  test('keys are unique and every domain names code, tables and docs or flags', () => {
    const keys = DOMAIN_ATLAS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of DOMAIN_ATLAS) {
      expect(d.code.length).toBeGreaterThan(0);
      expect(d.tables.length).toBeGreaterThan(0);
    }
  });

  test('the developer\'s words find the right domain', () => {
    expect(findDomain('how does the knowledge graph get written')?.key).toBe('memory');
    expect(findDomain('nova sonic keeps dropping')?.key).toBe('voice');
    expect(findDomain('why did the executor fail')?.key).toBe('autopilot');
    expect(findDomain('autopilot')?.key).toBe('autopilot');
    expect(findDomain('bedrock fallback')?.key).toBe('llm');
    expect(findDomain('zzzz')).toBeNull();
  });

  test('the prompt index is one line per domain and names the lookup tool', () => {
    const idx = renderAtlasIndex();
    expect(idx).toContain('dev_domain_atlas');
    expect(idx.split('\n').length).toBe(DOMAIN_ATLAS.length + 1);
    expect(idx.length).toBeLessThan(6000);
  });
});

describe('VTID-04562 live system snapshot — facts with a timestamp, never a throw', () => {
  const now = Date.parse('2026-09-25T10:00:00Z');

  test('critical facts lead the highlights (kill switch, provider outage, error spike)', () => {
    const s = assembleSnapshot({
      nowMs: now,
      autopilot: { ok: true, value: { ...CLEAN_AUTOPILOT, kill_switch: true, provider_outage: 'outage', awaiting_approval: 2 } },
      builds: { ok: true, value: [{ label: 'staging', ok: true, env: 'staging', git_commit: 'aaaaaaa1' }, { label: 'production', ok: true, env: 'production', git_commit: 'bbbbbbb2' }] },
      events: { ok: true, value: Array.from({ length: 12 }, () => ({ topic: 'orb.live.diag', status: 'error', message: 'nova_validation', created_at: '2026-09-25T09:50:00Z' })) },
    });
    expect(s.asOf).toBe('2026-09-25T10:00:00.000Z');
    expect(s.highlights[0]).toMatch(/kill switch/);
    expect(s.highlights[1]).toMatch(/LLM providers/);
    expect(s.highlights[2]).toMatch(/orb\.live\.diag errored 12 times/);
    expect(s.text).toContain('staging serves aaaaaaa');
    expect(s.text).toContain('2 waiting for approval');
    expect(s.text).toMatch(/taken 2026-09-25T10:00:00.000Z/);
  });

  test('a clean system says so instead of inventing a problem', () => {
    const s = assembleSnapshot({
      nowMs: now,
      autopilot: { ok: true, value: CLEAN_AUTOPILOT },
      builds: { ok: true, value: [] },
      events: { ok: true, value: [{ topic: 'vtid.live.session.start', status: 'info', created_at: '2026-09-25T09:59:00Z' }] },
    });
    expect(s.highlights).toEqual(['nothing is on fire: no autopilot alerts and no error spike in the last hour']);
    expect(s.text).toContain('1 voice session(s) started');
  });

  test('a failed source renders as unavailable, the rest still renders', async () => {
    const deps: SystemSnapshotDeps = {
      now: () => now,
      loadAutopilot: async () => { throw new Error('Supabase not configured'); },
      loadBuildInfo: async () => [{ label: 'staging', ok: false, error: 'HTTP 503' }],
      loadRecentEvents: async () => [],
    };
    const s = await buildSystemSnapshot(deps);
    expect(s.text).toContain('Dev Autopilot: (unavailable: Supabase not configured)');
    expect(s.text).toContain('Build staging: unreachable (HTTP 503)');
    expect(s.highlights).toContain('staging build-info is unreachable');
  });

  test('snapshots are cached and concurrent builds coalesce into one', async () => {
    resetSystemSnapshotCache();
    let calls = 0;
    const deps: SystemSnapshotDeps = {
      now: () => now,
      loadAutopilot: async () => { calls++; return CLEAN_AUTOPILOT; },
      loadBuildInfo: async () => [],
      loadRecentEvents: async () => [],
    };
    const [a, b] = await Promise.all([getSystemSnapshot(deps), getSystemSnapshot(deps)]);
    const c = await getSystemSnapshot(deps);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(calls).toBe(1);
    resetSystemSnapshotCache();
  });
});

describe('VTID-04562 developer knowledge loader — fails open, never member memory', () => {
  const snap = { asOf: '2026-09-25T10:00:00.000Z', text: 'LIVE SYSTEM SNAPSHOT ...', highlights: ['2 executions waiting for approval'] };

  test('snapshot, atlas and engineering memory all reach the session', async () => {
    const k = await loadDeveloperKnowledge({
      snapshot: async () => snap,
      recentMemory: async () => [{ category: 'incident', vtid: 'VTID-04221', title: 'Deploys reverted', content: 'topic mismatch', created_at: '2026-09-24T10:00:00Z' }],
    });
    expect(k.systemSnapshot).toBe(snap.text);
    expect(k.domainAtlas).toContain('DOMAIN ATLAS');
    expect(k.devMemory).toContain('dev_agent_memory');
    expect(k.devMemory).toContain('VTID-04221');
    expect(k.pulse).toEqual({ highlights: snap.highlights, asOf: snap.asOf });
  });

  test('failing sources degrade to null, the atlas stays', async () => {
    const k = await loadDeveloperKnowledge({
      snapshot: async () => { throw new Error('down'); },
      recentMemory: async () => { throw new Error('down'); },
    });
    expect(k.systemSnapshot).toBeNull();
    expect(k.pulse).toBeNull();
    expect(k.devMemory).toBeNull();
    expect(k.domainAtlas).toContain('DOMAIN ATLAS');
    expect(renderRecentDevMemory([])).toBeNull();
  });

  test('the Command Hub loader is registered and the member surface gets nothing', async () => {
    const dev = resolveAssistantProfile({ declaredSurface: 'command-hub', declaredViewRole: 'developer', isAnonymous: false, isExafyAdmin: true });
    const member = resolveAssistantProfile({ declaredSurface: 'vitanaland', declaredViewRole: 'community', isAnonymous: false, isExafyAdmin: true });
    const k = await buildWorkSurfaceKnowledge(dev, { userId: 'u1', tenantId: null });
    expect(k.domainAtlas).toContain('DOMAIN ATLAS');
    expect(await buildWorkSurfaceKnowledge(member, { userId: 'u1', tenantId: null })).toEqual({ systemSnapshot: null, domainAtlas: null, devMemory: null, pulse: null });
  });

  test('the developer loader reads dev_agent_memory, never the member memory tables', () => {
    const src = read('src/orb/developer/developer-knowledge.ts');
    expect(src).toContain('/rest/v1/dev_agent_memory');
    expect(src).not.toMatch(/memory_items|memory_facts|user_session_summaries/);
  });
});

describe('VTID-04562 developer knowledge tools', () => {
  const dev = { user_id: 'u1', role: 'developer', tenant_id: null } as never;
  const member = { user_id: 'u1', role: 'community', tenant_id: null } as never;

  test('both tools are declared for developers and registered with a handler', () => {
    const names = DEVELOPER_DOMAIN_TOOL_DECLARATIONS.map((d) => d.name);
    for (const t of DEVELOPER_KNOWLEDGE_TOOL_DECLARATIONS) {
      expect(names).toContain(t.name);
      expect(typeof ORB_TOOL_REGISTRY[t.name as string]).toBe('function');
    }
    const manifest = JSON.parse(read('src/services/tool-manifest.json')) as { tools: Array<{ name: string }> };
    expect(manifest.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['dev_system_status', 'dev_domain_atlas']));
  });

  test('a community caller is refused', async () => {
    expect((await dev_domain_atlas({ domain: 'voice' }, member, {} as never)).ok).toBe(false);
    expect((await dev_system_status({}, member, {} as never)).ok).toBe(false);
  });

  test('dev_domain_atlas answers a topic with code, tables and docs', async () => {
    const r = await dev_domain_atlas({ domain: 'knowledge graph' }, dev, {} as never);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('memory_facts');
    const idx = await dev_domain_atlas({}, dev, {} as never);
    expect(idx.text).toContain('DOMAIN ATLAS');
  });

  test('the developer conduct block names both tools', () => {
    const block = WORK_SURFACE_CONDUCT_BLOCK('command-hub');
    expect(block).toContain('dev_system_status');
    expect(block).toContain('dev_domain_atlas');
    expect(WORK_SURFACE_CONDUCT_BLOCK('admin')).not.toContain('dev_system_status');
  });
});

describe('VTID-04562 text path — the tool-result turn is gated like the main turn', () => {
  test('sendToolResultsToVertex only loads the pack for engineering callers', () => {
    const src = read('src/services/gemini-operator.ts');
    expect(src).toContain("const toolResultPack = engineering ? await getOperatorBootstrapPack(");
    expect(src).toContain('sendToolResultsToVertex(text, toolResults, threadId, engineeringContextAllowed(systemInstruction, userRole))');
  });
});

// ---------------------------------------------------------------------------
// VTID-04563 — the deep-dive engine
// ---------------------------------------------------------------------------

import {
  buildDeepDiveExecutor, DEEP_DIVE_TARGET, DEEP_DIVE_STAGE, DEEP_DIVE_MAX_TOOL_CALLS, findScreen,
  isDeveloperCaller, numberedWindow, probeUrl, routeLines, runDeepDive, type DeepDiveDeps,
} from '../src/orb/developer/deep-dive';
import { buildLiveApiTools } from '../src/orb/live/tools/live-tool-catalog';
import { callerFromSession } from '../src/orb/live/tools/delegation-tools';
import { listDelegationTargets, clearDelegationTargets } from '../src/services/orchestrator/dispatcher';
import { registerDefaultDelegationTargets, resetDefaultRegistration } from '../src/services/orchestrator/delegation-targets';

function toolNames(catalog: object[]): string[] {
  const out: string[] = [];
  for (const g of catalog as Array<Record<string, unknown>>) {
    if (Array.isArray(g.function_declarations)) for (const d of g.function_declarations as Array<{ name: string }>) out.push(d.name);
  }
  return out;
}

function fakeDeps(over: Partial<DeepDiveDeps> = {}): DeepDiveDeps & { emitted: Array<[boolean, Record<string, unknown>]> } {
  const emitted: Array<[boolean, Record<string, unknown>]> = [];
  let t = 1_000;
  return {
    emitted,
    runLoop: jest.fn(async () => ({
      ok: true, text: 'Answer: X. Evidence: services/gateway/src/a.ts:12.', provider: 'bedrock', model: 'opus',
      fallbackUsed: false, usage: { inputTokens: 10, outputTokens: 5 }, turns: 2, toolCalls: 1, toolNames: ['dev_index_query'],
      history: [], steps: [], budgetExhausted: false, stalled: false,
    })) as unknown as DeepDiveDeps['runLoop'],
    indexTool: async (name) => ({ result: `index:${name}` }),
    readRepoFile: async (repo, p) => {
      if (p === 'src/navigation/registry/screens.json') return JSON.stringify({ 'AI.COMPANION': { id: 'AI.COMPANION', route: '/ai/companion', i18n: { en: { title: 'AI Companion' } } } });
      if (p === 'src/App.tsx') return 'a\n<Route path="/ai/companion" element={<Companion />} />\nb';
      return `line1\nline2\nline3 of ${repo}`;
    },
    gitHistory: async () => [{ sha: 'abcdef1234', date: '2026-09-24T10:00:00Z', author: 'dev', message: 'fix it' }],
    fetchImpl: jest.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    triageTool: async (name) => ({ result: `triage:${name}` }),
    systemStatus: async () => 'SNAPSHOT',
    emit: (ok, payload) => { emitted.push([ok, payload]); },
    now: () => (t += 50),
    ...over,
  };
}

const DEV_CALLER = { user_id: 'u1', tenant_id: null, platform_role: 'developer', exafy_admin: true, surface: 'command-hub' as const, channel: 'voice' as const, session_id: 's1' };

describe('VTID-04563 deep dive — read-only tools with guard rails', () => {
  test('the probe only GETs /alive and /api/v1/* on the two known hosts', () => {
    expect(probeUrl(undefined, '/api/v1/admin/build-info')).toEqual({ ok: true, env: 'staging', url: 'https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info' });
    expect(probeUrl('production', '/alive')).toMatchObject({ ok: true, url: 'https://gateway.vitanaland.com/alive' });
    expect(probeUrl('staging', '/admin/delete').ok).toBe(false);
    expect(probeUrl('staging', '/api/v1/../../etc').ok).toBe(false);
    expect(probeUrl('staging', 'https://evil.example/api/v1/x').ok).toBe(false);
  });

  test('file windows are numbered and bounded', () => {
    const content = Array.from({ length: 500 }, (_, i) => `l${i + 1}`).join('\n');
    const w = numberedWindow(content, 10, 12);
    expect(w.split('\n').slice(0, 3)).toEqual(['10\tl10', '11\tl11', '12\tl12']);
    expect(numberedWindow(content).split('\n').filter((l) => /^\d+\t/.test(l)).length).toBe(300);
  });

  test('a screen resolves by id, route or title to its App.tsx mount', () => {
    const screens = [{ id: 'AI.COMPANION', route: '/ai/companion', i18n: { en: { title: 'AI Companion' } } }];
    expect(findScreen(screens, 'ai companion')?.id).toBe('AI.COMPANION');
    expect(findScreen(screens, '/ai/companion')?.id).toBe('AI.COMPANION');
    expect(findScreen(screens, 'nothing')).toBeNull();
    expect(routeLines('x\n<Route path="/ai/companion" element={<C/>} />', '/ai/companion')).toEqual(['2\t<Route path="/ai/companion" element={<C/>} />']);
  });

  test('the executor routes every tool and never throws', async () => {
    const deps = fakeDeps();
    const exec = buildDeepDiveExecutor(deps);
    expect((await exec('dev_index_query', { query: 'x' })).result).toBe('index:dev_index_query');
    expect((await exec('read_repo_file', { path: 'a.ts', repo: 'exafyltd/vitana-v1' })).result).toContain('exafyltd/vitana-v1:a.ts\n1\tline1');
    expect((await exec('dev_git_history', { path: 'a.ts' })).result).toContain('abcdef12 2026-09-24 dev: fix it');
    expect((await exec('dev_screen_trace', { screen: 'AI Companion' })).result).toContain('2\t<Route path="/ai/companion"');
    expect((await exec('dev_domain_atlas', { domain: 'voice' })).result).toContain('[voice]');
    expect((await exec('dev_system_status', {})).result).toBe('SNAPSHOT');
    expect((await exec('query_oasis_events', { vtid: 'VTID-1' })).result).toBe('triage:query_oasis_events');
    const probe = await exec('dev_probe_endpoint', { env: 'production', path: '/api/v1/admin/build-info' });
    expect(probe.result).toMatch(/^\[production\] GET https:\/\/gateway\.vitanaland\.com\/api\/v1\/admin\/build-info → 200/);
    const [, init] = (deps.fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(init.method).toBe('GET');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
    const broken = buildDeepDiveExecutor(fakeDeps({ readRepoFile: async () => { throw new Error('GitHub 404'); } }));
    expect(await broken('read_repo_file', { path: 'x' })).toEqual({ result: 'read_repo_file failed: GitHub 404', isError: true });
  });
});

describe('VTID-04563 deep dive — only developers, on the planner stage, with telemetry', () => {
  test('member and admin-surface callers are refused before any model call', async () => {
    const deps = fakeDeps();
    for (const c of [
      { ...DEV_CALLER, surface: 'vitanaland' as const, exafy_admin: false, platform_role: 'community' },
      { ...DEV_CALLER, exafy_admin: false, platform_role: 'community' },
    ]) {
      const r = await runDeepDive('why', c, new AbortController().signal, deps);
      expect(r.ok).toBe(false);
    }
    expect(deps.runLoop).not.toHaveBeenCalled();
    expect(isDeveloperCaller({ ...DEV_CALLER, exafy_admin: false, platform_role: 'developer' })).toBe(true);
  });

  test('a developer question runs bounded on the planner stage and reports findings with telemetry', async () => {
    const deps = fakeDeps();
    const r = await runDeepDive('why did PR 3543 revert?', DEV_CALLER, new AbortController().signal, deps);
    expect(r.ok).toBe(true);
    expect((r.result as { findings: string }).findings).toContain('Evidence');
    const opts = (deps.runLoop as unknown as jest.Mock).mock.calls[0][0];
    expect(opts.stage).toBe(DEEP_DIVE_STAGE);
    expect(DEEP_DIVE_STAGE).toBe('planner');
    expect(opts.maxToolCalls).toBe(DEEP_DIVE_MAX_TOOL_CALLS);
    const names = opts.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['dev_index_query', 'read_repo_file', 'dev_git_history', 'dev_probe_endpoint', 'dev_screen_trace', 'query_oasis_events', 'dev_cloudwatch_logs', 'dev_run_sql_readonly']));
    expect(deps.emitted[0][0]).toBe(true);
    expect(deps.emitted[0][1]).toMatchObject({ question: 'why did PR 3543 revert?', provider: 'bedrock', tools_used: ['dev_index_query'] });
  });

  test('a loop failure is reported as failed, never as findings', async () => {
    const deps = fakeDeps({ runLoop: (async () => ({ ok: false, error: 'stage failed', fallbackUsed: false, usage: { inputTokens: 0, outputTokens: 0 }, turns: 0, toolCalls: 0, toolNames: [], history: [], steps: [], budgetExhausted: false, stalled: false })) as unknown as DeepDiveDeps['runLoop'] });
    const r = await runDeepDive('q', DEV_CALLER, new AbortController().signal, deps);
    expect(r).toMatchObject({ ok: false, error: 'stage failed' });
    expect(deps.emitted[0][0]).toBe(false);
  });

  test('the target is registered for the Command Hub only, read tier', () => {
    clearDelegationTargets();
    resetDefaultRegistration();
    registerDefaultDelegationTargets();
    const t = listDelegationTargets('command-hub').find((x) => x.agent_id === 'deep_dive');
    expect(t).toMatchObject({ surfaces: ['command-hub'], tier: 'read', domain: 'dev' });
    expect(listDelegationTargets('vitanaland').some((x) => x.agent_id === 'deep_dive')).toBe(false);
    expect(DEEP_DIVE_TARGET.agent_id).toBe('deep_dive');
  });

  test('the Command Hub catalog declares dev_deep_dive; the member and admin catalogs never do', () => {
    expect(toolNames(buildLiveApiTools('authenticated', '/command-hub', 'developer', 'command-hub'))).toContain('dev_deep_dive');
    expect(toolNames(buildLiveApiTools('authenticated', '/home', 'community', 'vitanaland'))).not.toContain('dev_deep_dive');
    expect(toolNames(buildLiveApiTools('authenticated', '/admin/users', 'admin', 'admin'))).not.toContain('dev_deep_dive');
  });

  test('a delegation caller carries the served role from the profile', () => {
    const c = callerFromSession({ sessionId: 's', identity: { user_id: 'u', exafy_admin: false }, active_role: null, assistantProfile: { surface: 'command-hub', role: 'developer' } });
    expect(c.platform_role).toBe('developer');
  });

  test('orb-live dispatches dev_deep_dive to the async runner', () => {
    const src = read('src/routes/orb-live.ts');
    expect(src).toMatch(/case 'dev_deep_dive': \{\s*const \{ runDeepDiveAsync \}/);
  });
});
