/**
 * VTID-05162 (Health Hub Phase 1 / B2) — the CI grep rules of Change 7:
 *   1. No module outside package A (services/health-store/**) references a
 *      health store table (S5, imported from A's HEALTH_STORE_TABLES): B
 *      never writes observations itself, the consent gate is A's ingest.
 *   2. Every writer of WRITER_SPEC routes through recordToHealthStore, after
 *      its legacy write (the call sits after the legacy write in the file).
 *   3. B2's own tables are only touched from services/health-features/**.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HEALTH_STORE_TABLES } from '../../src/services/health-store/tables';
import { HEALTH_FEATURES_TABLES } from '../../src/services/health-features/health-features-repository';

const SRC = path.join(__dirname, '../../src');

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const ALL = listTs(SRC);
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const quoted = (names: readonly string[]) => new RegExp(`['"\`](${names.join('|')})['"\`]`);

describe('health store tables are package A only (S5, VTID-05162)', () => {
  it('no file outside services/health-store/** names a store table', () => {
    const re = quoted(HEALTH_STORE_TABLES);
    const offenders = ALL.filter((f) => !rel(f).startsWith('services/health-store/')).filter((f) => re.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('B2 tables are named only by services/health-features/**', () => {
    const re = quoted(HEALTH_FEATURES_TABLES);
    const offenders = ALL.filter((f) => !rel(f).startsWith('services/health-features/')).filter((f) => re.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('services/health-features/** reaches the store only through S3 / S4 / S2 / S8 / flags', () => {
    const allowed = new Set(['ingest', 'reader', 'catalogue', 'change-hook', 'flags']);
    for (const f of ALL.filter((x) => rel(x).startsWith('services/health-features/'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+['"]\.\.\/health-store\/([^'"]+)['"]/g)) {
        expect([rel(f), allowed.has(m[1])]).toEqual([rel(f), true]);
      }
    }
  });
});

describe('every writer routes through recordToHealthStore after its legacy write (VTID-05162)', () => {
  const sites: Array<[string, string, RegExp]> = [
    ['diary (3 call sites, one chokepoint)', 'services/diary-health-extractor.ts', /upsertHealthFeatureDaily\(/],
    ['voice', 'services/voice-tools/health-log.ts', /upsertHealthFeatureDaily\(/],
    ['manual', 'routes/integrations.ts', /upsertHealthFeatureDaily\(/],
    ['ORB (log_meal / log_mood / log_vitals HR)', 'services/orb-tools/health-depth-tools.ts', /upsertHealthFeatureDaily\(/],
    ['ORB log_vitals weight / BP', 'services/orb-tools/health-depth-tools.ts', /insertWearableSamples\(/],
    ['webhook daily metrics', 'routes/connector-webhooks.ts', /upsertWearableDailyMetrics\(/],
    ['webhook workouts', 'routes/connector-webhooks.ts', /upsertWearableWorkout\(/],
    ['wearable_log_workout', 'services/action-executors.ts', /insertManualWearableWorkout\(/],
  ];

  it.each(sites)('%s', (_name, file, legacy) => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const at = src.search(legacy);
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf('recordToHealthStore(', at)).toBeGreaterThan(at);
  });

  it('the three diary call sites all go through persistDiaryHealthFeatures', () => {
    for (const f of ['routes/memory.ts', 'services/memory/diary.ts', 'services/orb-tools-shared.ts']) {
      expect(fs.readFileSync(path.join(SRC, f), 'utf8')).toContain('persistDiaryHealthFeatures(');
    }
  });
});
