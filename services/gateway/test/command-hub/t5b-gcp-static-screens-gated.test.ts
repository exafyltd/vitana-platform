/**
 * VTID-04064 (T5B): five Command Hub screens rendered fabricated GCP-era
 * infrastructure data with no live API backing — a leftover from before GCP
 * was decommissioned (CLAUDE.md §1: GCP is fully decommissioned, AWS is
 * canonical; `lovable-vitana-vers1` / `*.run.app` / `us-central1` /
 * `pkg.dev` are dead references).
 *
 * They were:
 *   1. renderIntegrationsServiceMeshView() — a hardcoded `services` array of
 *      dead *.run.app hosts with always-"healthy" dots and no fetch at all.
 *   2. renderDatabasesSupabaseView()'s `connectionCards` — claimed the dead
 *      GCP project id + region were this Supabase project's identity.
 *   3. renderDatabasesClustersView()'s `clusterConfig` — claimed
 *      us-central1 co-location with dead managed-run instances.
 *   4. renderInfraConfigView()'s static 'Service URLs' + 'Environment'
 *      panels — dead *.run.app hosts, project id, region, registry.
 *   5. renderSecurityKeysSecretsView()'s 'Gemini API Key' row and the
 *      'Service Accounts' list (Cloud Run SA / Cloud Build SA / Artifact
 *      Registry).
 *
 * What replaced them is a neutral, honest placeholder built by the shared
 * `buildGcpStaticViewDisabledNotice()` helper. What must NOT have changed:
 * renderInfraConfigView()'s live governance-controls card rendering (backed
 * by fetchInfraConfig()), renderSecurityKeysSecretsView()'s JWT
 * Configuration block, renderDatabasesAnalyticsView()'s Analytics Pipeline
 * note, and the load-bearing `'vertex'` ORB voice wire value (VTID-03970).
 *
 * Structural/source-level, matching this repo's established pattern for
 * app.js (hand-maintained vanilla-JS single-page app, no build step, no
 * render-test harness — see memory-garden-placeholder-banner.test.ts).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

/** Dead GCP identifiers that must not appear anywhere in the five functions. */
const DEAD_GCP_MARKERS = ['lovable-vitana-vers1', 'us-central1', '.run.app', 'pkg.dev'];

const GATED_FUNCTIONS = [
  'renderIntegrationsServiceMeshView',
  'renderDatabasesSupabaseView',
  'renderDatabasesClustersView',
  'renderInfraConfigView',
  'renderSecurityKeysSecretsView',
];

/**
 * Extracts one function's full body (braces included) by brace-balancing
 * from its definition, skipping string literals and comments so a `{` or `}`
 * inside a message string cannot unbalance the scan.
 */
function extractFunctionBody(src: string, name: string): string {
  const defIdx = src.indexOf('function ' + name + '(');
  if (defIdx === -1) throw new Error('definition not found: ' + name);
  const bodyStart = src.indexOf('{', defIdx);
  if (bodyStart === -1) throw new Error('body not found: ' + name);

  let depth = 0;
  let i = bodyStart;
  let quote: string | null = null;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; i += 1; continue; }

    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
    i += 1;
  }

  throw new Error('unbalanced body: ' + name);
}

describe('Command Hub — GCP static screens gated (VTID-04064)', () => {
  let src: string;
  const bodies: Record<string, string> = {};

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
    for (const name of GATED_FUNCTIONS) bodies[name] = extractFunctionBody(src, name);
  });

  it('defines all five gated render functions', () => {
    for (const name of GATED_FUNCTIONS) {
      expect(src).toContain('function ' + name + '(');
    }
  });

  it('extracts a non-trivial body for each of the five functions', () => {
    for (const name of GATED_FUNCTIONS) {
      expect(bodies[name].length).toBeGreaterThan(100);
    }
  });

  describe.each(DEAD_GCP_MARKERS)('dead GCP marker "%s"', (marker) => {
    it.each(GATED_FUNCTIONS)('is absent from %s', (name) => {
      expect(bodies[name]).not.toContain(marker);
    });
  });

  it('no dead GCP marker survives in any of the five bodies (case-insensitive combined check)', () => {
    const pattern = new RegExp(DEAD_GCP_MARKERS.map((m) => m.replace(/\./g, '\\.')).join('|'), 'i');
    for (const name of GATED_FUNCTIONS) {
      expect(bodies[name]).not.toMatch(pattern);
    }
  });

  describe('shared neutral placeholder', () => {
    it('defines the shared notice text once, referencing CLAUDE.md §1 and §11', () => {
      expect(src).toContain('var GCP_STATIC_VIEW_DISABLED_TEXT =');
      expect(src).toContain('GCP is fully decommissioned (CLAUDE.md §1)');
      expect(src).toContain('aws ecs describe-services per CLAUDE.md §11, not yet wired into this UI');
    });

    it('defines the notice builder helper and uses it in the four gated views that render it', () => {
      expect(src).toContain('function buildGcpStaticViewDisabledNotice() {');
      expect(bodies.renderIntegrationsServiceMeshView).toContain('buildGcpStaticViewDisabledNotice()');
      expect(bodies.renderInfraConfigView).toContain('buildGcpStaticViewDisabledNotice()');
      expect(bodies.renderSecurityKeysSecretsView).toContain('buildGcpStaticViewDisabledNotice()');
    });
  });

  describe('per-view expectations', () => {
    it('renderIntegrationsServiceMeshView no longer hardcodes a service array or healthy dots', () => {
      expect(bodies.renderIntegrationsServiceMeshView).not.toContain('infra-card__dot--healthy');
      expect(bodies.renderIntegrationsServiceMeshView).not.toContain('var services = [');
      expect(bodies.renderIntegrationsServiceMeshView).not.toContain("health: '/alive'");
    });

    it('renderDatabasesSupabaseView no longer claims a GCP project identity, but keeps RLS/Engine cards', () => {
      expect(bodies.renderDatabasesSupabaseView).not.toContain('GCP Project');
      expect(bodies.renderDatabasesSupabaseView).not.toContain("title: 'Project ID'");
      expect(bodies.renderDatabasesSupabaseView).toContain("{ title: 'RLS Status', value: 'Enforced'");
      expect(bodies.renderDatabasesSupabaseView).toContain("{ title: 'Engine', value: 'PostgreSQL 15'");
    });

    it('renderDatabasesClustersView states the region/co-location are unverified instead of claiming them', () => {
      expect(bodies.renderDatabasesClustersView).not.toContain('Cloud Run');
      expect(bodies.renderDatabasesClustersView).toContain("title: 'Region', value: 'Unverified'");
      expect(bodies.renderDatabasesClustersView).toContain('not verified against live AWS config');
    });

    it('renderSecurityKeysSecretsView drops the Gemini key row and GCP service accounts, keeps JWT config', () => {
      expect(bodies.renderSecurityKeysSecretsView).not.toContain('Gemini API Key');
      expect(bodies.renderSecurityKeysSecretsView).not.toContain('Cloud Run SA');
      expect(bodies.renderSecurityKeysSecretsView).not.toContain('Cloud Build SA');
      expect(bodies.renderSecurityKeysSecretsView).not.toContain('Artifact Registry');
      expect(bodies.renderSecurityKeysSecretsView).toContain(
        "'<li><strong>Algorithm:</strong> HS256 (Supabase default)</li>' +"
      );
      expect(bodies.renderSecurityKeysSecretsView).toContain('Supabase handles refresh token rotation automatically');
    });
  });

  describe('unchanged neighbouring code', () => {
    it('keeps renderInfraConfigView’s live governance-controls rendering and its fetchInfraConfig() call', () => {
      const body = bodies.renderInfraConfigView;
      expect(body).toContain('fetchInfraConfig();');
      expect(body).toContain('controls.forEach(function (control) {');
      expect(body).toContain("badge.className = 'infra-card__badge infra-card__badge--' + (isEnabled ? 'armed' : 'disarmed');");
      expect(body).toContain("titleDiv.textContent = 'Governance Controls';");
      expect(body).toContain('container.appendChild(cardsGrid);');
    });

    it('leaves fetchInfraConfig() itself untouched', () => {
      const body = extractFunctionBody(src, 'fetchInfraConfig');
      expect(body).toContain("fetch('/api/v1/governance/controls'");
      expect(body).toContain('state.infraConfig.data = data.data');
    });

    it("keeps the Databases Analytics view's accurate Analytics Pipeline note", () => {
      expect(src).toContain("'<h3>Analytics Pipeline</h3>' +");
      expect(src).toContain('<li><strong>Ingestion:</strong> All services emit events via POST /api/v1/oasis/events</li>');
    });

    it("scope guard — the load-bearing ORB 'vertex' wire value is untouched", () => {
      expect(src).toContain("lktActiveProvider = 'vertex';");
      expect(src).toContain('"vertex" here is a legacy value name for the gateway-proxied transport');
    });

    // The Memory Garden / Intelligence panel block was required to stay
    // untouched by VTID-04064, pending the separate T1b product decision.
    // T1b has since resolved (VTID-04093): the block was confirmed a
    // fabricated-mock-data duplicate of the real, backend-wired
    // renderMemoryOpsView (VTID-02636, already mounted live) and deleted —
    // see t2-no-zero-caller-functions.test.ts for the removal assertions.
  });

  describe('cache-bust bump in index.html', () => {
    it('bumps past the pre-VTID-04064 marker and keeps both tags in sync', () => {
      const html = readFileSync(INDEX_HTML_PATH, 'utf8');
      const stylesMatch = html.match(/\/command-hub\/styles\.css\?v=([^"]+)"/);
      const appMatch = html.match(/\/command-hub\/app\.js\?v=([^"]+)"/);
      expect(stylesMatch).toBeTruthy();
      expect(appMatch).toBeTruthy();
      expect(stylesMatch![1]).toBe(appMatch![1]);
      expect(appMatch![1] >= '20260918-vtid-04064').toBe(true);
      expect(html).not.toContain('/command-hub/styles.css?v=20260918-vtid-04061-dead-code-removed');
      expect(html).not.toContain('/command-hub/app.js?v=20260918-vtid-04061-dead-code-removed');
    });
  });
});
