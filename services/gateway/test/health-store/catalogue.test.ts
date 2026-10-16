/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S2 catalogue and S5 tables.
 *
 * The TypeScript catalogue and the A1 `health_codes` seed are one catalogue:
 * this suite parses the migration and fails on any difference.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  HEALTH_CODES,
  HEALTH_DATA_CATEGORIES,
  categoryOf,
  dailyRuleOf,
  healthCodeById,
  healthCodeByKey,
  kindOf,
  sourceRankOf,
} from '../../src/services/health-store/catalogue';
import { HEALTH_STORE_TABLES } from '../../src/services/health-store/tables';

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/20261014100100_vtid_05158_health_store.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');

interface SeedRow {
  code_id: number;
  key: string;
  unit: string;
  kind: string;
  category: string;
  plausible_min: number | null;
  plausible_max: number | null;
  catalogue_allowed: boolean;
}

function parseSeed(): SeedRow[] {
  const start = sql.indexOf('INSERT INTO public.health_codes');
  const end = sql.indexOf('ON CONFLICT (code_id)', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = sql.slice(start, end);
  const rows: SeedRow[] = [];
  const re = /\(\s*(\d+)\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*([-\d.]+|NULL)\s*,\s*([-\d.]+|NULL)\s*,\s*(true|false)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    rows.push({
      code_id: Number(m[1]),
      key: m[2],
      unit: m[3],
      kind: m[4],
      category: m[5],
      plausible_min: m[6] === 'NULL' ? null : Number(m[6]),
      plausible_max: m[7] === 'NULL' ? null : Number(m[7]),
      catalogue_allowed: m[8] === 'true',
    });
  }
  return rows;
}

describe('S2 catalogue (VTID-05159)', () => {
  const seed = parseSeed();

  it('parses the A1 seed', () => {
    expect(seed.length).toBeGreaterThanOrEqual(20);
  });

  it('TypeScript catalogue equals the SQL seed, field by field', () => {
    const ts = HEALTH_CODES.map(({ daily_rule: _r, ...rest }) => rest);
    expect(ts).toEqual(seed);
  });

  it('keys and ids are unique', () => {
    expect(new Set(HEALTH_CODES.map((c) => c.key)).size).toBe(HEALTH_CODES.length);
    expect(new Set(HEALTH_CODES.map((c) => c.code_id)).size).toBe(HEALTH_CODES.length);
  });

  it('every code has a unit, kind, category, range and daily rule', () => {
    for (const c of HEALTH_CODES) {
      expect(c.unit.length).toBeGreaterThan(0);
      expect(['series_sum', 'series_stats', 'record']).toContain(c.kind);
      expect(HEALTH_DATA_CATEGORIES).toContain(c.category);
      expect(c.plausible_min).not.toBeNull();
      expect(c.plausible_max).not.toBeNull();
      expect(c.plausible_min as number).toBeLessThanOrEqual(c.plausible_max as number);
      expect(['sum', 'mean', 'min', 'max', 'last']).toContain(c.daily_rule);
    }
  });

  it('has no glucose / CGM / HbA1c code (owner decision 7)', () => {
    for (const c of HEALTH_CODES) expect(c.key).not.toMatch(/gluc|hba1c|cgm/i);
  });

  it('the category list equals the SQL CHECK', () => {
    const check = sql.match(/category\s+text NOT NULL CHECK \(category IN \(([^)]+)\)\)/);
    expect(check).not.toBeNull();
    const cats = check![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect([...HEALTH_DATA_CATEGORIES]).toEqual(cats);
  });

  it('lookups', () => {
    expect(categoryOf('steps')).toBe('activity');
    expect(kindOf('heart_rate')).toBe('series_stats');
    expect(dailyRuleOf('body_weight')).toBe('last');
    expect(categoryOf('blood_glucose')).toBeNull();
    expect(healthCodeByKey('nope')).toBeNull();
    expect(healthCodeById(1)?.key).toBe('steps');
  });

  it('source rank: device cloud > phone > aggregator > partner > self-logged; unknown last', () => {
    expect(sourceRankOf('device_cloud')).toBeLessThan(sourceRankOf('phone_store'));
    expect(sourceRankOf('phone_store')).toBeLessThan(sourceRankOf('aggregator'));
    expect(sourceRankOf('aggregator')).toBeLessThan(sourceRankOf('partner'));
    expect(sourceRankOf('partner')).toBeLessThan(sourceRankOf('manual'));
    expect(sourceRankOf('whatever')).toBeGreaterThan(sourceRankOf('voice'));
  });
});

describe('S5 HEALTH_STORE_TABLES (VTID-05159)', () => {
  it('names exactly the six member-data tables A1 creates', () => {
    expect([...HEALTH_STORE_TABLES]).toEqual([
      'health_series_5m',
      'health_series_1h',
      'health_series_1d',
      'health_observations',
      'health_ingest_batches',
      'health_ingest_quarantine',
    ]);
    for (const t of HEALTH_STORE_TABLES) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${t} (`);
  });

  it('only services/health-store/** references the store tables in gateway source', () => {
    const SRC = path.resolve(__dirname, '../../src');
    const pattern = new RegExp(`['"\`](${HEALTH_STORE_TABLES.join('|')})['"\`]`);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) {
          const rel = path.relative(SRC, full);
          if (rel.startsWith(`services${path.sep}health-store${path.sep}`)) continue;
          if (pattern.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
