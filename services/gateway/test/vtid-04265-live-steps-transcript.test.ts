/**
 * VTID-04265: Autopilot Live step/tool-call transcript.
 *
 * Part of the Command Hub Autopilot supervisor-visibility task list named
 * in VTID-04262's CHANGE LOG row. The Autopilot Live view's Dev Autopilot
 * execution cards showed a status pill (queued/running/ci/…) but nothing
 * about what the agent was actually doing turn to turn — an operator
 * watching a running execution had no way to see its steps without leaving
 * the page for the Operator Console (whose chat panel already had exactly
 * this transcript, VTID-04033).
 *
 * Deliberately reuses that existing machinery instead of a second
 * implementation of the same transport: followOperatorExecution (the SSE
 * connection to GET /executions/:id/stream), state.operatorExecFollow (the
 * shared per-execution step buffer), describeFollowedStep and the
 * pre-existing chat-exec-follow / chat-tool-activity-line CSS classes.
 *
 * This is a static source-check test, matching the established pattern for
 * app.js elsewhere in this suite (a plain IIFE bundle with no module export
 * surface).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../src/frontend/command-hub/index.html');

describe('VTID-04265: Autopilot Live step/tool-call transcript', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('renders a Steps toggle button on every Dev Autopilot execution card, not only awaiting_approval', () => {
    const idx = src.indexOf("liveStepsBtn.textContent = liveStepsOpen ? '▾ Steps' : '▸ Steps'");
    expect(idx).toBeGreaterThan(-1);
    // Must appear BEFORE the `if (exec.status === 'awaiting_approval')` diff
    // gate — the whole point is availability regardless of status.
    const diffGateIdx = src.indexOf("if (exec.status === 'awaiting_approval')");
    expect(diffGateIdx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(diffGateIdx);
  });

  it('the toggle opens/closes the followOperatorExecution SSE stream rather than a new one', () => {
    expect(src).toMatch(/function devAutopilotToggleSteps\(execId\) \{/);
    const start = src.indexOf('function devAutopilotToggleSteps(execId) {');
    const body = src.slice(start, start + 500);
    expect(body).toContain('followOperatorExecution(execId)');
    expect(body).toContain('closeOperatorExecutionFollow(execId)');
    // No second EventSource/fetch to a streaming endpoint introduced by this toggle.
    expect(body).not.toContain('new EventSource(');
  });

  it('the panel reads from the SAME state.operatorExecFollow bucket the Operator Console chat panel writes to', () => {
    expect(src).toMatch(/function renderAutopilotLiveStepsPanel\(execId\) \{/);
    const start = src.indexOf('function renderAutopilotLiveStepsPanel(execId) {');
    const body = src.slice(start, start + 400);
    expect(body).toContain('state.operatorExecFollow[execId]');
  });

  it('reuses describeFollowedStep for the per-step line text instead of a second formatter', () => {
    const start = src.indexOf('function renderAutopilotLiveStepsPanel(execId) {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 10);
    const body = src.slice(start, end === -1 ? start + 2000 : end);
    expect(body).toContain('describeFollowedStep(step)');
  });

  it('reuses the pre-existing chat-exec-follow / chat-tool-activity-line CSS classes — no new styling introduced', () => {
    const start = src.indexOf('function renderAutopilotLiveStepsPanel(execId) {');
    const end = src.indexOf('\nfunction ', start + 10);
    const body = src.slice(start, end === -1 ? start + 2000 : end);
    expect(body).toContain('chat-exec-follow');
    expect(body).toContain('chat-tool-activity-line');
    expect(body).not.toContain('.style.cssText');
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(appVersion >= '20260922-vtid-04265-live-steps-transcript').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
