/**
 * VTID-02937 (B4) — wall-integrity tests.
 *
 * B4 is tenure & journey-stage (read-only) ONLY. Asserts:
 *   - Command Hub Journey Stage panel renders even when no data
 *     exists.
 *   - Panel has NO mutation surface (no buttons, no onclick, no
 *     POST/PUT/PATCH/DELETE fetches).
 *   - Preview route is GET-only, admin-gated, performs no DB
 *     mutation.
 *   - JourneyStageFetcher source has no write methods (no upsert/
 *     insert/update/delete/rpc).
 *   - Compiler does no IO (no supabase / fetch / axios / timers).
 *   - Types module has no value exports (pure types only).
 *   - B4 does NOT touch ORB transport, audio, reconnect, Live API,
 *     timeout, or wake-brief-timing code paths.
 *   - B4 ships NO new migration (inline queries against existing
 *     read paths only).
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../../src/frontend/command-hub/app.js');
const ROUTE_PATH = join(__dirname, '../../../src/routes/voice-journey-stage.ts');
const FETCHER_PATH = join(__dirname, '../../../src/services/journey-stage/journey-stage-fetcher.ts');
const COMPILER_PATH = join(__dirname, '../../../src/services/journey-stage/compile-journey-stage-context.ts');
const TYPES_PATH = join(__dirname, '../../../src/services/journey-stage/types.ts');
const MIGRATIONS_DIR = join(__dirname, '../../../../../supabase/migrations');

describe('B4 — wall integrity', () => {
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
    it('defines renderJourneyContextJourneyStagePanel', () => {
      expect(appJs).toContain('function renderJourneyContextJourneyStagePanel');
    });

    it('panel handles missing js argument (empty-state branch)', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextJourneyStagePanel\(js\)\s*\{[\s\S]*?\n\}/,
      );
      expect(fnMatch).toBeTruthy();
      const body = fnMatch![0];
      expect(body).toMatch(/if\s*\(\s*!js\s*\)/);
      expect(body).toMatch(/no data — load a user above/);
    });

    it('panel is wired into the journey-context grid', () => {
      expect(appJs).toContain('renderJourneyContextJourneyStagePanel(jc.journeyStage)');
    });

    it('panel loader fetches the preview endpoint', () => {
      expect(appJs).toContain("'/api/v1/voice/journey-stage/preview'");
    });
  });

  describe('no mutation from preview/panel', () => {
    it('panel has NO mutation surface', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextJourneyStagePanel\(js\)\s*\{[\s\S]*?\n\}/,
      );
      const body = fnMatch![0];
      expect(body).not.toMatch(/createElement\(['"]button['"]\)/);
      expect(body).not.toMatch(/\.onclick\s*=/);
      expect(body).not.toMatch(/addEventListener\(['"]click['"]/);
      expect(body).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    });

    it('preview route is GET-only', () => {
      const startIdx = routeSrc.indexOf("'/voice/journey-stage/preview'");
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
    it('JourneyStageFetcher interface declares only fetch* methods', () => {
      const ifaceMatch = fetcherSrc.match(/export interface JourneyStageFetcher\s*\{[\s\S]*?\n\}/);
      expect(ifaceMatch).toBeTruthy();
      const iface = ifaceMatch![0];
      expect(iface).toMatch(/fetchAppUser/);
      expect(iface).toMatch(/fetchUserActiveDaysAggregate/);
      expect(iface).toMatch(/fetchVitanaIndexHistory/);
      expect(iface).not.toMatch(/upsert|insert|update|delete|writeStage|recordStage/);
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
    it('compileJourneyStageContext source has NO IO / DB / fetch / timers', () => {
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

  describe('B4 ships NO new migration (inline-query design)', () => {
    it('does not introduce a VTID-02937 migration file', () => {
      const files = readdirSync(MIGRATIONS_DIR);
      const b4Migrations = files.filter((f) => /VTID_02937/i.test(f) || /vtid_02937/i.test(f));
      expect(b4Migrations).toEqual([]);
    });
  });

  describe('B4 does NOT touch reliability-lane code paths', () => {
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
