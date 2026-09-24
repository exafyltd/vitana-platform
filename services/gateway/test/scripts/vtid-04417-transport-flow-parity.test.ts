/**
 * VTID-04417 (Plan v1 WS-1.5) — the transport-flow-parity rule enforces one
 * brain for decisions AND for context.
 *
 * The rule was already a blocker for inline `wake_opener` branches and
 * per-language directive maps. It now also fails a transport that:
 *   - calls `computeGreetingDecision` directly instead of the brain entry point
 *     (`decideOpeningFlow` → `decideConversationFlow`, VTID-04416);
 *   - assembles the voice context by calling a context builder directly instead
 *     of the shared session-context builder (VTID-04414).
 *
 * The rule is an ES module, so it is exercised through a child `node` process
 * — the same code CI runs, not a restatement of it.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const RULE = path.join(REPO, 'scripts/ci/impact-rules/transport-flow-parity.mjs');

function runNode(code: string): any {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function scan(src: string) {
  return runNode(
    `import { scanTransportSource } from ${JSON.stringify(RULE)};` +
      `process.stdout.write(JSON.stringify(scanTransportSource(${JSON.stringify(src)})));`,
  );
}

describe('VTID-04417: transport-flow-parity', () => {
  it('the current tree has no findings for any transport file', () => {
    const findings = runNode(
      `import { check, TRANSPORT_FILES } from ${JSON.stringify(RULE)};` +
        `const f = await check({ changedFiles: TRANSPORT_FILES.map((p) => ({ path: p, status: 'M' })), repoRoot: process.cwd() });` +
        `process.stdout.write(JSON.stringify(f));`,
    );
    expect(findings).toEqual([]);
  });

  it('covers the session-start controller as well as both routes', () => {
    const files = runNode(
      `import { TRANSPORT_FILES } from ${JSON.stringify(RULE)}; process.stdout.write(JSON.stringify(TRANSPORT_FILES));`,
    );
    expect(files).toEqual(expect.arrayContaining([
      'services/gateway/src/routes/orb-live.ts',
      'services/gateway/src/routes/orb-livekit.ts',
      'services/gateway/src/orb/live/session/live-session-controller.ts',
    ]));
  });

  it('flags a direct computeGreetingDecision call', () => {
    const r = scan('const a = 1;\nconst d = computeGreetingDecision(ctx);\n');
    expect(r.directDecisionLines).toEqual([2]);
  });

  it('flags a direct context build (legacy pack, brain, cached brain)', () => {
    const r = scan([
      'const a = await buildBootstrapContextPack(identity, sid);',
      'const b = await buildBrainSystemInstruction({ user_id });',
      'const c = await buildBrainSystemInstructionCached({ user_id });',
    ].join('\n'));
    expect(r.directContextLines).toEqual([1, 2, 3]);
  });

  it('does not flag the builder passed as a dependency, a definition, comments, or allowed lines', () => {
    const r = scan([
      'const base = await buildBaseSessionContext(req, { legacy: buildBootstrapContextPack });',
      'export async function buildBootstrapContextPack(identity, sid) {',
      '// computeGreetingDecision(ctx) used to be called here',
      ' * buildBrainSystemInstruction(x) in a doc comment',
      '// brain-parity-allow: debug route',
      'const x = await buildBrainSystemInstruction({ user_id });',
      'const y = decideOpeningFlow(ctx, { transport: "vertex" });',
    ].join('\n'));
    expect(r.directDecisionLines).toEqual([]);
    expect(r.directContextLines).toEqual([]);
  });

  it('check() turns a direct call into a blocker finding naming the line', () => {
    const findings = runNode(
      `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';` +
        `import { check } from ${JSON.stringify(RULE)};` +
        `const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfp-'));` +
        `const f = 'services/gateway/src/routes/orb-livekit.ts';` +
        `fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });` +
        `fs.writeFileSync(path.join(root, f), 'const a = 1;\\nconst p = await buildBootstrapContextPack(i, s);\\n');` +
        `const out = await check({ changedFiles: [{ path: f, status: 'M' }], repoRoot: root });` +
        `process.stdout.write(JSON.stringify(out));`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('blocker');
    expect(findings[0].line_number).toBe(2);
    expect(findings[0].message).toMatch(/shared session-context builder/);
  });
});
