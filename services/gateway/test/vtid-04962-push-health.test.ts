// VTID-04962 — /ops/health/push-dispatch also reads push_outcome: it reports
// the 6h outcome counts and turns degraded when FCM errors exceed half of at
// least 20 FCM attempts. Missing outcomes (NULL / not migrated) never degrade.
import { evalPushDispatch, PUSH_FCM_MIN_ATTEMPTS } from '../src/routes/ops-health-checks';

const now = Date.parse('2026-10-07T12:00:00Z');

describe('evalPushDispatch with outcomes', () => {
  test('no outcomes → backlog-only behaviour, unchanged', () => {
    expect(evalPushDispatch([], now)).toEqual({ status: 'ok', unsent: 0 });
  });

  test('outcomes are reported', () => {
    const r = evalPushDispatch([], now, { delivered_fcm: 30, no_device: 5 });
    expect(r).toEqual(expect.objectContaining({ status: 'ok', outcomes: { delivered_fcm: 30, no_device: 5 } }));
  });

  test('FCM errors above half of the attempts → degraded fcm_send_errors', () => {
    const r = evalPushDispatch([], now, { fcm_error: 15, delivered_fcm: 5, delivered_appilix: 40 });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('fcm_send_errors');
    expect(r.fcm_error_ratio).toBe(0.75);
  });

  test('too few FCM attempts → no verdict on FCM', () => {
    const r = evalPushDispatch([], now, { fcm_error: PUSH_FCM_MIN_ATTEMPTS - 1 });
    expect(r.status).toBe('ok');
  });

  test('Appilix deliveries and suppressions are not FCM attempts', () => {
    const r = evalPushDispatch([], now, { fcm_error: 9, delivered_fcm: 11, delivered_appilix: 500, suppressed_dnd: 50 });
    expect(r.status).toBe('ok');
  });

  test('a stalled backlog still wins over the FCM signal', () => {
    const old = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const r = evalPushDispatch([{ created_at: old }], now, { fcm_error: 30 });
    expect(r.status).toBe('down');
  });
});
