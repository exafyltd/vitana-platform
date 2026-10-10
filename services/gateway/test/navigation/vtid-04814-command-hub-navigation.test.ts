/**
 * VTID-04814 — Command Hub screens in the screen registry.
 *
 * Before this, NAV_V2_ENABLED sent every `navigate` on the Command Hub to a
 * registry that only knew member screens: "open Autopilot Live" could only
 * resolve to a community page, which the Command Hub refuses — the developer
 * heard "opening…" and nothing happened. The Command Hub's tabs now live in
 * src/navigation/data/command-hub-screens.json and the resolver keeps each
 * session on its own surface.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  DEV_IDENTITY: { USER_ID: '00000000-0000-0000-0000-000000000099', TENANT_ID: '00000000-0000-0000-0000-000000000001' },
  isMemoryBridgeEnabled: () => false,
  isDevSandbox: () => false,
}));

import * as fs from 'fs';
import * as path from 'path';
import { callSurface, findRegistryScreen, NavCallContext, navigateByRequest, openScreen } from '../../src/navigation/nav-dispatch';
import { getNavRegistry, loadCommandHubScreens, screenSurface, surfaceForRoute } from '../../src/navigation/nav-registry';
import { isReachable, resolveWithIndex } from '../../src/navigation/nav-resolver';
import { __setNavServiceForTests } from '../../src/navigation/nav-service';
import { buildLiveApiTools } from '../../src/orb/live/tools/live-tool-catalog';
import { COMMAND_HUB_CASES } from '../nav-golden/command-hub-golden';
import { GOLDEN_SET } from '../nav-golden/golden-set';
import { loadRegistryFixture, RegistryFixture } from '../nav-golden/registry-fixture';

/**
 * The 67 Command Hub ids the legacy navigation catalog carried, frozen when
 * that catalog was deleted (VTID-04846): every one must keep opening.
 */
const LEGACY_DEVHUB_IDS = [
  'DEVHUB.ADMIN.ANALYTICS',
  'DEVHUB.ADMIN.CONTENT_MODERATION',
  'DEVHUB.ADMIN.IDENTITY_ACCESS',
  'DEVHUB.ADMIN.PERMISSIONS',
  'DEVHUB.ADMIN.TENANTS',
  'DEVHUB.ADMIN.USERS',
  'DEVHUB.AGENTS.PIPELINES',
  'DEVHUB.AGENTS.REGISTERED',
  'DEVHUB.AGENTS.TELEMETRY',
  'DEVHUB.AUTOPILOT.ENGINE',
  'DEVHUB.AUTOPILOT.GROWTH',
  'DEVHUB.AUTOPILOT.LIVE',
  'DEVHUB.AUTOPILOT.REGISTRY',
  'DEVHUB.AUTOPILOT.RUNS',
  'DEVHUB.AUTOPILOT.SCANNERS',
  'DEVHUB.COMMAND_HUB.APPROVALS',
  'DEVHUB.COMMAND_HUB.EVENTS',
  'DEVHUB.COMMAND_HUB.LIVE_CONSOLE',
  'DEVHUB.COMMAND_HUB.TASKS',
  'DEVHUB.COMMAND_HUB.VTIDS',
  'DEVHUB.DATABASES.SUPABASE',
  'DEVHUB.DATABASES.VECTORS',
  'DEVHUB.DIAGNOSTICS.DEBUG_PANEL',
  'DEVHUB.DIAGNOSTICS.HEALTH_CHECKS',
  'DEVHUB.DIAGNOSTICS.LATENCY',
  'DEVHUB.DIAGNOSTICS.VOICE_LAB',
  'DEVHUB.DOCS.API_INVENTORY',
  'DEVHUB.DOCS.ARCHITECTURE',
  'DEVHUB.DOCS.DATABASE_SCHEMAS',
  'DEVHUB.GOVERNANCE.CONTROLS',
  'DEVHUB.GOVERNANCE.EVALUATIONS',
  'DEVHUB.GOVERNANCE.RULES',
  'DEVHUB.GOVERNANCE.VIOLATIONS',
  'DEVHUB.INFRA.CONFIG',
  'DEVHUB.INFRA.DEPLOYMENTS',
  'DEVHUB.INFRA.HEALTH',
  'DEVHUB.INFRA.LOGS',
  'DEVHUB.INFRA.SELF_HEALING',
  'DEVHUB.INFRA.SERVICES',
  'DEVHUB.INTEGRATIONS.APIS',
  'DEVHUB.INTEGRATIONS.LLM_PROVIDERS',
  'DEVHUB.INTEGRATIONS.MCP',
  'DEVHUB.INTELLIGENCE.EMBEDDINGS',
  'DEVHUB.INTELLIGENCE.KNOWLEDGE_GRAPH',
  'DEVHUB.INTELLIGENCE.MEMORY_VAULT',
  'DEVHUB.MODELS.EVALUATIONS',
  'DEVHUB.MODELS.PLAYGROUND',
  'DEVHUB.OASIS.EVENTS',
  'DEVHUB.OASIS.VTID_LEDGER',
  'DEVHUB.OPERATOR.DASHBOARD',
  'DEVHUB.OPERATOR.DEPLOYMENTS',
  'DEVHUB.OPERATOR.EVENT_STREAM',
  'DEVHUB.OPERATOR.RUNBOOK',
  'DEVHUB.OPERATOR.TASK_QUEUE',
  'DEVHUB.OVERVIEW.ERRORS_VIOLATIONS',
  'DEVHUB.OVERVIEW.LIVE_METRICS',
  'DEVHUB.OVERVIEW.RECENT_EVENTS',
  'DEVHUB.OVERVIEW.RELEASE_FEED',
  'DEVHUB.OVERVIEW.SYSTEM_OVERVIEW',
  'DEVHUB.SECURITY.AUDIT_LOG',
  'DEVHUB.SECURITY.KEYS_SECRETS',
  'DEVHUB.SECURITY.RLS',
  'DEVHUB.TESTING.CATALOG',
  'DEVHUB.TESTING.CI_REPORTS',
  'DEVHUB.TESTING.E2E',
  'DEVHUB.TESTING.OVERVIEW',
  'DEVHUB.TESTING.RUN_TESTS',
];

const APP_JS = fs.readFileSync(path.join(__dirname, '../../src/frontend/command-hub/app.js'), 'utf8');

/** NAVIGATION_CONFIG as the Command Hub router reads it. */
function commandHubTabs(): Array<{ section: string; key: string; path: string }> {
  const start = APP_JS.indexOf('const NAVIGATION_CONFIG = [');
  const open = APP_JS.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < APP_JS.length; i++) {
    if (APP_JS[i] === '[') depth++;
    else if (APP_JS[i] === ']' && --depth === 0) { end = i; break; }
  }
  // eslint-disable-next-line no-new-func
  const cfg = new Function(`return ${APP_JS.slice(open, end + 1)};`)() as Array<{ section: string; tabs: Array<{ key: string; path: string }> }>;
  return cfg.flatMap((s) => s.tabs.map((t) => ({ section: s.section, key: t.key, path: t.path })));
}

const hub: NavCallContext = { lang: 'en', isAnonymous: false, isMobile: false, currentRoute: '/command-hub/overview/system-overview/', sessionId: 'hub1' };
const member: NavCallContext = { lang: 'en', isAnonymous: false, isMobile: false, currentRoute: '/home', sessionId: 'm1' };

let f: RegistryFixture;
beforeAll(async () => {
  f = await loadRegistryFixture();
  __setNavServiceForTests({ index: f.index, embedder: f.embedder });
});

describe('the Command Hub screen list matches the Command Hub', () => {
  const screens = loadCommandHubScreens();
  const tabs = commandHubTabs();

  it('has exactly one screen per tab of NAVIGATION_CONFIG', () => {
    const routes = screens.map((s) => s.route);
    expect(tabs.length).toBeGreaterThan(100);
    expect(tabs.map((t) => t.path).filter((p) => !routes.includes(p))).toEqual([]);
    expect(routes.filter((r) => !tabs.some((t) => t.path === r))).toEqual([]);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('marks every screen as a Command Hub screen a signed-in developer can open', () => {
    for (const s of screens) {
      expect(s).toMatchObject({ surface: 'command-hub', access: 'member', category: 'developer' });
      expect(s.route.startsWith('/command-hub/')).toBe(true);
      expect(s.i18n.en.title.length).toBeGreaterThan(2);
      expect((s.i18n.en.shows || '').length).toBeGreaterThan(10);
      expect((s.i18n.en.phrasings || []).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps every legacy DEVHUB id working', () => {
    expect(LEGACY_DEVHUB_IDS).toHaveLength(67);
    const missing = LEGACY_DEVHUB_IDS.filter((id) => !findRegistryScreen(id, 'command-hub') || screenSurface(findRegistryScreen(id, 'command-hub') || {}) !== 'command-hub');
    expect(missing).toEqual([]);
  });

  it('is merged into the registry the gateway uses, after every member screen', () => {
    const all = getNavRegistry().registry.screens;
    expect(all.filter((s) => screenSurface(s) === 'command-hub')).toHaveLength(screens.length);
    expect(all.filter((s) => screenSurface(s) === 'community').length).toBeGreaterThan(150);
  });
});

describe('surfaces', () => {
  it('reads the surface from the route', () => {
    expect(surfaceForRoute('/command-hub/autopilot/live/')).toBe('command-hub');
    expect(surfaceForRoute('/command-hub')).toBe('command-hub');
    expect(surfaceForRoute('/command-hubx')).toBe('community');
    expect(surfaceForRoute('/home')).toBe('community');
    expect(surfaceForRoute(null)).toBe('community');
    expect(callSurface({ currentRoute: '/home', surface: 'command-hub' })).toBe('command-hub');
  });

  it('only reaches screens of the session\'s own surface', () => {
    const live = findRegistryScreen('DEVHUB.AUTOPILOT.LIVE')!;
    const inbox = findRegistryScreen('INBOX.OVERVIEW')!;
    expect(isReachable(live, { authenticated: true, surface: 'command-hub' })).toBe(true);
    expect(isReachable(live, { authenticated: true })).toBe(false);
    expect(isReachable(inbox, { authenticated: true })).toBe(true);
    expect(isReachable(inbox, { authenticated: true, surface: 'command-hub' })).toBe(false);
  });

  it('never matches an invented Command Hub id to a member screen', () => {
    // Before: DEVHUB.OASIS.EVENTS fell to the alias "events" → COMM.EVENTS.
    expect(findRegistryScreen('DEVHUB.OASIS.EVENTS', 'command-hub')?.route).toBe('/command-hub/oasis/events/');
    expect(screenSurface(findRegistryScreen('DEVHUB.SOMETHING.EVENTS', 'command-hub') || { surface: 'command-hub' })).toBe('command-hub');
  });
});

describe('what a developer says on the Command Hub', () => {
  it.each(COMMAND_HUB_CASES.map((c) => [c.say, c]))('%s', async (_say, c) => {
    const r = await resolveWithIndex(f.index, f.embedder, c.say, { lang: c.lang, authenticated: true, surface: 'command-hub', ignoreText: c.say });
    expect(r.kind).not.toBe('none');
    const top = r.kind === 'match' ? r.screen.screen_id : r.candidates[0]?.screen_id;
    expect(c.expect).toContain(top);
    for (const x of r.kind === 'match' ? [r.screen, ...r.candidates] : r.candidates) {
      expect(screenSurface(findRegistryScreen(x.screen_id, 'command-hub')!)).toBe('command-hub');
    }
  });

  it('never sends a member request on the Command Hub to a member screen', async () => {
    for (const c of GOLDEN_SET.filter((g) => g.intent !== 'none').slice(0, 80)) {
      const r = await resolveWithIndex(f.index, f.embedder, c.utterance.trim(), { lang: c.lang, authenticated: true, surface: 'command-hub' });
      const ids = r.kind === 'match' ? [r.screen.screen_id] : r.candidates.map((x) => x.screen_id);
      for (const id of ids) expect(id.startsWith('DEVHUB.')).toBe(true);
    }
  });

  it('never offers a Command Hub screen to a member', async () => {
    for (const c of COMMAND_HUB_CASES) {
      const r = await resolveWithIndex(f.index, f.embedder, c.say, { lang: c.lang, authenticated: true });
      const ids = r.kind === 'match' ? [r.screen.screen_id] : r.candidates.map((x) => x.screen_id);
      for (const id of ids) expect(id.startsWith('DEVHUB.')).toBe(false);
    }
  });
});

describe('opening a Command Hub screen', () => {
  it('opens it on the Command Hub with a /command-hub route', async () => {
    const r = await navigateByRequest('take me to the VTID ledger', 'open', hub) as { ok: true; result: { directive: Record<string, unknown> } };
    expect(r.result.directive).toMatchObject({ directive: 'navigate', screen_id: 'DEVHUB.OASIS.VTID_LEDGER', route: '/command-hub/oasis/vtid-ledger/' });
  });

  it('refuses a member screen on the Command Hub and a Command Hub screen in the app', async () => {
    const a = await openScreen('INBOX.OVERVIEW', '', hub);
    expect(a).toMatchObject({ ok: false });
    expect((a as { error: string }).error).toMatch(/not the Command Hub/);
    const b = await openScreen('DEVHUB.AUTOPILOT.LIVE', '', member);
    expect(b).toMatchObject({ ok: false });
    expect((b as { error: string }).error).toMatch(/Command Hub screen/);
  });

  it('opens a legacy redirect id at the tab it moved to', async () => {
    const r = await openScreen('DEVHUB.DIAGNOSTICS.VOICE_LAB', '', hub) as { ok: true; result: { route: string } };
    expect(r.result.route).toBe('/command-hub/voice/sessions/');
  });
});

describe('Command Hub tools', () => {
  it('declares navigate_to_screen next to navigate, so its answers can be acted on', () => {
    const names = (buildLiveApiTools('community', '/command-hub/autopilot/live/', 'developer', 'command-hub') as Array<{ function_declarations?: Array<{ name: string }> }>)
      .flatMap((g) => (g.function_declarations || []).map((d) => d.name));
    expect(names).toEqual(expect.arrayContaining(['navigate', 'navigate_to_screen', 'get_current_screen', 'dev_open_hub_panel']));
  });

  it('routes dev_open_hub_panel through the navigation handler on the Command Hub', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/orb-live.ts'), 'utf8');
    expect(src).toMatch(/toolName === 'dev_open_hub_panel' && sessionServedSurface\(session\) === 'command-hub'\)[\s\S]{0,80}handleNavigateToScreen/);
  });

  it('reports the outcome and keeps the widget\'s route current in the Command Hub client', () => {
    expect(APP_JS).toMatch(/return \{ status: 'refused', reason: 'not a Command Hub screen' \}/);
    expect(APP_JS).toMatch(/return \{ status: 'opened', route: window\.location\.pathname \}/);
    expect(APP_JS).toMatch(/function syncOrbRouteWithCommandHub\(\)[\s\S]{0,1200}updateContext\(\{ current_route: now \}\)/);
    expect(APP_JS).toMatch(/syncOrbRouteWithCommandHub\(\);/);
  });
});
