/**
 * Unit tests for the Claude Code subprocess wrapper.
 *
 * We drive the wrapper against a tiny fake `claude` binary that prints
 * canned stream-json to stdout — no real Claude Code auth or LLM call
 * happens in CI. The goal is to lock the parser's behaviour against the
 * stream-json shape Claude Code documents: NDJSON events, assistant
 * messages with text blocks + optional usage, final result event.
 */

import { writeFileSync, chmodSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runClaude } from '../src/claude';

function makeFakeBinary(script: string): string {
  // #!/usr/bin/env node shebang — script gets piped-in stdin as real claude
  // does via `-p`.
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const path = join(dir, 'fake-claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe('runClaude (subprocess wrapper)', () => {
  it('parses a canonical stream-json transcript: assistant text + result usage', async () => {
    const bin = makeFakeBinary([
      '#!/usr/bin/env node',
      "let _ = ''; process.stdin.on('data', c => _ += c); process.stdin.on('end', () => {",
      "  // print canonical NDJSON sequence",
      "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'world.' }] } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'result', stop_reason: 'end_turn', usage: { input_tokens: 42, output_tokens: 7 } }) + '\\n');",
      "  process.exit(0);",
      "});",
    ].join('\n'));
    const r = await runClaude('say hi', { bin });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Hello world.');
    expect(r.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
    expect(r.stop_reason).toBe('end_turn');
  });

  it('falls back to result.result when no assistant text blocks were emitted', async () => {
    const bin = makeFakeBinary([
      '#!/usr/bin/env node',
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ type: 'result', result: 'final answer from result event', stop_reason: 'end_turn' }) + '\\n');",
      "  process.exit(0);",
      "});",
      "process.stdin.resume();",
    ].join('\n'));
    const r = await runClaude('anything', { bin });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('final answer from result event');
  });

  it('returns ok=false on non-zero exit, surfacing stderr tail', async () => {
    const bin = makeFakeBinary([
      '#!/usr/bin/env node',
      "process.stdin.on('end', () => {",
      "  process.stderr.write('Authentication failed — run `claude login`.\\n');",
      "  process.exit(3);",
      "});",
      "process.stdin.resume();",
    ].join('\n'));
    const r = await runClaude('anything', { bin });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exit=3/);
    expect(r.error).toMatch(/Authentication failed/);
  });

  it('returns ok=false when stdout has no parseable text', async () => {
    const bin = makeFakeBinary([
      '#!/usr/bin/env node',
      "process.stdin.on('end', () => { process.stdout.write('not json at all\\n'); process.exit(0); });",
      "process.stdin.resume();",
    ].join('\n'));
    const r = await runClaude('x', { bin });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no text output/);
  });

  it('enforces timeout + surfaces a clear error when the subprocess hangs', async () => {
    const bin = makeFakeBinary([
      '#!/usr/bin/env node',
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);", // hang forever
    ].join('\n'));
    const r = await runClaude('x', { bin, timeoutMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  it('reports a helpful error when the binary does not exist', async () => {
    const r = await runClaude('x', { bin: '/nonexistent/claude-binary', timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/failed to spawn/);
    expect(r.error).toMatch(/Claude Code installed/);
  });
});
