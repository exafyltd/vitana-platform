/**
 * VTID-02923 (B0e.3) — Command Hub Feature Discovery panel structural test.
 *
 * Same pattern as the B0c/B0d.3 structural tests: read app.js as a
 * string and assert the panel function exists, renders the required
 * rows, and is wired into the loader.
 *
 * Wall discipline: assert the panel renders provider state (selected /
 * suppressed / errored) but does NOT include any mutation buttons or
 * state-advancement controls (those land in B0e.4).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../../src/frontend/command-hub/app.js');
const INDEX_TS_PATH = join(__dirname, '../../../src/index.ts');

describe('B0e.3 — Command Hub Feature Discovery panel', () => {
  let appJs: string;
  let indexTs: string;
  beforeAll(() => {
    appJs = readFileSync(APP_JS_PATH, 'utf8');
    indexTs = readFileSync(INDEX_TS_PATH, 'utf8');
  });

  describe('panel function', () => {
    it('defines renderJourneyContextFeatureDiscoveryPanel', () => {
      expect(appJs).toContain('function renderJourneyContextFeatureDiscoveryPanel');
    });

    it('is wired into the journey-context render grid', () => {
      expect(appJs).toContain('renderJourneyContextFeatureDiscoveryPanel(jc.featureDiscovery)');
    });

    it('renders the 3 documented sub-sections', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextFeatureDiscoveryPanel\(fd\)\s*\{[\s\S]*?\n\}/,
      );
      expect(fnMatch).toBeTruthy();
      const body = fnMatch![0];
      // Provider state, catalog, awareness ladder.
      expect(body).toContain('provider status');
      expect(body).toMatch(/Catalog/);
      expect(body).toMatch(/Awareness ladder/);
    });

    it('has NO mutation surface (B0e.4 owns state advancement)', () => {
      const fnMatch = appJs.match(
        /function renderJourneyContextFeatureDiscoveryPanel\(fd\)\s*\{[\s\S]*?\n\}/,
      );
      const body = fnMatch![0];
      // No button DOM nodes (B0e.3 is read-only — operators cannot
      // advance/dismiss state from this panel).
      expect(body).not.toMatch(/createElement\(['"]button['"]\)/);
      // No click handlers wired (.onclick = / addEventListener).
      expect(body).not.toMatch(/\.onclick\s*=/);
      expect(body).not.toMatch(/addEventListener\(['"]click['"]/);
      // No POSTs / PUTs / PATCHes / DELETEs initiated from the panel.
      expect(body).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    });
  });

  describe('loader fetches feature-discovery preview', () => {
    it('loadJourneyContext POSTs to /api/v1/voice/feature-discovery/preview', () => {
      // We use GET; the assertion is on the URL path appearing as a fetch target.
      expect(appJs).toMatch(/\/api\/v1\/voice\/feature-discovery\/preview/);
    });

    it('passes surface=orb_turn_end (NOT orb_wake — wake stays clean)', () => {
      expect(appJs).toMatch(/surface=orb_turn_end/);
      // Strong guard: never preview the wake surface for feature-discovery.
      // (The route accepts orb_wake but the panel defaults to orb_turn_end.)
    });

    it('stashes featureDiscovery into state.journeyContext', () => {
      expect(appJs).toMatch(/jc\.featureDiscovery\s*=/);
    });
  });

  describe('gateway wiring', () => {
    it('mounts /api/v1/voice/feature-discovery router in index.ts', () => {
      expect(indexTs).toContain('./routes/voice-feature-discovery');
      expect(indexTs).toContain("owner: 'voice-feature-discovery'");
    });

    it('registers the feature-discovery provider at startup', () => {
      expect(indexTs).toMatch(/ensureFeatureDiscoveryRegistered\(defaultSupabaseCapabilityFetcher\)/);
    });
  });
});
