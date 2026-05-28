// VTID-03169 — D39 PR 5b seed migration shape guard.
//
// Asserts the seed migration that populates `decision_compatibility_score`
// with the 138-cell D39 matrix snapshot from the rev e962dbe7 of
// services/gateway/src/services/d39-taste-alignment-service.ts:
//
//   - All 9 dimensions are present with the exact cell counts from the
//     PR 5b brief (simplicity 9, premium 12, aesthetic 36, tone 36,
//     routine 6, social 12, convenience 9, experience 9, novelty 9).
//   - aesthetic + tone are full-grid 6×6 (no implicit resolver default).
//   - Every (dimension, profile_value, candidate_value) tuple is unique
//     within the migration.
//   - Every score is in [0, 1].
//   - Every row uses `tenant_id = NULL`, `version = 1`, `source = 'seed'`.
//   - Idempotency is via ON CONFLICT DO NOTHING (relies on the
//     NULLS NOT DISTINCT constraint from PR 5a).
//   - PR 5b also seeds three `decision_policy` JSONB rows
//     (`taste_alignment.scoring_weights`, `.thresholds`, `.tag_emission`).
//   - Scope discipline: no D39 service code or resolver imports.

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname,
  '../../../../../supabase/migrations/' +
    '20260605000000_VTID_03169_seed_compatibility_matrices.sql',
);

interface ParsedRow {
  dimension: string;
  profile_value: string;
  candidate_value: string;
  score: number;
  tenant_id: string; // 'NULL' literal expected
  version: number;
  source: string;
}

/**
 * Parse every `('dim', 'profile', 'cand', <score>, '<rationale>',
 * NULL, <version>, '<source>')` VALUES row from the migration SQL.
 * Returns one entry per row across all 9 dimension INSERTs.
 */
function parseSeedRows(sql: string): ParsedRow[] {
  // Rows look like:
  //   ('simplicity', 'minimalist', 'simple', 1.00, 'perfect match', NULL, 1, 'seed'),
  // We match anything in single quotes for the string fields and the
  // numeric score / version. The rationale may contain a comma, so we
  // capture it with `[^']*`. Trailing comma OR closing paren both OK.
  const re =
    /\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*([0-9]+\.[0-9]+)\s*,\s*'([^']*)'\s*,\s*NULL\s*,\s*([0-9]+)\s*,\s*'([a-z_]+)'\s*\)/g;
  const out: ParsedRow[] = [];
  let m;
  while ((m = re.exec(sql)) !== null) {
    out.push({
      dimension: m[1],
      profile_value: m[2],
      candidate_value: m[3],
      score: Number.parseFloat(m[4]),
      tenant_id: 'NULL',
      version: Number.parseInt(m[6], 10),
      source: m[7],
    });
  }
  return out;
}

describe('VTID-03169 D39 PR 5b — compatibility seed migration', () => {
  let sql: string;
  let rows: ParsedRow[];
  beforeAll(() => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
    rows = parseSeedRows(sql);
  });

  describe('idempotency posture', () => {
    it('uses ON CONFLICT DO NOTHING (PR 5a NULLS NOT DISTINCT constraint)', () => {
      const occurrences = sql.match(/ON\s+CONFLICT\s+DO\s+NOTHING/gi) ?? [];
      // 9 compatibility-score INSERTs (one per dimension), each gated
      // with ON CONFLICT DO NOTHING. The three decision_policy seeds
      // use WHERE NOT EXISTS instead, so they don't add to the count.
      expect(occurrences.length).toBeGreaterThanOrEqual(9);
    });

    it('decision_policy seeds use WHERE NOT EXISTS (matches decision_policy unique constraint shape)', () => {
      // The decision_policy unique constraint pre-dates NULLS NOT DISTINCT;
      // VTID-03113/03140/03142 used WHERE NOT EXISTS as the idempotency
      // idiom — keep it for the three taste_alignment rows.
      const matches = sql.match(/WHERE NOT EXISTS\s*\(\s*SELECT 1 FROM decision_policy/g) ?? [];
      expect(matches.length).toBe(3);
    });

    it('migration is re-runnable: no DELETE / TRUNCATE statements', () => {
      expect(sql).not.toMatch(/\bDELETE\s+FROM\s+decision_compatibility_score/i);
      expect(sql).not.toMatch(/\bTRUNCATE\s+decision_compatibility_score/i);
    });
  });

  describe('cell counts per dimension', () => {
    const EXPECTED: Record<string, number> = {
      simplicity:  9,
      premium:    12,
      aesthetic:  36,
      tone:       36,
      routine:     6,
      social:     12,
      convenience: 9,
      experience:  9,
      novelty:     9,
    };

    for (const [dim, expected] of Object.entries(EXPECTED)) {
      it(`${dim} has exactly ${expected} cells`, () => {
        const dimRows = rows.filter(r => r.dimension === dim);
        expect(dimRows.length).toBe(expected);
      });
    }

    it('total cell count is exactly 138 across all dimensions', () => {
      expect(rows.length).toBe(138);
    });
  });

  describe('aesthetic and tone are full 6×6 grids', () => {
    const SIX_VALUES_AESTHETIC = [
      'modern', 'classic', 'eclectic', 'natural', 'functional', 'neutral',
    ];
    const SIX_VALUES_TONE = [
      'technical', 'expressive', 'casual', 'professional', 'minimalist', 'neutral',
    ];

    function fullGridCheck(dim: string, values: string[]) {
      const dimRows = rows.filter(r => r.dimension === dim);
      const seen = new Set<string>();
      for (const r of dimRows) {
        seen.add(`${r.profile_value}|${r.candidate_value}`);
      }
      const expected = new Set<string>();
      for (const p of values) for (const c of values) expected.add(`${p}|${c}`);
      // Every expected pair is present (full grid)
      for (const pair of expected) {
        expect(seen.has(pair)).toBe(true);
      }
      // No extras
      expect(seen.size).toBe(values.length * values.length);
    }

    it('aesthetic: every (profile, candidate) pair from the 6 values is present (36/36)', () => {
      fullGridCheck('aesthetic', SIX_VALUES_AESTHETIC);
    });

    it('tone: every (profile, candidate) pair from the 6 values is present (36/36)', () => {
      fullGridCheck('tone', SIX_VALUES_TONE);
    });

    it('aesthetic diagonal cells (excluding neutral) carry score 1.0', () => {
      const nonNeutralDiag = SIX_VALUES_AESTHETIC.filter(v => v !== 'neutral');
      for (const v of nonNeutralDiag) {
        const cell = rows.find(
          r => r.dimension === 'aesthetic' && r.profile_value === v && r.candidate_value === v,
        );
        expect(cell?.score).toBe(1.0);
      }
    });

    it('aesthetic neutral row/col cells carry score 0.5', () => {
      const neutralCells = rows.filter(
        r => r.dimension === 'aesthetic' &&
          (r.profile_value === 'neutral' || r.candidate_value === 'neutral'),
      );
      // 6 neutral-profile + 5 neutral-candidate (excl. neutral×neutral dup) = 11
      expect(neutralCells.length).toBe(11);
      for (const c of neutralCells) expect(c.score).toBe(0.5);
    });

    it('tone neutral row/col cells carry score 0.5', () => {
      const neutralCells = rows.filter(
        r => r.dimension === 'tone' &&
          (r.profile_value === 'neutral' || r.candidate_value === 'neutral'),
      );
      expect(neutralCells.length).toBe(11);
      for (const c of neutralCells) expect(c.score).toBe(0.5);
    });
  });

  describe('row invariants', () => {
    it('every score is in [0, 1]', () => {
      for (const r of rows) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('every row uses tenant_id = NULL', () => {
      for (const r of rows) expect(r.tenant_id).toBe('NULL');
    });

    it('every row uses version = 1', () => {
      for (const r of rows) expect(r.version).toBe(1);
    });

    it("every row uses source = 'seed'", () => {
      for (const r of rows) expect(r.source).toBe('seed');
    });

    it('no duplicate (dimension, profile_value, candidate_value) tuples within the migration', () => {
      const seen = new Set<string>();
      for (const r of rows) {
        const key = `${r.dimension}|${r.profile_value}|${r.candidate_value}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });
  });

  describe('exact value byte-identity against the d39 service literals', () => {
    // A few spot-checks to lock the migration to the source literals.
    // Catches the case where someone edits the migration and drifts
    // from d39-taste-alignment-service.ts.
    const SPOT_CHECKS: Array<[string, string, string, number]> = [
      // simplicity scoreMap
      ['simplicity', 'minimalist', 'simple', 1.0],
      ['simplicity', 'minimalist', 'complex', 0.2],
      ['simplicity', 'comprehensive', 'complex', 1.0],
      // premium scoreMap
      ['premium', 'value_focused', 'budget', 1.0],
      ['premium', 'value_focused', 'luxury', 0.2],
      ['premium', 'premium_oriented', 'luxury', 0.9],
      // aesthetic specific cells
      ['aesthetic', 'modern', 'eclectic', 0.7],       // compat
      ['aesthetic', 'modern', 'classic', 0.3],        // mismatch
      ['aesthetic', 'functional', 'natural', 0.7],    // compat
      // tone specific cells
      ['tone', 'technical', 'minimalist', 0.7],       // compat
      ['tone', 'casual', 'professional', 0.3],        // mismatch
      // routine scoreMap
      ['routine', 'hybrid', 'fixed', 0.7],
      // social scoreMap
      ['social', 'solo_focused', 'large_group', 0.2],
      ['social', 'social_oriented', 'large_group', 1.0],
      // convenience scoreMap
      ['convenience', 'intentional_living', 'low', 0.8],
      // experience scoreMap
      ['experience', 'blended', 'hybrid', 1.0],
      // novelty scoreMap
      ['novelty', 'conservative', 'novel', 0.2],
      ['novelty', 'explorer', 'novel', 1.0],
    ];

    for (const [dim, profile, candidate, expected] of SPOT_CHECKS) {
      it(`${dim}/${profile}×${candidate} = ${expected}`, () => {
        const cell = rows.find(
          r => r.dimension === dim &&
            r.profile_value === profile &&
            r.candidate_value === candidate,
        );
        expect(cell).toBeDefined();
        expect(cell!.score).toBeCloseTo(expected, 2);
      });
    }
  });

  describe('decision_policy companion seeds', () => {
    it('seeds taste_alignment.scoring_weights with 9 dimension weights', () => {
      expect(sql).toMatch(/'taste_alignment\.scoring_weights'/);
      // Spot-check the 9 weight keys are present in the JSONB literal
      for (const dim of [
        'simplicity', 'premium', 'aesthetic', 'tone',
        'routine', 'social', 'convenience', 'experience', 'novelty',
      ]) {
        // After 'taste_alignment.scoring_weights' policy_key but before
        // the next INSERT. Loose scan: the substring must appear somewhere.
        expect(sql).toMatch(new RegExp(`"${dim}"\\s*:`));
      }
    });

    it('seeds taste_alignment.thresholds with the 6 named thresholds', () => {
      expect(sql).toMatch(/'taste_alignment\.thresholds'/);
      for (const k of [
        'exclude', 'reframe', 'good_fit', 'confidence_min_scoring',
        'sparse_data', 'exploration_boost',
      ]) {
        expect(sql).toMatch(new RegExp(`"${k}"\\s*:`));
      }
    });

    it('seeds taste_alignment.tag_emission with 10 tag rules', () => {
      expect(sql).toMatch(/'taste_alignment\.tag_emission'/);
      // 10 tags from generateAlignmentTags
      const tags = [
        'minimalist_fit', 'premium_fit', 'classic_style', 'modern_fit',
        'convenience_first', 'exploratory_ok', 'solo_appropriate',
        'social_appropriate', 'routine_compatible', 'flexible_fit',
      ];
      for (const tag of tags) {
        expect(sql).toMatch(new RegExp(`"${tag}"`));
      }
    });
  });

  describe('scope discipline — PR 5b is seed-only', () => {
    it('contains NO actual code references to the D39 service or resolver', () => {
      // The migration is allowed to NAME its source file inside the
      // `notes` audit column (single-quoted SQL string literal) — that
      // is the provenance trail an analyst wants. What's forbidden is
      // an actual code reference (e.g. an IMPORT-like construct, a
      // function call, a code-fence reference) in the SQL or comments.
      // Strip SQL comments AND single-quoted string literals before
      // scanning so the audit-trail notes don't false-positive.
      const sqlOnly = sql
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(line => line.replace(/--.*$/, ''))
        .join('\n')
        .replace(/'(?:[^']|'')*'/g, "''");
      expect(sqlOnly).not.toMatch(/d39-taste-alignment-service/);
      expect(sqlOnly).not.toMatch(/compatibility-resolver/);
    });

    it('does NOT recreate / alter the decision_compatibility_score table', () => {
      // PR 5a owns the schema. PR 5b is data-only.
      expect(sql).not.toMatch(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?decision_compatibility_score/i);
      expect(sql).not.toMatch(/ALTER\s+TABLE\s+decision_compatibility_score/i);
      expect(sql).not.toMatch(/DROP\s+TABLE\s+decision_compatibility_score/i);
    });

    it('does NOT touch the decision_compatibility_score RLS policy', () => {
      expect(sql).not.toMatch(/decision_compatibility_score_tenant_read/);
      expect(sql).not.toMatch(/decision_compatibility_score\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    });
  });
});
