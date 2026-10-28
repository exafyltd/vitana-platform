/**
 * VTID-03889 — parser unit test for the CLAUDE.md CHANGE LOG backfill.
 *
 * Only parseChangelog() is exercised here (a pure function over a small
 * fixture string) -- the script's main() does real Bedrock/Supabase I/O and
 * is exercised manually (see the script's own header comment), not in CI.
 */

import { parseChangelog } from '../../scripts/backfill-dev-memory-from-claude-md';

const FIXTURE = `
# CLAUDE.md - Fixture

## CHANGE LOG

| Date | Change | VTID |
|------|--------|------|
| 2026-09-14 | **Short fix.** Did a thing with \`some/path.ts\`. | VTID-03889 |
| 2026-08-19 | **Doc cleanup only.** No code changed. | (docs cleanup, no VTID — see IF-THEN rule 1) |
`;

describe('parseChangelog', () => {
  it('extracts date, vtid, title, and content for a normal row', () => {
    const rows = parseChangelog(FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe('2026-09-14');
    expect(rows[0].vtid).toBe('VTID-03889');
    expect(rows[0].title).toBe('Short fix.');
    expect(rows[0].content).toContain('[2026-09-14]');
    expect(rows[0].content).toContain('Did a thing with some/path.ts');
    // Markdown bold/backtick markers must not leak into the embedded text.
    expect(rows[0].content).not.toContain('**');
    expect(rows[0].content).not.toContain('`');
  });

  it('produces vtid: null for a row with no VTID reference, rather than dropping it', () => {
    const rows = parseChangelog(FIXTURE);
    expect(rows[1].vtid).toBeNull();
    expect(rows[1].title).toBe('Doc cleanup only.');
  });

  it('returns an empty list when the CHANGE LOG header is missing', () => {
    expect(parseChangelog('# No changelog here\n\nJust prose.')).toEqual([]);
  });

  it('truncates content past MAX_CONTENT_CHARS instead of feeding an oversized string to the embedder', () => {
    const longChange = 'x'.repeat(20_000);
    const fixture = `## CHANGE LOG\n\n| Date | Change | VTID |\n|---|---|---|\n| 2026-01-01 | **Long.** ${longChange} | VTID-00001 |\n`;
    const rows = parseChangelog(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0].content.length).toBeLessThan(20_000);
    expect(rows[0].content.endsWith('...')).toBe(true);
  });
});
