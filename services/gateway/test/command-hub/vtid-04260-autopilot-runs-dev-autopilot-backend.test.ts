/**
 * Command Hub (VTID-04260) — Autopilot "Runs" tab wired to the wrong backend.
 *
 * The RUNS tab (Autopilot module: Registry · Scanners · Impact Rules ·
 * Auto Approve · Runs · Live · Engine · Growth) called
 * GET /api/v1/automations/runs — the VTID-01250 tenant-scoped CONSUMER
 * automation engine. That route 400s "tenant_id required" for any Command
 * Hub call, since buildContextHeaders() sends an X-Vitana-Tenant header but
 * the route's own getTenantId() never reads it (only req.identity.tenant_id,
 * req.body.tenant_id, or DEFAULT_TENANT_ID) — so the tab rendered
 * permanently empty. Every sibling Autopilot tab (Scanners, Impact Rules,
 * Auto Approve) already reads from /api/v1/dev-autopilot/*, and that router
 * already has a working GET /runs backed by the real dev_autopilot_runs
 * table (scan-run history: run_id, started_at, completed_at, status enum
 * running|ingesting|ranking|planning|done|failed, signal_count,
 * new_finding_count, updated_finding_count, triggered_by, error).
 *
 * A Dev Autopilot agent execution (7f837403) burned all 120 turns grepping
 * for this exact mismatch and hit the turn cap without finding or fixing
 * it — the mismatch was real, not a hallucinated failure.
 *
 * Structural/source-level, matching this repo's established pattern for
 * app.js (hand-maintained vanilla-JS single-page app, no build step) — see
 * stale-provider-defaults-fixed.test.ts's identical approach.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

function readAppJs(): string {
  return readFileSync(APP_JS_PATH, 'utf8');
}

function extractFunction(src: string, name: string): string {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in app.js`);
  // Balance braces from the first '{' after the marker to find the function body.
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

describe('Command Hub — Autopilot Runs tab points at dev-autopilot backend (VTID-04260)', () => {
  let src: string;

  beforeAll(() => {
    src = readAppJs();
  });

  it('fetchAutopilotRuns() calls /api/v1/dev-autopilot/runs, not /api/v1/automations/runs', () => {
    const fn = extractFunction(src, 'fetchAutopilotRuns');
    expect(fn).toContain('/api/v1/dev-autopilot/runs');
    expect(fn).not.toContain('/api/v1/automations/runs');
  });

  it('fetchAutopilotRuns() no longer sends the removed automation_id filter', () => {
    const fn = extractFunction(src, 'fetchAutopilotRuns');
    expect(fn).not.toContain('automation_id');
  });

  it('renderAutopilotRunsView() renders the real dev_autopilot_runs row shape', () => {
    const fn = extractFunction(src, 'renderAutopilotRunsView');
    expect(fn).toContain('r.run_id');
    expect(fn).toContain('r.triggered_by');
    expect(fn).toContain('r.signal_count');
    expect(fn).toContain('r.new_finding_count');
    // The old consumer-automation fields must not survive the rewrite.
    expect(fn).not.toContain('r.automation_id');
    expect(fn).not.toContain('r.users_affected');
    expect(fn).not.toContain('r.actions_taken');
    expect(fn).not.toContain('r.error_message');
  });

  it('renderAutopilotRunsView() status filter matches the real status enum', () => {
    const fn = extractFunction(src, 'renderAutopilotRunsView');
    for (const status of ['done', 'failed', 'running', 'ingesting', 'ranking', 'planning']) {
      expect(fn).toContain(`value="${status}"`);
    }
    // The old consumer-automation statuses never appeared on dev_autopilot_runs.
    expect(fn).not.toContain('value="completed"');
    expect(fn).not.toContain('value="skipped"');
  });

  it('autopilotStatusColor() covers every dev_autopilot_runs.status value', () => {
    const fn = extractFunction(src, 'autopilotStatusColor');
    for (const status of ['running', 'ingesting', 'ranking', 'planning', 'done', 'failed']) {
      expect(fn).toContain(`case '${status}'`);
    }
  });

  it('shared autopilot.runs state no longer defaults an automation_id filter', () => {
    const stateMatch = src.match(/runs:\s*\{\s*loading:\s*false,\s*data:\s*null,\s*filters:\s*\{[^}]*\}\s*\}/);
    expect(stateMatch).not.toBeNull();
    expect(stateMatch![0]).not.toContain('automation_id');
  });

  it('the Live tab (a different, correct consumer of /api/v1/automations/runs) is untouched', () => {
    // renderAutopilotLiveView/fetchAutopilotLive deliberately mix both
    // subsystems (active dev-autopilot executions + consumer automation
    // run history) — this VTID only fixes the standalone Runs tab, so the
    // Live tab's own use of /api/v1/automations/runs must survive intact.
    const fn = extractFunction(src, 'fetchAutopilotLive');
    expect(fn).toContain('/api/v1/automations/runs');
    expect(fn).toContain('/api/v1/dev-autopilot/executions');
  });
});
