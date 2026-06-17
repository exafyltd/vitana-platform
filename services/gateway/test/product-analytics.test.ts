/**
 * BOOTSTRAP-PRODUCT-ANALYTICS: ingestion endpoint tests.
 *
 * POST /api/v1/analytics/events/batch
 *  - valid batch inserts events
 *  - invalid event returns 400
 *  - consent_state='denied' events are dropped (inserted 0, dropped 1)
 *  - duplicate event_id upserts with ignoreDuplicates (no duplicate rows)
 *  - forbidden raw-text property keys are stripped before insert
 */

import request from 'supertest';
import express from 'express';

process.env.NODE_ENV = 'test';

const mockUpsert = jest.fn().mockResolvedValue({ error: null });
const mockFrom = jest.fn().mockReturnValue({ upsert: mockUpsert });
jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn().mockReturnValue({ from: (...args: any[]) => mockFrom(...args) }),
}));

import productAnalyticsRouter from '../src/routes/product-analytics';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-00000001',
    event_name: 'screen_viewed',
    event_type: 'journey',
    tenant_id: TENANT_ID,
    user_id_hash: 'abc123',
    session_id: 'session-1',
    journey_id: null,
    conversation_id: null,
    screen_route: '/community',
    screen_id: null,
    feature_key: null,
    source: 'web',
    app_version: '1.0.0',
    language: 'de',
    device_type: 'mobile',
    consent_state: 'granted',
    properties: {},
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('POST /api/v1/analytics/events/batch', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsert.mockResolvedValue({ error: null });
    app = express();
    app.use(express.json());
    app.use('/api/v1/analytics', productAnalyticsRouter);
  });

  it('inserts a valid batch', async () => {
    const res = await request(app)
      .post('/api/v1/analytics/events/batch')
      .send({ events: [makeEvent()] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 1, dropped: 0 });
    expect(mockFrom).toHaveBeenCalledWith('product_analytics_events');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid event with 400', async () => {
    const res = await request(app)
      .post('/api/v1/analytics/events/batch')
      .send({ events: [makeEvent({ event_type: 'not-a-type' })] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'INVALID_ANALYTICS_BATCH' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects an empty batch with 400', async () => {
    const res = await request(app).post('/api/v1/analytics/events/batch').send({ events: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a batch over 100 events with 400', async () => {
    const events = Array.from({ length: 101 }, (_, i) => makeEvent({ event_id: `evt-${String(i).padStart(8, '0')}` }));
    const res = await request(app).post('/api/v1/analytics/events/batch').send({ events });
    expect(res.status).toBe(400);
  });

  it('drops consent-denied events without writing them', async () => {
    const res = await request(app)
      .post('/api/v1/analytics/events/batch')
      .send({ events: [makeEvent({ consent_state: 'denied' })] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 0, dropped: 1 });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('upserts on event_id with ignoreDuplicates so retries never duplicate rows', async () => {
    const event = makeEvent();
    await request(app).post('/api/v1/analytics/events/batch').send({ events: [event, { ...event }] });

    expect(mockUpsert).toHaveBeenCalledWith(expect.any(Array), {
      onConflict: 'event_id',
      ignoreDuplicates: true,
    });
  });

  it('strips raw message text keys from properties before insert', async () => {
    const event = makeEvent({
      event_name: 'user_message_sent',
      event_type: 'assistant',
      conversation_id: 'convo-1',
      properties: {
        message: 'my raw health question',
        prompt: 'secret prompt',
        raw_text: 'transcript text',
        transcript: 'voice transcript',
        answer: 'assistant answer',
        message_length: 24,
        input_mode: 'text',
      },
    });

    const res = await request(app).post('/api/v1/analytics/events/batch').send({ events: [event] });
    expect(res.status).toBe(200);

    const inserted = mockUpsert.mock.calls[0][0][0];
    expect(inserted.properties).toEqual({ message_length: 24, input_mode: 'text' });
    expect(JSON.stringify(inserted)).not.toContain('my raw health question');
  });

  it('returns 500 when the insert fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'boom' } });
    const res = await request(app)
      .post('/api/v1/analytics/events/batch')
      .send({ events: [makeEvent()] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'ANALYTICS_INSERT_FAILED' });
  });
});
