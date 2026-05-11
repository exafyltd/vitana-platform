/**
 * VTID-02930 (B1) — wall-integrity tests.
 *
 * B1 is cadence/repetition/greeting policy ONLY. Asserts:
 *   - Acceptance #5: Command Hub panel renders even when no cadence data exists.
 *   - Acceptance #6: NO mutation from preview/panel routes.
 *   - B1 does NOT touch ORB transport, audio, reconnect, Live API,
 *     timeout, or wake-brief-timing code paths.
 *   - B0d wake-brief-wiring still calls decideGreetingPolicy()
 *     unchanged.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../../src/frontend/command-hub/app.js');
const ROUTE_PATH = join(__dirname, '../../../src/routes/voice-greeting-policy.ts');
const POLICY_PATH = join(__dirname, '../../../src/orb/live/instruction/greeting-policy.ts');
const WAKE_BRIEF_WIRING_PATH = join(__dirname, '../../../src/services/wake-brief-wiring.ts');

describe('B1 — wall integrity', () => {
  let appJs: string;
  let routeSrc: string;
  let policySrc: string;
  let wakeBriefSrc: string;
  beforeAll(() => {
    appJs = readFileSync(APP_JS_PATH, 'utf8');
    routeSrc = readFileSync(ROUTE_PATH, 'utf8');
    policySrc = readFileSync(POLICY_PATH, 'utf8');
    wakeBriefSrc = readFileSync(WAKE_BRIEF_WIRING_PATH, 'utf8');
  });

  describe('Acceptance #5: panel renders without data', () => {
    it('defines renderJourneyContextGreetingDecayPanel', () => {
      expect(appJs).toContain('function renderJourneyContextGreetingDecayPanel');
    });

    it('panel handles missing gd argument (empty-state branch)', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextGreetingDecayPanel\(gd\)\s*\{[\s\S]*?\n\}/,
      );
      expect(fnMatch).toBeTruthy();
      const body = fnMatch![0];
      // Renders an empty-state row when gd is falsy.
      expect(body).toMatch(/if\s*\(\s*!gd\s*\)/);
      expect(body).toMatch(/no data — set state\.greetingDecaySim/);
    });

    it('panel is wired into the journey-context grid', () => {
      expect(appJs).toContain('renderJourneyContextGreetingDecayPanel(jc.greetingDecay)');
    });
  });

  describe('Acceptance #6: no mutation from preview/panel routes', () => {
    it('panel has NO mutation surface', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextGreetingDecayPanel\(gd\)\s*\{[\s\S]*?\n\}/,
      );
      const body = fnMatch![0];
      expect(body).not.toMatch(/createElement\(['"]button['"]\)/);
      expect(body).not.toMatch(/\.onclick\s*=/);
      expect(body).not.toMatch(/addEventListener\(['"]click['"]/);
      expect(body).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    });

    it('preview route is GET-only', () => {
      const startIdx = routeSrc.indexOf("'/voice/greeting-policy/preview'");
      expect(startIdx).toBeGreaterThan(-1);
      // The block surrounding the route registration must be router.get(.
      const before = routeSrc.slice(Math.max(0, startIdx - 200), startIdx);
      expect(before).toMatch(/router\.get\(/);
    });

    it('preview route has NO DB-mutation calls', () => {
      expect(routeSrc).not.toMatch(/\.insert\(/);
      expect(routeSrc).not.toMatch(/\.update\(/);
      expect(routeSrc).not.toMatch(/\.upsert\(/);
      expect(routeSrc).not.toMatch(/\.delete\(/);
      expect(routeSrc).not.toMatch(/\.rpc\(/);
    });

    it('preview route requires exafy_admin', () => {
      expect(routeSrc).toContain('requireExafyAdmin');
    });
  });

  describe('B1 does NOT touch reliability-lane code paths', () => {
    it('greeting-policy.ts is a pure module (no IO, no DB, no fetch)', () => {
      expect(policySrc).not.toMatch(/supabase|getSupabase/);
      expect(policySrc).not.toMatch(/\bfetch\(/);
      expect(policySrc).not.toMatch(/axios/);
      expect(policySrc).not.toMatch(/\.rpc\(/);
    });

    it('greeting-policy.ts does NOT reference transport / audio / reconnect / Live API', () => {
      // The cadence signals discuss transparent_reconnect / wake_origin /
      // device_handoff as INPUTS, but the policy must not call out to
      // transport code or audio code or Live API timeout settings.
      expect(policySrc).not.toMatch(/eventSource|EventSource|WebSocket|new AudioContext|playAudio|geminiLive\.|liveSessions\./);
      expect(policySrc).not.toMatch(/reconnect_attempt\(|attemptReconnect\(/);
      expect(policySrc).not.toMatch(/setTimeout\(|setInterval\(/);
    });

    it('B0d wake-brief-wiring still calls decideGreetingPolicy with the same signature', () => {
      // Acceptance #7: B0d continuation behavior unchanged except via the
      // intended seam.
      expect(wakeBriefSrc).toContain('decideGreetingPolicy');
      expect(wakeBriefSrc).toMatch(/decideGreetingPolicy\(\{[\s\S]*?bucket:/);
    });
  });
});
