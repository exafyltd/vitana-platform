/**
 * VTID-04181 — the Operator Console turn-cost badge now says what the money
 * figure actually is.
 *
 * The badge's `$0.0016` comes from `MODEL_COSTS` — the list prices the
 * router's telemetry is priced with — and the repo's own documentation says
 * so ("Rates are list prices, an estimate, not a bill",
 * docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md §19). That caveat was
 * never surfaced to the person reading the badge, who sees a dollar amount
 * with all the authority of a bill.
 *
 * AC-1 asks for a visible note or tooltip; AC-2 forbids changing any other
 * badge content or layout. The badge already has a hover breakdown
 * (`badge.title = describeTurnCost(msg.meta)`, VTID-04031), so the caveat
 * goes there: the badge text and every other tooltip line stay byte-for-byte
 * what they were.
 *
 * The functions are evaluated out of app.js itself (a plain script with no
 * module exports — the same source-extraction pattern as
 * vtid-04031-operator-turn-cost.test.ts and
 * vtid-04136-single-format-relative-time.test.ts), so this pins the real
 * rendered strings, not a copy of them.
 */

import * as fs from 'fs';
import * as path from 'path';

const FE = path.resolve(__dirname, '../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
// Editing anything under command-hub/ requires the ownership guard's marker.
const GUARD_JS = fs.readFileSync(
  path.resolve(__dirname, '../../../scripts/ci/command-hub-ownership-guard.js'),
  'utf8'
);

/** The clarifying line the badge's tooltip must carry. */
const ESTIMATE_NOTE = 'Estimate from list prices, not exact billing';

interface TurnMeta {
  provider?: string;
  model?: string;
  duration_ms?: number;
  tool_calls?: number;
  model_calls?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  cost_usd?: number;
  cost_priced?: boolean;
}

function fnBody(name: string): string {
  // Anchor on the definition at column 0 — a mention in a comment or a call
  // site earlier in the file must not select the wrong slice.
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

/** The `var TURN_COST_ESTIMATE_NOTE = '…';` declaration, as written in app.js. */
function noteDeclaration(): string {
  const m = APP_JS.match(/var TURN_COST_ESTIMATE_NOTE = '[^']*';/);
  expect(m).not.toBeNull();
  return m![0];
}

function loadFunctions(): {
  describeTurnCost: (meta: TurnMeta | null | undefined) => string;
  formatTurnCostBadge: (meta: TurnMeta | null | undefined) => string;
} {
  const src = [
    noteDeclaration(),
    fnBody('formatToolDuration'),
    fnBody('formatTokenCount'),
    fnBody('formatTurnCostUsd'),
    fnBody('formatTurnCostBadge'),
    fnBody('describeTurnCost'),
    'return { describeTurnCost: describeTurnCost, formatTurnCostBadge: formatTurnCostBadge };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(src)() as ReturnType<typeof loadFunctions>;
}

const { describeTurnCost, formatTurnCostBadge } = loadFunctions();

const PRICED: TurnMeta = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  duration_ms: 6000,
  tool_calls: 0,
  model_calls: 1,
  usage: { input_tokens: 7600, output_tokens: 700 },
  cost_usd: 0.0016,
  cost_priced: true,
};

describe('VTID-04181: the cost badge carries the list-price caveat (AC-1)', () => {
  it('appends the clarifying line to the badge tooltip for a priced turn', () => {
    const tooltip = describeTurnCost(PRICED);
    expect(tooltip).toContain(ESTIMATE_NOTE);
    // It reads as a qualifier of the dollar figure above it, not a stray line.
    const lines = tooltip.split('\n');
    const estimate = lines.findIndex((l) => l.startsWith('Est. cost: $'));
    expect(estimate).toBeGreaterThan(-1);
    expect(lines[estimate + 1]).toBe(ESTIMATE_NOTE);
  });

  it('states both halves of the claim — list prices, and not exact billing', () => {
    const tooltip = describeTurnCost(PRICED).toLowerCase();
    expect(tooltip).toContain('list prices');
    expect(tooltip).toContain('not exact billing');
    // An estimate, explicitly — the bare word "cost" would not say so.
    expect(tooltip).toContain('estimate');
  });

  it('still carries every pre-existing line, unchanged', () => {
    const lines = describeTurnCost(PRICED).split('\n');
    expect(lines).toContain('Provider: deepseek');
    expect(lines).toContain('Model: deepseek-flash');
    expect(lines).toContain('Turn: 6.0s (0 tool calls)');
    expect(lines).toContain('Tokens: 7600 in / 700 out over 1 model call');
    expect(lines).toContain('Est. cost: $0.001600');
  });

  it('does not qualify an unknown model — there is no dollar figure to qualify', () => {
    const tooltip = describeTurnCost({ ...PRICED, cost_priced: false });
    expect(tooltip).toContain('Cost: model not in the price table');
    expect(tooltip).not.toContain('Est. cost:');
    expect(tooltip).not.toContain(ESTIMATE_NOTE);
  });

  it('says nothing at all without meta, exactly as before', () => {
    expect(describeTurnCost(null)).toBe('');
    expect(describeTurnCost(undefined)).toBe('');
  });

  it('is wired onto the badge the reply renders on hover', () => {
    // The tooltip is only reachable if renderOperatorChat still sets it —
    // the badge has no other detail view.
    const chat = fnBody('renderOperatorChat');
    expect(chat).toContain('badge.title = describeTurnCost(msg.meta);');
  });
});

describe('VTID-04181: no other badge content changed (AC-2)', () => {
  it('renders the badge text byte-for-byte as before', () => {
    expect(formatTurnCostBadge(PRICED)).toBe('deepseek \u00b7 deepseek-flash \u00b7 6.0s \u00b7 7.6k\u2191 700\u2193 \u00b7 $0.0016');
  });

  it('keeps "unpriced" for a model the table does not know, and invents nothing', () => {
    expect(formatTurnCostBadge({ ...PRICED, cost_priced: false })).toBe(
      'deepseek \u00b7 deepseek-flash \u00b7 6.0s \u00b7 7.6k\u2191 700\u2193 \u00b7 unpriced'
    );
    expect(formatTurnCostBadge({ provider: 'deepseek' })).toBe('deepseek');
    expect(formatTurnCostBadge(null)).toBe('');
    expect(formatTurnCostBadge(undefined)).toBe('');
  });

  it('does not put the caveat into the badge itself — text and layout stay put', () => {
    expect(formatTurnCostBadge(PRICED)).not.toContain(ESTIMATE_NOTE);
    expect(formatTurnCostBadge(PRICED)).not.toContain('list prices');
    expect(formatTurnCostBadge(PRICED).length).toBeLessThan(80);
  });

  it('leaves the badge markup in renderOperatorChat untouched', () => {
    const chat = fnBody('renderOperatorChat');
    expect(chat).toContain("if (!isSent && msg.meta && msg.meta.provider) {");
    expect(chat).toContain("badge.className = 'message-cost-badge';");
    expect(chat).toContain('var badgeText = formatTurnCostBadge(msg.meta);');
    expect(chat).toContain('badge.textContent = badgeText;');
  });

  it('bumps the cache-bust so the changed app.js is actually served, and registers the guard marker', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260920-vtid-04181-cost-badge-tooltip').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
    // Without this, the ownership guard fails closed on the Command Hub path.
    expect(GUARD_JS).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04181/);
  });
});
