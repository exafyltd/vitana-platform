/**
 * VTID-03985 — the cascade's `runTurn()` silently dropped a turn when the
 * primary LLM call returned `ok:true` with EMPTY text.
 *
 * `callViaRouter` only escalates to the stage's fallback model on an
 * explicit failure (`ok:false`); a technically-successful-but-empty
 * completion sails through as a "success" with nothing to say. Reached live
 * on the very first real exercise of this cascade path (VTID-03984 wired
 * Fish Audio into staging, which made `sr` cascade-eligible for the first
 * time) — the operator stage's current primary (`deepseek/deepseek-flash`,
 * VTID-03817) returned empty text for the day_close greeting turn, and the
 * session then sat in dead air for the full 30s stall-watchdog window
 * before closing with a generic, unhelpful error.
 *
 * These tests drive `CascadedLiveClient` directly (not source-check —
 * `cascaded-wiring.test.ts` already covers the "is it reachable" question;
 * this covers "does a turn actually complete").
 */

jest.mock('../../../../src/orb/live/upstream/cascaded/transcribe-stream', () => ({
  TranscribeStreamSession: jest.fn().mockImplementation(() => ({
    onFragment: jest.fn(),
    onError: jest.fn(),
    pushAudioB64: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../../src/services/llm-router', () => ({
  callViaRouter: jest.fn(),
}));

jest.mock('../../../../src/services/tts/polly', () => ({
  synthesizePolly: jest.fn(),
  resolvePollyVoice: jest.fn(),
}));

jest.mock('../../../../src/services/tts/fish', () => ({
  synthesizeFish: jest.fn(),
}));

import { CascadedLiveClient } from '../../../../src/orb/live/upstream/cascaded-live-client';
import { callViaRouter } from '../../../../src/services/llm-router';
import { synthesizePolly, resolvePollyVoice } from '../../../../src/services/tts/polly';

const mockCallViaRouter = callViaRouter as jest.Mock;
const mockSynthesizePolly = synthesizePolly as jest.Mock;
const mockResolvePollyVoice = resolvePollyVoice as jest.Mock;

async function makeConnectedClient(): Promise<CascadedLiveClient> {
  const client = new CascadedLiveClient({ lang: 'ru' });
  await client.connect({ systemInstruction: 'You are Vitana.' });
  return client;
}

describe('VTID-03985: cascade turn survives an ok-but-empty primary completion', () => {
  beforeEach(() => {
    mockCallViaRouter.mockReset();
    mockSynthesizePolly.mockReset();
    mockResolvePollyVoice.mockReset();
    mockResolvePollyVoice.mockReturnValue({ voiceId: 'Tatyana', engine: 'standard' });
    mockSynthesizePolly.mockResolvedValue({ audioB64: 'AAAA' });
  });

  it('retries against the fallback model and completes the turn when the retry has real text', async () => {
    mockCallViaRouter
      .mockResolvedValueOnce({ ok: true, text: '   ', provider: 'deepseek', model: 'deepseek-flash' })
      .mockResolvedValueOnce({
        ok: true,
        text: 'Privet! Kak dela?',
        provider: 'bedrock',
        model: 'eu.anthropic.claude-sonnet-4-6',
      });

    const client = await makeConnectedClient();
    const errors: unknown[] = [];
    const turns: unknown[] = [];
    const audioChunks: unknown[] = [];
    client.onError((e) => errors.push(e));
    client.onTurnComplete((e) => turns.push(e));
    client.onAudioOutput((e) => audioChunks.push(e));

    client.sendTextTurn('privet', true);
    // runTurn is fire-and-forget from sendTextTurn; flush microtasks.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockCallViaRouter).toHaveBeenCalledTimes(2);
    // The retry must target the stage's own confirmed-invokable fallback,
    // not silently repeat the primary that already came back empty.
    expect(mockCallViaRouter.mock.calls[1][2]).toMatchObject({
      providerOverride: 'bedrock',
      modelOverride: 'eu.anthropic.claude-sonnet-4-6',
      allowFallback: false,
    });
    expect(errors).toHaveLength(0);
    expect(turns).toHaveLength(1);
    expect(audioChunks.length).toBeGreaterThan(0);
    expect(mockSynthesizePolly).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Privet! Kak dela?' }),
    );
  });

  it('reports cascade_llm_empty only after BOTH the primary and the retry come back empty', async () => {
    mockCallViaRouter
      .mockResolvedValueOnce({ ok: true, text: '', provider: 'deepseek', model: 'deepseek-flash' })
      .mockResolvedValueOnce({ ok: true, text: '', provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });

    const client = await makeConnectedClient();
    const errors: Array<{ code?: string }> = [];
    client.onError((e) => errors.push(e));

    client.sendTextTurn('privet', true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockCallViaRouter).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('cascade_llm_empty');
    // No audio was ever synthesized for an empty reply.
    expect(mockSynthesizePolly).not.toHaveBeenCalled();
  });

  it('does NOT retry when the primary already used the router-level fallback (fallbackUsed:true)', async () => {
    // If callViaRouter itself already fell back internally (primary ok:false,
    // fallback ok:true-but-empty), retrying against the SAME fallback model
    // again would just repeat an already-exhausted path. Fail fast instead.
    mockCallViaRouter.mockResolvedValueOnce({
      ok: true,
      text: '',
      provider: 'bedrock',
      model: 'eu.anthropic.claude-sonnet-4-6',
      fallbackUsed: true,
    });

    const client = await makeConnectedClient();
    const errors: Array<{ code?: string }> = [];
    client.onError((e) => errors.push(e));

    client.sendTextTurn('privet', true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('cascade_llm_empty');
  });

  it('does not retry on an explicit primary failure (ok:false) — cascade_llm_failed still fires immediately', async () => {
    mockCallViaRouter.mockResolvedValueOnce({ ok: false, error: 'AccessDeniedException' });

    const client = await makeConnectedClient();
    const errors: Array<{ code?: string }> = [];
    client.onError((e) => errors.push(e));

    client.sendTextTurn('privet', true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('cascade_llm_failed');
  });

  it('a non-empty primary reply never triggers a retry call at all', async () => {
    mockCallViaRouter.mockResolvedValueOnce({
      ok: true,
      text: 'Zdravstvuyte!',
      provider: 'deepseek',
      model: 'deepseek-flash',
    });

    const client = await makeConnectedClient();
    const turns: unknown[] = [];
    client.onTurnComplete((e) => turns.push(e));

    client.sendTextTurn('privet', true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    expect(turns).toHaveLength(1);
  });
});
