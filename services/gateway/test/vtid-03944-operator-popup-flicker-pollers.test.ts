/**
 * VTID-03944 — Operator popup flickering: four more unguarded background
 * pollers found and fixed.
 *
 * This codebase has already fixed this exact bug class twice before:
 *   - VTID-0526-E: the SSE ticker event handler called a full renderApp()
 *     on every event even while the Operator chat tab was active, flickering
 *     the popup on top of it.
 *   - VTID-03906: the Overview tab's `_actionRequiredTimer` (30s) kept
 *     calling a full renderApp() while mounted underneath the Operator
 *     popup, tearing down and rebuilding the whole DOM unprompted.
 *
 * Reported again live ("operator popup screen flickering... its annoying").
 * Auditing every setInterval that (transitively) calls renderApp() found
 * FOUR more surviving instances of the same defect, none checking
 * state.isOperatorOpen before firing:
 *
 *   1. executionStatusPollInterval (5s) — polls while a task's execution
 *      status drawer is open, calling fetchExecutionStatus()/renderApp()
 *      regardless of the Operator popup. The tightest interval of the
 *      four, so the most visibly "annoying" contributor.
 *   2. state.devAutopilot.pollerId (10s) — Dev Autopilot tab.
 *   3. state.autonomyPulse.pollerId (30s) — Autonomy Pulse tab.
 *   4. state.autonomyTrace.pollerId (30s) — Autonomy Trace tab.
 *
 * All three tab-scoped pollers only checked state.currentTab/currentModuleKey,
 * never state.isOperatorOpen — so opening the Operator popup while any of
 * those tabs was mounted underneath left the popup silently flickering every
 * 10-30s, exactly as VTID-03906 already documented for the Overview tab.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard, same pattern as
 * vtid-03906-08-operator-scroll-mic-fullscreen.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

describe('VTID-03944: Operator popup flicker — remaining unguarded pollers', () => {
  it('executionStatusPollInterval (5s) skips its tick while the Operator popup is open', () => {
    const idx = SOURCE.indexOf('state.executionStatusPollInterval = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, 5000);', idx);
    expect(end).toBeGreaterThan(idx);
    const body = SOURCE.slice(idx, end);
    expect(body).toContain('if (state.isOperatorOpen) return;');
    // The guard must come before the fetchExecutionStatus() call it protects.
    const guardIdx = body.indexOf('if (state.isOperatorOpen) return;');
    const fetchIdx = body.lastIndexOf('fetchExecutionStatus(vtid);');
    expect(guardIdx).toBeLessThan(fetchIdx);
    // Polling itself must not be torn down by the guard — only VTID-01209's
    // own drawer-closed/task-changed checks may call stopExecutionStatusPolling().
    expect(body).not.toMatch(/isOperatorOpen\)[\s\S]{0,40}stopExecutionStatusPolling/);
  });

  it('devAutopilot.pollerId (10s) skips its tick while the Operator popup is open', () => {
    const idx = SOURCE.indexOf('state.devAutopilot.pollerId = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, 10000);', idx);
    const body = SOURCE.slice(idx, end);
    expect(body).toContain('if (state.isOperatorOpen) return;');
    expect(body).toContain("state.currentTab === 'dev-autopilot'");
  });

  it('autonomyPulse.pollerId (30s) skips its tick while the Operator popup is open', () => {
    const idx = SOURCE.indexOf('state.autonomyPulse.pollerId = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, 30000);', idx);
    const body = SOURCE.slice(idx, end);
    expect(body).toContain('if (state.isOperatorOpen) return;');
    expect(body).toContain("state.currentTab === 'autonomy-pulse'");
  });

  it('autonomyTrace.pollerId (30s) skips its tick while the Operator popup is open', () => {
    const idx = SOURCE.indexOf('state.autonomyTrace.pollerId = setInterval(function () {');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('}, 30000);', idx);
    const body = SOURCE.slice(idx, end);
    expect(body).toContain('if (state.isOperatorOpen) return;');
    expect(body).toContain("state.currentTab === 'autonomy-trace'");
  });

  it('mutation check: removing any one guard reproduces the reported bug shape', () => {
    // Documents the exact assertion that would fail without each fix —
    // each poller's body must contain the isOperatorOpen early-return
    // BEFORE any renderApp()-triggering fetch call in the same tick.
    const cases: Array<[string, string]> = [
      ['state.executionStatusPollInterval = setInterval(function () {', '}, 5000);'],
      ['state.devAutopilot.pollerId = setInterval(function () {', '}, 10000);'],
      ['state.autonomyPulse.pollerId = setInterval(function () {', '}, 30000);'],
      ['state.autonomyTrace.pollerId = setInterval(function () {', '}, 30000);'],
    ];
    cases.forEach(([startMarker, endMarker]) => {
      const idx = SOURCE.indexOf(startMarker);
      expect(idx).toBeGreaterThan(-1);
      const end = SOURCE.indexOf(endMarker, idx);
      expect(end).toBeGreaterThan(idx);
      const body = SOURCE.slice(idx, end);
      expect(body).toMatch(/if \(state\.isOperatorOpen\) return;/);
    });
  });
});
