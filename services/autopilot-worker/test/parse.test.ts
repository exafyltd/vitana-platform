import { parseExecutionOutput } from '../src/parse';

describe('parseExecutionOutput', () => {
  it('parses a canonical delimiter-formatted response', () => {
    const raw = [
      '<<<PR_TITLE>>>',
      'DEV-AUTOPILOT: add tests for foo',
      '<<<END>>>',
      '',
      '<<<PR_BODY>>>',
      '## Summary',
      '',
      'Tests for foo.',
      '<<<END>>>',
      '',
      '<<<FILE create services/gateway/src/routes/foo.test.ts>>>',
      "import { foo } from '../foo';",
      '',
      "describe('foo', () => {",
      "  it('works', () => { expect(foo()).toBe(42); });",
      '});',
      '<<<END>>>',
    ].join('\n');
    const out = parseExecutionOutput(raw);
    if ('error' in out) throw new Error(out.error);
    expect(out.pr_title).toBe('DEV-AUTOPILOT: add tests for foo');
    expect(out.files).toHaveLength(1);
    expect(out.files[0].action).toBe('create');
    expect(out.files[0].content).toContain('expect(foo()).toBe(42);');
  });

  it('returns error when PR_TITLE is missing', () => {
    const out = parseExecutionOutput('<<<PR_BODY>>>b<<<END>>><<<FILE create a.ts>>>\nx\n<<<END>>>');
    expect('error' in out).toBe(true);
  });

  it('returns error when FILE blocks are missing', () => {
    const out = parseExecutionOutput('<<<PR_TITLE>>>t<<<END>>><<<PR_BODY>>>b<<<END>>>');
    expect('error' in out).toBe(true);
  });

  it('matches gateway parser on the exact escape-heavy payload that broke the JSON path', () => {
    // Matches gateway's test `handles source code that contains quotes, backslashes, and braces without escaping`.
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
    const out = parseExecutionOutput(raw);
    if ('error' in out) throw new Error(out.error);
    expect(out.files[0].content).toBe(code);
  });
});
