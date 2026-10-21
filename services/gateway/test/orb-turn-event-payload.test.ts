/**
 * BOOTSTRAP-VOICE-DATASET-EMITTER — orb.turn.responded payload assembly tests.
 *
 * Proves the contract the voice-tool-routing dataset extractor
 * (services/gateway/scripts/datasets/voice-tool-routing.ts) depends on:
 *   - WHEN export consent is established AND the turn is not guardrail-excluded,
 *     the emitted payload (→ oasis_events.metadata) carries the extractor's
 *     projected fields: tool_name, tool_call{name,arguments}, transcript,
 *     input_text.
 *   - WHEN consent is absent, or the turn is guardrail-excluded, those raw /
 *     tool-routing fields are OMITTED entirely (PII fail-closed), while the
 *     non-PII envelope (reply_preview, provider, mode) is preserved.
 *
 * These mirror the extractor's exact projection so a green test here means a
 * non-zero extraction downstream.
 */

process.env.NODE_ENV = 'test';

import {
  buildOrbTurnRespondedPayload,
  type BuildOrbTurnPayloadInput,
} from '../src/routes/orb-turn-event-payload';

const BASE: Omit<BuildOrbTurnPayloadInput, 'consentTag'> = {
  orbSessionId: 'orb-abc',
  conversationId: 'conv-xyz',
  replyText: 'Sure — I have opened your calendar for tomorrow.',
  provider: 'vertex',
  toolSignal: {
    toolName: 'create_calendar_event',
    inputText: 'book me a dentist appointment tomorrow at 9',
    toolCall: {
      name: 'create_calendar_event',
      arguments: { title: 'Dentist', when: 'tomorrow 09:00' },
    },
  },
};

/** Mirrors the extractor's projection in voice-tool-routing.ts. */
function extractorProjection(meta: Record<string, unknown>) {
  const tc = meta.tool_call as { name?: string; arguments?: unknown } | undefined;
  const toolName = (meta.tool_name as string | undefined) ?? tc?.name;
  const userInput = (meta.transcript as string | undefined) ?? (meta.input_text as string | undefined);
  return { toolName, userInput, toolArguments: tc?.arguments ?? null };
}

describe('buildOrbTurnRespondedPayload — consented turn', () => {
  const payload = buildOrbTurnRespondedPayload({
    ...BASE,
    consentTag: { data_export_ok: true },
  });

  test('carries the extractor-aligned tool + transcript fields', () => {
    expect(payload.tool_name).toBe('create_calendar_event');
    expect(payload.tool_dispatched).toBe(true);
    expect(payload.transcript).toBe('book me a dentist appointment tomorrow at 9');
    expect(payload.input_text).toBe('book me a dentist appointment tomorrow at 9');
    expect(payload.tool_call).toEqual({
      name: 'create_calendar_event',
      arguments: { title: 'Dentist', when: 'tomorrow 09:00' },
    });
  });

  test('the extractor would derive a real (user_input, tool_chosen) row', () => {
    const proj = extractorProjection(payload);
    expect(proj.toolName).toBe('create_calendar_event');
    expect(proj.userInput).toBe('book me a dentist appointment tomorrow at 9');
    expect(proj.toolArguments).toEqual({ title: 'Dentist', when: 'tomorrow 09:00' });
  });

  test('preserves the existing envelope (no regression)', () => {
    expect(payload.orb_session_id).toBe('orb-abc');
    expect(payload.conversation_id).toBe('conv-xyz');
    expect(payload.reply_preview).toBe('Sure — I have opened your calendar for tomorrow.');
    expect(payload.provider).toBe('vertex');
    expect(payload.metadata).toEqual({ mode: 'orb_voice' });
    expect(payload.data_export_ok).toBe(true);
  });
});

describe('buildOrbTurnRespondedPayload — NOT consented', () => {
  const payload = buildOrbTurnRespondedPayload({
    ...BASE,
    consentTag: {}, // dataExportConsentTag returned no flag
  });

  test('omits all raw / tool-routing fields', () => {
    expect(payload.tool_name).toBeUndefined();
    expect(payload.tool_call).toBeUndefined();
    expect(payload.transcript).toBeUndefined();
    expect(payload.input_text).toBeUndefined();
    expect(payload.tool_dispatched).toBeUndefined();
    expect('data_export_ok' in payload).toBe(false);
  });

  test('the extractor would skip this row (no toolName/userInput)', () => {
    const proj = extractorProjection(payload);
    expect(proj.toolName).toBeUndefined();
    expect(proj.userInput).toBeUndefined();
  });

  test('still emits the non-PII envelope', () => {
    expect(payload.reply_preview).toBe('Sure — I have opened your calendar for tomorrow.');
    expect(payload.provider).toBe('vertex');
    expect(payload.metadata).toEqual({ mode: 'orb_voice' });
  });
});

describe('buildOrbTurnRespondedPayload — guardrail-excluded turn', () => {
  test('withholds raw fields even when consent is present', () => {
    const payload = buildOrbTurnRespondedPayload({
      ...BASE,
      consentTag: { data_export_ok: true },
      guardrailExcluded: true,
    });
    expect(payload.tool_name).toBeUndefined();
    expect(payload.transcript).toBeUndefined();
    expect(payload.input_text).toBeUndefined();
    expect(payload.tool_call).toBeUndefined();
    // consent flag itself is still recorded; only the PII content is withheld.
    expect(payload.data_export_ok).toBe(true);
    expect(payload.reply_preview).toBe('Sure — I have opened your calendar for tomorrow.');
  });
});

describe('buildOrbTurnRespondedPayload — tool_call.name fallback', () => {
  test('uses tool_call.name when toolName is absent (extractor fallback path)', () => {
    const payload = buildOrbTurnRespondedPayload({
      ...BASE,
      consentTag: { data_export_ok: true },
      toolSignal: {
        inputText: 'what is on my calendar',
        toolCall: { name: 'search_calendar' },
      },
    });
    expect(payload.tool_name).toBe('search_calendar');
    expect(payload.tool_call).toEqual({ name: 'search_calendar' });
    expect(extractorProjection(payload).toolName).toBe('search_calendar');
  });
});

describe('buildOrbTurnRespondedPayload — consented turn with NO tool dispatched', () => {
  test('emits transcript but no tool fields (extractor skips: no toolName)', () => {
    const payload = buildOrbTurnRespondedPayload({
      ...BASE,
      consentTag: { data_export_ok: true },
      toolSignal: { inputText: 'just chatting, thanks' },
    });
    expect(payload.transcript).toBe('just chatting, thanks');
    expect(payload.input_text).toBe('just chatting, thanks');
    expect(payload.tool_name).toBeUndefined();
    expect(payload.tool_call).toBeUndefined();
    expect(extractorProjection(payload).toolName).toBeUndefined();
  });
});
