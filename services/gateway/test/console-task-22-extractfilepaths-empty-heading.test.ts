/**
 * Console task 22 — `extractFilePaths()` edge case: a "Files to modify" heading
 * that is PRESENT but lists ZERO real file paths.
 *
 * Contract under test (see the comment block above `extractFilePaths` in
 * src/services/dev-autopilot-planning.ts):
 *
 *   1. heading present AND at least one real path → trust ONLY that section
 *      (prose paths like package.json / jest.config.ts must NOT leak in).
 *   2. heading present but EMPTY → fall through to the whole-document scan.
 *   3. heading absent → whole-document scan (legacy "Components"-only plans).
 *
 * Case 2 is the one this suite pins: the heading text alone must not suppress
 * the fallback scan, otherwise a plan that says "## Files to modify" and then
 * immediately starts another section loses the real targets it names in prose
 * (which would surface downstream as "plan has no files_referenced").
 */

import { extractFilePaths } from '../src/services/dev-autopilot-planning';

describe('extractFilePaths — Files-to-modify heading present but empty', () => {
  it('falls through and finds paths elsewhere when the heading is followed immediately by another heading', () => {
    const md = [
      '## Context',
      'Real change: update `services/gateway/src/services/foo.ts` to remove the unused export.',
      '',
      '## Files to modify',
      '',
      '## Verification',
      'Run the suite for services/gateway/test/services/foo.test.ts.',
    ].join('\n');

    const paths = extractFilePaths(md);
    expect(paths).toContain('services/gateway/src/services/foo.ts');
    expect(paths).toContain('services/gateway/test/services/foo.test.ts');
  });

  it('falls through when the heading is followed only by non-path prose', () => {
    const md = [
      '## Files to modify',
      'No files are touched by this change; it is documentation-only.',
      '',
      '## Context',
      'The real target is `services/gateway/src/routes/health.ts`.',
    ].join('\n');

    const paths = extractFilePaths(md);
    expect(paths).toEqual(['services/gateway/src/routes/health.ts']);
  });

  it('does not treat a bare filename under the empty heading as a path', () => {
    // "jest.config.ts" has no slash, so it is not a repo-relative path and must
    // not count as content for the section (see FILES_SECTION_LINE_RE gate).
    const md = [
      '## Files to modify',
      'jest.config.ts',
      '',
      '## Components to build / modify',
      '- services/gateway/src/services/bar.ts — the actual edit',
    ].join('\n');

    const paths = extractFilePaths(md);
    expect(paths).toEqual(['services/gateway/src/services/bar.ts']);
  });

  it('still returns an empty array when the heading is empty AND the document has no paths at all', () => {
    const md = [
      '## Context',
      'Nothing to do here.',
      '',
      '## Files to modify',
      '',
      '## Verification',
      'n/a',
    ].join('\n');

    expect(extractFilePaths(md)).toEqual([]);
  });

  it('still trusts ONLY the section when it lists at least one real path', () => {
    // Regression guard for case 1 — the empty-heading fall-through must not
    // re-enable the whole-document scan for populated sections.
    const md = [
      '## Context',
      'Check `services/gateway/package.json` for dev-dependencies.',
      '',
      '## Files to modify',
      '- services/gateway/src/services/foo.ts',
      '',
      '## Verification',
      'Run `npm test services/gateway/test/services/foo.test.ts`.',
    ].join('\n');

    expect(extractFilePaths(md)).toEqual(['services/gateway/src/services/foo.ts']);
  });
});
