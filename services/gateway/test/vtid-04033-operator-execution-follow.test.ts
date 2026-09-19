/**
 * VTID-04033 (W4i): the Operator Console follows an execution it queued.
 *
 * app.js is a plain script (no export surface), so this suite pins it the way
 * vtid-03822 / vtid-04028 / vtid-04031 do — by source text for the wiring and
 * by evaluating the two pure helpers (extractFollowedExecutionIds,
 * describeFollowedStep) out of the file for their behaviour. The stream it
 * consumes is VTID-03897's GET /executions/:id/stream (connected → step* →
 * terminal), unchanged here; the terminal topics are those the route emits.
 */

import * as fs from 'fs';
import * as path from 'path';

const FE = path.resolve(__dirname, '../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(FE, 'styles.css'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const ROUTE_TS = fs.readFileSync(path.resolve(__dirname, '../src/routes/dev-autopilot.ts'), 'utf8');
const GUARD_JS = fs.readFileSync(path.resolve(__dirname, '../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');

function fnBody(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

function asyncFnBody(name: string): string {
  const start = APP_JS.indexOf(`\nasync function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = APP_JS.slice(start + 1);
  const next = rest.search(/\n(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

// Evaluate the pure helpers out of the script with the constants they read.
function loadHelpers(): {
  extractFollowedExecutionIds: (trs: unknown) => string[];
  describeFollowedStep: (step: unknown) => string;
  OPERATOR_EXEC_TERMINAL_LABELS: Record<string, string>;
} {
  const constStart = APP_JS.indexOf('\nvar OPERATOR_EXEC_FOLLOW_TOOLS = {');
  expect(constStart).toBeGreaterThan(-1);
  const constEnd = APP_JS.indexOf('\n// The execution ids a finished turn should follow', constStart);
  const consts = APP_JS.slice(constStart, constEnd);
  const src = consts + fnBody('extractFollowedExecutionIds') + fnBody('describeFollowedStep') +
    '\nreturn { extractFollowedExecutionIds, describeFollowedStep, OPERATOR_EXEC_TERMINAL_LABELS };';
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

describe('VTID-04033 extractFollowedExecutionIds', () => {
  const { extractFollowedExecutionIds } = loadHelpers();

  it('follows successful queue/approve results that carry an execution_id, in order, deduplicated', () => {
    const ids = extractFollowedExecutionIds([
      { name: 'dev_read_file', response: { ok: true, execution_id: 'not-a-queue-tool' } },
      { name: 'autopilot_run_task', response: { ok: true, execution_id: 'aaaa-1' } },
      { name: 'autopilot_execute_task', response: { ok: true, execution_id: 'bbbb-2' } },
      { name: 'autopilot_approve_execution', response: { ok: true, execution_id: 'aaaa-1', pr_number: 7 } },
      { name: 'autopilot_run_task', response: { ok: false, error: 'auth_not_admin', execution_id: 'cccc-3' } },
      { name: 'autopilot_run_task', response: { ok: true } },
      { name: 'autopilot_review_execution', response: { ok: true, execution_id: 'dddd-4' } },
    ]);
    expect(ids).toEqual(['aaaa-1', 'bbbb-2']);
  });

  it('is empty for no results, a non-array, or results without a usable id', () => {
    expect(extractFollowedExecutionIds(undefined)).toEqual([]);
    expect(extractFollowedExecutionIds('nope')).toEqual([]);
    expect(extractFollowedExecutionIds([{ name: 'autopilot_run_task', response: { ok: true, execution_id: '   ' } }, null])).toEqual([]);
  });
});

describe('VTID-04033 describeFollowedStep', () => {
  const { describeFollowedStep, OPERATOR_EXEC_TERMINAL_LABELS } = loadHelpers();

  it('renders execution topics short, agent steps with their turn and tool, and tolerates missing fields', () => {
    expect(describeFollowedStep({ topic: 'dev_autopilot.execution.claimed', message: 'claimed by staging' })).toBe('claimed: claimed by staging');
    expect(describeFollowedStep({ topic: 'dev_autopilot.agent.tool', message: 'search_text foo', metadata: { turn: 2, tool: 'search_text' } }))
      .toBe('turn 2 · agent.tool: search_text foo');
    expect(describeFollowedStep({ topic: 'dev_autopilot.agent.check', message: 'jest → green', metadata: { turn: 8, tool: 'run_check' } }))
      .toBe('turn 8 · agent.check: run_check — jest → green');
    expect(describeFollowedStep({ topic: 'dev_autopilot.execution.failed' })).toBe('failed');
    expect(describeFollowedStep(null)).toBe('');
  });

  it('labels every terminal topic the stream route emits', () => {
    const block = ROUTE_TS.slice(ROUTE_TS.indexOf('const EXECUTION_STREAM_TERMINAL_TOPICS'), ROUTE_TS.indexOf(']);', ROUTE_TS.indexOf('const EXECUTION_STREAM_TERMINAL_TOPICS')));
    const topics = Array.from(block.matchAll(/'(dev_autopilot\.execution\.[a-z_]+)'/g)).map((m) => m[1]);
    expect(topics.length).toBeGreaterThanOrEqual(7);
    for (const t of topics) expect(OPERATOR_EXEC_TERMINAL_LABELS[t]).toBeTruthy();
  });
});

describe('VTID-04033 Command Hub wiring', () => {
  it('keeps the follow state on the console state and drops it with a new thread', () => {
    expect(APP_JS).toContain('operatorExecFollow: {}, // VTID-04033');
    expect(fnBody('startNewOperatorThread')).toContain('closeAllOperatorExecutionFollows();');
    const closeAll = fnBody('closeAllOperatorExecutionFollows');
    expect(closeAll).toContain('forEach(closeOperatorExecutionFollow)');
    expect(closeAll).toContain('state.operatorExecFollow = {};');
  });

  it('opens the VTID-03897 per-execution stream with the bearer as query, bounds the steps and closes on terminal', () => {
    const follow = fnBody('followOperatorExecution');
    expect(follow).toContain("'/api/v1/dev-autopilot/executions/' + execId + '/stream?access_token=' + encodeURIComponent(state.authToken || '')");
    expect(follow).toContain('new EventSource(url)');
    expect(follow).toContain("es.addEventListener('step'");
    expect(follow).toContain('OPERATOR_EXEC_FOLLOW_MAX_LINES');
    expect(follow).toContain("es.addEventListener('terminal'");
    expect(follow).toContain('closeOperatorExecutionFollow(execId);');
    expect(follow).toContain('if (slot.es || slot.terminal) return;');
    expect(APP_JS).toContain('var OPERATOR_EXEC_FOLLOW_MAX_LINES = 40;');
    expect(fnBody('closeOperatorExecutionFollow')).toContain('slot.es.close();');
  });

  it('sendChatMessage stamps followExecIds on the reply and follows each execution the turn queued', () => {
    const send = asyncFnBody('sendChatMessage');
    // VTID-04104: computed once into turnFollowExecIds and reused so it can
    // also be persisted onto the history entry (see the sibling suite).
    expect(send).toContain('var turnFollowExecIds = extractFollowedExecutionIds(result.toolResults);');
    expect(send).toContain('followExecIds: turnFollowExecIds');
    expect(send).toContain('followOperatorExecution(execId, tr ? OPERATOR_EXEC_FOLLOW_TOOLS[tr.name] : null);');
  });

  it('renders the follow panel under the reply through classes only (chip to Autopilot Live, status, step lines)', () => {
    const chat = fnBody('renderOperatorChat');
    expect(chat).toContain('msg.followExecIds.forEach(function (execId) {');
    expect(chat).toContain('messages.appendChild(renderOperatorExecutionFollow(execId));');
    const render = fnBody('renderOperatorExecutionFollow');
    expect(render).toContain("chip.href = '/command-hub/autopilot/live/#autopilot-live-exec-' + execId;");
    expect(render).toContain("'chat-exec-follow-status chat-exec-follow-status--live'");
    expect(render).toContain("'chat-exec-follow-status chat-exec-follow-status--done'");
    expect(render).toContain("'chat-exec-follow-status chat-exec-follow-status--error'");
    expect(render).toContain('chat-tool-activity-line--failed');
    expect(render).not.toMatch(/\.style\b/);
    expect(fnBody('followOperatorExecution')).not.toMatch(/\.style\b/);
  });

  it('ships the styles, the cache-bust and the ownership-guard allowlist together', () => {
    for (const cls of ['.chat-exec-follow {', '.chat-exec-follow--done {', '.chat-exec-follow-chip {', '.chat-exec-follow-status--live {', '.chat-exec-follow-status--done {', '.chat-exec-follow-status--error {', '.chat-exec-follow-line {']) {
      expect(CSS).toContain(cls);
    }
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260918-vtid-04033-exec-follow').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
    expect(GUARD_JS).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04033/);
  });
});
