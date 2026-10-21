/**
 * VTID-02936 (B3) — wall-integrity tests.
 *
 * B3 is concept-mastery / repetition suppression (read-only) ONLY.
 * Asserts:
 *   - Command Hub Concept Mastery panel renders even when no data
 *     exists.
 *   - Panel has NO mutation surface (no buttons, no onclick, no
 *     POST/PUT/PATCH/DELETE fetches).
 *   - Preview route is GET-only, admin-gated, performs no DB
 *     mutation.
 *   - ConceptMasteryFetcher source has no write methods (no upsert/
 *     insert/update/delete/rpc) — state advancement lives in a
 *     follow-up slice.
 *   - Compiler does no IO (no supabase / fetch / axios / timers).
 *   - Types module has no value exports (pure types only).
 *   - B3 does NOT touch ORB transport, audio, reconnect, Live API,
 *     timeout, or wake-brief-timing code paths.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../../src/frontend/command-hub/app.js');
const ROUTE_PATH = join(__dirname, '../../../src/routes/voice-concept-mastery.ts');
const FETCHER_PATH = join(__dirname, '../../../src/services/concept-mastery/concept-mastery-fetcher.ts');
const COMPILER_PATH = join(__dirname, '../../../src/services/concept-mastery/compile-concept-mastery-context.ts');
const TYPES_PATH = join(__dirname, '../../../src/services/concept-mastery/types.ts');

describe('B3 — wall integrity', () => {
  let appJs: string;
  let routeSrc: string;
  let fetcherSrc: string;
  let compilerSrc: string;
  let typesSrc: string;
  beforeAll(() => {
    appJs = readFileSync(APP_JS_PATH, 'utf8');
    routeSrc = readFileSync(ROUTE_PATH, 'utf8');
    fetcherSrc = readFileSync(FETCHER_PATH, 'utf8');
    compilerSrc = readFileSync(COMPILER_PATH, 'utf8');
    typesSrc = readFileSync(TYPES_PATH, 'utf8');
  });

  describe('panel renders without data', () => {
    it('defines renderJourneyContextConceptMasteryPanel', () => {
      expect(appJs).toContain('function renderJourneyContextConceptMasteryPanel');
    });

    it('panel handles missing cm argument (empty-state branch)', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextConceptMasteryPanel\(cm\)\s*\{[\s\S]*?\n\}/,
      );
      expect(fnMatch).toBeTruthy();
      const body = fnMatch![0];
      expect(body).toMatch(/if\s*\(\s*!cm\s*\)/);
      expect(body).toMatch(/no data — load a user above/);
    });

    it('panel is wired into the journey-context grid', () => {
      expect(appJs).toContain('renderJourneyContextConceptMasteryPanel(jc.conceptMastery)');
    });

    it('panel loader fetches the preview endpoint', () => {
      expect(appJs).toContain("'/api/v1/voice/concept-mastery/preview'");
    });
  });

  describe('no mutation from preview/panel', () => {
    it('panel has NO mutation surface', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextConceptMasteryPanel\(cm\)\s*\{[\s\S]*?\n\}/,
      );
      const body = fnMatch![0];
      expect(body).not.toMatch(/createElement\(['"]button['"]\)/);
      expect(body).not.toMatch(/\.onclick\s*=/);
      expect(body).not.toMatch(/addEventListener\(['"]click['"]/);
      expect(body).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    });

    it('preview route is GET-only', () => {
      const startIdx = routeSrc.indexOf("'/voice/concept-mastery/preview'");
      expect(startIdx).toBeGreaterThan(-1);
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

  describe('fetcher has no mutator methods', () => {
    it('ConceptMasteryFetcher interface declares only listConceptState', () => {
      const ifaceMatch = fetcherSrc.match(/export interface ConceptMasteryFetcher\s*\{[\s\S]*?\n\}/);
      expect(ifaceMatch).toBeTruthy();
      const iface = ifaceMatch![0];
      expect(iface).toMatch(/listConceptState/);
      expect(iface).not.toMatch(/upsert|insert|update|delete|markMastery|recordConcept|incrementExplained/);
    });

    it('fetcher source has no Supabase write calls', () => {
      expect(fetcherSrc).not.toMatch(/\.insert\(/);
      expect(fetcherSrc).not.toMatch(/\.update\(/);
      expect(fetcherSrc).not.toMatch(/\.upsert\(/);
      expect(fetcherSrc).not.toMatch(/\.delete\(/);
      expect(fetcherSrc).not.toMatch(/\.rpc\(/);
    });
  });

  describe('compiler is pure', () => {
    it('compileConceptMasteryContext source has NO IO / DB / fetch / timers', () => {
      expect(compilerSrc).not.toMatch(/supabase|getSupabase/);
      expect(compilerSrc).not.toMatch(/\bfetch\(/);
      expect(compilerSrc).not.toMatch(/axios/);
      expect(compilerSrc).not.toMatch(/\.rpc\(/);
      expect(compilerSrc).not.toMatch(/setTimeout\(|setInterval\(/);
    });

    it('compiler accepts an injected nowMs for testability', () => {
      expect(compilerSrc).toMatch(/nowMs\?:\s*number/);
    });
  });

  describe('B3 does NOT touch reliability-lane code paths', () => {
    it('types module is pure types (no IO, no value exports)', () => {
      expect(typesSrc).not.toMatch(/supabase|getSupabase/);
      expect(typesSrc).not.toMatch(/\bfetch\(/);
      expect(typesSrc).not.toMatch(/\bconst\s+\w+\s*=\s*(?!.*\btype\b)/);
    });

    it('fetcher does NOT reference transport / audio / reconnect / Live API', () => {
      expect(fetcherSrc).not.toMatch(/EventSource|WebSocket|new AudioContext|playAudio|geminiLive\.|liveSessions\./);
      expect(fetcherSrc).not.toMatch(/reconnect_attempt\(|attemptReconnect\(/);
    });

    it('route does NOT reference transport / audio / reconnect / Live API', () => {
      expect(routeSrc).not.toMatch(/EventSource|WebSocket|new AudioContext|playAudio|geminiLive\.|liveSessions\./);
    });

    it('compiler does NOT reference transport / audio / reconnect / Live API', () => {
      expect(compilerSrc).not.toMatch(/EventSource|WebSocket|AudioContext|geminiLive|liveSessions|reconnect/);
    });
  });
});
