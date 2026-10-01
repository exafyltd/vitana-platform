/**
 * VTID-04418 (Plan v1 WS-1.6) — duplicate teardown logic removed.
 *
 *  - A session superseded by a newer one is finalized (memory commit, voice
 *    summary, continuity, conversation.session.finalized) like every other end
 *    path. It was the one end path VTID-04353 missed.
 *  - The upstream keepalive is cleared through the one helper,
 *    `clearUpstreamKeepalive`, instead of five hand-copied blocks.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { clearUpstreamKeepalive } from '../../../../src/orb/live/session/upstream-keepalive';

const root = join(__dirname, '../../../../src');
const orbLive = readFileSync(join(root, 'routes/orb-live.ts'), 'utf8');
const controller = readFileSync(join(root, 'orb/live/session/live-session-controller.ts'), 'utf8');

// The hand-copied block the helper replaces.
const PAIRED_CLEAR = /if \(([\w.]+)\.upstreamPingInterval\) \{\s*clearInterval\(\1\.upstreamPingInterval\);\s*\1\.upstreamPingInterval = undefined;\s*\}\s*if \(\1\.silenceKeepaliveInterval\) \{/g;

describe('VTID-04418: superseded sessions are finalized', () => {
  it('terminateExistingSessionsForUser finalizes each superseded session before marking it inactive', () => {
    const start = orbLive.indexOf('function terminateExistingSessionsForUser(');
    expect(start).toBeGreaterThan(0);
    const body = orbLive.slice(start, orbLive.indexOf('return terminated;', start));
    const fin = body.indexOf("finalizeLiveSession(existingSession, { sessionId: sid, reason: 'superseded_by_new_session' })");
    const inactive = body.indexOf('existingSession.active = false;');
    expect(fin).toBeGreaterThan(0);
    expect(inactive).toBeGreaterThan(fin);
  });
});

describe('VTID-04418: one keepalive teardown', () => {
  it('no hand-copied keepalive clearing remains in orb-live.ts or the controller', () => {
    expect(orbLive.match(PAIRED_CLEAR) || []).toHaveLength(0);
    expect(controller.match(PAIRED_CLEAR) || []).toHaveLength(0);
    expect((orbLive.match(/clearUpstreamKeepalive\(/g) || []).length).toBeGreaterThanOrEqual(4);
    expect((controller.match(/clearUpstreamKeepalive\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('the helper clears both intervals and is idempotent', () => {
    jest.useFakeTimers();
    try {
      const ping = jest.fn();
      const silence = jest.fn();
      const session: any = {
        upstreamPingInterval: setInterval(ping, 10),
        silenceKeepaliveInterval: setInterval(silence, 10),
      };
      clearUpstreamKeepalive(session);
      clearUpstreamKeepalive(session);
      jest.advanceTimersByTime(100);
      expect(ping).not.toHaveBeenCalled();
      expect(silence).not.toHaveBeenCalled();
      expect(session.upstreamPingInterval).toBeUndefined();
      expect(session.silenceKeepaliveInterval).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// One upstream handler set (the Vertex path joins the shared handlers)
// ---------------------------------------------------------------------------

import {
  bindUpstreamSessionHandlers,
  isVertexSharedHandlersEnabled,
  type UpstreamMessageHandlerDeps,
} from '../../../../src/orb/live/session/upstream-message-handler';
import { getPendingToolResults } from '../../../../src/orb/live/session/pending-tool-results';
import { VertexLiveClient } from '../../../../src/orb/live/upstream/vertex-live-client';

class FakeClient {
  state = 'open';
  h: Record<string, ((e: any) => void) | undefined> = {};
  sentToolResults: any[] = [];
  async connect() { /* noop */ }
  sendAudioChunk() { return true; }
  sendTextTurn() { return true; }
  sendEndOfTurn() { return true; }
  sendToolResult(r: any) { this.sentToolResults.push(r); return true; }
  onAudioOutput(h: any) { this.h.audio = h; }
  onTranscript(h: any) { this.h.transcript = h; }
  onToolCall(h: any) { this.h.tool = h; }
  onTurnComplete(h: any) { this.h.turn = h; }
  onInterrupted(h: any) { this.h.interrupted = h; }
  onUsage(h: any) { this.h.usage = h; }
  onError(h: any) { this.h.error = h; }
  onClose(h: any) { this.h.close = h; }
  async close() { this.state = 'closed'; }
  getState() { return this.state; }
}

function harness(options?: Record<string, unknown>) {
  const session: any = {
    sessionId: 's', active: true, isModelSpeaking: false, audioOutChunks: 0, turn_count: 0,
    consecutiveModelTurns: 0, consecutiveToolCalls: 0, greetingSent: false, greetingTurnIndex: 0,
    inputTranscriptBuffer: '', outputTranscriptBuffer: '', transcriptTurns: [], pendingEventLinks: [],
    lastAudioForwardedTime: Date.now(), createdAt: new Date(), lang: 'sr', identity: null, isAnonymous: false,
    sseResponse: { write: () => true, writableEnded: false }, clientWs: null, navigationDispatched: false,
  };
  const client = new FakeClient();
  const deps: UpstreamMessageHandlerDeps = {
    clearResponseWatchdog: jest.fn(), detectAuthIntent: jest.fn().mockReturnValue(null),
    detectStillHereComplaint: jest.fn().mockReturnValue(false), dispatchEndConversationDirective: jest.fn(),
    emitDiag: jest.fn(), emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: '{"screen":"journey"}' }),
    isDevSandbox: jest.fn().mockReturnValue(false), sendAudioToLiveAPI: jest.fn().mockReturnValue(true),
    sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(true), sendWsMessage: jest.fn(),
    markVoiceLatency: jest.fn(), finalizeVoiceTurnLatency: jest.fn(), startResponseWatchdog: jest.fn(),
  };
  const callbacks = { onAudioResponse: jest.fn(), onTextResponse: jest.fn(), onError: jest.fn(), onTurnComplete: jest.fn(), onInterrupted: jest.fn() };
  bindUpstreamSessionHandlers({ session, client: client as any, callbacks, deps, options: options as any });
  return { session, client, callbacks };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('VTID-04418: shared upstream handlers', () => {
  it('the Vertex switch is an exact-string opt-in', () => {
    expect(isVertexSharedHandlersEnabled('true')).toBe(true);
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'staging-only']) expect(isVertexSharedHandlersEnabled(v)).toBe(false);
  });

  it('a completed turn clears the tool results the model consumed', async () => {
    const { session, client } = harness();
    client.h.tool!({ calls: [{ id: 't1', name: 'get_current_screen', args: {} }] });
    await flush();
    expect(getPendingToolResults(session).length).toBe(1);
    client.h.turn!({});
    expect(getPendingToolResults(session)).toEqual([]);
  });

  it('bindConnectionEvents:false leaves error/close to the route', () => {
    const shared = harness({ bindConnectionEvents: false });
    expect(shared.client.h.error).toBeUndefined();
    expect(shared.client.h.close).toBeUndefined();
    expect(shared.client.h.turn).toBeDefined();
    const nova = harness();
    expect(nova.client.h.error).toBeDefined();
    expect(nova.client.h.close).toBeDefined();
  });

  it('VertexLiveClient stops at an interruption and does not emit audio from the same frame', () => {
    const v = new VertexLiveClient();
    const audio = jest.fn();
    const interrupted = jest.fn();
    v.onAudioOutput(audio);
    v.onInterrupted(interrupted);
    (v as any).dispatchServerMessage({
      server_content: { interrupted: true, model_turn: { parts: [{ inline_data: { data: 'AAAA', mime_type: 'audio/pcm' } }] } },
    });
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(audio).not.toHaveBeenCalled();
  });

  it('orb-live.ts binds the shared handlers before connect and skips the raw handler when enabled', () => {
    const bindAt = orbLive.indexOf("const useSharedVertexHandlers = isVertexSharedHandlersEnabled();");
    const connectAt = orbLive.indexOf('await vertex.connect({');
    expect(bindAt).toBeGreaterThan(0);
    expect(connectAt).toBeGreaterThan(bindAt);
    const block = orbLive.slice(bindAt, connectAt);
    expect(block).toMatch(/bindUpstreamSessionHandlers\(\{\s*session,\s*client: vertex,/);
    expect(block).toMatch(/bindConnectionEvents: false/);
    expect(orbLive).toMatch(/if \(!useSharedVertexHandlers\) \{\s*ws\.on\('message', handleUpstreamLiveMessage\);/);
  });
});

describe('VTID-04418: the Vertex switch is pinned on staging only', () => {
  const wf = (n: string) => readFileSync(join(__dirname, '../../../../../../.github/workflows', n), 'utf8');
  it('staging strips and re-adds ORB_VERTEX_SHARED_HANDLERS=true', () => {
    const stage = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(stage).toMatch(/"ORB_VERTEX_SHARED_HANDLERS",/);
    expect(stage).toMatch(/\{name:"ORB_VERTEX_SHARED_HANDLERS", value:"true"\}/);
  });
  it('production does not set it', () => {
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toMatch(/ORB_VERTEX_SHARED_HANDLERS/);
  });
});
