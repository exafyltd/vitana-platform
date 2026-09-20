/**
 * VTID-04205 — the Operator Console cost/model badge's tooltip
 * (`describeTurnCost()`, shown via `badge.title`) now notes that a priced
 * dollar figure is a list-price estimate, not exact billing. The visible
 * badge text (`formatTurnCostBadge()`) and layout are unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

const FE = path.resolve(__dirname, '../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');

function fnBody(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

describe('VTID-04205 describeTurnCost — list-price estimate note', () => {
  it('appends the estimate note after a priced cost line', () => {
    const body = fnBody('describeTurnCost');
    expect(body).toContain("lines.push('(estimate \\u2014 list prices, not exact billing)')");
    expect(body).toContain("if (meta.cost_priced !== false) lines.push(");
  });

  it('the note sits inside the same meta.usage guard as the cost line, never on its own', () => {
    const body = fnBody('describeTurnCost');
    const usageGuardStart = body.indexOf('if (meta.usage) {');
    const costLine = body.indexOf("'Cost: model not in the price table'");
    const noteLine = body.indexOf('estimate \\u2014 list prices');
    const guardEnd = body.indexOf('\n    }', usageGuardStart);
    expect(usageGuardStart).toBeGreaterThan(-1);
    expect(costLine).toBeGreaterThan(usageGuardStart);
    expect(noteLine).toBeGreaterThan(costLine);
    expect(noteLine).toBeLessThan(guardEnd);
  });

  it('does NOT change the visible badge text function or its layout', () => {
    const badge = fnBody('formatTurnCostBadge');
    expect(badge).not.toContain('estimate');
    expect(badge).not.toContain('list price');
    // The badge still joins the same five possible parts the same way.
    expect(badge).toContain("parts.join(' \\u00b7 ')");
  });

  it('is a real function call, not a live regression: node --check on app.js', () => {
    // Syntax-level guard — the actual behavioral test lives in
    // vtid-04031-operator-turn-cost.test.ts's own describeTurnCost coverage,
    // which is unaffected by this addition (no branch removed, only one
    // new conditional push).
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('child_process').execSync(
        `node --check "${path.join(FE, 'app.js')}"`,
        { stdio: 'pipe' }
      );
    }).not.toThrow();
  });

  it('bumps the shared cache-bust version for app.js and styles.css together', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260920-vtid-04205-cost-badge-tooltip-estimate').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
  });
});

describe('VTID-04205 command-hub-ownership-guard allowlist', () => {
  // scripts/ci/command-hub-ownership-guard.js requires every PR touching
  // services/gateway/src/frontend/command-hub/** to carry either a
  // DEV-COMHU-* marker or a listed VTID in its branch name or PR title —
  // this PR's own branch/VTID must be added to that list, or CI rejects it.
  const {
    evaluateMarkerAuthorization,
  } = require('../../../scripts/ci/command-hub-ownership-guard.js');

  it('authorizes this VTID by branch name', () => {
    expect(evaluateMarkerAuthorization('claude/vtid-04205-cost-badge-tooltip-estimate-note', '')).toEqual({
      allowed: true,
      reason: 'allowlisted-marker',
    });
  });

  it('authorizes this VTID by PR title', () => {
    expect(
      evaluateMarkerAuthorization('some-other-branch', 'Command Hub: cost badge tooltip notes list-price estimate (VTID-04205)')
    ).toEqual({ allowed: true, reason: 'allowlisted-marker' });
  });
});
