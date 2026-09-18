/**
 * VTID-04065 (T5c): no fabricated fallback rows in the Integrations & Tools module.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js (see
 * test/command-hub/memory-garden-placeholder-banner.test.ts and
 * test/command-hub/dead-code-workflows-removed.test.ts) — this suite pins the
 * change by source text.
 *
 * Before this VTID, three fetch helpers in the Integrations & Tools module
 * fell back to a fully invented, hardcoded array of rows whenever the live API
 * call failed OR returned an empty result. That made a real backend outage
 * indistinguishable from a healthy service in the Command Hub UI. The
 * LLM one was worse: it fabricated vertex-ai / gemini-* rows as 'active',
 * contradicting the standing rule that GCP is fully decommissioned
 * (CLAUDE.md §1).
 *
 * All three `getKnown*()` seed arrays were unreachable except from those two
 * call sites inside their own fetch helper (verified by grepping the whole
 * file: each name had exactly its own definition + two call sites), and none
 * of the three render views carried a demo/offline mode that needed seed data
 * — each one already had its own loading branch, an error branch keyed off
 * `state.integrations*.error`, and an empty-state branch. So all three were
 * deleted, and the empty/catch branches now distinguish the two cases.
 *
 * Scope guard: the Memory Garden / Intelligence panel block is explicitly out
 * of scope, including renderEmbeddingsView()'s unrelated mock `status:
 * 'active'` strings (gated pending a separate product decision). Those are
 * asserted below to still exist, so this test also pins the boundary.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

/** Slice the body of a top-level `function <name>() { ... }` declaration. */
function functionBody(src: string, name: string): string {
  const match = src.match(new RegExp('function\\s+' + name + '\\(\\)\\s*\\{[\\s\\S]*?\\n\\}'));
  if (!match) throw new Error('function ' + name + ' not found in app.js');
  return match[0];
}

const REMOVED_SEED_FUNCTIONS = [
  'getKnownMcpConnectors',
  'getKnownLlmModels',
  'getKnownTools',
];

const FETCH_FUNCTIONS = [
  'fetchIntegrationsMcp',
  'fetchIntegrationsLlm',
  'fetchIntegrationsTools',
];

describe('Command Hub — no fabricated fallback rows (VTID-04065)', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  describe('the invented seed catalogs are gone', () => {
    it.each(REMOVED_SEED_FUNCTIONS)('no `function %s(` definition remains', (name) => {
      expect(src).not.toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
    });

    it('no reference to any removed seed function remains anywhere in app.js', () => {
      for (const name of REMOVED_SEED_FUNCTIONS) {
        expect(src).not.toContain(name);
      }
    });

    it('no fabricated vertex-ai / gemini-* rows are asserted as active', () => {
      expect(src).not.toContain("provider: 'vertex-ai'");
      expect(src).not.toContain("provider: 'gemini-api'");
      expect(src).not.toMatch(/gemini-2\.5-pro'\s*,\s*status: 'active'/);
    });
  });

  describe.each(FETCH_FUNCTIONS)('%s', (fnName) => {
    it('its live-success branch stores whatever the API returned, seeded or not', () => {
      const body = functionBody(src, fnName);
      // No `items = <seed>` fallback: the array that reaches state is the one
      // the API produced (an empty one is a legitimate empty result).
      expect(body).not.toMatch(/if\s*\(\s*items\.length === 0\s*\)\s*items\s*=/);
      expect(body).not.toMatch(/items\s*=\s*get[A-Za-z]*\(/);
    });

    it('its catch branch surfaces the failure instead of seeding rows', () => {
      const body = functionBody(src, fnName);
      // The outer catch is the last one in the function (fetchIntegrationsTools
      // also has per-request inner catches inside Promise.all that legitimately
      // degrade to empty payloads — those are not the fallback under test).
      const idx = body.lastIndexOf('.catch(');
      expect(idx).toBeGreaterThan(-1);
      const catchBody = body.slice(idx);

      // An error must be recorded so the render view's error branch fires...
      expect(catchBody).toMatch(/state\.integrations\w+\.error\s*=/);
      // ...and the item list must be empty, never a fabricated status array.
      expect(catchBody).toMatch(/state\.integrations\w+\.items\s*=\s*\[\]/);
      expect(catchBody).not.toMatch(/status:\s*'active'/);
      expect(catchBody).not.toMatch(/status:\s*'connected'/);
      expect(catchBody).not.toMatch(/status:\s*'available'/);
    });
  });

  describe('each render view still has a real error state and a real empty state', () => {
    const VIEWS: Array<[string, string]> = [
      ['renderIntegrationsMcpView', 'integrationsMcp'],
      ['renderIntegrationsLlmProvidersView', 'integrationsLlm'],
      ['renderIntegrationsToolsView', 'integrationsTools'],
    ];

    it.each(VIEWS)('%s keys an error branch off state.%s.error', (viewName, stateKey) => {
      const body = functionBody(src, viewName);
      expect(body).toContain('if (state.' + stateKey + '.error)');
      expect(body).toMatch(/errDiv\.textContent = 'Error: ' \+ state\./);
      // The pre-existing empty state (not a fabricated table).
      expect(body).toContain('if (items.length === 0)');
      expect(body).toContain('infra-empty');
    });
  });

  describe('out-of-scope Memory Garden / Intelligence block is untouched', () => {
    it('renderEmbeddingsView still carries its gated mock rows', () => {
      const body = functionBody(src, 'renderEmbeddingsView');
      expect(body).toContain("{ id: 'memories', name: 'User Memories', vectors: 8234, status: 'active'");
      expect(body).toContain("{ id: 'knowledge', name: 'Knowledge Base', vectors: 3156, status: 'active'");
    });

    it('the other gated render functions are still defined', () => {
      for (const name of [
        'renderMemoryGardenView',
        'renderMemoryGardenCard',
        'renderLongevityFocusPanel',
        'renderUnifiedIntelligencePanel',
        'renderKnowledgeGraphView',
        'renderRecallView',
        'renderInspectorView',
      ]) {
        expect(src).toMatch(new RegExp('function\\s+' + name + '\\s*\\('));
      }
    });
  });

  describe('cache-bust bump in index.html', () => {
    it('bumped both styles.css and app.js in sync for this change', () => {
      const html = readFileSync(INDEX_HTML_PATH, 'utf8');
      const stylesMatch = html.match(/\/command-hub\/styles\.css\?v=([^"]+)"/);
      const appMatch = html.match(/\/command-hub\/app\.js\?v=([^"]+)"/);
      expect(stylesMatch).toBeTruthy();
      expect(appMatch).toBeTruthy();
      expect(stylesMatch![1]).toBe(appMatch![1]);
      expect(appMatch![1]).toBe('20260918-vtid-04065-no-fabricated-rows');
      expect(html).not.toContain('?v=20260918-vtid-04061-dead-code-removed');
    });
  });
});
