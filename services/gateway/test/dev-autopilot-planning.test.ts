/**
 * Tests for Developer Autopilot Stage B planning helpers.
 *
 * The full `generatePlanVersion` round-trip requires Supabase + optionally the
 * Anthropic API; covered by integration tests. Here we lock in the offline
 * parts: prompt structure, stub plan shape, file path extraction, and the
 * version-increment logic surface.
 */

import {
  buildPlanningPrompt,
  buildStubPlan,
  extractFilePaths,
  FindingForPlanning,
} from '../src/services/dev-autopilot-planning';

const baseFinding = (overrides: Partial<FindingForPlanning> = {}): FindingForPlanning => ({
  id: 'abc-123',
  title: 'Remove dead exports in orb-live',
  summary: 'Unused export `foo` detected by knip.',
  domain: 'services',
  risk_class: 'low',
  spec_snapshot: {
    signal_type: 'dead_code',
    file_path: 'services/gateway/src/services/foo.ts',
    line_number: 42,
    suggested_action: 'Remove the unused export',
    scanner: 'knip',
  },
  ...overrides,
});

describe('buildPlanningPrompt', () => {
  it('includes the finding fields in the prompt', () => {
    const p = buildPlanningPrompt(baseFinding());
    expect(p).toContain('Remove dead exports in orb-live');
    expect(p).toContain('services/gateway/src/services/foo.ts');
    expect(p).toContain('knip');
    expect(p).toContain('dead_code');
  });

  it('emphasizes plan structure and file validation in the system instructions', () => {
    const p = buildPlanningPrompt(baseFinding());
    expect(p).toMatch(/## Context/);
    expect(p).toMatch(/## Files to modify/);
    expect(p).toMatch(/## Verification/);
    expect(p).toMatch(/cite every/i);
  });

  it('includes previous plan and feedback in continue-planning mode', () => {
    const p = buildPlanningPrompt(
      baseFinding(),
      '## Context\nPrior plan body',
      'Please also add a test for the edge case in bar.ts',
    );
    expect(p).toContain('Prior plan body');
    expect(p).toContain('bar.ts');
    expect(p).toContain('Revise the plan');
  });

  it('omits the previous-plan section when neither feedback nor prior plan present', () => {
    const p = buildPlanningPrompt(baseFinding());
    expect(p).not.toContain('Previous plan');
    expect(p).not.toContain('Reviewer feedback');
  });
});

describe('buildStubPlan', () => {
  it('produces a plan with all required sections', () => {
    const md = buildStubPlan(baseFinding());
    expect(md).toMatch(/## Context/);
    expect(md).toMatch(/## Target flow/);
    expect(md).toMatch(/## Components to build \/ modify/);
    expect(md).toMatch(/## Files to modify/);
    expect(md).toMatch(/## Reused primitives/);
    expect(md).toMatch(/## Implementation order/);
    expect(md).toMatch(/## Verification/);
    expect(md).toMatch(/## Out of scope/);
  });

  it('cites a matching test file alongside the source file', () => {
    const md = buildStubPlan(baseFinding());
    expect(md).toContain('services/gateway/src/services/foo.ts');
    // Stub transforms src/foo.ts → test/foo.test.ts
    expect(md).toContain('services/gateway/test/services/foo.test.ts');
  });

  it('mentions reviewer feedback when present', () => {
    const md = buildStubPlan(baseFinding(), 'Be gentler on the typing changes');
    expect(md).toContain('Be gentler on the typing changes');
  });

  it('uses a sensible default when no file is specified', () => {
    const f = baseFinding();
    f.spec_snapshot = {};
    const md = buildStubPlan(f);
    expect(md).toContain('services/gateway/src/services/');
  });
});

describe('extractFilePaths', () => {
  it('pulls paths from the Files to modify section', () => {
    const md = [
      '## Context',
      'Some prose.',
      '',
      '## Files to modify',
      '- services/gateway/src/routes/auth.ts',
      '- services/gateway/test/routes/auth.test.ts',
      '',
      '## Verification',
      'Run tests.',
    ].join('\n');
    const paths = extractFilePaths(md);
    expect(paths).toContain('services/gateway/src/routes/auth.ts');
    expect(paths).toContain('services/gateway/test/routes/auth.test.ts');
  });

  it('also catches paths mentioned in prose', () => {
    const md = 'Modify `services/gateway/src/services/foo.ts` to remove the export.';
    const paths = extractFilePaths(md);
    expect(paths).toContain('services/gateway/src/services/foo.ts');
  });

  it('returns an empty array for a plan with no paths', () => {
    expect(extractFilePaths('## Context\nNo paths here.')).toEqual([]);
  });

  it('deduplicates repeated paths', () => {
    const md = [
      '## Files to modify',
      '- services/gateway/src/services/foo.ts',
      '',
      'Also edit services/gateway/src/services/foo.ts again.',
    ].join('\n');
    const paths = extractFilePaths(md);
    expect(paths.filter(p => p === 'services/gateway/src/services/foo.ts')).toHaveLength(1);
  });

  it('accepts sql and yaml extensions', () => {
    const md = [
      '## Files to modify',
      '- supabase/migrations/20260101_foo.sql',
      '- .github/workflows/DEPLOY.yml',
    ].join('\n');
    const paths = extractFilePaths(md);
    expect(paths).toContain('supabase/migrations/20260101_foo.sql');
    expect(paths).toContain('.github/workflows/DEPLOY.yml');
  });

  it('preserves .json extension (regression: alternation truncated to .js)', () => {
    const md = [
      '## Files to modify',
      '- services/gateway/src/routes/foo.ts',
      '- services/gateway/package.json',
      '',
      'Also bump services/agents/config.json in prose.',
    ].join('\n');
    const paths = extractFilePaths(md);
    expect(paths).toContain('services/gateway/package.json');
    expect(paths).not.toContain('services/gateway/package.js');
  });

  it('ignores prose path noise when Files to modify section is populated', () => {
    // This is the exact bug that caused every auto-generated plan to fail the
    // safety gate: the LLM mentions package.json / jest.config.ts / tsconfig
    // in the Context or Reused primitives sections for reference, but the
    // "Files to modify" section correctly names only the real targets. The
    // fallback scan used to leak all the prose paths into files_referenced
    // and then fail allow_scope.
    const md = [
      '## Context',
      'Check `services/gateway/package.json` for dev-dependencies.',
      'Reference jest config at services/gateway/jest.config.ts.',
      '',
      '## Files to modify',
      '```',
      'services/gateway/src/routes/media-hub.test.ts',
      '```',
      '',
      '## Verification',
      'Run `npm test services/gateway/src/routes/media-hub.test.ts`.',
    ].join('\n');
    const paths = extractFilePaths(md);
    expect(paths).toEqual(['services/gateway/src/routes/media-hub.test.ts']);
  });
});
