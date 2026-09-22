/**
 * VTID-04310 — Command Hub voice hands work to the Operator through one
 * tool, and the Command Hub voice catalog is the developer catalog.
 */
import { buildLiveApiTools, COMMAND_HUB_RETIRED_VOICE_TOOLS } from '../src/orb/live/tools/live-tool-catalog';
import { runOperatorDelegate, OPERATOR_DELEGATE_TOOL_NAME } from '../src/orb/live/tools/operator-delegate';

const THREAD = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const ADMIN = { user_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', exafy_admin: true };

function names(tools: object[]): string[] {
  return (tools as Array<{ function_declarations?: Array<{ name: string }> }>)
    .flatMap((g) => (g.function_declarations || []).map((d) => d.name));
}

describe('Command Hub voice catalog', () => {
  const hub = buildLiveApiTools('authenticated', '/command-hub/operator', 'developer');
  const hubNames = names(hub);

  it('declares operator_delegate exactly once', () => {
    expect(hubNames.filter((n) => n === OPERATOR_DELEGATE_TOOL_NAME)).toHaveLength(1);
  });

  it('retires the legacy task tools that bypassed the Operator on-ramp', () => {
    for (const retired of COMMAND_HUB_RETIRED_VOICE_TOOLS) expect(hubNames).not.toContain(retired);
  });

  it('keeps navigation, memory search and developer read tools', () => {
    expect(hubNames).toEqual(expect.arrayContaining(['navigate', 'end_conversation', 'search_memory', 'dev_discover_tasks', 'dev_query_oasis_events']));
  });

  it('drops community tools', () => {
    expect(hubNames).not.toContain('log_water');
    expect(hubNames).not.toContain('get_vitana_index');
  });

  it('fits well inside the 64 KB Nova tool budget, so nothing is trimmed away', () => {
    expect(Buffer.byteLength(JSON.stringify(hub), 'utf8')).toBeLessThan(64 * 1024);
  });

  it('leaves the community catalog unchanged', () => {
    const community = names(buildLiveApiTools('authenticated', '/home', 'community'));
    expect(community).not.toContain(OPERATOR_DELEGATE_TOOL_NAME);
    expect(community).toContain('log_water');
  });
});

describe('runOperatorDelegate', () => {
  const session = { sessionId: 'live-1', current_route: '/command-hub', operator_thread_id: THREAD, identity: ADMIN };

  it('runs the Operator turn on the bound thread with the verified identity, tagged voice_delegate', async () => {
    const runTurn = jest.fn().mockResolvedValue({
      status: 200,
      body: {
        ok: true, threadId: THREAD, reply: 'Queued VTID-04999; held for your approval.',
        toolResults: [{ name: 'autopilot_run_task', response: { execution_id: 'ex-1', vtid: 'VTID-04999', status: 'queued' } }],
      },
    });
    const r = await runOperatorDelegate(session, { request: '  fix the login redirect  ' }, { runTurn });
    expect(r.success).toBe(true);
    const [req, opts] = runTurn.mock.calls[0];
    expect(req.body).toEqual({ message: 'fix the login redirect', threadId: THREAD });
    expect(req.identity).toBe(ADMIN);
    expect(opts).toEqual({ threadId: THREAD, channel: 'voice_delegate' });
    const out = JSON.parse(r.result);
    expect(out.executions).toEqual([{ execution_id: 'ex-1', vtid: 'VTID-04999', status: 'queued' }]);
    expect(out.tools_used).toEqual(['autopilot_run_task']);
  });

  it('reports still_working when the turn outlasts the wait, without failing', async () => {
    const runTurn = jest.fn(() => new Promise<never>(() => {}));
    const r = await runOperatorDelegate(session, { request: 'long job' }, { runTurn: runTurn as any, waitMs: 10 });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.result).status).toBe('still_working');
  });

  it('refuses outside the Command Hub and without a signed-in identity', async () => {
    const runTurn = jest.fn();
    expect((await runOperatorDelegate({ ...session, current_route: '/home' }, { request: 'x' }, { runTurn })).success).toBe(false);
    expect((await runOperatorDelegate({ ...session, identity: null }, { request: 'x' }, { runTurn })).success).toBe(false);
    expect((await runOperatorDelegate(session, { request: '   ' }, { runTurn })).success).toBe(false);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('surfaces an Operator failure as a tool error', async () => {
    const runTurn = jest.fn().mockResolvedValue({ status: 500, body: { ok: false, error: 'Internal server error', details: 'boom' } });
    const r = await runOperatorDelegate(session, { request: 'x' }, { runTurn });
    expect(r).toEqual({ success: false, result: '', error: 'Operator turn failed: boom' });
  });
});
