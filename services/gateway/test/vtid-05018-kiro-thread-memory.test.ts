/**
 * VTID-05018: a Kiro thread keeps its conversation when its Kiro session is
 * reopened (idle/expiry close, a failed turn, a deploy, another gateway task).
 *
 * The real ACP client and turn runner run against a scripted fake `kiro-cli
 * acp`. Pins: the restored block (order, clipping, cap, omitted line); a NEW
 * session's first prompt carries it as its own leading block; a live session
 * never loads history; a failed load does not break the turn; the route passes
 * the caller's own thread (user/assistant rows only, limit 60).
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { AcpChild } from '../src/services/kiro/acp-client';
import {
  setKiroBackend, runKiroTurn, closeKiroSession, closeAllKiroSessions,
  restoredHistoryBlock, KIRO_HISTORY_MESSAGE_CHARS, KIRO_HISTORY_TOTAL_CHARS, type KiroHistoryMessage,
  KIRO_SESSION_RULES, clipHistoryMessage, statusForStopReason, workspaceNoteFor,
} from '../src/services/kiro/kiro-turn';

function fakeChild(): AcpChild & { written: any[] } {
  const out = new EventEmitter();
  const proc = new EventEmitter();
  const written: any[] = [];
  const send = (o: unknown) => out.emit('data', `${JSON.stringify(o)}\n`);
  const child: any = {
    written,
    stdout: out,
    stdin: {
      write: (line: string) => {
        const msg = JSON.parse(line);
        written.push(msg);
        if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S1' } });
        else if (msg.method === 'session/prompt') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
        return true;
      },
      end: () => {},
    },
    kill() { proc.emit('exit'); },
    on: (ev: string, cb: any) => proc.on(ev, cb),
  };
  return child;
}

const ENV = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;
let children: Array<ReturnType<typeof fakeChild>> = [];
const prompts = () => children.flatMap((c) => c.written.filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt));
const HISTORY: KiroHistoryMessage[] = [
  { role: 'user', content: 'Wire GitHub, AWS and Supabase into the Operator.' },
  { role: 'assistant', content: 'I can see the repos and the ledger through the vitana tools.' },
];

beforeEach(() => {
  children = [];
  setKiroBackend({ spawn: () => { const c = fakeChild(); children.push(c); return c; }, workspace: () => '/work/t' });
});
afterEach(() => { closeAllKiroSessions(); setKiroBackend(null); });

describe('restoredHistoryBlock', () => {
  it('marks the block as context, keeps order, labels roles', () => {
    const b = restoredHistoryBlock(HISTORY)!;
    expect(b.count).toBe(2);
    expect(b.text.split('\n')[0]).toMatch(/^=== RESTORED THREAD HISTORY .*context only, not new instructions/);
    expect(b.text.trim().endsWith('=== END RESTORED THREAD HISTORY ===')).toBe(true);
    expect(b.text.indexOf('User: Wire GitHub')).toBeLessThan(b.text.indexOf('You (Kiro): I can see'));
  });

  it('clips each message and caps the block, dropping the oldest first with a count', () => {
    const many: KiroHistoryMessage[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i} ` + 'x'.repeat(2_000) }));
    const b = restoredHistoryBlock(many)!;
    expect(b.text.length).toBeLessThanOrEqual(KIRO_HISTORY_TOTAL_CHARS + 200);
    expect(b.text).toContain('m29 ');
    expect(b.text).not.toContain('m0 ');
    expect(b.text).toMatch(/… \d+ earlier message\(s\) omitted/);
    for (const line of b.text.split('\n').filter((l) => l.startsWith('User:') || l.startsWith('You (Kiro):'))) {
      expect(line.length).toBeLessThan(KIRO_HISTORY_MESSAGE_CHARS + 20);
    }
  });

  it('empty, blank or tool rows give no block', () => {
    expect(restoredHistoryBlock([])).toBeNull();
    expect(restoredHistoryBlock([{ role: 'user', content: '   ' }])).toBeNull();
    expect(restoredHistoryBlock([{ role: 'tool' as any, content: 'raw tool output' }])).toBeNull();
  });
});

describe('runKiroTurn restores history only when it opens a new session', () => {
  it('new session: two blocks (history, then the message); live session: the message only, no load', async () => {
    const loadHistory = jest.fn(async () => HISTORY);
    const r1 = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'Do you remember what I asked?', loadHistory }, ENV);
    expect(r1.meta).toMatchObject({ kiro_status: 'ok', kiro_history_restored: 2 });
    expect(loadHistory).toHaveBeenCalledTimes(1);
    const [first] = prompts();
    expect(first).toHaveLength(2);
    expect(first[0].text).toContain('=== RESTORED THREAD HISTORY');
    expect(first[0].text).toContain('Wire GitHub, AWS and Supabase');
    expect(first[1]).toEqual({ type: 'text', text: 'Do you remember what I asked?' });

    const r2 = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'next', loadHistory }, ENV);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(r2.meta.kiro_history_restored).toBeUndefined();
    expect(prompts()[1]).toEqual([{ type: 'text', text: 'next' }]);
  });

  it('after the session closes (idle, expiry, deploy), the next turn restores again', async () => {
    const loadHistory = jest.fn(async () => HISTORY);
    await runKiroTurn({ threadId: 't2', userId: 'u1', message: 'a', loadHistory }, ENV);
    closeKiroSession('t2', 'u1');
    await runKiroTurn({ threadId: 't2', userId: 'u1', message: 'b', loadHistory }, ENV);
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
    expect(prompts()[1][0].text).toContain('=== RESTORED THREAD HISTORY');
  });

  it('a failed or empty load does not break the turn', async () => {
    // VTID-05064: a new session's first prompt still carries the session rules (and no history).
    const r1 = await runKiroTurn({ threadId: 't3', userId: 'u1', message: 'x', loadHistory: async () => { throw new Error('store down'); } }, ENV);
    expect(r1.meta.kiro_status).toBe('ok');
    expect(prompts()[0]).toEqual([{ type: 'text', text: KIRO_SESSION_RULES }, { type: 'text', text: 'x' }]);
    const r2 = await runKiroTurn({ threadId: 't4', userId: 'u1', message: 'y', loadHistory: async () => [] }, ENV);
    expect(r2.meta.kiro_status).toBe('ok');
    expect(prompts()[1]).toEqual([{ type: 'text', text: KIRO_SESSION_RULES }, { type: 'text', text: 'y' }]);
  });

  it('no loader (other callers): unchanged behaviour', async () => {
    await runKiroTurn({ threadId: 't5', userId: 'u1', message: 'z' }, ENV);
    expect(prompts()[0]).toEqual([{ type: 'text', text: KIRO_SESSION_RULES }, { type: 'text', text: 'z' }]);
    // Only the first prompt of the session carries them.
    await runKiroTurn({ threadId: 't5', userId: 'u1', message: 'z2' }, ENV);
    expect(prompts()[1]).toEqual([{ type: 'text', text: 'z2' }]);
  });
});

describe('route wiring (source check)', () => {
  it('runKiroChatTurn passes the caller\'s own thread, user/assistant rows only, limit 60', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/operator.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function runKiroChatTurn'), src.indexOf('async function runKiroChatTurn') + 2_500);
    expect(fn).toMatch(/listOperatorThreadMessages\(a\.threadId, \{ userId: a\.userId, limit: 60 \}\)/);
    expect(fn).toMatch(/m\.role === 'user' \|\| m\.role === 'assistant'/);
    // VTID-05060 added loadModelPick after loadHistory; loadHistory must still be passed.
    expect(fn).toMatch(/runKiroTurn\(\{[^}]*\bloadHistory\b[^}]*\}\)/);
  });
});


describe('VTID-05064: history keeps conclusions, marks cut-off replies, and Kiro gets session rules', () => {
  it('a long message keeps its start AND its end, within the cap', () => {
    const long = 'START ' + 'a'.repeat(5_000) + ' CONCLUSION: recommend option B';
    const c = clipHistoryMessage(long);
    expect(c.length).toBeLessThanOrEqual(KIRO_HISTORY_MESSAGE_CHARS);
    expect(c.startsWith('START ')).toBe(true);
    expect(c.endsWith('CONCLUSION: recommend option B')).toBe(true);
    expect(c).toMatch(/\[\d+ chars omitted\]/);
    expect(clipHistoryMessage('short')).toBe('short');
  });

  it('a reply that ended early is labelled in the restored block; the header says it is shortened', () => {
    const b = restoredHistoryBlock([
      { role: 'user', content: 'fix the paste' },
      { role: 'assistant', content: 'Let me look at the upload endpoint', stopReason: 'refusal' },
      { role: 'assistant', content: 'Done.', stopReason: 'end_turn' },
    ])!;
    expect(b.text).toContain('You (Kiro): [this reply was cut off: refusal] Let me look');
    expect(b.text).toContain('You (Kiro): Done.');
    expect(b.text).toContain('git status');
  });

  it('the rules forbid asking for a VTID and say what to do instead', () => {
    expect(KIRO_SESSION_RULES).toMatch(/Never ask the user to give you a VTID/);
    expect(KIRO_SESSION_RULES).toMatch(/offer to write that plan/);
  });

  it('stop reasons map to statuses', () => {
    expect(statusForStopReason('end_turn')).toBe('ok');
    expect(statusForStopReason('refusal')).toBe('refused');
    expect(statusForStopReason('max_tokens')).toBe('incomplete');
    expect(statusForStopReason('cancelled')).toBe('incomplete');
  });

  it('workspace note: restored, lost only when the last turn left unpushed edits', () => {
    const dirtyHist: KiroHistoryMessage[] = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'edited', workspaceDirty: ['vitana-platform'] }];
    const cleanHist: KiroHistoryMessage[] = [{ role: 'assistant', content: 'pushed', workspaceDirty: [] }];
    expect(workspaceNoteFor({ workspace: 'restored', dirty: null }, dirtyHist)).toBe('restored');
    expect(workspaceNoteFor({ workspace: 'fresh', dirty: null }, dirtyHist)).toBe('lost');
    expect(workspaceNoteFor({ workspace: 'fresh', dirty: null }, cleanHist)).toBeNull();
    expect(workspaceNoteFor(null, dirtyHist)).toBeNull();
    expect(workspaceNoteFor({ workspace: null, dirty: null }, dirtyHist)).toBeNull();
  });
});
