import * as fs from 'fs';
import * as path from 'path';

// VTID-03449 — replaced the rotating "thinking" status text (Thinking...,
// Searching memory..., Processing your request... (10s), Still working on
// it..., Almost there... (19s)) with warmer, non-technical copy and removed
// the visible elapsed-time counter. Static checks mirror the style of the
// other orb-widget-*.test.ts files (the widget runs in the browser; we
// assert on its source so CI catches accidental regressions).

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('orb-widget thinking-status messages (VTID-03449)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('removes the old technical message arrays and the visible elapsed-time counter', () => {
    expect(source).not.toMatch(/messages_en|messages_de/);
    expect(source).not.toMatch(/Searching memory/);
    expect(source).not.toMatch(/Processing your request/);
    expect(source).not.toMatch(/Taking a bit longer than usual/);
    expect(source).not.toMatch(/text \+= ' \(' \+ elapsed \+ 's\)'/);
    expect(source).not.toMatch(/\(' \+ elapsed \+ 's\)/);
  });

  it('defines a single opener plus a 7-item primary sequence and an 8-item alternates pool', () => {
    const openerMatch = source.match(/var _THINKING_OPENER = \{[^}]*\};/);
    expect(openerMatch).not.toBeNull();
    expect(openerMatch![0]).toMatch(/en:\s*'Let me think…'/);

    const primaryMatch = source.match(/var _THINKING_PRIMARY = (\[[\s\S]*?\n  \]);/);
    expect(primaryMatch).not.toBeNull();
    const primaryCount = (primaryMatch![1].match(/\{ en:/g) || []).length;
    expect(primaryCount).toBe(7);

    const altMatch = source.match(/var _THINKING_ALTERNATES = (\[[\s\S]*?\n  \]);/);
    expect(altMatch).not.toBeNull();
    const altCount = (altMatch![1].match(/\{ en:/g) || []).length;
    expect(altCount).toBe(8);
  });

  it('every message pair has both an en and de value, short and without forbidden technical wording', () => {
    const forbidden = /\b(processing|request|retrieving|query|system)\b/i;
    const pairs = source.match(/\{ en: '[^']*', de: '[^']*' \}/g) || [];
    // opener(1) + primary(7) + alternates(8) = 16 pairs
    expect(pairs.length).toBeGreaterThanOrEqual(15);
    for (const pair of pairs) {
      expect(pair).toMatch(/en: '/);
      expect(pair).toMatch(/de: '/);
      expect(pair).not.toMatch(forbidden);
      expect(pair).not.toMatch(/\bSie\b|\bIhnen\b|\bIhr\b/); // no formal German register
    }
  });

  it('_buildThinkingQueue swaps 2 random alternates into a 7-slot copy of the primary sequence', () => {
    const body = extractFunctionBody(source, 'function _buildThinkingQueue()');
    expect(body).toMatch(/_THINKING_PRIMARY\.slice\(\)/);
    expect(body).toMatch(/_shuffled\(_THINKING_ALTERNATES\)\.slice\(0, 2\)/);
    expect(body).toMatch(/return queue;/);
  });

  it('_shuffled performs an in-place Fisher-Yates shuffle on a copy, not the original array', () => {
    const body = extractFunctionBody(source, 'function _shuffled(arr)');
    expect(body).toMatch(/arr\.slice\(\)/);
    expect(body).toMatch(/Math\.random\(\)/);
  });

  it('_startThinkingProgress rotates every 4 seconds through the per-session queue with no counter suffix', () => {
    const body = extractFunctionBody(source, 'function _startThinkingProgress()');
    expect(body).toMatch(/_buildThinkingQueue\(\)/);
    expect(body).toMatch(/Math\.floor\(elapsed \/ 4\)/);
    expect(body).toMatch(/queue\.length - 1/);
    expect(body).not.toMatch(/elapsed \+ 's'/);
    // still self-tears-down once THINKING state ends (unchanged behavior)
    expect(body).toMatch(/if \(_s\.voiceState !== 'THINKING'\)/);
    expect(body).toMatch(/clearInterval\(_s\.thinkingProgressTimer\)/);
  });

  it('shows _THINKING_OPENER (not a hardcoded "Thinking...") on both the ready and thinking SSE handlers', () => {
    expect(source).not.toMatch(/'Thinking\.\.\.'/);
    expect(source).not.toMatch(/'Denkt nach\.\.\.'/);
    expect(
      source.match(/_setStatus\(_cfg\.lang\.startsWith\('de'\) \? _THINKING_OPENER\.de : _THINKING_OPENER\.en\)/g)
        ?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });
});
