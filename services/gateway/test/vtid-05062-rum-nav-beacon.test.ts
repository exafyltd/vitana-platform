/**
 * VTID-05062: RUM nav beacon (`kind: 'nav'`) on POST /api/v1/rum/beacon.
 *
 *  - a valid nav beacon → 204 and ONE `screen.nav.measured` event with the nav fields;
 *  - invalid nav beacons → 400, nothing emitted;
 *  - metric beacons are unchanged: same topic, same payload keys, same message;
 *  - the feature flag gates nav beacons exactly like metric beacons.
 */

import request from 'supertest';
import express from 'express';

const mockEmit = jest.fn(async (_e: any) => ({ ok: true, event_id: 'evt-1' }));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (e: unknown) => mockEmit(e),
}));

let mockLive = true;
jest.mock('../src/services/feature-flags', () => ({
  isFeatureLive: () => mockLive,
}));

import { rumBeaconRouter } from '../src/routes/rum-beacon';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/rum', rumBeaconRouter);
  return a;
}

const NAV = {
  kind: 'nav',
  screen: '/home',
  nav: 'return',
  ready_ms: 412.5,
  img_refetch: 0,
  img_total: 6,
  timed_out: false,
  session: 'sess-abc',
  captured_at: '2026-10-10T08:00:00.000Z',
  user_agent: 'Mozilla/5.0 (iPhone)',
  platform: 'ios',
};

const METRIC = {
  screen: '/community/feed',
  metric: 'LCP',
  value: 1234.5,
  rating: 'good',
  session: 'sess-abc',
  captured_at: '2026-10-10T08:00:00.000Z',
  user_agent: 'Mozilla/5.0',
  ts_origin_ms: 1748434496789,
  platform: 'android',
  webview: true,
};

beforeEach(() => {
  mockEmit.mockClear();
  mockLive = true;
});

describe('nav beacon — valid', () => {
  it('emits one screen.nav.measured event with the nav fields', async () => {
    const res = await request(app()).post('/api/v1/rum/beacon').send(NAV);
    expect(res.status).toBe(204);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const e = mockEmit.mock.calls[0][0];
    expect(e.type).toBe('screen.nav.measured');
    expect(e.vtid).toBe('VTID-05062');
    expect(e.source).toBe('gateway/rum-beacon');
    expect(e.status).toBe('success');
    // env is NOT set by the route — emitOasisEvent tags it from VITANA_ENV,
    // exactly as on the metric path.
    expect(e.env).toBeUndefined();
    expect(e.payload).toEqual({
      screen: '/home',
      nav: 'return',
      ready_ms: 412.5,
      img_refetch: 0,
      img_total: 6,
      timed_out: false,
      session: 'sess-abc',
      captured_at: '2026-10-10T08:00:00.000Z',
      user_agent: 'Mozilla/5.0 (iPhone)',
      platform: 'ios',
    });
    expect(e.payload).not.toHaveProperty('metric');
    expect(e.payload).not.toHaveProperty('value');
  });

  it('accepts the 60 s / 500-image upper bounds and a first visit', async () => {
    const res = await request(app())
      .post('/api/v1/rum/beacon')
      .send({ ...NAV, nav: 'first', ready_ms: 60000, img_refetch: 500, img_total: 500, timed_out: true });
    expect(res.status).toBe(204);
    expect(mockEmit.mock.calls[0][0].payload.nav).toBe('first');
  });
});

describe('nav beacon — invalid → 400, not emitted', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['nav not first|return', { nav: 'back' }],
    ['ready_ms negative', { ready_ms: -1 }],
    ['ready_ms over 60000', { ready_ms: 60001 }],
    ['img_refetch not an integer', { img_refetch: 1.5 }],
    ['img_refetch over 500', { img_refetch: 501 }],
    ['img_total negative', { img_total: -1 }],
    ['timed_out not boolean', { timed_out: 'no' }],
    ['screen too long', { screen: '/' + 'x'.repeat(256) }],
    ['captured_at not ISO', { captured_at: 'yesterday-afternoon-ish' }],
    ['session missing', { session: undefined }],
    ['platform unknown', { platform: 'windows-phone' }],
  ];
  it.each(cases)('%s', async (_name, patch) => {
    const res = await request(app()).post('/api/v1/rum/beacon').send({ ...NAV, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_beacon');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a nav beacon is never accepted through the metric schema', async () => {
    // kind:'nav' with metric fields but no nav fields → nav schema → 400.
    const res = await request(app()).post('/api/v1/rum/beacon').send({ ...METRIC, kind: 'nav' });
    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('metric beacon — unchanged', () => {
  it('still emits screen.latency.measured with the original payload and message', async () => {
    const res = await request(app()).post('/api/v1/rum/beacon').send(METRIC);
    expect(res.status).toBe(204);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const e = mockEmit.mock.calls[0][0];
    expect(e).toEqual({
      vtid: 'VTID-03177',
      type: 'screen.latency.measured',
      source: 'gateway/rum-beacon',
      status: 'success',
      message: 'LCP 1234.5 on /community/feed',
      payload: {
        screen: '/community/feed',
        metric: 'LCP',
        value: 1234.5,
        rating: 'good',
        session: 'sess-abc',
        captured_at: '2026-10-10T08:00:00.000Z',
        user_agent: 'Mozilla/5.0',
        ts_origin_ms: 1748434496789,
        platform: 'android',
        webview: true,
      },
    });
  });

  it('an invalid metric beacon is still 400', async () => {
    const res = await request(app()).post('/api/v1/rum/beacon').send({ ...METRIC, metric: 'SCREEN_READY' });
    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a metric beacon with some other kind value still takes the metric path', async () => {
    const res = await request(app()).post('/api/v1/rum/beacon').send({ ...METRIC, kind: 'metric' });
    expect(res.status).toBe(204);
    expect(mockEmit.mock.calls[0][0].type).toBe('screen.latency.measured');
  });
});

describe('feature flag + limits apply to nav beacons too', () => {
  it('flag off → 204, nothing emitted', async () => {
    mockLive = false;
    const res = await request(app()).post('/api/v1/rum/beacon').send(NAV);
    expect(res.status).toBe(204);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('oversized nav beacon → 413', async () => {
    const res = await request(app()).post('/api/v1/rum/beacon').send({ ...NAV, user_agent: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('emit failure never blocks the client (204)', async () => {
    mockEmit.mockRejectedValueOnce(new Error('db down'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app()).post('/api/v1/rum/beacon').send(NAV);
    expect(res.status).toBe(204);
    err.mockRestore();
  });
});
