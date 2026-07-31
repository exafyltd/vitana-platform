import * as fs from 'fs';
import * as path from 'path';

// VTID-03449 — replaced the rotating "thinking" status text (Thinking...,
// Searching memory..., Processing your request... (10s), Still working on
// it..., Almost there... (19s)) with warmer, non-technical copy and removed
// the visible elapsed-time counter.
//
// VTID-03451 follow-up — the first cut still showed the exact same 1-2 lines
// on almost every turn: a single fixed opener shown immediately, plus a
// narrative-ordered rotation whose 2nd slot only had a ~29% chance of being
// swapped. Since most real turns resolve before the old 4s-to-first-rotation
// delay, users saw "Let me think... / Checking what I remember..." nearly
// every time. Fixed by merging every line into one pool, shuffling it fresh
// per turn, and guarding against the first-shown line repeating back-to-back
// across turns.
//
// Static checks mirror the style of the other orb-widget-*.test.ts files
// (the widget runs in the browser; we assert on its source so CI catches
// accidental regressions).

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

describe('orb-widget thinking-status messages (VTID-03449, VTID-03451)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('removes the old technical message arrays and the visible elapsed-time counter', () => {
    expect(source).not.toMatch(/messages_en|messages_de/);
    expect(source).not.toMatch(/Searching memory/);
    expect(source).not.toMatch(/Processing your request/);
    expect(source).not.toMatch(/Taking a bit longer than usual/);
    expect(source).not.toMatch(/text \+= ' \(' \+ elapsed \+ 's\)'/);
    expect(source).not.toMatch(/\(' \+ elapsed \+ 's\)/);
  });

  it('no longer has a single fixed opener — removes _THINKING_OPENER entirely', () => {
    expect(source).not.toMatch(/_THINKING_OPENER\b/);
    expect(source).not.toMatch(/'Thinking\.\.\.'/);
    expect(source).not.toMatch(/'Denkt nach\.\.\.'/);
  });

  it('defines a 6-item quick pool, 7-item primary sequence, and 8-item alternates pool merged into one 21-item pool', () => {
    const quickMatch = source.match(/var _THINKING_QUICK = (\[[\s\S]*?\n  \]);/);
    expect(quickMatch).not.toBeNull();
    expect((quickMatch![1].match(/\{ en:/g) || []).length).toBe(6);

    const primaryMatch = source.match(/var _THINKING_PRIMARY = (\[[\s\S]*?\n  \]);/);
    expect(primaryMatch).not.toBeNull();
    expect((primaryMatch![1].match(/\{ en:/g) || []).length).toBe(7);

    const altMatch = source.match(/var _THINKING_ALTERNATES = (\[[\s\S]*?\n  \]);/);
    expect(altMatch).not.toBeNull();
    expect((altMatch![1].match(/\{ en:/g) || []).length).toBe(8);

    expect(source).toMatch(
      /var _THINKING_ALL = _THINKING_QUICK\.concat\(_THINKING_PRIMARY, _THINKING_ALTERNATES\);/,
    );
  });

  it('every message pair has both an en and de value, without forbidden technical wording or formal German register', () => {
    const forbidden = /\b(processing|request|retrieving|query|system)\b/i;
    const pairs = source.match(/\{ en: '[^']*', de: '[^']*' \}/g) || [];
    // quick(6) + primary(7) + alternates(8) = 21 pairs
    expect(pairs.length).toBe(21);
    for (const pair of pairs) {
      expect(pair).toMatch(/en: '/);
      expect(pair).toMatch(/de: '/);
      expect(pair).not.toMatch(forbidden);
      expect(pair).not.toMatch(/\bSie\b|\bIhnen\b|\bIhr\b/); // no formal German register
    }
  });

  it('_buildThinkingQueue fully shuffles the merged pool and guards against repeating the previous first line', () => {
    const body = extractFunctionBody(source, 'function _buildThinkingQueue()');
    expect(body).toMatch(/_shuffled\(_THINKING_ALL\)/);
    expect(body).toMatch(/queue\[0\]\.en === _s\.lastThinkingFirstMsg/);
    expect(body).toMatch(/_s\.lastThinkingFirstMsg = queue\[0\]\.en;/);
    expect(body).toMatch(/return queue;/);
  });

  it('_shuffled performs a Fisher-Yates shuffle on a copy, not the original array', () => {
    const body = extractFunctionBody(source, 'function _shuffled(arr)');
    expect(body).toMatch(/arr\.slice\(\)/);
    expect(body).toMatch(/Math\.random\(\)/);
  });

  it('_startThinkingProgress shows the first message immediately, then rotates every 4 seconds with no counter suffix', () => {
    const body = extractFunctionBody(source, 'function _startThinkingProgress()');
    expect(body).toMatch(/_buildThinkingQueue\(\)/);
    // shows queue[0] right away — this is what most turns actually display,
    // since they resolve before the first interval tick
    expect(body).toMatch(/_setStatus\(isDe \? queue\[0\]\.de : queue\[0\]\.en\)/);
    expect(body).toMatch(/Math\.floor\(elapsed \/ 4\)/);
    expect(body).toMatch(/queue\.length - 1/);
    expect(body).not.toMatch(/elapsed \+ 's'/);
    // still self-tears-down once THINKING state ends (unchanged behavior)
    expect(body).toMatch(/if \(_s\.voiceState !== 'THINKING'\)/);
    expect(body).toMatch(/clearInterval\(_s\.thinkingProgressTimer\)/);
  });

  it('the ready and thinking SSE handlers pick from the shared pool instead of a hardcoded opener', () => {
    expect(source).toMatch(/var readyMsg = _buildThinkingQueue\(\)\[0\];/);
    expect(source).toMatch(/_startThinkingProgress\(\); \/\/ also sets the first status line immediately/);
  });
});
