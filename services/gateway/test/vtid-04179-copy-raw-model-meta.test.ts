/**
 * VTID-04179 — "Copy raw" on the Operator Console's cost / model badge.
 *
 * The badge under an operator reply (rendered by `renderOperatorChat` from
 * `msg.meta`, VTID-04031) shows provider, model, duration, tokens and cost.
 * This task adds a small affordance beside it that copies the badge's own
 * underlying meta JSON to the clipboard for debugging.
 *
 * The JSON is built by `buildTurnCostMetaJson(meta)` in app.js — a pure
 * function with no DOM/state dependency, so it can be sliced out of the
 * source and exercised directly. app.js is a plain browser script with no
 * build step and no render harness, so behaviour is pinned by evaluating the
 * declaration out of the file (the same pattern as
 * test/command-hub/escape-html.test.ts and test/vtid-04136-*.test.ts), and the
 * wiring/structure by source text.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FE_DIR = join(__dirname, '../src/frontend/command-hub');
const APP_JS_PATH = join(FE_DIR, 'app.js');
const INDEX_HTML_PATH = join(FE_DIR, 'index.html');

const APP_JS = readFileSync(APP_JS_PATH, 'utf8');
const CSS = readFileSync(join(FE_DIR, 'styles.css'), 'utf8');

/** The body of a top-level function, from its declaration to the next one. */
function fnBody(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

/**
 * Evaluates the real `buildTurnCostMetaJson` straight out of app.js so the
 * assertions below exercise the shipped implementation, not a copy of it.
 */
function loadBuildTurnCostMetaJson(): (meta: unknown) => string {
  const match = APP_JS.match(/\nfunction buildTurnCostMetaJson\(meta\) \{[\s\S]*?\n\}\n/);
  if (!match) {
    throw new Error('buildTurnCostMetaJson(meta) declaration not found in app.js');
  }
  // eslint-disable-next-line no-new-func
  return new Function(match[0] + '\nreturn buildTurnCostMetaJson;')() as (meta: unknown) => string;
}

const buildTurnCostMetaJson = loadBuildTurnCostMetaJson();

/** Every field the badge itself is built from, per AC-1. */
const BADGE_FIELDS = [
  'provider',
  'model',
  'duration_ms',
  'usage',
  'cost_usd',
  'cost_priced',
  'model_calls',
] as const;

const SAMPLE_META = {
  provider: 'bedrock',
  model: 'eu.anthropic.claude-sonnet-4-6',
  duration_ms: 4213,
  usage: { input_tokens: 12_345, output_tokens: 678 },
  cost_usd: 0.041_2,
  cost_priced: true,
  model_calls: 2,
};

describe('VTID-04179: buildTurnCostMetaJson is pure and round-trips the badge fields', () => {
  it('JSON.parses back to exactly the badge fields of the input (AC-3)', () => {
    const parsed = JSON.parse(buildTurnCostMetaJson(SAMPLE_META));
    expect(parsed).toEqual(SAMPLE_META);
    expect(Object.keys(parsed).sort()).toEqual([...BADGE_FIELDS].sort());
  });

  it('emits exactly those seven keys — nothing else the reply meta carries (AC-1)', () => {
    const parsed = JSON.parse(
      buildTurnCostMetaJson({
        ...SAMPLE_META,
        thread_id: 'thread-secret',
        tool_calls: 3,
        prompt: 'do not copy me',
        stages: ['plan', 'final'],
      }),
    );
    expect(Object.keys(parsed).sort()).toEqual([...BADGE_FIELDS].sort());
    expect(parsed.thread_id).toBeUndefined();
    expect(parsed.tool_calls).toBeUndefined();
    expect(parsed.prompt).toBeUndefined();
  });

  it('keeps the gateway snake_case field names verbatim, including usage', () => {
    const parsed = JSON.parse(buildTurnCostMetaJson(SAMPLE_META));
    expect(parsed.usage).toEqual({ input_tokens: 12_345, output_tokens: 678 });
    expect(parsed.duration_ms).toBe(4213);
    expect(parsed.cost_priced).toBe(true);
    expect(parsed.model_calls).toBe(2);
  });

  it('is pure: same input → same output, no input mutation, no state/DOM access', () => {
    const input = JSON.parse(JSON.stringify(SAMPLE_META));
    const first = buildTurnCostMetaJson(input);
    const second = buildTurnCostMetaJson(input);
    expect(first).toBe(second);
    expect(input).toEqual(SAMPLE_META); // the builder never mutates its argument

    const body = fnBody('buildTurnCostMetaJson');
    expect(body).not.toContain('state.');
    expect(body).not.toContain('document');
    expect(body).not.toContain('window.');
    expect(body).not.toContain('navigator');
  });

  it('leaves out a field the badge never received rather than inventing a null', () => {
    const parsed = JSON.parse(buildTurnCostMetaJson({ provider: 'deepseek', model: 'deepseek-flash' }));
    expect(parsed).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect('usage' in parsed).toBe(false);
    expect('cost_usd' in parsed).toBe(false);
    expect('model_calls' in parsed).toBe(false);
  });

  it('handles an unpriced turn honestly (cost_priced false, cost 0) and survives missing meta', () => {
    const unpriced = { provider: 'router', model: 'mystery', usage: { input_tokens: 5, output_tokens: 5 }, cost_usd: 0, cost_priced: false, model_calls: 1 };
    expect(JSON.parse(buildTurnCostMetaJson(unpriced))).toEqual(unpriced);
    expect(buildTurnCostMetaJson(undefined)).toBe('{}');
    expect(buildTurnCostMetaJson(null)).toBe('{}');
  });

  it('emits the pretty-printed JSON a debugging paste wants, not a one-liner', () => {
    const json = buildTurnCostMetaJson(SAMPLE_META);
    expect(json.split('\n').length).toBeGreaterThan(1);
    expect(json).toContain('\n  "provider": "bedrock"');
  });
});

describe('VTID-04179: the "Copy raw" affordance on the reply badge', () => {
  it('renders beside the badge on the reply meta row only, wired to the builder', () => {
    const body = fnBody('renderOperatorChat');
    expect(body).toContain('var badgeText = formatTurnCostBadge(msg.meta);');
    expect(body).toContain("rawBtn.className = 'message-cost-badge-copy';");
    expect(body).toContain("rawBtn.textContent = 'Copy raw';");
    expect(body).toContain('navigator.clipboard.writeText(buildTurnCostMetaJson(msg.meta))');
    // Inside the same `if (!isSent && msg.meta && msg.meta.provider)` block as
    // the badge, i.e. replies only — never on the operator's own messages.
    const guard = body.indexOf('if (!isSent && msg.meta && msg.meta.provider) {');
    const rawBtn = body.indexOf("rawBtn.className = 'message-cost-badge-copy';");
    expect(guard).toBeGreaterThan(-1);
    expect(rawBtn).toBeGreaterThan(guard);
  });

  it('labels itself for hover and assistive tech, and confirms the copy transiently', () => {
    const body = fnBody('renderOperatorChat');
    expect(body).toContain("rawBtn.title = 'Copy raw model meta JSON';");
    expect(body).toContain("rawBtn.setAttribute('aria-label', 'Copy raw model meta JSON');");
    expect(body).toContain("rawBtn.textContent = 'Copied';");
    expect(body).toContain("rawBtn.classList.add('message-cost-badge-copy--copied');");
    expect(body).toContain('}, 1500);');
    // Clipboard failures stay a quiet no-op, matching the message copy button.
    expect(body).toContain('.catch(function () { /* ignore */ });');
  });

  it('ships its styles and bumps the cache-bust for both app.js and styles.css', () => {
    expect(CSS).toContain('.message-cost-badge-copy {');
    expect(CSS).toContain('.message-cost-badge-copy--copied {');
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (html.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    const cssVersion = (html.match(/styles\.css\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    // "at or after", not exact-match — a later sibling PR legitimately re-bumps
    // this marker (the VTID-04028/04031/04074 pattern).
    expect(appVersion >= '20260920-vtid-04179-copy-raw-model-meta').toBe(true);
    expect(cssVersion).toBe(appVersion);
  });
});
