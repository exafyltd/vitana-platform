/**
 * Tests for Developer Autopilot execute helpers.
 *
 * Full approve/cancel flows require Supabase; covered by integration tests.
 * Unit tests here lock:
 *   - the deletion-intent parser used by the safety gate
 *   - the LLM-output JSON parser used by runExecutionSession
 *   - the execution prompt shape
 */

import {
  extractDeletions,
  parseExecutionJson,
  buildExecutionPrompt,
} from '../src/services/dev-autopilot-execute';

describe('extractDeletions', () => {
  it('detects "delete" keyword followed by a path', () => {
    const md = '- delete services/gateway/src/services/dead.ts';
    expect(extractDeletions(md)).toContain('services/gateway/src/services/dead.ts');
  });

  it('detects "remove" and "drop" keywords too', () => {
    const md = [
      '- remove services/gateway/src/routes/unused.ts',
      '- drop services/agents/legacy/thing.ts',
    ].join('\n');
    const paths = extractDeletions(md);
    expect(paths).toContain('services/gateway/src/routes/unused.ts');
    expect(paths).toContain('services/agents/legacy/thing.ts');
  });

  it('works with backtick-quoted paths', () => {
    const md = 'delete `services/gateway/src/services/old.ts`';
    expect(extractDeletions(md)).toContain('services/gateway/src/services/old.ts');
  });

  it('returns empty for plans without deletion intent', () => {
    const md = '- modify services/gateway/src/routes/auth.ts';
    expect(extractDeletions(md)).toEqual([]);
  });

  it('deduplicates repeated deletions', () => {
    const md = [
      '- delete services/gateway/src/services/foo.ts',
      'We will delete services/gateway/src/services/foo.ts in step 2.',
    ].join('\n');
    expect(extractDeletions(md)).toEqual(['services/gateway/src/services/foo.ts']);
  });
});

describe('parseExecutionJson (delimiter format)', () => {
  it('parses a complete delimiter-formatted response', () => {
    const raw = [
      '<<<PR_TITLE>>>',
      'DEV-AUTOPILOT: add tests for foo',
      '<<<END>>>',
      '',
      '<<<PR_BODY>>>',
      '## Summary',
      '',
      'Adds Jest tests for the foo module.',
      '<<<END>>>',
      '',
      '<<<FILE create services/gateway/src/routes/foo.test.ts>>>',
      "import { foo } from '../foo';",
      '',
      "describe('foo', () => {",
      "  it('does a thing', () => {",
      '    expect(foo()).toBe(42);',
      '  });',
      '});',
      '<<<END>>>',
    ].join('\n');
    const out = parseExecutionJson(raw);
    if ('error' in out) throw new Error(`unexpected: ${out.error}`);
    expect(out.pr_title).toBe('DEV-AUTOPILOT: add tests for foo');
    expect(out.pr_body).toContain('Adds Jest tests');
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('services/gateway/src/routes/foo.test.ts');
    expect(out.files[0].action).toBe('create');
    expect(out.files[0].content).toContain("import { foo } from '../foo';");
    expect(out.files[0].content).toContain('expect(foo()).toBe(42);');
  });

  it('handles source code that contains quotes, backslashes, and braces without escaping', () => {
    // The exact class of content that broke the old JSON parser.
    const code = [
      'export function render() {',
      '  const msg = "user said \\"hi\\" and then {went} away";',
      "  const re = /^[a-z]+\\s*$/;",
      '  return `Template ${msg} with ${re.source}`;',
      '}',
    ].join('\n');
    const raw = [
      '<<<PR_TITLE>>>t<<<END>>>',
      '<<<PR_BODY>>>b<<<END>>>',
      '<<<FILE create services/gateway/src/a.ts>>>',
      code,
      '<<<END>>>',
    ].join('\n');
    const out = parseExecutionJson(raw);
    if ('error' in out) throw new Error(`unexpected: ${out.error}`);
    expect(out.files[0].content).toBe(code);
  });

  it('parses multiple file blocks with actions create + modify', () => {
    const raw = [
      '<<<PR_TITLE>>>t<<<END>>>',
      '<<<PR_BODY>>>b<<<END>>>',
      '<<<FILE create a/new.ts>>>',
      'export const a = 1;',
      '<<<END>>>',
      '',
      '<<<FILE modify a/existing.ts>>>',
      'export const b = 2;',
      '<<<END>>>',
    ].join('\n');
    const out = parseExecutionJson(raw);
    if ('error' in out) throw new Error(`unexpected: ${out.error}`);
    expect(out.files).toHaveLength(2);
    expect(out.files.map(f => f.action)).toEqual(['create', 'modify']);
    expect(out.files.map(f => f.path)).toEqual(['a/new.ts', 'a/existing.ts']);
  });

  it('errors when PR_TITLE block is missing', () => {
    const raw = '<<<PR_BODY>>>b<<<END>>><<<FILE create a.ts>>>\nx\n<<<END>>>';
    const out = parseExecutionJson(raw);
    expect('error' in out).toBe(true);
  });

  it('errors when PR_BODY block is missing', () => {
    const raw = '<<<PR_TITLE>>>t<<<END>>><<<FILE create a.ts>>>\nx\n<<<END>>>';
    const out = parseExecutionJson(raw);
    expect('error' in out).toBe(true);
  });

  it('errors when no FILE blocks are emitted', () => {
    const raw = '<<<PR_TITLE>>>t<<<END>>><<<PR_BODY>>>b<<<END>>>';
    const out = parseExecutionJson(raw);
    expect('error' in out).toBe(true);
  });

  it('errors for completely malformed input', () => {
    const out = parseExecutionJson('no delimiters here at all');
    expect('error' in out).toBe(true);
  });
});

describe('buildExecutionPrompt', () => {
  it('includes finding id + plan version + branch + plan markdown', () => {
    const p = buildExecutionPrompt(
      'finding-abc',
      3,
      '## Plan body goes here.\nStep 1.',
      [],
      'dev-autopilot/deadbeef',
    );
    expect(p).toContain('finding-abc');
    expect(p).toContain('plan v3');
    expect(p).toContain('dev-autopilot/deadbeef');
    expect(p).toContain('Step 1.');
  });

  it('includes current content for existing files, marker for missing ones', () => {
    const p = buildExecutionPrompt(
      'f1',
      1,
      'body',
      [
        { path: 'services/gateway/src/routes/a.ts', exists: true, content: 'export const x = 1;', sha: 'abc' },
        { path: 'services/gateway/src/routes/a.test.ts', exists: false },
      ],
      'b',
    );
    expect(p).toContain('services/gateway/src/routes/a.ts');
    expect(p).toContain('export const x = 1;');
    expect(p).toContain('services/gateway/src/routes/a.test.ts');
    expect(p).toMatch(/does NOT exist/);
  });

  it('specifies the delimiter output contract so the parser can rely on it', () => {
    const p = buildExecutionPrompt('f', 1, 'body', [], 'b');
    expect(p).toContain('<<<PR_TITLE>>>');
    expect(p).toContain('<<<PR_BODY>>>');
    expect(p).toMatch(/<<<FILE create /);
    expect(p).toContain('<<<END>>>');
    expect(p).toMatch(/Allowed actions in the FILE header: "create", "modify", "delete"/);
    expect(p).toMatch(/verbatim/);
    // Must explicitly tell the model NOT to use JSON (prevent regression).
    expect(p).toMatch(/NOT JSON/);
  });
});
