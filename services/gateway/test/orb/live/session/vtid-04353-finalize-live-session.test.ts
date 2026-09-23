/**
 * VTID-04353 — every ORB live-session end path commits memory and writes the
 * voice session summary through one idempotent finalizeLiveSession().
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../../../src/services/session-memory-commit', () => ({
  commitSessionMemory: jest.fn(() => ({ committed: true, cognee_queued: false })),
}));

import {
  finalizeLiveSession,
  isVoiceSessionSummaryEnabled,
  FinalizableLiveSession,
} from '../../../../src/orb/live/session/finalize-live-session';

const T0 = Date.parse('2026-09-23T10:00:00.000Z');

function session(turns: Array<['user' | 'assistant', string]>, identity: any = { tenant_id: 't1', user_id: 'u1' }): FinalizableLiveSession {
  return {
    sessionId: 'live-1',
    identity,
    active_role: 'community',
    createdAt: new Date(T0),
    transcriptTurns: turns.map(([role, text]) => ({ role, text })),
  };
}

function seams() {
  return {
    commitMemory: jest.fn(() => ({ committed: true, cognee_queued: false })),
    recordSummary: jest.fn(() => Promise.resolve({ success: true })),
    recordContinuity: jest.fn(() =>
      Promise.resolve({ ok: true, threads_written: 1, threads_touched: 0, promises_written: 1 }),
    ),
    emitFinalized: jest.fn(() => Promise.resolve({ ok: true })),
  };
}

const convo: Array<['user' | 'assistant', string]> = [
  ['assistant', 'Guten Morgen, wie hast du geschlafen?'],
  ['user', 'Nicht so gut, ich war bis zwei Uhr wach wegen der Hochzeitsplanung.'],
  ['assistant', 'Das klingt anstrengend. Magst du heute früher ins Bett?'],
];

describe('finalizeLiveSession (VTID-04353)', () => {
  const OLD = process.env.ORB_VOICE_SESSION_SUMMARY_ENABLED;
  const OLD_CONT = process.env.ORB_SESSION_CONTINUITY_WRITE_ENABLED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.ORB_VOICE_SESSION_SUMMARY_ENABLED;
    else process.env.ORB_VOICE_SESSION_SUMMARY_ENABLED = OLD;
    if (OLD_CONT === undefined) delete process.env.ORB_SESSION_CONTINUITY_WRITE_ENABLED;
    else process.env.ORB_SESSION_CONTINUITY_WRITE_ENABLED = OLD_CONT;
  });

  it('commits memory and queues a voice summary with the full transcript', () => {
    const s = session(convo);
    const x = seams();
    const r = finalizeLiveSession(s, { sessionId: 'live-1', reason: 'test', nowMs: T0 + 90_000, ...x });
    expect(r).toMatchObject({ ran: true, turns: 3, memory_committed: true, summary_queued: true });
    expect(x.commitMemory).toHaveBeenCalledTimes(1);
    const commitArgs = (x.commitMemory.mock.calls[0] as any[])[0];
    expect(commitArgs).toMatchObject({ tenantId: 't1', userId: 'u1', sessionId: 'live-1', activeRole: 'community' });
    expect(commitArgs.transcript).toContain('User: Nicht so gut');
    expect(commitArgs.transcript.split('\n')).toHaveLength(3);
    expect(x.recordSummary).toHaveBeenCalledWith({
      user_id: 'u1',
      session_id: 'live-1',
      channel: 'voice',
      transcript_turns: convo.map(([role, text]) => ({ role, text })),
      duration_ms: 90_000,
    });
  });

  it('writes continuity and emits exactly one finalized event carrying what the writes produced', async () => {
    const x = seams();
    const r = finalizeLiveSession(session(convo), { sessionId: 'live-1', reason: 'ws_stop', nowMs: T0 + 90_000, ...x });
    expect(r.continuity_queued).toBe(true);
    const payload = await r.settled;
    expect(x.recordContinuity).toHaveBeenCalledWith({
      tenant_id: 't1',
      user_id: 'u1',
      session_id: 'live-1',
      transcript_turns: convo.map(([role, text]) => ({ role, text })),
    });
    expect(x.emitFinalized).toHaveBeenCalledTimes(1);
    expect(payload).toEqual({
      session_id: 'live-1',
      reason: 'ws_stop',
      turns: 3,
      user_turns: 1,
      duration_ms: 90_000,
      memory_committed: true,
      memory_skip_reason: undefined,
      summary_written: true,
      threads_written: 1,
      threads_touched: 0,
      promises_written: 1,
    });
    expect((x.emitFinalized.mock.calls[0] as any[])[1]).toBe('u1');
  });

  it('the finalized event reports a failed summary and continuity honestly', async () => {
    const x = seams();
    x.recordSummary.mockImplementationOnce(() => Promise.resolve({ success: false, error: 'router down' }) as any);
    x.recordContinuity.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    const payload = await finalizeLiveSession(session(convo), { sessionId: 'live-1', reason: 'test', ...x }).settled;
    expect(payload).toMatchObject({ summary_written: false, threads_written: 0, promises_written: 0 });
    expect(x.emitFinalized).toHaveBeenCalledTimes(1);
  });

  it('a skipped finalize emits no event', async () => {
    const x = seams();
    const s = session(convo);
    await finalizeLiveSession(s, { sessionId: 'live-1', reason: 'a', ...x }).settled;
    const r2 = finalizeLiveSession(s, { sessionId: 'live-1', reason: 'b', ...x });
    expect(await r2.settled).toBeNull();
    expect(x.emitFinalized).toHaveBeenCalledTimes(1);
  });

  it('a failing event emit never throws out of settled', async () => {
    const x = seams();
    x.emitFinalized.mockImplementationOnce(() => Promise.reject(new Error('oasis down')));
    await expect(finalizeLiveSession(session(convo), { sessionId: 'live-1', reason: 't', ...x }).settled).resolves.toMatchObject({
      session_id: 'live-1',
    });
  });

  it('ORB_SESSION_CONTINUITY_WRITE_ENABLED=false turns off only the continuity write', async () => {
    process.env.ORB_SESSION_CONTINUITY_WRITE_ENABLED = 'false';
    const x = seams();
    const r = finalizeLiveSession(session(convo), { sessionId: 'live-1', reason: 't', ...x });
    await r.settled;
    expect(r).toMatchObject({ continuity_queued: false, summary_queued: true, memory_committed: true });
    expect(x.recordContinuity).not.toHaveBeenCalled();
    expect(x.emitFinalized).toHaveBeenCalledTimes(1);
  });

  it('an anonymous session writes no continuity', async () => {
    const x = seams();
    x.commitMemory.mockReturnValueOnce({ committed: false, cognee_queued: false, reason: 'missing_identity' } as any);
    const r = finalizeLiveSession(session(convo, null), { sessionId: 'live-1', reason: 't', ...x });
    await r.settled;
    expect(r.continuity_queued).toBe(false);
    expect(x.recordContinuity).not.toHaveBeenCalled();
  });

  it('a second end path on the same transcript is a no-op', () => {
    const s = session(convo);
    const x = seams();
    finalizeLiveSession(s, { sessionId: 'live-1', reason: 'ws_stop', ...x });
    const r2 = finalizeLiveSession(s, { sessionId: 'live-1', reason: 'live_session_stop', ...x });
    expect(r2).toMatchObject({ ran: false, reason: 'already_finalized' });
    expect(x.commitMemory).toHaveBeenCalledTimes(1);
    expect(x.recordSummary).toHaveBeenCalledTimes(1);
  });

  it('runs again when the session gained turns after an earlier finalize', () => {
    const s = session(convo);
    const x = seams();
    finalizeLiveSession(s, { sessionId: 'live-1', reason: 'upstream_disconnect', ...x });
    s.transcriptTurns.push({ role: 'user', text: 'Ja, gute Idee.' });
    const r2 = finalizeLiveSession(s, { sessionId: 'live-1', reason: 'live_session_stop', ...x });
    expect(r2).toMatchObject({ ran: true, turns: 4 });
    expect(x.commitMemory).toHaveBeenCalledTimes(2);
    expect(x.recordSummary).toHaveBeenCalledTimes(2);
  });

  it('skips an empty transcript without latching', () => {
    const s = session([]);
    const x = seams();
    expect(finalizeLiveSession(s, { sessionId: 'live-1', reason: 'test', ...x })).toMatchObject({
      ran: false,
      reason: 'empty_transcript',
    });
    expect(s.finalizedTurnCount).toBeUndefined();
    expect(x.commitMemory).not.toHaveBeenCalled();
  });

  it('writes no summary for a greeting-only session', () => {
    const x = seams();
    const r = finalizeLiveSession(session([['assistant', 'Hallo! Schön, dass du da bist.']]), { sessionId: 'live-1', reason: 'test', ...x });
    expect(r.summary_queued).toBe(false);
    expect(x.recordSummary).not.toHaveBeenCalled();
  });

  it('writes no summary for an anonymous session and passes the missing identity to the commit guard', () => {
    const x = seams();
    x.commitMemory.mockReturnValueOnce({ committed: false, cognee_queued: false, reason: 'missing_identity' } as any);
    const r = finalizeLiveSession(session(convo, null), { sessionId: 'live-1', reason: 'test', ...x });
    expect(r).toMatchObject({ ran: true, memory_committed: false, memory_skip_reason: 'missing_identity', summary_queued: false });
    expect((x.commitMemory.mock.calls[0] as any[])[0]).toMatchObject({ tenantId: '', userId: '' });
    expect(x.recordSummary).not.toHaveBeenCalled();
  });

  it('ORB_VOICE_SESSION_SUMMARY_ENABLED=false turns off the summary, not the memory commit', () => {
    process.env.ORB_VOICE_SESSION_SUMMARY_ENABLED = 'false';
    const x = seams();
    const r = finalizeLiveSession(session(convo), { sessionId: 'live-1', reason: 'test', ...x });
    expect(r).toMatchObject({ memory_committed: true, summary_queued: false });
    expect(x.recordSummary).not.toHaveBeenCalled();
  });

  it('isVoiceSessionSummaryEnabled defaults on and only the exact string false disables it', () => {
    expect(isVoiceSessionSummaryEnabled(undefined)).toBe(true);
    expect(isVoiceSessionSummaryEnabled('true')).toBe(true);
    expect(isVoiceSessionSummaryEnabled('0')).toBe(true);
    expect(isVoiceSessionSummaryEnabled('false')).toBe(false);
  });

  it('never throws: a throwing commit and a rejecting summary are both contained', async () => {
    const x = seams();
    x.commitMemory.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    x.recordSummary.mockImplementationOnce(() => Promise.reject(new Error('router down')));
    const r = finalizeLiveSession(session(convo), { sessionId: 'live-1', reason: 'test', ...x });
    expect(r).toMatchObject({ ran: true, memory_committed: false, memory_skip_reason: 'commit_threw', summary_queued: true });
    await r.settled;
  });
});

describe('every end path goes through finalizeLiveSession (VTID-04353 source contract)', () => {
  const root = path.join(__dirname, '../../../../src');
  const orbLive = fs.readFileSync(path.join(root, 'routes/orb-live.ts'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'orb/live/session/live-session-controller.ts'), 'utf8');

  it.each([
    ['WS stop frame', orbLive, "reason: 'ws_stop'"],
    ['SSE disconnect', orbLive, "reason: 'sse_disconnect'"],
    ['idle sweep', orbLive, 'reason: `idle_sweep_${closeReason}`'],
    ['upstream genuine disconnect', orbLive, "reason: 'upstream_disconnect'"],
    ['WS socket cleanup', controller, 'reason: `ws_cleanup_${reason}`'],
    ['POST /live/session/stop', controller, "reason: 'live_session_stop'"],
  ])('%s', (_label, src, marker) => {
    expect(src).toContain(`finalizeLiveSession(`);
    expect(src).toContain(marker);
  });

  it('the controller no longer carries its own forced end-of-session extraction for the live transcript', () => {
    expect(controller).not.toContain('Cognee extraction queued from transcriptTurns');
  });
});
