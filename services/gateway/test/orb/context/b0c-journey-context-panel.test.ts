/**
 * B0c acceptance check #4 — Match Journey panel renders even at journeyStage='none'.
 *
 * The plan's hard rule: "Command Hub renders the Match Journey panel with
 * journeyStage: 'none', source health for match_journey_context, and
 * suppression / none state visible. The panel MUST be visible — never
 * hidden because the journey is empty."
 *
 * This test is structural / source-level. The Command Hub renderer is
 * pure DOM JS inside app.js (no React, no JSX) and isn't easily mounted
 * inside Jest. We assert the source-level contract instead:
 *
 *   1. The renderJourneyContextMatchJourneyPanel function exists.
 *   2. It accepts `preview` and tolerates `preview === null/undefined`
 *      (no early return on missing data — the empty state IS the state).
 *   3. It references each required row label, so an operator can read:
 *      - current surface
 *      - journey stage
 *      - recommended next move
 *      - privacyMode + privacyGate
 *      - source health for match_journey_context
 *      - suppression reason placeholder
 *
 * Plus the route-level contract:
 *
 *   4. The compiler returns `compiled.matchJourney.journeyStage === 'none'`
 *      when no match context exists (acceptance check #2, re-validated
 *      here in the B0c file so the test passes on its own).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { compileContext } from '../../../src/orb/context/context-compiler';
import type { ClientContextEnvelope } from '../../../src/orb/context/client-context-envelope';

const APP_JS_PATH = join(
  __dirname,
  '../../../src/frontend/command-hub/app.js',
);

function readAppJs(): string {
  return readFileSync(APP_JS_PATH, 'utf8');
}

describe('B0c — Journey Context Match Journey panel', () => {
  describe('source-level (Command Hub renderer)', () => {
    let src: string;
    beforeAll(() => {
      src = readAppJs();
    });

    it('defines renderJourneyContextMatchJourneyPanel', () => {
      expect(src).toContain('function renderJourneyContextMatchJourneyPanel');
    });

    it('does NOT early-return when match journey is absent (panel always renders)', () => {
      // The function must not contain a guard like `if (!mj) return;` that
      // would suppress the panel when context is empty.
      const fnMatch = src.match(
        /function renderJourneyContextMatchJourneyPanel\(preview\)\s*\{[\s\S]*?\n\}/,
      );
      expect(fnMatch).toBeTruthy();
      const fnBody = fnMatch![0];
      // Defensive: must accept missing data via fallbacks, not bail out.
      expect(fnBody).not.toMatch(/if\s*\(\s*!mj\s*\)\s*return/);
      expect(fnBody).not.toMatch(/if\s*\(\s*!preview\s*\)\s*return/);
      // Must explicitly default the stage to 'none' when missing.
      expect(fnBody).toContain("'none'");
    });

    it('renders every required row label', () => {
      const fnMatch = src.match(
        /function renderJourneyContextMatchJourneyPanel\(preview\)\s*\{[\s\S]*?\n\}/,
      );
      const fnBody = fnMatch![0];
      const requiredRows = [
        'current surface',
        'journey stage',
        'recommended next move',
        'pending user decision',
        'privacyMode',
        'privacyGate',
        'source health',
        'suppression reason',
      ];
      for (const label of requiredRows) {
        expect(fnBody).toContain(label);
      }
    });

    it('is wired into the voice section tab handler', () => {
      // The Voice → Journey Context tab must be wired so navigating to
      // /command-hub/voice/journey-context/ actually renders this panel.
      expect(src).toContain("'journey-context'");
      expect(src).toContain('/command-hub/voice/journey-context/');
      expect(src).toContain('renderJourneyContextView');
    });
  });

  describe('compiler contract (B0c acceptance check restated)', () => {
    function makeEnvelope(
      over: Partial<ClientContextEnvelope> = {},
    ): ClientContextEnvelope {
      return {
        surface: 'mobile',
        localNow: '2026-05-11T18:30:00+02:00',
        timezone: 'Europe/Berlin',
        deviceClass: 'ios_webview',
        privacyMode: 'private',
        ...over,
      };
    }

    it('returns matchJourney.journeyStage="none" when no match context exists', async () => {
      const result = await compileContext({
        userId: 'user-b0c',
        tenantId: 'tenant-b0c',
        envelope: makeEnvelope(),
        nowMs: Date.UTC(2026, 4, 11, 18, 30, 0),
      });
      expect(result.compiled.matchJourney).toBeDefined();
      expect(result.compiled.matchJourney.journeyStage).toBe('none');
    });

    it('source health includes match_journey_context (panel can render it)', async () => {
      const result = await compileContext({
        userId: 'user-b0c',
        tenantId: 'tenant-b0c',
        envelope: makeEnvelope(),
        nowMs: Date.UTC(2026, 4, 11, 18, 30, 0),
      });
      const sources = result.compiled.sourceHealth.timings.map((t) => t.source);
      expect(sources).toContain('match_journey_context');
    });
  });
});
