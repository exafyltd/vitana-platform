/**
 * VTID-04777..04780 — the Voice section rebuilt as a supervisor cockpit.
 *
 * app.js is a plain browser script with no render harness, so (like every
 * other suite in this folder) this pins the change by source text:
 *
 *  - the six Voice tabs, in order, and the redirects that keep every old
 *    Voice URL (and the backend's test-contracts deep links) working;
 *  - Test Contracts living under Testing & QA;
 *  - the LiveKit bench's Run Diagnostics carrying no write probe — it runs
 *    as the signed-in operator against the shared production database;
 *  - the Test Bench mounting both benches plus the voice test suite;
 *  - voice-supervisor.{js,css} loaded by index.html, exposing the four
 *    screens, reading the supervisor API with auth headers, CSP-clean.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const HUB = join(__dirname, '../../src/frontend/command-hub');
const APP = readFileSync(join(HUB, 'app.js'), 'utf8');
const INDEX = readFileSync(join(HUB, 'index.html'), 'utf8');
const SUP = readFileSync(join(HUB, 'voice-supervisor.js'), 'utf8');
const SUP_CSS = readFileSync(join(HUB, 'voice-supervisor.css'), 'utf8');
const GUARD = readFileSync(join(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a + start.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('VTID-04777 Voice tabs', () => {
  it('declares Overview, Tenants & Roles, Sessions, Issues & Healing, Test Bench, Providers & Config — in that order', () => {
    const section = between(APP, '"section": "voice"', ']');
    expect([...section.matchAll(/"key": "([a-z0-9-]+)"/g)].map((m) => m[1])).toEqual([
      'overview', 'segments', 'sessions', 'issues-healing', 'test-bench', 'providers',
    ]);
    expect(section).toContain('"label": "Tenants & Roles"');
    expect(section).toContain('"label": "Providers & Config"');
  });

  it('routes every Voice tab to its screen', () => {
    expect(APP).toContain("renderVoiceSupervisorScreen('renderVoiceSupervisorOverview'");
    expect(APP).toContain("renderVoiceSupervisorScreen('renderVoiceSupervisorSegments'");
    expect(APP).toContain("renderVoiceSupervisorScreen('renderVoiceSupervisorSessions'");
    expect(APP).toContain('container.appendChild(renderVoiceIssuesHealingView());');
    expect(APP).toContain('container.appendChild(renderVoiceTestBenchView());');
    for (const old of ['improve', 'orb-live', 'self-healing', 'test-contracts', 'livekit-test', 'nova-sonic-test', 'orb-ui-monitor']) {
      expect(APP).not.toContain(`moduleKey === 'voice' && tab === '${old}'`);
    }
  });

  it('keeps every old Voice URL working through a redirect', () => {
    const expected: Record<string, string> = {
      '/command-hub/voice/improve/': "{ section: 'voice', tab: 'issues-healing', subtab: 'action-queue' }",
      '/command-hub/voice/orb-live/': "{ section: 'voice', tab: 'sessions' }",
      '/command-hub/voice/self-healing/': "{ section: 'voice', tab: 'issues-healing', subtab: 'pipeline' }",
      '/command-hub/voice/livekit-test/': "{ section: 'voice', tab: 'test-bench' }",
      '/command-hub/voice/nova-sonic-test/': "{ section: 'voice', tab: 'test-bench' }",
      '/command-hub/voice/orb-ui-monitor/': "{ section: 'voice', tab: 'test-bench' }",
      '/command-hub/voice/test-contracts/': "{ section: 'testing-qa', tab: 'test-contracts' }",
      '/command-hub/diagnostics/voice-lab/': "{ section: 'voice', tab: 'sessions' }",
      '/command-hub/assistant/orb-live/': "{ section: 'voice', tab: 'sessions' }",
      '/command-hub/testing-qa/livekit-test/': "{ section: 'voice', tab: 'test-bench' }",
      '/command-hub/testing-qa/e2e/orb-monitor/': "{ section: 'voice', tab: 'test-bench' }",
    };
    const redirects = between(APP, 'const AUTONOMY_REDIRECTS = {', '};');
    for (const [path, target] of Object.entries(expected)) {
      const line = redirects.split('\n').find((l) => l.includes(`'${path}'`));
      expect(line).toBeDefined();
      expect(line).toContain(target);
    }
    // No link anywhere still points at a removed Voice tab path as a destination.
    expect(APP).not.toMatch(/href="\/command-hub\/voice\/orb-live\/"/);
  });

  it('moves Test Contracts into Testing & QA', () => {
    expect(APP).toContain("moduleKey === 'testing-qa' && tab === 'test-contracts') {\n        // VTID-04779");
    expect(APP).toContain('container.appendChild(renderTestContractsPanel());');
  });

  it('keeps the query string when the boot router canonicalises a path (shared supervisor links)', () => {
    expect(APP).toContain("history.replaceState(null, '', tab.path + (window.location.search || ''));");
  });

  it('lets the Sessions tab reuse the existing session drawer', () => {
    expect(APP).toContain('window.openVoiceLabSessionDrawer = function (sessionId) {');
    expect(APP).toContain('function mountVoiceLabSessionDrawer() {');
    expect(SUP).toContain('window.openVoiceLabSessionDrawer(id)');
  });
});

describe('VTID-04779 Test Bench', () => {
  const diag = between(APP, 'async function runDiagnostics() {', "diagnoseBtn.addEventListener('click'");

  it('Run Diagnostics creates nothing under the signed-in account', () => {
    expect(diag).not.toMatch(/diagFetch\('DELETE'/);
    for (const writePath of [
      "diagFetch('POST', '/api/v1/calendar/events'",
      "diagFetch('POST', '/api/v1/reminders'",
      "diagFetch('POST', '/api/v1/memory/diary/sync-index'",
      "diagFetch('POST', '/api/v1/intents'",
      '/activate',
      '/close',
    ]) {
      expect(diag).not.toContain(writePath);
    }
    for (const tool of [
      'send_chat_message', 'share_link', 'share_intent_post', 'respond_to_match', 'report_to_specialist',
      'set_capability_preference', 'switch_persona', 'create_index_improvement_plan', 'play_music',
      'consult_external_ai', 'search_web', 'read_email', 'ask_pillar_agent', 'scan_existing_matches',
    ]) {
      expect(diag).not.toContain(`diagDispatch('${tool}'`);
    }
    expect(APP).toContain('Run Diagnostics (read-only)');
  });

  it('mounts both benches side by side plus the voice test suite', () => {
    const tb = between(APP, 'function renderVoiceTestBenchView() {', '\nfunction ');
    expect(tb).toContain('renderLivekitTestView()');
    expect(tb).toContain('renderNovaSonicTestView()');
    expect(tb).toContain('renderLivekitHourlyTestsPanel()');
    expect(tb).toContain('renderOrbMonitorSection()');
    expect(tb).toContain("'/command-hub/orb-voice-bench.html'");
    expect(tb).toContain("frame.setAttribute('allow', 'microphone; autoplay');");
    expect(SUP_CSS).toMatch(/@media \(min-width: 1200px\) \{\s*\.vtb-split \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/);
  });

  it('labels the tool-routing dry run honestly (no LiveKit, no hourly cron)', () => {
    expect(APP).toContain('Tool-routing dry run (gateway)');
    expect(APP).not.toContain('hourly cron lands in Slice 1b');
  });
});

describe('VTID-04777 / VTID-04780 voice-supervisor.js', () => {
  it('is loaded by index.html with a cache-buster, after app.js', () => {
    expect(INDEX).toContain('<link rel="stylesheet" href="/command-hub/voice-supervisor.css?v=');
    const js = INDEX.indexOf('/command-hub/voice-supervisor.js?v=');
    expect(js).toBeGreaterThan(INDEX.indexOf('/command-hub/app.js?v='));
  });

  it('exposes the four screens', () => {
    for (const fn of ['renderVoiceSupervisorOverview', 'renderVoiceSupervisorSegments', 'renderVoiceSupervisorSessions', 'renderVoiceFixImpact']) {
      expect(SUP).toContain(`window.${fn} = function`);
    }
  });

  it('reads the supervisor API with the Command Hub auth headers and only ever GETs', () => {
    expect(SUP).toContain("var API = '/api/v1/voice/supervisor';");
    expect(SUP).toContain('window.buildContextHeaders(h)');
    expect(SUP).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    for (const p of ["'/meta'", "'/overview'", "'/segments'", "'/sessions'", "'/fixes?days=30'", "'/fixes/'"]) {
      expect(SUP).toContain(p);
    }
  });

  it('shows a fixed tenant chip instead of the tenant picker for non-platform admins', () => {
    expect(SUP).toContain('S.meta.scope.is_platform_admin === false');
    expect(SUP).toContain("'Tenant: ' + (tenantName(tid) || 'your tenant')");
  });

  it('polls every 10 s only while visible and stops once its screen is detached', () => {
    expect(SUP).toContain('var POLL_MS = 10000;');
    expect(SUP).toContain('if (document.hidden) return;');
    expect(SUP).toMatch(/if \(!slot \|\| !attached\(slot\.root\)\) \{\s*clearInterval\(S\.timer\);/);
  });

  it('is CSP-clean: no inline styles or script', () => {
    expect(SUP).not.toMatch(/\.style\./);
    expect(SUP).not.toMatch(/style=/);
    expect(SUP).not.toMatch(/innerHTML/);
    expect(SUP).not.toMatch(/\beval\(|new Function\(/);
  });

  it('is allowlisted in the Command Hub ownership guard', () => {
    expect(GUARD).toMatch(/ALLOWED_VTID_PATTERN = \/VTID-04777\|VTID-04778\|VTID-04779\|VTID-04780\|/);
  });
});
