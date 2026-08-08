/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 6): NovaWsFacade tests.
 *
 * The facade presents a minimal `ws`-like surface over an
 * UpstreamLiveClient and translates the Vertex BidiGenerateContent wire
 * envelopes into provider-neutral client calls. No network — a fake
 * client with jest.fn methods, mirroring the injected-fake pattern of
 * nova-sonic-live-client.test.ts / upstream-client-factory.test.ts.
 */

import { createNovaWsFacade } from '../../../../src/orb/live/upstream/nova-ws-facade';
import type { UpstreamLiveClient, UpstreamConnectionState } from '../../../../src/orb/live/upstream/types';

function makeFakeClient(state: UpstreamConnectionState = 'open') {
  let currentState = state;
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    sendAudioChunk: jest.fn().mockReturnValue(true),
    sendTextTurn: jest.fn().mockReturnValue(true),
    sendEndOfTurn: jest.fn().mockReturnValue(true),
    sendToolResult: jest.fn().mockReturnValue(true),
    onAudioOutput: jest.fn(),
    onTranscript: jest.fn(),
    onToolCall: jest.fn(),
    onTurnComplete: jest.fn(),
    onInterrupted: jest.fn(),
    onError: jest.fn(),
    onClose: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    getState: jest.fn(() => currentState),
    __setState: (s: UpstreamConnectionState) => { currentState = s; },
  };
  return client as unknown as UpstreamLiveClient & { __setState: (s: UpstreamConnectionState) => void };
}

const flush = () => new Promise((r) => setImmediate(r));

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('createNovaWsFacade', () => {
  it('is marked so diagnostics can tell facade from real socket', () => {
    const facade = createNovaWsFacade(makeFakeClient());
    expect(facade.__novaFacade).toBe(true);
  });

  describe('readyState', () => {
    it('reports OPEN (1) only while the client state is open', () => {
      const client = makeFakeClient('open');
      const facade = createNovaWsFacade(client);
      expect(facade.readyState).toBe(1);
    });

    it('reports CLOSED (3) for every non-open state', () => {
      const client = makeFakeClient('idle');
      const facade = createNovaWsFacade(client);
      for (const s of ['idle', 'connecting', 'closing', 'closed', 'error'] as const) {
        client.__setState(s);
        expect(facade.readyState).toBe(3);
      }
      // and it is live, not a snapshot
      client.__setState('open');
      expect(facade.readyState).toBe(1);
    });
  });

  describe('send — realtime_input', () => {
    it('forwards each media chunk as sendAudioChunk (b64 passthrough, mime preserved)', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({
        realtime_input: {
          media_chunks: [
            { data: 'AAA=', mime_type: 'audio/pcm;rate=16000' },
            { data: 'BBB=', mime_type: 'audio/pcm;rate=16000' },
          ],
        },
      }));

      expect(client.sendAudioChunk).toHaveBeenCalledTimes(2);
      expect(client.sendAudioChunk).toHaveBeenNthCalledWith(1, 'AAA=', 'audio/pcm;rate=16000');
      expect(client.sendAudioChunk).toHaveBeenNthCalledWith(2, 'BBB=', 'audio/pcm;rate=16000');
      expect(client.sendTextTurn).not.toHaveBeenCalled();
    });

    it('skips chunks whose data is not a string', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({
        realtime_input: { media_chunks: [{ data: 123 }, null, { data: 'CCC=' }] },
      }));

      expect(client.sendAudioChunk).toHaveBeenCalledTimes(1);
      expect(client.sendAudioChunk).toHaveBeenCalledWith('CCC=', undefined);
    });
  });

  describe('send — client_content', () => {
    it('joins text parts across turns into one sendTextTurn, turn-complete by default', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({
        client_content: {
          turns: [
            { parts: [{ text: 'hello' }, { text: 'there' }] },
            { parts: [{ text: 'world' }] },
          ],
        },
      }));

      expect(client.sendTextTurn).toHaveBeenCalledTimes(1);
      expect(client.sendTextTurn).toHaveBeenCalledWith('hello\nthere\nworld', true);
      expect(client.sendEndOfTurn).not.toHaveBeenCalled();
    });

    it('honors an explicit turn_complete: false', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({
        client_content: { turns: [{ parts: [{ text: 'partial' }] }], turn_complete: false },
      }));

      expect(client.sendTextTurn).toHaveBeenCalledWith('partial', false);
    });

    it('a bare turn_complete (no turns) maps to sendEndOfTurn', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({ client_content: { turn_complete: true } }));

      expect(client.sendEndOfTurn).toHaveBeenCalledTimes(1);
      expect(client.sendTextTurn).not.toHaveBeenCalled();
    });

    it('empty client_content (no texts, no turn_complete) sends nothing', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({ client_content: { turns: [{ parts: [{ text: '' }] }] } }));

      expect(client.sendTextTurn).not.toHaveBeenCalled();
      expect(client.sendEndOfTurn).not.toHaveBeenCalled();
      expect(client.sendAudioChunk).not.toHaveBeenCalled();
    });
  });

  describe('send — refusals and drops', () => {
    it('refuses tool_response envelopes — tool results must use client.sendToolResult', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({ tool_response: { function_responses: [{ id: 'c1' }] } }));

      expect(client.sendToolResult).not.toHaveBeenCalled();
      expect(client.sendTextTurn).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('facade refused tool_response'));
    });

    it('drops non-JSON payloads with a warning, without touching the client', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send('not json {');

      expect(client.sendAudioChunk).not.toHaveBeenCalled();
      expect(client.sendTextTurn).not.toHaveBeenCalled();
      expect(client.sendEndOfTurn).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped non-JSON upstream payload'));
    });

    it('drops unrecognized envelopes, naming the keys in the warning', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({ mystery_envelope: 1, other: 2 }));

      expect(client.sendTextTurn).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unrecognized upstream envelope: keys=mystery_envelope,other'),
      );
    });

    it('an empty realtime_input.media_chunks array is not treated as audio (falls through to drop)', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.send(JSON.stringify({ realtime_input: { media_chunks: [] } }));

      expect(client.sendAudioChunk).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unrecognized upstream envelope'));
    });
  });

  describe('close / terminate / ping', () => {
    it('close(code, reason) closes the client with the reason only', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.close(1000, 'persona_swap');

      expect(client.close).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledWith('persona_swap');
    });

    it("terminate() closes with reason 'terminated'", () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.terminate();

      expect(client.close).toHaveBeenCalledWith('terminated');
    });

    it('close rejections are swallowed (idempotent close)', async () => {
      const client = makeFakeClient();
      (client.close as jest.Mock).mockRejectedValue(new Error('already closed'));
      const facade = createNovaWsFacade(client);

      expect(() => facade.close(1001, 'again')).not.toThrow();
      expect(() => facade.terminate()).not.toThrow();
      await flush(); // would surface an unhandled rejection if not caught
      expect(client.close).toHaveBeenCalledTimes(2);
    });

    it('ping() is a no-op that never touches the client', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      facade.ping();

      expect(client.close).not.toHaveBeenCalled();
      expect(client.sendAudioChunk).not.toHaveBeenCalled();
      expect(client.sendEndOfTurn).not.toHaveBeenCalled();
    });
  });

  describe('inert listener surface', () => {
    it('on/once/removeListener/removeAllListeners exist and never crash or register upstream', () => {
      const client = makeFakeClient();
      const facade = createNovaWsFacade(client);

      expect(() => {
        facade.on();
        facade.once();
        facade.removeListener();
        facade.removeAllListeners();
      }).not.toThrow();

      // Inbound events flow via bindUpstreamSessionHandlers, never the facade
      expect(client.onAudioOutput).not.toHaveBeenCalled();
      expect(client.onTranscript).not.toHaveBeenCalled();
      expect(client.onClose).not.toHaveBeenCalled();
      expect(client.onError).not.toHaveBeenCalled();
    });
  });
});
