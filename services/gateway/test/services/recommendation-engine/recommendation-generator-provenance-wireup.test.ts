// VTID-03133 — Phase C.4 of the decision-contract refactor.
//
// Source-level wire-up assertions confirming `recommendation-generator.ts`
// calls `rankBatchWithProvenance` and persists the resulting trail to
// `autopilot_recommendations.provenance` via a follow-up PATCH.
//
// We assert at the source level (matching the Phase E / VTID-03036
// pattern) because the integration scaffolding for the full
// recommendation pipeline is heavy and the wire-up is the load-bearing
// contract — the behaviour (the call to the strategy, the PATCH on the
// row id) is exactly what production must do.

import * as fs from 'fs';
import * as path from 'path';

const SOURCE_PATH = path.resolve(
  __dirname,
  '../../../src/services/recommendation-engine/recommendation-generator.ts',
);

let source: string;

beforeAll(() => {
  source = fs.readFileSync(SOURCE_PATH, 'utf8');
});

describe('VTID-03133 Phase C.4 — rankBatchWithProvenance + provenance persistence', () => {
  it('imports rankBatchWithProvenance + RankProvenance from the decision-contract barrel', () => {
    expect(source).toMatch(/import\s*{[\s\S]*?\brankBatchWithProvenance\b[\s\S]*?\bRankProvenance\b[\s\S]*?}\s*from\s*['"]\.\.\/decision-contract['"]/);
  });

  it('keeps the legacy `rankBatch` import for the fallback path', () => {
    // Critical: if `rankBatchWithProvenance` throws (e.g. resolver bug),
    // we MUST fall back to the pre-C.4 scoring path so production isn''t
    // blocked. The legacy import must survive.
    expect(source).toMatch(/import\s*{[^}]*\bbuildRankerContext\b[^}]*\brankBatch\b[^}]*}\s*from\s*['"]\.\/ranking\/index-pillar-weighter['"]/);
  });

  it('invokes rankBatchWithProvenance inside the rank block', () => {
    expect(source).toMatch(/const\s+rankedWithProv\s*=\s*rankBatchWithProvenance\(\s*rankerInputs\s*,\s*rankerCtx\s*\)/);
  });

  it('keys the provenance trail by the rec index id', () => {
    expect(source).toMatch(/provenanceByIndex\.set\(\s*idxId\s*,\s*r\.provenance\s*\)/);
  });

  it('falls back to legacy rankBatch on strategy exception (non-fatal)', () => {
    expect(source).toMatch(/rankBatchWithProvenance failed[\s\S]{0,200}falling back to legacy rankBatch/);
    // The fallback path must actually call rankBatch, not just log:
    expect(source).toMatch(/rankBatch\(rankerInputs,\s*rankerCtx\)\.map/);
  });

  it('captures the inserted row id from the insert RPC return', () => {
    // The RPC's JSONB return shape is `{ ok, duplicate, id }`. We extend
    // the TS type so `insertResult.data?.id` is type-safe.
    expect(source).toMatch(/callRpc<\{\s*duplicate\?\s*:\s*boolean;\s*id\?\s*:\s*string\s*\}>/);
    expect(source).toMatch(/const\s+insertedId\s*=\s*insertResult\.data\?\.id/);
  });

  it('PATCHes autopilot_recommendations to set provenance on the inserted row', () => {
    // Direct REST UPDATE keyed on the row id. PATCH (not the RPC) so
    // the existing function signature stays untouched.
    expect(source).toMatch(/autopilot_recommendations\?id=eq\.\$\{insertedId\}/);
    expect(source).toMatch(/method:\s*['"]PATCH['"]/);
    expect(source).toMatch(/JSON\.stringify\(\{\s*provenance:\s*prov\s*\}\)/);
  });

  it('provenance PATCH failure is non-fatal (never throws upstream)', () => {
    // The PATCH lives inside its own try/catch so a network blip cannot
    // surface as a generation error. The row already exists; provenance
    // is auxiliary.
    expect(source).toMatch(/provenance UPDATE failed[\s\S]{0,200}non-fatal/);
    expect(source).toMatch(/provenance UPDATE threw[\s\S]{0,200}non-fatal/);
  });

  it('only persists provenance on non-duplicate inserts (no UPDATE on dup rows)', () => {
    // The provenance write is inside the `else` branch of
    // `if (insertResult.data?.duplicate)` so duplicate skips never fire
    // an UPDATE on a row that may belong to a different run.
    expect(source).toMatch(
      /if\s*\(\s*insertResult\.data\?\.duplicate\s*\)\s*\{[\s\S]{0,200}duplicatesSkipped\+\+;[\s\S]*?\}\s*else\s*\{[\s\S]*?provenance/,
    );
  });
});
