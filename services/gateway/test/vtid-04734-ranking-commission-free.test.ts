/**
 * VTID-04734 — ranking and recommendations stay commission-free.
 *
 * docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md §1.2 invariant 6 and
 * §7.2: Discover ranking, search ranking, the ORB marketplace tools, the
 * autopilot recommendation analyzers, the shopping agent and every health
 * recommendation are computed without any commission, payout or earnings
 * input. A higher commission must never make an offering rank higher or be
 * recommended more often, least of all a health product.
 *
 * Commission may be DISPLAYED to an eligible recommender elsewhere; it may
 * never be READ by the code that chooses or orders what a user is shown.
 * This test reads the source of every module in that path and fails the
 * build when one of them references a commission, payout or earnings field.
 * New files in the guarded directories are picked up automatically.
 *
 * If this fails: the fix is to remove the commercial input from the ranking
 * or recommendation code, not to loosen this list. Changing the invariant is
 * an owner decision (architecture doc §11, D-9).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../src');
const REPO_SERVICES = path.resolve(__dirname, '../..');

/** Identifiers that carry commercial value. Whole words, so "learning" never matches. */
const COMMERCIAL_REFERENCE = /commission|payout|\bearnings?\b|\bearned\b|_earned|earned_/i;

/** Source without comments, so a comment stating this rule does not trip it. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export function commercialReferences(source: string): string[] {
  return stripComments(source)
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => COMMERCIAL_REFERENCE.test(line))
    .map(({ line, n }) => `${n}: ${line}`);
}

function listTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

function matching(dir: string, re: RegExp): string[] {
  return listTs(dir).filter((f) => re.test(path.basename(f)));
}

/** Every module that selects, filters, ranks or recommends offerings or health actions. */
const GUARDED_FILES: string[] = [
  // Discover feed and search: candidate selection, filters and ranking.
  path.join(SRC, 'services/feed-ranker.ts'),
  path.join(SRC, 'services/limitations-filter.ts'),
  path.join(SRC, 'routes/discover-search.ts'),
  ...matching(path.join(SRC, 'routes'), /^discover-feed/),
  ...matching(path.join(SRC, 'services'), /^user-health-context/),
  // ORB marketplace tools: what the voice/text assistant recommends.
  ...matching(path.join(SRC, 'services/orb-tools'), /^marketplace-/),
  // Autopilot recommendation analyzers, including the health analyzer.
  ...listTs(path.join(SRC, 'services/recommendation-engine')),
  // Shopping agent: proposes cart items to a member.
  ...listTs(path.join(SRC, 'services/shopping-agent')),
];

describe('VTID-04734: ranking and recommendations read no commercial fields', () => {
  it('guards a non-trivial set of modules, all of which exist', () => {
    for (const f of GUARDED_FILES) expect(fs.existsSync(f)).toBe(true);
    // A rename that empties a directory must not turn this test into a no-op.
    expect(GUARDED_FILES.length).toBeGreaterThanOrEqual(25);
    expect(GUARDED_FILES.some((f) => f.endsWith('feed-ranker.ts'))).toBe(true);
    expect(GUARDED_FILES.some((f) => f.endsWith('marketplace-analyzer.ts'))).toBe(true);
    expect(GUARDED_FILES.some((f) => f.endsWith('agent-core.ts'))).toBe(true);
  });

  it.each(GUARDED_FILES.map((f) => [path.relative(SRC, f), f]))('%s', (_rel, file) => {
    expect(commercialReferences(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the VAEA matcher may load commission_percent but never scores or sorts by it', () => {
    const source = fs.readFileSync(path.join(REPO_SERVICES, 'vaea/src/matcher/catalog-matcher.ts'), 'utf8');
    const start = source.indexOf('const scored');
    expect(start).toBeGreaterThan(-1);
    // Everything from the scoring map to the end of the file: score, reason, filter, sort.
    expect(commercialReferences(source.slice(start))).toEqual([]);
  });
});

describe('VTID-04734: the detector itself', () => {
  it('flags commission, payout and earnings identifiers', () => {
    const planted = [
      'const score = rating * 0.5 + product.commission_rate;',
      'rows.sort((a, b) => b.recommendation_commission_rate_override - a.recommendation_commission_rate_override);',
      'if (merchant.payout_amount_minor > 0) boost += 1;',
      'const w = earnings[p.id] ?? 0;',
      'weight += item.commission_percent;',
    ].join('\n');
    expect(commercialReferences(planted)).toHaveLength(5);
  });

  it('does not flag ordinary words or comments', () => {
    const clean = [
      '// commission must never be used here',
      '/* payout is out of scope for ranking */',
      "const note = 'preference learning';",
      'const learned = true; const yearning = false;',
      "fetch('https://example.test/path');",
    ].join('\n');
    expect(commercialReferences(clean)).toEqual([]);
  });
});
