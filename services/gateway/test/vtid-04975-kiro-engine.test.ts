/**
 * VTID-04975: Kiro engine for the Command Hub Operator (Phase 1).
 * Drives the real ACP client, permission broker and turn runner against a
 * scripted fake `kiro-cli acp`. No network, no key, no real process.
 */
import { EventEmitter } from 'events';
import { AcpClient, type AcpChild } from '../src/services/kiro/acp-client';
import { mapAcpUpdate, type KiroTurnEvent } from '../src/services/kiro/kiro-events';
import { answerPermission, makePermissionHandler, pendingPermissionCount } from '../src/services/kiro/permission-broker';
import {
  setKiroBackend, runKiroTurn, cancelKiroTurn, closeKiroSession, closeAllKiroSessions, openKiroSessionCount,
} from '../src/services/kiro/kiro-turn';
import { OperatorChatMessageSchema } from '../src/types/operator-chat';

type Script = (msg: any, send: (o: unknown) => void) => void;

/** A fake kiro-cli: parses what the client writes, answers per `script`. */
function fakeChild(script: Script): AcpChild & { written: any[]; killed: boolean; emitter: EventEmitter } {
  const out = new EventEmitter();
  const proc = new EventEmitter();
  const written: any[] = [];
  const child: any = {
    written, killed: false, emitter: proc,
    stdout: out,
    stdin: {
      write: (line: string) => {
        const msg = JSON.parse(line);
        written.push(msg);
        script(msg, (o) => out.emit('data', `${JSON.stringify(o)}\n`));
        return true;
      },
      end: () => {},
    },
    kill() { child.killed = true; proc.emit('exit'); },
    on: (ev: string, cb: any) => proc.on(ev, cb),
  };
  return child;
}

const happy: Script = (msg, send) => {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S1' } });
  else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
};

const ENV = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;

afterEach(() => { closeAllKiroSessions(); setKiroBackend(null); });

describe('mapAcpUpdate', () => {
  it('maps message chunks, tool calls and updates (both spellings)', () => {
    expect(mapAcpUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } })).toEqual({ type: 'kiro.message_chunk', text: 'hi' });
    expect(mapAcpUpdate({ update: { sessionUpdate: 'AgentMessageChunk', content: { text: 'hi' } } })).toEqual({ type: 'kiro.message_chunk', text: 'hi' });
    expect(mapAcpUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Run', kind: 'execute', status: 'pending' } }))
      .toEqual({ type: 'kiro.tool_call', tool_call_id: 'a', title: 'Run', kind: 'execute', status: 'pending' });
    expect(mapAcpUpdate({ update: { sessionUpdate: 'ToolCallUpdate', toolCallId: 'a', status: 'failed' } }))
      .toEqual({ type: 'kiro.tool_update', tool_call_id: 'a', status: 'failed' });
  });
  it('ignores updates the console does not show and empty chunks', () => {
    expect(mapAcpUpdate({ update: { sessionUpdate: 'plan' } })).toBeNull();
    expect(mapAcpUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { text: '' } } })).toBeNull();
    expect(mapAcpUpdate(undefined)).toBeNull();
  });
  it('clips oversized text', () => {
    const ev = mapAcpUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x'.repeat(9000) } } }) as any;
    expect(ev.text.length).toBeLessThanOrEqual(4001);
  });
});

describe('AcpClient', () => {
  it('runs initialize -> session/new -> prompt and streams notifications', async () => {
    const child = fakeChild(happy);
    const seen: string[] = [];
    const c = new AcpClient(child, { onNotification: (m) => seen.push(m) });
    await c.initialize();
    expect(await c.newSession('/work')).toBe('S1');
    expect(await c.prompt('S1', 'go')).toEqual({ stopReason: 'end_turn' });
    expect(seen.length).toBe(4);
    expect(child.written.find((m) => m.method === 'session/new').params.cwd).toBe('/work');
    expect(child.written.find((m) => m.method === 'session/prompt').params.prompt).toEqual([{ type: 'text', text: 'go' }]);
  });
  it('ignores non-JSON noise and splits frames across chunks', async () => {
    const child = fakeChild((msg, send) => { if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} }); });
    const c = new AcpClient(child);
    (child.stdout as EventEmitter).emit('data', 'log line not json\n{"jsonrpc":"2.0","id":1,');
    const p = c.initialize();
    await expect(Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 20))])).resolves.toBe('pending');
  });
  it('rejects pending requests when the child exits', async () => {
    const child = fakeChild(() => {});
    const c = new AcpClient(child);
    const p = c.initialize();
    child.emitter.emit('exit');
    await expect(p).rejects.toThrow(/exited/);
    await expect(c.initialize()).rejects.toThrow(/closed/);
  });
  it('times out a request', async () => {
    const c = new AcpClient(fakeChild(() => {}), { requestTimeoutMs: 15 });
    await expect(c.initialize()).rejects.toThrow(/timed out/);
  });
  it('answers an agent permission request: selected option, or cancelled when denied', async () => {
    const child = fakeChild(() => {});
    const c = new AcpClient(child, { onPermissionRequest: async (r) => (r.kind === 'read' ? 'allow1' : null) });
    const out = child.stdout as EventEmitter;
    out.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'session/request_permission', params: { sessionId: 'S1', toolCall: { toolCallId: 't', title: 'x', kind: 'read' }, options: [{ optionId: 'allow1', kind: 'allow_once' }] } })}\n`);
    out.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'session/request_permission', params: { sessionId: 'S1', toolCall: { toolCallId: 'u', title: 'rm', kind: 'execute' }, options: [] } })}\n`);
    await new Promise((r) => setTimeout(r, 10));
    expect(child.written.find((m) => m.id === 90).result.outcome).toEqual({ outcome: 'selected', optionId: 'allow1' });
    expect(child.written.find((m) => m.id === 91).result.outcome).toEqual({ outcome: 'cancelled' });
    void c;
  });
  it('denies a permission request when no handler is set, and refuses unknown agent methods', async () => {
    const child = fakeChild(() => {});
    new AcpClient(child);
    const out = child.stdout as EventEmitter;
    out.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session/request_permission', params: { toolCall: {}, options: [] } })}\n`);
    out.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'fs/write_text_file', params: {} })}\n`);
    await new Promise((r) => setTimeout(r, 10));
    expect(child.written.find((m) => m.id === 5).result.outcome).toEqual({ outcome: 'cancelled' });
    expect(child.written.find((m) => m.id === 6).error.code).toBe(-32601);
  });
});

describe('permission broker', () => {
  const options = [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }];
  it('allows read/search/think without asking', async () => {
    const events: KiroTurnEvent[] = [];
    const h = makePermissionHandler({ threadId: 't', userId: 'u1', emit: (e) => events.push(e) });
    expect(await h({ sessionId: 's', toolCallId: 'a', title: 'r', kind: 'read', options })).toBe('ok');
    expect(events).toHaveLength(0);
  });
  it('turns a write into an approval card and honours the owner answer', async () => {
    const events: KiroTurnEvent[] = [];
    const h = makePermissionHandler({ threadId: 't', userId: 'u1', emit: (e) => events.push(e) });
    const p = h({ sessionId: 's', toolCallId: 'a', title: 'edit', kind: 'edit', options });
    const card = events[0] as any;
    expect(card.type).toBe('kiro.permission_request');
    expect(answerPermission(card.request_id, 'someone-else', true)).toEqual({ ok: false, error: 'forbidden' });
    expect(answerPermission(card.request_id, 'u1', true)).toEqual({ ok: true });
    expect(await p).toBe('ok');
    expect(answerPermission(card.request_id, 'u1', true)).toEqual({ ok: false, error: 'not_found' });
  });
  it('denies when the owner rejects', async () => {
    const events: KiroTurnEvent[] = [];
    const h = makePermissionHandler({ threadId: 't', userId: 'u1', emit: (e) => events.push(e) });
    const p = h({ sessionId: 's', toolCallId: 'a', title: 'run', kind: 'execute', options });
    answerPermission((events[0] as any).request_id, 'u1', false);
    expect(await p).toBeNull();
  });
  it('denies on timeout and leaves nothing pending', async () => {
    const h = makePermissionHandler({ threadId: 't', userId: 'u1', emit: () => {} }, { KIRO_PERMISSION_TIMEOUT_MS: '20' } as NodeJS.ProcessEnv);
    expect(await h({ sessionId: 's', toolCallId: 'a', title: 'run', kind: 'execute', options })).toBeNull();
    expect(pendingPermissionCount()).toBe(0);
  });
});

describe('runKiroTurn', () => {
  const backendFor = (script: Script, spawned: string[] = []) => ({
    spawn: (ctx: { userId: string | null; threadId: string }) => { spawned.push(ctx.threadId); return fakeChild(script); },
    workspace: (ctx: { threadId: string }) => `/ws/${ctx.threadId}`,
  });

  it('is inert (not_connected) with no backend or with the switch off', async () => {
    const r = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi' }, ENV);
    expect(r.meta).toMatchObject({ engine: 'kiro', kiro_status: 'not_connected' });
    setKiroBackend(backendFor(happy));
    const off = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi' }, {} as NodeJS.ProcessEnv);
    expect(off.meta.kiro_status).toBe('not_connected');
    expect(openKiroSessionCount()).toBe(0);
  });

  it('returns the router-shaped result and streams events', async () => {
    setKiroBackend(backendFor(happy));
    const events: KiroTurnEvent[] = [];
    const r = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'go', emit: (e) => events.push(e) }, ENV);
    expect(r.reply).toBe('Hello world');
    expect(r.toolResults).toEqual([{ name: 'Read file', response: { kind: 'read', status: 'completed' } }]);
    expect(r.meta).toMatchObject({ engine: 'kiro', kiro_status: 'ok', stop_reason: 'end_turn' });
    expect(events.map((e) => e.type)).toEqual(['kiro.message_chunk', 'kiro.tool_call', 'kiro.tool_update', 'kiro.message_chunk', 'kiro.turn_end']);
  });

  it('reuses the session for the same thread and spawns once', async () => {
    const spawned: string[] = [];
    setKiroBackend(backendFor(happy, spawned));
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'a' }, ENV);
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'b' }, ENV);
    expect(spawned).toEqual(['t1']);
    expect(openKiroSessionCount()).toBe(1);
  });

  it('refuses another user on the same thread, and enforces the per-user cap', async () => {
    setKiroBackend(backendFor(happy));
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'a' }, ENV);
    const other = await runKiroTurn({ threadId: 't1', userId: 'u2', message: 'a' }, ENV);
    expect(other.meta).toMatchObject({ kiro_status: 'error', error: 'forbidden' });
    const env = { ...ENV, KIRO_MAX_SESSIONS_PER_USER: '2' } as NodeJS.ProcessEnv;
    await runKiroTurn({ threadId: 't2', userId: 'u1', message: 'a' }, env);
    const busy = await runKiroTurn({ threadId: 't3', userId: 'u1', message: 'a' }, env);
    expect(busy.meta).toMatchObject({ kiro_status: 'busy', limit: 'per_user' });
  });

  it('enforces the global cap', async () => {
    setKiroBackend(backendFor(happy));
    const env = { ...ENV, KIRO_MAX_SESSIONS_GLOBAL: '1' } as NodeJS.ProcessEnv;
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'a' }, env);
    const busy = await runKiroTurn({ threadId: 't2', userId: 'u2', message: 'a' }, env);
    expect(busy.meta).toMatchObject({ kiro_status: 'busy', limit: 'global' });
  });

  it('reports a start failure and does not keep a session', async () => {
    setKiroBackend(backendFor((msg, send) => { if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'auth failed' } }); }));
    const r = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'a' }, ENV);
    expect(r.meta).toMatchObject({ kiro_status: 'error', error: 'auth failed' });
    expect(r.reply).not.toContain('auth failed');
    expect(openKiroSessionCount()).toBe(0);
  });

  it('drops the session when a turn fails so the next turn restarts it', async () => {
    let first = true;
    setKiroBackend(backendFor((msg, send) => {
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S' } });
      else if (msg.method === 'session/prompt') {
        if (first) { first = false; send({ jsonrpc: '2.0', id: msg.id, error: { code: -2, message: 'boom' } }); }
        else send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    }));
    const bad = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'a' }, ENV);
    expect(bad.meta.kiro_status).toBe('error');
    expect(openKiroSessionCount()).toBe(0);
    const good = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'a' }, ENV);
    expect(good.meta.kiro_status).toBe('ok');
  });

  it('cancel and close are owner-only', async () => {
    const children: any[] = [];
    setKiroBackend({ spawn: () => { const c = fakeChild(happy); children.push(c); return c; }, workspace: () => '/w' });
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'a' }, ENV);
    expect(cancelKiroTurn('t1', 'u2')).toEqual({ ok: false, error: 'forbidden' });
    expect(cancelKiroTurn('nope', 'u1')).toEqual({ ok: false, error: 'not_found' });
    expect(cancelKiroTurn('t1', 'u1')).toEqual({ ok: true });
    expect(children[0].written.some((m: any) => m.method === 'session/cancel')).toBe(true);
    expect(closeKiroSession('t1', 'u2')).toEqual({ ok: false, error: 'forbidden' });
    expect(closeKiroSession('t1', 'u1')).toEqual({ ok: true });
    expect(children[0].killed).toBe(true);
    expect(openKiroSessionCount()).toBe(0);
  });
});

describe('chat schema', () => {
  it('accepts engine llm|kiro and rejects anything else; defaults to unset', () => {
    expect(OperatorChatMessageSchema.safeParse({ message: 'hi', engine: 'kiro' }).success).toBe(true);
    expect(OperatorChatMessageSchema.safeParse({ message: 'hi', engine: 'llm' }).success).toBe(true);
    expect(OperatorChatMessageSchema.safeParse({ message: 'hi', engine: 'other' }).success).toBe(false);
    expect((OperatorChatMessageSchema.parse({ message: 'hi' }) as any).engine).toBeUndefined();
  });
});
