/**
 * Command Hub (VTID-04066) — stale UI-visible GCP labels replaced.
 *
 * GCP is fully decommissioned (CLAUDE.md §1/§2e): there is no Vertex AI, no
 * Gemini Live and no Cloud Run anywhere in the running platform — the LLM
 * stages route to Claude via AWS Bedrock (CLAUDE.md ALWAYS 10a/10b) and the
 * voice transport is Amazon Nova Sonic. Seven UI-visible Command Hub strings
 * still named the dead Google services, so an operator reading the screen
 * believed the platform was still calling them:
 *
 *   1. renderTelemetryStreamPanel()'s provider filter option
 *      `'<option value="vertex">Vertex AI (Google)</option>'` — relabelled
 *      `(decommissioned, do not use)`. The value is NOT removed: a stored
 *      routing-policy/telemetry row can still carry `vertex`, and deleting
 *      the option would leave that value unrenderable in the filter.
 *   2. llmProviderLabel()'s matching `vertex: 'Vertex AI (Google)'` map entry
 *      — relabelled `(decommissioned)`, key kept for the same reason.
 *   3. Voice Lab audio-chunk hint: 'Gemini Live' -> 'Nova Sonic'.
 *   4. Voice Lab 'Voice Model' dropdown lists only dead Gemini Live model ids;
 *      no verified Nova Sonic identifier exists in this repo, so no option
 *      value was invented — the control is labelled
 *      '(legacy, non-functional)' instead.
 *   5. PERSONALITY_SURFACE_DEFS.voice_live label/description:
 *      'Voice (Gemini Live)' -> 'Voice (Nova Sonic)' + Nova Sonic description.
 *   6. Docs > Architecture subtitle + layers array: 'Cloud Run' -> 'AWS ECS'.
 *   7. Docs > Agent Workforce Planner/Worker model fields: 'Gemini Pro' /
 *      'Gemini Flash' -> Claude-via-Bedrock / DeepSeek-Flash (Bedrock Claude
 *      fallback), matching current reality.
 *
 * IMPORTANT SCOPE NOTE: the literal value 'vertex' is a load-bearing WIRE
 * VALUE for the ORB voice transport (VTID-03970's "vertex is a LEGACY WIRE
 * VALUE" note around app.js's active-provider block) — that string means
 * "Nova Sonic gateway-proxied transport", not literal Google Vertex, and is
 * deliberately untouched. Asserted below so this test also pins the boundary
 * of VTID-04066's narrow text-only scope, alongside the Memory Garden /
 * Intelligence panel block the task explicitly excluded.
 *
 * Structural/source-level, matching this repo's established pattern for
 * app.js (hand-maintained vanilla-JS single-page app, no build step, no
 * render-test harness — see memory-garden-placeholder-banner.test.ts and
 * stale-provider-defaults-fixed.test.ts's identical approach).
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

/**
 * Drop whole-line `//` comments. The VTID-04066 change notes are written
 * inside these blocks (naming the old strings verbatim), so "must not
 * appear" assertions have to look past them at real code only.
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Slice a top-level `function <name>(...) { ... }` body. */
function topLevelFunctionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

/** Slice a `var <name> = [ ... ];` literal block. */
function arrayLiteral(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('];', start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe('Command Hub — stale GCP labels fixed (VTID-04066)', () => {
  let src: string;

  beforeAll(() => {
    src = readAppJs();
  });

  describe('FIX 1 — telemetry provider-filter option (renderTelemetryStreamPanel)', () => {
    it('marks the vertex provider option decommissioned instead of a live choice', () => {
      expect(src).toContain(
        '\'<option value="vertex">Vertex AI (Google) (decommissioned, do not use)</option>\''
      );
    });

    it('no longer offers the bare live-looking label, and keeps the value itself', () => {
      expect(src).not.toContain('<option value="vertex">Vertex AI (Google)</option>');
      // The value attribute must survive — a stored policy row can carry it.
      expect(src).toContain('<option value="vertex">');
    });
  });

  describe('FIX 2 — llmProviderLabel map entry', () => {
    it('relabels vertex as decommissioned but keeps the key', () => {
      expect(src).toContain("vertex: 'Vertex AI (Google) (decommissioned)'");
      expect(src).not.toContain("vertex: 'Vertex AI (Google)',");
    });
  });

  describe('FIX 3 — Voice Lab audio-chunk hint', () => {
    it('says Nova Sonic, not Gemini Live', () => {
      expect(src).toContain('20-40ms optimal for Nova Sonic.');
      expect(src).not.toContain('20-40ms optimal for Gemini Live.');
    });
  });

  describe('FIX 4 — Voice Lab "Voice Model" dropdown labelled legacy', () => {
    it('marks the control legacy/non-functional', () => {
      expect(src).toContain(
        '<label for="vl-model">Voice Model (legacy, non-functional)</label>'
      );
      expect(src).not.toContain('<label for="vl-model">Voice Model</label>');
    });

    it('does not invent unverifiable Nova Sonic model option values', () => {
      const options = arrayLiteral(src, 'var modelOptions = [');
      // The three existing (dead) Gemini Live ids stay verbatim; no new
      // selectable option value was fabricated for this control.
      expect(options).toContain(
        "{ value: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (Experimental)' }"
      );
      expect(options).toContain(
        "{ value: 'gemini-2.0-flash-live-001', label: 'Gemini 2.0 Flash Live' }"
      );
      expect(options).toContain("{ value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' }");
      // No new option value was added for this control (the change notes above
      // mention Nova Sonic; the option-list code itself must not).
      expect(stripLineComments(options)).not.toContain('Nova');
    });
  });

  describe('FIX 5 — PERSONALITY_SURFACE_DEFS.voice_live', () => {
    it('renames the surface label to Voice (Nova Sonic)', () => {
      expect(src).toContain("label: 'Voice (Nova Sonic)'");
      expect(src).not.toContain("label: 'Voice (Gemini Live)'");
    });

    it('describes real-time Nova Sonic sessions instead of Gemini Live', () => {
      expect(src).toContain(
        "description: 'Primary voice assistant personality for real-time Nova Sonic sessions.'"
      );
      expect(src).not.toContain(
        "description: 'Primary voice assistant personality for real-time Gemini Live sessions.'"
      );
      expect(src).not.toContain('real-time Gemini Live sessions');
    });

    it('leaves the voice_live sourceFile mapping untouched', () => {
      const surfaceMatch = src.match(/voice_live: \{[\s\S]*?sourceFile: '([^']+)'/);
      expect(surfaceMatch).toBeTruthy();
      expect(surfaceMatch![1]).toBe('orb-live.ts');
    });
  });

  describe('FIX 6 — Docs > Architecture page (renderDocsArchitectureView)', () => {
    it('subtitle says AWS ECS, not Cloud Run', () => {
      expect(src).toContain(
        "subtitle.textContent = 'Vitana platform architecture: Gateway, AWS ECS services, and Supabase data layer.';"
      );
    });

    it('layer names say AWS ECS, not Cloud Run', () => {
      expect(src).toContain("{ name: 'API Gateway (AWS ECS)',");
      expect(src).toContain("{ name: 'Microservices (AWS ECS)',");

      const fnBody = topLevelFunctionBody(src, 'renderDocsArchitectureView');
      expect(stripLineComments(fnBody)).not.toContain('Cloud Run');
      expect(stripLineComments(fnBody)).not.toContain('(Cloud Run)');
    });
  });

  describe('FIX 7 — Docs > Agent Workforce page (renderDocsWorkforceView)', () => {
    it('Planner now reflects Claude-via-Bedrock', () => {
      expect(src).toContain(
        "{ name: 'Planner', stage: 'Planning', model: 'Claude via AWS Bedrock',"
      );
    });

    it('Worker now reflects DeepSeek-Flash primary with Bedrock Claude fallback', () => {
      expect(src).toContain(
        "{ name: 'Worker', stage: 'Execution', model: 'DeepSeek-Flash (Bedrock Claude fallback)',"
      );
    });

    it('no dead Gemini model remains on the Workforce page', () => {
      const fnBody = topLevelFunctionBody(src, 'renderDocsWorkforceView');
      expect(stripLineComments(fnBody)).not.toContain('Gemini Pro');
      expect(stripLineComments(fnBody)).not.toContain('Gemini Flash');
      expect(fnBody).toContain("model: 'Claude via AWS Bedrock'");
    });
  });

  describe('scope guard — the ORB voice "vertex" wire value is untouched', () => {
    it('still carries VTID-03970\'s legacy-wire-value disclaimer comment', () => {
      expect(src).toContain('VTID-03970: "vertex" is a LEGACY WIRE VALUE');
      expect(src).toContain('Renaming the value itself is a separate,');
      expect(src).toContain(
        "vertexNote.textContent = '\"vertex\" here is a legacy value name for the gateway-proxied transport"
      );
    });

    it('still sends/accepts the literal wire value vertex', () => {
      expect(src).toContain("lktActiveProvider = 'vertex'");
      expect(src).toContain("['vertex', 'livekit']");
      expect(src).toContain("body: JSON.stringify({ provider: p,");
    });

    it('does not rename the user-facing "Nova Sonic (gateway transport)" flip button', () => {
      expect(src).toContain(
        "'Use ' + (p === 'vertex' ? 'Nova Sonic (gateway transport)' : 'LiveKit')"
      );
    });
  });

  describe('scope guard — excluded Command Hub blocks unchanged', () => {
    // The Memory Garden / Intelligence panel block was explicitly out of
    // scope for THIS VTID (VTID-04066) — its renderers were required to
    // stay present pending the separate T1b product decision. T1b has
    // since resolved (VTID-04093): the block was confirmed a fabricated-
    // mock-data duplicate of the real, backend-wired renderMemoryOpsView
    // (VTID-02636, already mounted live) and deleted. This guard is no
    // longer applicable to that block; nothing here asserts its absence
    // either — that's t2-no-zero-caller-functions.test.ts's job.

    it('leaves the Nova bench Serbian language option exactly as-is', () => {
      // VTID-04066: this one already carries deliberately-updated wording
      // ("Nova Sonic does not speak this ... Vertex is permanently dead") and
      // was explicitly out of scope. Pinned verbatim.
      expect(src).toContain(
        "'<option value=\"sr\">Srpski (Nova Sonic does not speak this \u2014 no working ORB voice yet; Vertex is permanently dead, GCP decommissioned, so there is no fallback destination either)</option>'"
      );
    });
  });

  describe('cache-bust bump in index.html', () => {
    it('bumps both styles.css and app.js together, kept in sync (at or after VTID-04066)', () => {
      const html = readIndexHtml();

      const stylesMatch = html.match(/\/command-hub\/styles\.css\?v=([^"]+)"/);
      const appMatch = html.match(/\/command-hub\/app\.js\?v=([^"]+)"/);
      expect(stylesMatch).toBeTruthy();
      expect(appMatch).toBeTruthy();
      expect(stylesMatch![1]).toBe(appMatch![1]);
      // Past the previous marker, so the browser cannot serve a stale copy. Asserted
      // "at or after" rather than pinned to this exact literal — a later sibling PR
      // legitimately re-bumps this marker further, and pinning an exact string here
      // would break every such PR (the VTID-04028/04031 pattern).
      expect(stylesMatch![1] > '20260918-vtid-04061-dead-code-removed').toBe(true);
    });
  });
});
