/**
 * VTID-02988 (PR-M1.x'): structural lock-in for the executor-source-type
 * allowlist call sites in dev-autopilot-execute.ts.
 *
 * PR-M1.x (VTID-02984) extended the allowlist into autoApproveTick + the
 * two executeRecommendation guards. It missed two more sites:
 *
 *   - lazyPlanTick (line ~2807) — without coverage, test-contract-
 *     failure-scanner recs never receive a plan, so autoApproveTick can
 *     never approve them. This was the actual blocker for VTID-02977.
 *   - activationReaperTick (line ~2877) — without coverage, orphaned
 *     status='activated' rows from new scanners stay orphaned forever.
 *
 * PR-M1.x' fixes both by routing them through
 * executableSourceTypesPostgrestIn(). These tests assert the dead
 * hard-coded list cannot return without a code review noticing.
 *
 * Pure-string assertions against the source file — no runtime needed.
 */

import fs from 'fs';
import path from 'path';

const FILE = path.resolve(
  __dirname,
  '../src/services/dev-autopilot-execute.ts',
);
const source = fs.readFileSync(FILE, 'utf8');

describe('dev-autopilot-execute.ts — executor-source-type allowlist call sites', () => {
  it('imports the shared allowlist module', () => {
    expect(source).toMatch(
      /from '\.\/autopilot-executable-source-types'/,
    );
    expect(source).toMatch(/executableSourceTypesPostgrestIn/);
  });

  it('does NOT re-introduce the hard-coded source_type=in.(dev_autopilot,dev_autopilot_impact) filter', () => {
    // Anchored on the literal that PR-M1.x' replaced. If anyone
    // reintroduces this string, the test fails — they have to either
    // add a new entry to EXECUTABLE_RECOMMENDATION_SOURCE_TYPES or
    // justify a narrow eq./in.() filter elsewhere.
    expect(source).not.toContain(
      'source_type=in.(dev_autopilot,dev_autopilot_impact)',
    );
  });

  it('lazyPlanTick filters recommendations through executableSourceTypesPostgrestIn()', () => {
    const lazyPlanFn = extractFunctionBody(source, 'lazyPlanTick');
    expect(lazyPlanFn).toMatch(/autopilot_recommendations\?source_type=in\.\(\$\{executableSourceTypesPostgrestIn\(\)\}\)/);
  });

  it('activationReaperTick filters recommendations through executableSourceTypesPostgrestIn()', () => {
    const reaperFn = extractFunctionBody(source, 'activationReaperTick');
    expect(reaperFn).toMatch(/autopilot_recommendations\?source_type=in\.\(\$\{executableSourceTypesPostgrestIn\(\)\}\)/);
  });

  it('autoApproveTick (PR-M1.x baseline) still filters through executableSourceTypesPostgrestIn()', () => {
    // Regression guard for PR-M1.x — make sure PR-M1.x' did not
    // accidentally revert the baseline allowlist coverage.
    const autoApproveFn = extractFunctionBody(source, 'autoApproveTick');
    expect(autoApproveFn).toMatch(/autopilot_recommendations\?source_type=in\.\(\$\{executableSourceTypesPostgrestIn\(\)\}\)/);
  });

  it('preserves the narrow impact-only filter inside autoApproveTick (intentional, not a regression)', () => {
    // The impact-only branch deliberately uses eq.dev_autopilot_impact
    // because it's scoped to impact rules — adding non-impact scanners
    // there would be wrong. Lock this in so we don't "fix" it later.
    expect(source).toContain(
      'source_type=eq.dev_autopilot_impact&status=eq.new',
    );
  });
});

/**
 * Extracts the body of a top-level function by name. Returns the substring
 * between the `function <name>` opener and the matching closing brace
 * at column 0. Good enough for lock-in assertions; not a real parser.
 */
function extractFunctionBody(src: string, name: string): string {
  const re = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b[\\s\\S]*?\\{`,
    'm',
  );
  const m = re.exec(src);
  if (!m) throw new Error(`could not locate function ${name} in source`);
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}
