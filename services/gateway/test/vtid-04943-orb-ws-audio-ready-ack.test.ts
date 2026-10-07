/**
 * VTID-04943 — since VTID-04866 moved production voice to the WebSocket
 * transport, the WS `audio_ready` released the greeting but recorded nothing;
 * only the HTTP route wrote the ack. Morning check row 16 counted 0 acks
 * against 100+ session starts. Both transports now share recordAudioReadyAck.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as repo from '../src/services/orb/orb-session-state-repository';
import { recordAudioReadyAck } from '../src/services/orb/orb-session-state';

const NOW = Date.parse('2026-10-07T10:00:00Z');
const supabase = {} as any;

describe('recordAudioReadyAck (VTID-04943)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes the audio_ready_ack row and emits the acked event with transport and greeting', async () => {
    const upsert = jest.spyOn(repo, 'upsertOrbSessionStateValue').mockResolvedValue({ error: null } as any);
    const emit = jest.fn().mockResolvedValue(undefined);
    const r = await recordAudioReadyAck({
      supabase, userId: 'u1', sessionId: 's1', transport: 'ws', greeting: 'prebuffer_flushed', emit, nowMs: NOW,
    });
    expect(r).toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(supabase, expect.objectContaining({
      user_id: 'u1', key: 'audio_ready_ack', value: { session_id: 's1', ready_at: new Date(NOW).toISOString() },
    }));
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0][0];
    expect(ev).toMatchObject({ type: 'orb.session.audio_ready.acked', vtid: 'DEV-COMHU-0504', actor_id: 'u1', surface: 'orb' });
    // `ok` stays: ci_orb_session_state_health() counts by it.
    expect(ev.payload).toEqual({ session_id: 's1', user_id: 'u1', ok: true, reason: undefined, transport: 'ws', greeting: 'prebuffer_flushed' });
  });

  it('http keeps the original payload plus transport, no greeting field', async () => {
    jest.spyOn(repo, 'upsertOrbSessionStateValue').mockResolvedValue({ error: null } as any);
    const emit = jest.fn();
    await recordAudioReadyAck({ supabase, userId: 'u1', sessionId: 's1', transport: 'http', emit, nowMs: NOW });
    expect(emit.mock.calls[0][0].payload).toEqual({ session_id: 's1', user_id: 'u1', ok: true, reason: undefined, transport: 'http' });
  });

  it('records nothing for an anonymous caller or without a database', async () => {
    const upsert = jest.spyOn(repo, 'upsertOrbSessionStateValue');
    const emit = jest.fn();
    expect(await recordAudioReadyAck({ supabase, userId: undefined, sessionId: 's1', transport: 'ws', emit }))
      .toEqual({ ok: false, reason: 'anonymous_no_ack' });
    expect(await recordAudioReadyAck({ supabase: null, userId: 'u1', sessionId: 's1', transport: 'ws', emit }))
      .toEqual({ ok: false, reason: 'supabase_unavailable' });
    expect(upsert).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('a failed write still emits the event with ok:false', async () => {
    jest.spyOn(repo, 'upsertOrbSessionStateValue').mockResolvedValue({ error: { message: 'boom' } } as any);
    const emit = jest.fn();
    const r = await recordAudioReadyAck({ supabase, userId: 'u1', sessionId: 's1', transport: 'ws', emit, nowMs: NOW });
    expect(r).toEqual({ ok: false, reason: 'boom' });
    expect(emit.mock.calls[0][0].payload).toMatchObject({ ok: false, reason: 'boom' });
  });

  it('never throws when the emitter throws or rejects', async () => {
    jest.spyOn(repo, 'upsertOrbSessionStateValue').mockResolvedValue({ error: null } as any);
    await expect(recordAudioReadyAck({
      supabase, userId: 'u1', sessionId: 's1', transport: 'ws', emit: () => { throw new Error('x'); },
    })).resolves.toEqual({ ok: true });
    await expect(recordAudioReadyAck({
      supabase, userId: 'u1', sessionId: 's1', transport: 'ws', emit: () => Promise.reject(new Error('y')),
    })).resolves.toEqual({ ok: true });
  });
});

describe('both transports call recordAudioReadyAck (VTID-04943)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/orb-live.ts'), 'utf8');

  it('the HTTP route records through the helper with transport http and the same response', () => {
    const route = src.slice(src.indexOf("router.post('/session/:id/audio-ready'"));
    const body = route.slice(0, route.indexOf('\n});'));
    expect(body).toContain("transport: 'http'");
    expect(body).toContain('recordAudioReadyAck');
    expect(body).toContain('return res.json({ ok: r.ok });');
    expect(body).toContain("reason: 'anonymous_no_ack'");
    expect(body).not.toContain('writeOrbSessionState(');
  });

  it('the WS audio_ready records after the greeting branch, only for an identified user', () => {
    const start = src.indexOf("    case 'audio_ready':");
    const block = src.slice(start, src.indexOf("    case 'stop':", start));
    const flush = block.indexOf("flushPrebufferedGreeting(liveSession, clientWs, 'audio_ready')");
    const deferred = block.indexOf('sendGreetingPromptToLiveAPI(liveSession.upstreamWs, liveSession)');
    const record = block.indexOf('recordAudioReadyAck(');
    expect(flush).toBeGreaterThan(0);
    expect(deferred).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(flush);
    expect(record).toBeGreaterThan(deferred);
    expect(block).toContain("transport: 'ws'");
    expect(block).toContain('greeting: wsGreeting');
    expect(block).toMatch(/const ackUserId = liveSession\.identity\?\.user_id;\s*if \(ackUserId\) \{/);
    expect(block.match(/recordAudioReadyAck\(/g)?.length).toBe(1);
    // never awaited: the greeting path does not wait on telemetry
    expect(block).not.toMatch(/await\s+(import\('\.\.\/services\/orb\/orb-session-state'\)|recordAudioReadyAck)/);
    for (const g of ["'deferred_sent'", "'prebuffer_flushed'", "'already_released'"]) expect(block).toContain(`wsGreeting = ${g}`);
  });
});
