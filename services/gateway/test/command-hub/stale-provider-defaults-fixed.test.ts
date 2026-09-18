/**
 * Command Hub (VTID-04057) — decommissioned Google Vertex/Gemini defaults.
 *
 * GCP is fully decommissioned (CLAUDE.md §1), so two Command Hub UI spots
 * that defaulted a *provider/model selection* to a dead Google model sent
 * every first-time user down a path that could not route:
 *
 *   1. renderRoutingPolicyPanel()'s unconfigured-stage fallback object
 *      defaulted to primary_provider 'vertex' / primary_model
 *      'gemini-3.1-pro' — a model that is neither deployed nor reachable.
 *      It now defaults to the Bedrock inference profile this repo's own
 *      CLAUDE.md documents as confirmed-invokable
 *      ('eu.anthropic.claude-sonnet-4-6').
 *
 *   2. renderModelsPlaygroundView()'s <select> (options gemini-2.0-flash /
 *      gemini-1.5-pro / claude-3-haiku) defaulted to 'gemini-2.0-flash' via
 *      `state.modelsPlayground.model || ...`, and the same fallback string
 *      was repeated in the POST body sent to /api/v1/assistant/chat. Both
 *      now fall back to 'claude-3-haiku' — a model already present in that
 *      same dropdown, so no new option was introduced.
 *
 * IMPORTANT SCOPE NOTE: the literal value 'vertex' is a load-bearing WIRE
 * VALUE elsewhere in app.js (the ORB voice active-provider transport name,
 * still served by Amazon Nova Sonic — see VTID-03970's note around
 * app.js's "vertex is a LEGACY WIRE VALUE" comment). Those references are
 * deliberately untouched and are asserted below to still exist, so this
 * test also pins the boundary of VTID-04057's narrow scope.
 *
 * Structural/source-level, matching this repo's established pattern for
 * app.js (hand-maintained vanilla-JS single-page app, no build step, no
 * render-test harness — see memory-garden-placeholder-banner.test.ts's
 * identical approach).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

function readAppJs(): string {
  return readFileSync(APP_JS_PATH, 'utf8');
}

function readIndexHtml(): string {
  return readFileSync(INDEX_HTML_PATH, 'utf8');
}

describe('Command Hub — stale Google provider defaults (VTID-04057)', () => {
  let src: string;

  beforeAll(() => {
    src = readAppJs();
  });

  describe('FIX 1 — renderRoutingPolicyPanel unconfigured-stage default', () => {
    it('switched the fallback provider to bedrock / the working Bedrock inference profile', () => {
      expect(src).toContain("primary_provider: 'bedrock'");
      expect(src).toContain("primary_model: 'eu.anthropic.claude-sonnet-4-6'");
    });

    it('no longer contains the dead gemini-3.1-pro model anywhere in the file', () => {
      expect(src).not.toContain('gemini-3.1-pro');
    });

    it('keeps fallback_provider / fallback_model null in that default object', () => {
      const fnMatch = src.match(/function renderRoutingPolicyPanel\(\)\s*\{[\s\S]*?\n\}/);
      expect(fnMatch).toBeTruthy();
      const fnBody = fnMatch![0];

      const defaultObjMatch = fnBody.match(
        /pending\[stage\.key\] \|\| \{[\s\S]*?fallback_model: null,\s*\}/
      );
      expect(defaultObjMatch).toBeTruthy();
      const defaultObj = defaultObjMatch![0];

      expect(defaultObj).toContain("primary_provider: 'bedrock'");
      expect(defaultObj).toContain("primary_model: 'eu.anthropic.claude-sonnet-4-6'");
      expect(defaultObj).toContain('fallback_provider: null');
      expect(defaultObj).toContain('fallback_model: null');
      expect(defaultObj).not.toContain("primary_provider: 'vertex'");
    });
  });

  describe('FIX 2 — Models Playground default fallback', () => {
    it('defines renderModelsPlaygroundView', () => {
      expect(src).toContain('function renderModelsPlaygroundView');
    });

    it('falls back to claude-3-haiku for the <select> default value', () => {
      expect(src).toContain("modelSelect.value = state.modelsPlayground.model || 'claude-3-haiku';");
    });

    it('falls back to claude-3-haiku in the POST body sent to /api/v1/assistant/chat', () => {
      expect(src).toContain(
        "model: state.modelsPlayground.model || 'claude-3-haiku'"
      );
    });

    it('uses no gemini-2.0-flash default fallback anywhere in the file', () => {
      // The task asked for the *default fallback* string to be gone file-wide.
      // It is: no `|| 'gemini-2.0-flash'` default survives.
      expect(src).not.toContain("|| 'gemini-2.0-flash'");
      expect(src).not.toContain('|| "gemini-2.0-flash"');
    });

    it('leaves exactly one gemini-2.0-flash left, and it is not a default', () => {
      // Honest scope boundary: `getKnownLlmModels()` still carries a
      // `model_id: 'gemini-2.0-flash'` row in its Vertex AI *display catalog*
      // (the Integrations → LLM fallback inventory, used only when
      // /api/v1/llm/models returns nothing). That is a read-only listing, not
      // a selectable default, and it lives inside the Vertex AI provider block
      // this VTID was explicitly told not to touch. Pin it so a future change
      // to that catalog is a conscious decision rather than a silent drift.
      const occurrences = src.split("'gemini-2.0-flash'").length - 1;
      expect(occurrences).toBe(1);

      expect(src).toContain("{ provider: 'vertex-ai', model_id: 'gemini-2.0-flash',");

      // ...and it must not be reachable as any Playground *default* (the
      // dropdown still lists it as an ordinary, non-default choice).
      const playgroundFn = src.match(/function renderModelsPlaygroundView\(\)\s*\{[\s\S]*?\n\}/);
      expect(playgroundFn).toBeTruthy();
      expect(playgroundFn![0]).not.toContain("|| 'gemini-2.0-flash'");
      expect(playgroundFn![0]).toContain("|| 'claude-3-haiku'");
    });

    it('did not need a new dropdown option — claude-3-haiku was already there', () => {
      const fnMatch = src.match(/function renderModelsPlaygroundView\(\)\s*\{[\s\S]*?\n\}/);
      expect(fnMatch).toBeTruthy();
      expect(fnMatch![0]).toContain('<option value="claude-3-haiku">claude-3-haiku</option>');
    });
  });

  describe('scope guard — the load-bearing ORB "vertex" wire value is untouched', () => {
    it('still carries the legacy vertex transport wire value for ORB voice', () => {
      expect(src).toContain("lktActiveProvider = 'vertex'");
      expect(src).toContain("['vertex', 'livekit']");
    });
  });

  describe('cache-bust bump in index.html', () => {
    it('bumped past the pre-VTID-04057 marker on both styles.css and app.js, and stayed in sync', () => {
      // Pins the invariant this test exists for (a cache-bust happened, so
      // the browser can't serve a stale pre-fix copy) rather than the exact
      // literal string — a later, unrelated Command Hub PR (e.g. VTID-04060/
      // VTID-04061) legitimately bumps the same two tags again, and pinning
      // this PR's own marker forever would break on every such bump, the
      // same class of fragility VTID-04031 already hit and fixed this way.
      const html = readIndexHtml();
      const stylesMatch = html.match(/\/command-hub\/styles\.css\?v=([^"]+)"/);
      const appMatch = html.match(/\/command-hub\/app\.js\?v=([^"]+)"/);
      expect(stylesMatch).toBeTruthy();
      expect(appMatch).toBeTruthy();
      expect(stylesMatch![1]).toBe(appMatch![1]);
      expect(html).not.toContain('/command-hub/styles.css?v=20260918-vtid-04033-exec-follow');
      expect(html).not.toContain('/command-hub/app.js?v=20260918-vtid-04033-exec-follow');
    });
  });
});
