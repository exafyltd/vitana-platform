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

describe('parseExecutionJson', () => {
  it('parses a clean JSON object', () => {
    const raw = JSON.stringify({
      files: [{ path: 'a/b.ts', action: 'create', content: 'export {};' }],
      pr_title: 'T',
      pr_body: 'B',
    });
    const out = parseExecutionJson(raw);
    if ('error' in out) throw new Error(`unexpected: ${out.error}`);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('a/b.ts');
    expect(out.pr_title).toBe('T');
  });

  it('strips ```json fences the model often adds', () => {
    const raw = [
      'Here you go:',
      '```json',
      JSON.stringify({
        files: [{ path: 'x.ts', action: 'create', content: 'c' }],
        pr_title: 't',
        pr_body: 'b',
      }),
      '```',
    ].join('\n');
    const out = parseExecutionJson(raw);
    if ('error' in out) throw new Error(`unexpected: ${out.error}`);
    expect(out.files[0].path).toBe('x.ts');
  });

  it('recovers JSON when the model adds leading narration before {', () => {
    const raw = 'Sure. Here is the structured output you asked for: { "files": [{"path":"a.ts","action":"create","content":"x"}], "pr_title":"t", "pr_body":"b" }';
    const out = parseExecutionJson(raw);
    if ('error' in out) throw new Error(`unexpected: ${out.error}`);
    expect(out.files[0].path).toBe('a.ts');
  });

  it('errors on malformed JSON', () => {
    const out = parseExecutionJson('{"files": [oops');
    expect('error' in out).toBe(true);
  });

  it('errors when JSON is missing files array', () => {
    const raw = JSON.stringify({ pr_title: 't', pr_body: 'b' });
    const out = parseExecutionJson(raw);
    expect('error' in out).toBe(true);
  });

  it('errors when no JSON object is found', () => {
    const out = parseExecutionJson('no braces here at all');
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

  it('specifies the JSON output contract so the parser can rely on it', () => {
    const p = buildExecutionPrompt('f', 1, 'body', [], 'b');
    expect(p).toMatch(/"files"/);
    expect(p).toMatch(/"pr_title"/);
    expect(p).toMatch(/"pr_body"/);
    expect(p).toMatch(/"action": "create"/);
    expect(p).toMatch(/Allowed actions: "create", "modify", "delete"/);
  });
});
