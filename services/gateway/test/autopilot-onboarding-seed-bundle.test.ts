/**
 * BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED — drift guard.
 *
 * The community onboarding Autopilot bundle is seeded at signup by a DB trigger
 * (supabase/migrations/..._seed_community_onboarding_autopilot.sql) because
 * vitana-v1 authenticates directly against Supabase Auth and never hits the
 * gateway /auth/login hook that was *supposed* to seed it. To avoid the SQL
 * bundle drifting away from the canonical TypeScript analyzer, this test parses
 * the migration and asserts the seeded rows mirror STAGE_TEMPLATES.day0
 * (source_ref, title, summary, domain, risk_level=priority, impact, effort,
 * time_estimate) EXACTLY.
 *
 * If you change day0 in community-user-analyzer.ts, update the migration's
 * VALUES list (or add a new migration) so this test passes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { STAGE_TEMPLATES, t } from '../src/services/recommendation-engine/analyzers/community-user-analyzer';

function loadSeedMigration(): string {
  const migDir = path.resolve(__dirname, '../../../supabase/migrations');
  const file = fs
    .readdirSync(migDir)
    .find((f) => f.endsWith('_seed_community_onboarding_autopilot.sql'));
  expect(file).toBeDefined();
  return fs.readFileSync(path.join(migDir, file as string), 'utf8');
}

interface SeededRow {
  source_ref: string;
  title: string;
  summary: string;
  domain: string;
  risk_level: string;
  impact_score: number;
  effort_score: number;
  time_estimate_seconds: number;
}

/** Parse the `('onboarding_*', 'title', 'summary', 'domain', 'risk', i, e, t)` VALUES rows. */
function parseSeededBundle(sql: string): Map<string, SeededRow> {
  const re =
    /\('(onboarding_[a-z0-9_]+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'([a-z]+)',\s*'([a-z]+)',\s*(\d+),\s*(\d+),\s*(\d+)\)/g;
  const out = new Map<string, SeededRow>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.set(m[1], {
      source_ref: m[1],
      title: m[2].replace(/''/g, "'"),
      summary: m[3].replace(/''/g, "'"),
      domain: m[4],
      risk_level: m[5],
      impact_score: Number(m[6]),
      effort_score: Number(m[7]),
      time_estimate_seconds: Number(m[8]),
    });
  }
  return out;
}

describe('BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED — DB seed mirrors analyzer day0', () => {
  const sql = loadSeedMigration();
  const seeded = parseSeededBundle(sql);
  const day0 = STAGE_TEMPLATES.day0;

  test('seed parses to a non-empty bundle', () => {
    expect(seeded.size).toBeGreaterThan(0);
  });

  test('seeded source_refs are EXACTLY the day0 onboarding set (no missing, no extra)', () => {
    const expected = day0.map((tpl) => tpl.signal_type).sort();
    const actual = [...seeded.keys()].sort();
    expect(actual).toEqual(expected);
  });

  test.each(STAGE_TEMPLATES.day0.map((tpl) => [tpl.signal_type, tpl] as const))(
    'day0 template %s matches the seeded row field-for-field',
    (sourceRef, tpl) => {
      const row = seeded.get(sourceRef);
      expect(row).toBeDefined();
      const copy = t(tpl.key, 'en');
      // convertCommunityUserSignal() maps risk_level = priority for non-critical.
      expect(row!.title).toBe(copy.title);
      expect(row!.summary).toBe(copy.summary);
      expect(row!.domain).toBe(tpl.domain);
      expect(row!.risk_level).toBe(tpl.priority);
      expect(row!.impact_score).toBe(tpl.impact_score);
      expect(row!.effort_score).toBe(tpl.effort_score);
      expect(row!.time_estimate_seconds).toBe(tpl.time_estimate_seconds);
    },
  );

  test('every seeded row carries source_type=community + status new via the seed function', () => {
    // The INSERT hard-codes 'community' and 'new'; assert the migration still does.
    expect(sql).toMatch(/'community',\s*\n?\s*b\.source_ref/);
    expect(sql).toMatch(/'new',/);
  });

  test('fingerprint scheme matches the TS generator (community:<uid>:<ref>, 16 hex)', () => {
    // generateCommunityUserFingerprint = sha256('community:'+uid+':'+signal).slice(0,16)
    expect(sql).toMatch(
      /substring\(encode\(digest\('community:'\s*\|\|\s*p_user_id::text\s*\|\|\s*':'\s*\|\|\s*b\.source_ref,\s*'sha256'\),\s*'hex'\)\s*for\s*16\)/,
    );
  });
});
