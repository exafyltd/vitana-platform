/**
 * VTID-03722 — the cascade must END a user turn on its own.
 *
 * The defect this pins, found by review on PR #3177 and confirmed against
 * source before acting:
 *
 *   - `orb-widget.js` sends only `{type:'audio'}` frames. It NEVER sends
 *     `end_turn` — zero occurrences in the file.
 *   - Nova does not need one: it runs VAD inside its own bidirectional
 *     stream, which is why nobody noticed the widget never sends a boundary.
 *   - `CascadedLiveClient.runTurn()` was reachable ONLY from `sendTextTurn()`
 *     and `sendEndOfTurn()`. The transcript handler appended finals to
 *     `pendingUserText` and stopped there.
 *
 * Net effect with the cascade switched on: the greeting speaks (a text turn),
 * the user then talks, Transcribe transcribes correctly — and Bedrock is never
 * invoked. Silence, forever. Strictly worse than the English it replaced,
 * which is why this had to land before the flag reaches anyone.
 *
 * `vadSilenceMs` was already being passed to `connect()` and discarded; it is
 * now the debounce that closes the turn.
 */

const mockTranscribeCtor = jest.fn();
const mockStop = jest.fn().mockResolvedValue(undefined);
let fragmentHandler: ((f: { text: string; isPartial: boolean }) => void) | null = null;

jest.mock('../../../../src/orb/live/upstream/cascaded/transcribe-stream', () => ({
  TranscribeStreamSession: class {
    constructor(opts: unknown) {
      mockTranscribeCtor(opts);
    }
    onFragment(h: (f: { text: string; isPartial: boolean }) => void) {
      fragmentHandler = h;
    }
    onError() {
      /* not exercised here */
    }
    async start() {
      /* no real AWS stream */
    }
    async stop() {
      return mockStop();
    }
    sendAudio() {
      return true;
    }
  },
}));

const mockCallViaRouter = jest.fn();
jest.mock('../../../../src/services/llm-router', () => ({
  callViaRouter: (...a: unknown[]) => mockCallViaRouter(...a),
}));

const mockSynthesizePolly = jest.fn();
jest.mock('../../../../src/services/tts/polly', () => ({
  ...jest.requireActual('../../../../src/services/tts/polly'),
  synthesizePolly: (...a: unknown[]) => mockSynthesizePolly(...a),
}));

import {
  CascadedLiveClient,
  DEFAULT_CASCADE_VAD_SILENCE_MS,
} from '../../../../src/orb/live/upstream/cascaded-live-client';

async function connectedClient(vadSilenceMs?: number) {
  const c = new CascadedLiveClient({ lang: 'pl' });
  await c.connect({
    model: 'cascaded',
    voiceName: 'polly:pl',
    responseModalities: ['audio'],
    vadSilenceMs,
    systemInstruction: 'be helpful',
  } as never);
  return c;
}

/** Let the debounce elapse and any queued microtasks settle. */
async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  fragmentHandler = null;
  mockCallViaRouter.mockReset().mockResolvedValue({ ok: true, text: 'dzień dobry' });
  mockSynthesizePolly.mockReset().mockResolvedValue({ audioB64: 'AAAA' });
  mockTranscribeCtor.mockReset();
  mockStop.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('VTID-03722: the cascade ends a user turn without an end_turn frame', () => {
  it('invokes the model after the silence budget, with NO end_turn ever sent', async () => {
    const c = await connectedClient();
    expect(fragmentHandler).toBeTruthy();

    fragmentHandler!({ text: 'cześć', isPartial: false });
    expect(mockCallViaRouter).not.toHaveBeenCalled(); // still mid-turn

    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS + 10);

    // The whole point: a reply happened without anyone calling sendEndOfTurn().
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    expect(mockCallViaRouter.mock.calls[0][1]).toBe('cześć');
    await c.close();
  });

  it('does not cut the user off mid-sentence — each fragment pushes the boundary out', async () => {
    await connectedClient();

    fragmentHandler!({ text: 'chcę', isPartial: false });
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS - 100);
    fragmentHandler!({ text: 'powiedzieć', isPartial: false });
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS - 100);
    expect(mockCallViaRouter).not.toHaveBeenCalled();

    await advance(200);
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    // Both clauses reach the model as ONE turn, in order.
    expect(mockCallViaRouter.mock.calls[0][1]).toBe('chcę powiedzieć');
  });

  it('treats a partial as "still speaking" and re-arms', async () => {
    await connectedClient();

    fragmentHandler!({ text: 'to jest', isPartial: false });
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS - 50);
    fragmentHandler!({ text: 'to jest dłu', isPartial: true }); // revision in flight
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS - 50);
    expect(mockCallViaRouter).not.toHaveBeenCalled();

    await advance(100);
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    // A partial re-arms but is NOT accumulated — Transcribe revises partials,
    // so appending them feeds the model the same clause twice.
    expect(mockCallViaRouter.mock.calls[0][1]).toBe('to jest');
  });

  it('never fires a turn on silence alone', async () => {
    await connectedClient();
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS * 5);
    expect(mockCallViaRouter).not.toHaveBeenCalled();
  });

  it('honours a per-session vadSilenceMs', async () => {
    await connectedClient(400);
    fragmentHandler!({ text: 'tak', isPartial: false });
    await advance(300);
    expect(mockCallViaRouter).not.toHaveBeenCalled();
    await advance(150);
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 50, 60_000, NaN, undefined])(
    'falls back to the default for an out-of-range vadSilenceMs (%p)',
    async (v) => {
      // 0 would end the turn on the first final fragment (cutting the user
      // off); an enormous value would hang the turn forever. Both are worse
      // than the default, so the range is guarded rather than trusted.
      await connectedClient(v as number);
      fragmentHandler!({ text: 'ok', isPartial: false });
      await advance(DEFAULT_CASCADE_VAD_SILENCE_MS + 10);
      expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    },
  );

  it('stops the countdown on close, so a torn-down session cannot fire a turn', async () => {
    const c = await connectedClient();
    fragmentHandler!({ text: 'halo', isPartial: false });
    await c.close('user_stop');
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS * 3);
    expect(mockCallViaRouter).not.toHaveBeenCalled();
  });

  it('does not start a second turn while one is in flight', async () => {
    // A slow model call must not be raced by the next countdown.
    let release!: (v: unknown) => void;
    mockCallViaRouter.mockReturnValueOnce(new Promise((r) => { release = r; }));

    await connectedClient();
    fragmentHandler!({ text: 'pierwsze', isPartial: false });
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS + 10);
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);

    fragmentHandler!({ text: 'drugie', isPartial: false });
    await advance(DEFAULT_CASCADE_VAD_SILENCE_MS + 10);
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1); // still just the one

    release({ ok: true, text: 'odpowiedź' });
  });
});
