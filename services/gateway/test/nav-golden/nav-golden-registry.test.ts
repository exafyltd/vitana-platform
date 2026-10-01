/**
 * VTID-04517 — the golden navigation set against the registry resolver.
 *
 * Same cases and harness as the legacy baseline (VTID-04496), so the two
 * reports compare directly. Hard rules, whatever the numbers:
 *   - no small talk ever opens or offers a screen;
 *   - no production failure case (news → cart …) lands on its forbidden screen.
 * Everything else ratchets against baseline.registry.json. When a change
 * legitimately improves it, regenerate:
 *
 *   NAV_GOLDEN_WRITE_BASELINE=1 npx jest test/nav-golden/nav-golden-registry.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { GOLDEN_SET, GoldenCase } from './golden-set';
import { evaluate, formatReport, Report, summarize } from './harness';
import { liveIds, loadRegistryFixture, registryResolve } from './registry-fixture';

const BASELINE_FILE = path.join(__dirname, 'baseline.registry.json');

/**
 * Hand-offs where the right screen is the first candidate. The voice model
 * receives the list and, on an explicit "open …", will usually take the
 * first — so this is the number that matters after direct matches.
 */
function clarifiedRightFirst(rep: Report): number {
  return rep.results.filter(
    (r) => r.resolution.outcome === 'clarify' && r.case.expect.includes(r.resolution.candidates?.[0] ?? ''),
  ).length;
}
const LEGACY_FILE = path.join(__dirname, 'baseline.legacy.json');

describe('VTID-04517 golden navigation set — registry resolver', () => {
  let report: Report;

  beforeAll(async () => {
    const f = await loadRegistryFixture();
    const cases: GoldenCase[] = GOLDEN_SET.map((c) => ({
      ...c,
      expect: liveIds(f.index, c.expect),
      forbid: c.forbid ? liveIds(f.index, c.forbid) : undefined,
    }));
    report = await evaluate('registry resolver (Titan v2, 512d, golden sentences held out)', cases, (c) => registryResolve(f, c));
    // eslint-disable-next-line no-console
    console.log(`\n${formatReport(report)}\n\nclarified with the right screen first: ${clarifiedRightFirst(report)}\n`);
    if (process.env.NAV_GOLDEN_WRITE_BASELINE === '1') {
      fs.writeFileSync(
        BASELINE_FILE,
        JSON.stringify({ ...summarize(report), clarified_right_first: clarifiedRightFirst(report) }, null, 2) + '\n',
      );
    }
  }, 120_000);

  it('never acts on small talk', () => {
    expect(report.overall.false_action).toBe(0);
  });

  it('never sends a known production failure to its forbidden screen', () => {
    expect(report.results.filter((r) => r.forbidden_hit).map((r) => r.case.id)).toEqual([]);
  });

  it('beats the legacy navigator on reaching the right screen and on wrong screens', () => {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    expect(report.overall.reaches_right_screen).toBeGreaterThan(legacy.overall.reaches_right_screen);
    expect(report.overall.wrong_screen).toBeLessThanOrEqual(legacy.overall.wrong_screen);
    expect(report.overall.silent).toBeLessThan(legacy.overall.silent);
  });

  it('does not regress against its own baseline', () => {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const o = report.overall;
    expect(o.reaches_right_screen + o.clarified_with_right_option).toBeGreaterThanOrEqual(
      base.overall.reaches_right_screen + base.overall.clarified_with_right_option,
    );
    expect(o.reaches_right_screen).toBeGreaterThanOrEqual(base.overall.reaches_right_screen);
    expect(o.wrong_screen).toBeLessThanOrEqual(base.overall.wrong_screen);
    expect(o.silent).toBeLessThanOrEqual(base.overall.silent);
    expect(o.reaches_right_screen + clarifiedRightFirst(report)).toBeGreaterThanOrEqual(
      base.overall.reaches_right_screen + base.clarified_right_first,
    );
  });
});
