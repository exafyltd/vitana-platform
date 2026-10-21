/**
 * VTID-04984: model selection inside Kiro threads.
 * The model list is whatever Kiro returns for the session; switching goes
 * through Kiro. Drives the real AcpClient and kiro-turn against a scripted
 * fake `kiro-cli acp` in both shapes Kiro can report models in.
 */
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { AcpClient, parseModelState, type AcpChild } from '../src/services/kiro/acp-client';
import { setKiroBackend, runKiroTurn, listKiroModels, setKiroModel, closeAllKiroSessions } from '../src/services/kiro/kiro-turn';

type Script = (msg: any, send: (o: unknown) => void) => void;

function fakeChild(script: Script): AcpChild & { written: any[] } {
  const out = new EventEmitter();
  const proc = new EventEmitter();
  const written: any[] = [];
  const child: any = {
    written,
    stdout: out,
    stdin: { write: (line: string) => { const m = JSON.parse(line); written.push(m); script(m, (o) => out.emit('data', `${JSON.stringify(o)}\n`)); return true; }, end: () => {} },
    kill: () => proc.emit('exit'),
    on: (ev: string, cb: any) => proc.on(ev, cb),
  };
  return child;
}

const CONFIG_OPTIONS = [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'code', options: [{ value: 'code', name: 'Code' }] },
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'claude-sonnet',
    options: [
      { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced' },
      { group: 'more', name: 'More models', options: [{ value: 'claude-opus', name: 'Claude Opus', description: 'Most capable' }] },
    ],
  },
];

/** Kiro v3 shape: configOptions, switched with session/set_config_option. */
const v3: Script = (msg, send) => {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S3', configOptions: CONFIG_OPTIONS } });
  else if (msg.method === 'session/set_config_option') {
    if (msg.params.value === 'nope') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Model not available on your plan' } }); return; }
    const opts = CONFIG_OPTIONS.map((o) => (o.id === msg.params.configId ? { ...o, currentValue: msg.params.value } : o));
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: opts } });
  } else if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
};

/** Kiro v2 shape: models field, switched with session/set_model. */
const v2: Script = (msg, send) => {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S2', models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced' }] } } });
  else if (msg.method === 'session/set_model') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
};

const ENV = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;
let children: any[] = [];
function useBackend(script: Script) {
  children = [];
  setKiroBackend({ spawn: () => { const c = fakeChild(script); children.push(c); return c; }, workspace: () => '/w' });
}

afterEach(() => { closeAllKiroSessions(); setKiroBackend(null); });

describe('parseModelState', () => {
  it('reads the model config option, flattening groups, and ignores other options', () => {
    expect(parseModelState({ configOptions: CONFIG_OPTIONS })).toEqual({
      models: [{ id: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced' }, { id: 'claude-opus', name: 'Claude Opus', description: 'Most capable' }],
      current: 'claude-sonnet', via: 'config_option', configId: 'model',
    });
  });
  it('reads the v2 models field', () => {
    expect(parseModelState({ models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'Auto' }] } }))
      .toEqual({ models: [{ id: 'auto', name: 'Auto' }], current: 'auto', via: 'set_model' });
  });
});

describe('AcpClient.setModel', () => {
  it('uses session/set_config_option for a config-option list and returns Kiro’s updated list', async () => {
    const child = fakeChild(v3);
    const c = new AcpClient(child);
    const { sessionId, models } = await c.openNewSession('/w');
    const next = await c.setModel(sessionId, models!, 'claude-opus');
    expect(child.written.find((m) => m.method === 'session/set_config_option').params).toEqual({ sessionId: 'S3', configId: 'model', value: 'claude-opus' });
    expect(next.current).toBe('claude-opus');
  });
  it('uses session/set_model for a v2 list', async () => {
    const child = fakeChild(v2);
    const c = new AcpClient(child);
    const { sessionId, models } = await c.openNewSession('/w');
    const next = await c.setModel(sessionId, models!, 'claude-sonnet');
    expect(child.written.find((m) => m.method === 'session/set_model').params).toEqual({ sessionId: 'S2', modelId: 'claude-sonnet' });
    expect(next.current).toBe('claude-sonnet');
  });
  it('newSession still returns just the session id', async () => {
    expect(await new AcpClient(fakeChild(v3)).newSession('/w')).toBe('S3');
  });
});

describe('listKiroModels / setKiroModel', () => {
  it('lists Kiro’s models after the first turn and reports the model that answered', async () => {
    useBackend(v3);
    expect(listKiroModels('t1', 'u1')).toEqual({ ok: false, error: 'not_found' });
    const r = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi' }, ENV);
    expect(r.meta.kiro_model).toBe('claude-sonnet');
    const list = listKiroModels('t1', 'u1');
    expect(list).toMatchObject({ ok: true, current: 'claude-sonnet' });
    expect((list as any).models.map((m: any) => m.id)).toEqual(['claude-sonnet', 'claude-opus']);
  });

  it('switches through Kiro, and the next reply reports the new model', async () => {
    useBackend(v3);
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi' }, ENV);
    expect(await setKiroModel('t1', 'u1', 'claude-opus')).toMatchObject({ ok: true, current: 'claude-opus' });
    const r = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'again' }, ENV);
    expect(r.meta.kiro_model).toBe('claude-opus');
  });

  it('passes Kiro’s own error through unchanged', async () => {
    useBackend(v3);
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi' }, ENV);
    expect(await setKiroModel('t1', 'u1', 'nope')).toEqual({ ok: false, error: 'kiro_error', message: 'Model not available on your plan' });
    expect((listKiroModels('t1', 'u1') as any).current).toBe('claude-sonnet');
  });

  it('works with the v2 shape', async () => {
    useBackend(v2);
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi' }, ENV);
    expect(await setKiroModel('t1', 'u1', 'claude-sonnet')).toMatchObject({ ok: true, current: 'claude-sonnet' });
    expect(children[0].written.some((m: any) => m.method === 'session/set_model')).toBe(true);
  });

  it('is owner-only', async () => {
    useBackend(v3);
    await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi' }, ENV);
    expect(listKiroModels('t1', 'u2')).toEqual({ ok: false, error: 'forbidden' });
    expect(await setKiroModel('t1', 'u2', 'claude-opus')).toEqual({ ok: false, error: 'forbidden' });
    expect(await setKiroModel('nope', 'u1', 'claude-opus')).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('routes (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/operator.ts'), 'utf8');
  it('both model routes are admin-only and the switch logs an OASIS event', () => {
    expect(src).toContain("router.get('/kiro/sessions/:threadId/models', requireAdminAuth,");
    expect(src).toContain("router.post('/kiro/sessions/:threadId/model', requireAdminAuth,");
    expect(src).toContain("type: 'operator.kiro.model_selected'");
  });
  it('the event type is declared', () => {
    expect(fs.readFileSync(path.join(__dirname, '../src/types/cicd.ts'), 'utf8')).toContain("| 'operator.kiro.model_selected'");
  });
});
