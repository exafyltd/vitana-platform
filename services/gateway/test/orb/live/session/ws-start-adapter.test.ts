/**
 * VTID-03471 (L-04/L-05) — the WS transport's session start runs through the
 * SAME controller the HTTP/SSE transport uses.
 *
 * These are behavioral: `handleLiveSessionStart` is mocked so the assertions
 * are about the request/response surface the adapter synthesizes — the exact
 * surface the real controller reads (`req.identity`, `req.headers`,
 * `req.get()`, `req.body`, `res.status().json()`).
 *
 * Verified to fail against the pre-fix arrangement by pointing the WS start
 * back at its own fork: the fork never called the controller at all, so every
 * assertion here had nothing to observe.
 */

const handleLiveSessionStart = jest.fn();

jest.mock('../../../../src/orb/live/session/live-session-controller', () => ({
  handleLiveSessionStart: (...args: unknown[]) => handleLiveSessionStart(...args),
}));

import { startLiveSessionForWs } from '../../../../src/orb/live/session/ws-start-adapter';

type CapturedReq = {
  identity?: { user_id: string; tenant_id: string | null };
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
  get: (name: string) => string | undefined;
};

/** Make the mocked controller reply like the real one does. */
function replyWith(status: number, body: Record<string, unknown>) {
  handleLiveSessionStart.mockImplementation(async (_req: CapturedReq, res: any) => {
    res.status(status).json(body);
  });
}

const IDENTITY = { user_id: 'u-1', tenant_id: 't-1' };

describe('startLiveSessionForWs — request surface', () => {
  beforeEach(() => {
    handleLiveSessionStart.mockReset();
    replyWith(200, { ok: true, session_id: 'live-abc' });
  });

  it('passes the WS-verified identity straight through (tenant fallback survives)', async () => {
    await startLiveSessionForWs({
      startMessage: { type: 'start', lang: 'de' },
      identity: IDENTITY as any,
      upgradeHeaders: {},
    });
    const req = handleLiveSessionStart.mock.calls[0][0] as CapturedReq;
    expect(req.identity).toEqual(IDENTITY);
  });

  it('forwards every start field as the request body, minus the `type` discriminator', async () => {
    await startLiveSessionForWs({
      startMessage: {
        type: 'start',
        lang: 'de',
        guided_topic_id: 'topic-7',
        journey_focus_step: 'step-2',
        reconnect_stage: 'thinking',
        conversation_id: 'conv-9',
        transcript_history: [{ role: 'user', text: 'hi' }],
      },
      identity: IDENTITY as any,
      upgradeHeaders: {},
    });
    const req = handleLiveSessionStart.mock.calls[0][0] as CapturedReq;
    // The fields the WS fork used to silently drop.
    expect(req.body.guided_topic_id).toBe('topic-7');
    expect(req.body.journey_focus_step).toBe('step-2');
    expect(req.body.reconnect_stage).toBe('thinking');
    expect(req.body.conversation_id).toBe('conv-9');
    expect(req.body.transcript_history).toEqual([{ role: 'user', text: 'hi' }]);
    expect(req.body.lang).toBe('de');
    expect(req.body.type).toBeUndefined();
  });

  it('labels the start as `ws` so session telemetry can separate the transports', async () => {
    await startLiveSessionForWs({
      startMessage: { type: 'start' },
      upgradeHeaders: {},
    });
    const req = handleLiveSessionStart.mock.calls[0][0] as CapturedReq;
    expect(req.body.transport).toBe('ws');
  });

  it('exposes upgrade headers through req.get() — origin validation reads them that way', async () => {
    await startLiveSessionForWs({
      startMessage: { type: 'start' },
      upgradeHeaders: { origin: 'https://vitanaland.com', 'user-agent': 'jest' },
    });
    const req = handleLiveSessionStart.mock.calls[0][0] as CapturedReq;
    // validateOrigin() calls req.get('origin') / req.get('referer').
    expect(req.get('origin')).toBe('https://vitanaland.com');
    expect(req.get('Origin')).toBe('https://vitanaland.com');
    expect(req.get('referer')).toBeUndefined();
    expect(req.headers['user-agent']).toBe('jest');
  });

  it('synthesizes the Authorization header from the socket token, so an expired JWT is rejected not downgraded', async () => {
    replyWith(401, { ok: false, error: 'AUTH_TOKEN_INVALID', message: 'Session expired' });
    const result = await startLiveSessionForWs({
      startMessage: { type: 'start' },
      // token present, identity absent = exactly the expired-JWT shape
      token: 'stale.jwt.value',
      upgradeHeaders: {},
    });
    const req = handleLiveSessionStart.mock.calls[0][0] as CapturedReq;
    expect(req.headers.authorization).toBe('Bearer stale.jwt.value');
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('never leaks an Authorization header the socket did not present', async () => {
    await startLiveSessionForWs({
      startMessage: { type: 'start' },
      upgradeHeaders: { authorization: 'Bearer left.over.from.upgrade' },
      // no token
    });
    const req = handleLiveSessionStart.mock.calls[0][0] as CapturedReq;
    expect(req.headers.authorization).toBeUndefined();
  });

  it('does not mutate the caller\'s start message or headers', async () => {
    const startMessage = { type: 'start', lang: 'de' };
    const upgradeHeaders = { origin: 'https://vitanaland.com' };
    await startLiveSessionForWs({ startMessage, upgradeHeaders, token: 't' });
    expect(startMessage).toEqual({ type: 'start', lang: 'de' });
    expect(upgradeHeaders).toEqual({ origin: 'https://vitanaland.com' });
  });
});

describe('startLiveSessionForWs — response capture', () => {
  beforeEach(() => handleLiveSessionStart.mockReset());

  it('returns the controller status + body verbatim on success', async () => {
    replyWith(200, {
      ok: true,
      session_id: 'live-abc',
      conversation_id: 'conv-9',
      meta: { context_status: 'pending', voice_quota: null },
    });
    const result = await startLiveSessionForWs({
      startMessage: { type: 'start' },
      upgradeHeaders: {},
    });
    expect(result.status).toBe(200);
    expect(result.body.session_id).toBe('live-abc');
    expect(result.body.conversation_id).toBe('conv-9');
    expect((result.body.meta as any).context_status).toBe('pending');
  });

  it('defaults to 200 with an empty body when the controller answers nothing', async () => {
    handleLiveSessionStart.mockImplementation(async () => {
      /* controller returned without responding */
    });
    const result = await startLiveSessionForWs({
      startMessage: { type: 'start' },
      upgradeHeaders: {},
    });
    // The caller treats a missing `ok`/`session_id` as a failed start.
    expect(result.body.ok).toBeUndefined();
    expect(result.body.session_id).toBeUndefined();
  });

  it('propagates a controller throw rather than pretending the session started', async () => {
    handleLiveSessionStart.mockImplementation(async () => {
      throw new Error('boom');
    });
    await expect(
      startLiveSessionForWs({ startMessage: { type: 'start' }, upgradeHeaders: {} }),
    ).rejects.toThrow('boom');
  });
});
