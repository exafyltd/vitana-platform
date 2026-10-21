/**
 * BOOTSTRAP-VOICE-DATASET-EMITTER (LiveKit parity) — /api/v1/oasis/emit ingest gate.
 *
 * The LiveKit orb-agent cannot read tenant export policy, so it POSTs a RAW
 * `orb.turn.responded` payload (full reply_text + raw transcript + tool signal
 * + user/tenant ids). This proves the emit route:
 *   1. ACCEPTS the `orb.turn.responded` topic (previously refused by the prefix
 *      allowlist — it doesn't match `orb.livekit.`).
 *   2. Re-runs the consent/PII gate server-side via buildOrbTurnRespondedPayload:
 *      the persisted payload carries transcript + tool signal ONLY when consent
 *      holds, and is stripped to the non-PII envelope otherwise.
 *
 * Mirrors the Vertex path's gating exactly (same builder), so a consented
 * LiveKit turn contributes a real extractor row and a non-consented one cannot.
 */
process.env.NODE_ENV = 'test';
process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';

import express from 'express';
import request from 'supertest';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true, event_id: 'evt-1' })),
}));
jest.mock('../src/services/data-export-consent', () => ({
  dataExportConsentTag: jest.fn(),
}));

import { emitOasisEvent } from '../src/services/oasis-event-service';
import { dataExportConsentTag } from '../src/services/data-export-consent';
import oasisEmitRouter from '../src/routes/oasis-emit';

const emitOasisEventMock = emitOasisEvent as unknown as jest.Mock;
const consentTagMock = dataExportConsentTag as unknown as jest.Mock;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', oasisEmitRouter);
  return app;
}

const AUTH = { Authorization: 'Bearer test-service-token' };
const RAW = {
  orb_session_id: 'orb-1',
  conversation_id: 'conv-1',
  reply_text: 'Opened your calendar.',
  provider: 'livekit',
  user_id: 'u-1',
  tenant_id: 't-1',
  tool_name: 'create_calendar_event',
  input_text: 'book a dentist tomorrow',
  tool_call: { name: 'create_calendar_event', arguments: { when: 'tomorrow' } },
};

beforeEach(() => {
  emitOasisEventMock.mockClear();
  consentTagMock.mockReset();
});

describe('POST /api/v1/oasis/emit — orb.turn.responded ingest gate', () => {
  test('accepts the topic and persists the PII signal when consented', async () => {
    consentTagMock.mockResolvedValue({ data_export_ok: true });
    const res = await request(makeApp())
      .post('/api/v1/oasis/emit')
      .set(AUTH)
      .send({ topic: 'orb.turn.responded', payload: RAW });

    expect(res.status).toBe(200);
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    const arg = emitOasisEventMock.mock.calls[0][0] as { type: string; payload: Record<string, unknown> };
    expect(arg.type).toBe('orb.turn.responded');
    expect(arg.payload.transcript).toBe('book a dentist tomorrow');
    expect(arg.payload.input_text).toBe('book a dentist tomorrow');
    expect(arg.payload.tool_name).toBe('create_calendar_event');
    expect(arg.payload.tool_dispatched).toBe(true);
    expect(arg.payload.tool_call).toEqual({
      name: 'create_calendar_event',
      arguments: { when: 'tomorrow' },
    });
    expect(arg.payload.data_export_ok).toBe(true);
    // non-PII envelope always present
    expect(arg.payload.reply_preview).toBe('Opened your calendar.');
  });

  test('strips transcript + tool signal when NOT consented (envelope only)', async () => {
    consentTagMock.mockResolvedValue({});
    const res = await request(makeApp())
      .post('/api/v1/oasis/emit')
      .set(AUTH)
      .send({ topic: 'orb.turn.responded', payload: RAW });

    expect(res.status).toBe(200);
    const arg = emitOasisEventMock.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(arg.payload.transcript).toBeUndefined();
    expect(arg.payload.input_text).toBeUndefined();
    expect(arg.payload.tool_name).toBeUndefined();
    expect(arg.payload.tool_call).toBeUndefined();
    expect(arg.payload.data_export_ok).toBeUndefined();
    // non-PII envelope preserved
    expect(arg.payload.reply_preview).toBe('Opened your calendar.');
    expect(arg.payload.provider).toBe('livekit');
  });

  test('does not run the consent gate for unrelated topics', async () => {
    const res = await request(makeApp())
      .post('/api/v1/oasis/emit')
      .set(AUTH)
      .send({ topic: 'livekit.stt.recovery', payload: { outcome: 'attempted' } });

    expect(res.status).toBe(200);
    expect(consentTagMock).not.toHaveBeenCalled();
    const arg = emitOasisEventMock.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(arg.payload.outcome).toBe('attempted');
  });

  test('still refuses a non-allowlisted topic', async () => {
    const res = await request(makeApp())
      .post('/api/v1/oasis/emit')
      .set(AUTH)
      .send({ topic: 'evil.forged.topic', payload: {} });

    expect(res.status).toBe(400);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});
