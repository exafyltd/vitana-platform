// VTID-03171 — D39 PR 5c boundary guard.
//
// PR 5c lands the compatibility resolver but does NOT wire any
// consumer. Consumer migration ships in PR 5d (vertical proof on
// scoreSimplicityAlignment) and PR 5e (the remaining 8 functions).
//
// This test asserts the resolver is not yet read by:
//   - d39-taste-alignment-service.ts (the engine — PR 5d/5e territory)
//   - taste-alignment routes (no direct reads expected)
//
// And asserts the resolver IS exported from the decision-contract
// barrel + lives at the canonical path so the PR 5d wiring has a
// stable import surface.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const RESOLVER_PATH = join(
  __dirname,
  '../../../src/services/decision-contract/compatibility-resolver.ts',
);
const BARREL_PATH = join(
  __dirname,
  '../../../src/services/decision-contract/index.ts',
);
const D39_SERVICE_PATH = join(
  __dirname,
  '../../../src/services/d39-taste-alignment-service.ts',
);
const D39_ROUTE_PATH = join(
  __dirname,
  '../../../src/routes/taste-alignment.ts',
);

describe('VTID-03171 D39 PR 5c — compatibility resolver boundary', () => {
  describe('resolver lives at the canonical path', () => {
    it('compatibility-resolver.ts exists', () => {
      expect(existsSync(RESOLVER_PATH)).toBe(true);
    });
  });

  describe('decision-contract barrel exports the public surface', () => {
    let barrelSrc: string;
    beforeAll(() => {
      barrelSrc = readFileSync(BARREL_PATH, 'utf8');
    });

    it('exports getCompatibilityResolver from the barrel', () => {
      expect(barrelSrc).toMatch(/getCompatibilityResolver/);
    });

    it('exports warmCompatibilityCache for boot hook callers', () => {
      expect(barrelSrc).toMatch(/warmCompatibilityCache/);
    });

    it('exports test helpers configureCompatibilityResolverForTests + __resetCompatibilityResolverForTests', () => {
      expect(barrelSrc).toMatch(/configureCompatibilityResolverForTests/);
      expect(barrelSrc).toMatch(/__resetCompatibilityResolverForTests/);
    });

    it('exports the resolver + matrix types', () => {
      expect(barrelSrc).toMatch(/type\s+CompatibilityResolver/);
      expect(barrelSrc).toMatch(/type\s+CompatibilityMatrix/);
    });

    it('routes the barrel re-export through compatibility-resolver.ts', () => {
      expect(barrelSrc).toMatch(/from\s+['"]\.\/compatibility-resolver['"]/);
    });
  });

  describe('D39 consumer surface (per-PR contract)', () => {
    // Originally written for PR 5c ("no D39 consumer reads the
    // resolver yet"). Updated for PR 5d (VTID-03182) which migrated
    // ONLY scoreSimplicityAlignment behind the resolver. The
    // per-function vertical-proof assertions live in
    // `d39-pr5d-simplicity-vertical-proof.test.ts`; this file keeps
    // only the wider boundary guards that apply across the PR 5d-g
    // sweep.

    it('taste-alignment routes do not import the resolver', () => {
      // No route handler should reach the resolver directly — the
      // service layer is the only consumer. This stays true for
      // every PR in the 5d-g sweep.
      const src = readFileSync(D39_ROUTE_PATH, 'utf8');
      expect(src).not.toMatch(/from\s+['"][^'"]*compatibility-resolver['"]/);
      expect(src).not.toMatch(/getCompatibilityResolver\s*\(/);
      expect(src).not.toMatch(/getCompatibilityScore\s*\(/);
      expect(src).not.toMatch(/getCompatibilityMatrix\s*\(/);
    });

    it("d39-taste-alignment-service.ts still carries inline scoreMap literals for the un-migrated dimensions (proves PR 5e hasn't shipped)", () => {
      // PR 5d migrated only simplicity. The remaining 8 functions
      // still own their inline literals; PR 5e will sweep them.
      // The per-function "still has inline literal" assertions live
      // in d39-pr5d-simplicity-vertical-proof.test.ts. This is a
      // cross-cut sanity check that *some* inline scoreMap remains
      // in the file.
      const src = readFileSync(D39_SERVICE_PATH, 'utf8');
      expect(src).toMatch(/const\s+scoreMap\s*:\s*Record</);
    });
  });

  describe('PR 5c scope discipline', () => {
    let resolverSrc: string;
    beforeAll(() => {
      resolverSrc = readFileSync(RESOLVER_PATH, 'utf8');
    });

    it('resolver reads from decision_compatibility_score', () => {
      expect(resolverSrc).toMatch(/\.from\(\s*['"]decision_compatibility_score['"]\s*\)/);
    });

    it('resolver does NOT import any D39 service code (no upstream coupling)', () => {
      // The boundary direction: D39 service will import the resolver
      // in PR 5d, never the other way around. Catches a future drift
      // where someone wires the resolver into d39 service code.
      expect(resolverSrc).not.toMatch(/from\s+['"][^'"]*d39-taste-alignment-service['"]/);
      expect(resolverSrc).not.toMatch(/from\s+['"][^'"]*\.\/routes\/taste-alignment['"]/);
    });

    it('resolver uses the canonical 15s TTL constant (matches conflict-pair-resolver / policy-resolver)', () => {
      expect(resolverSrc).toMatch(/CACHE_TTL_MS\s*=\s*15_000/);
    });
  });
});
