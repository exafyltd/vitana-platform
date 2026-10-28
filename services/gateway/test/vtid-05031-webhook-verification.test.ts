/**
 * VTID-05031 — Health Hub WP3 / D2: vendor-correct webhook verification, fail closed.
 *
 * Pins:
 *   1. Terra `t=…,v1=…` over `${t}.${raw}`, ±300 s tolerance, any v1 may match.
 *   2. Svix (Vital/Junction) over `${id}.${ts}.${raw}` with the base64-decoded
 *      `whsec_` key — checked against Svix's own published test vector.
 *   3. DoctorBox hex HMAC over the raw body.
 *   4. Every verifier rejects when its secret is unset — no dev mode.
 *   5. The route verifies over the raw bytes (index.ts mounts express.raw),
 *      answers 401 on an invalid delivery and 500 without the exception text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/routes/connector-webhooks-repository');

import * as repo from '../src/routes/connector-webhooks-repository';
import { verifyHexHmac, verifySvix, verifyTerra, WEBHOOK_TOLERANCE_SECONDS } from '../src/connectors/runtime/webhook-signature';
import connectorWebhooksRouter from '../src/routes/connector-webhooks';
import terra from '../src/connectors/wearable/terra';
import vital from '../src/connectors/wearable/vital';
import doctorbox from '../src/connectors/health/doctorbox';

const mockedRepo = repo as jest.Mocked<typeof repo>;
const NOW = 1_760_000_000_000; // ms
const T = String(NOW / 1000);
const terraSig = (secret: string, t: string, raw: string) => createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');

const OLD_ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV };
  delete process.env.TERRA_WEBHOOK_SECRET;
  delete process.env.VITAL_WEBHOOK_SECRET;
  delete process.env.DOCTORBOX_WEBHOOK_SECRET;
  for (const fn of Object.values(mockedRepo)) {
    if (jest.isMockFunction(fn)) fn.mockResolvedValue({ data: null, error: null } as never);
  }
});
afterAll(() => {
  process.env = OLD_ENV;
});

// ---------------------------------------------------------------------------
// 1. Terra
// ---------------------------------------------------------------------------

describe('verifyTerra (VTID-05031)', () => {
  const raw = '{"type":"sleep","user":{"user_id":"u1"}}';
  it('accepts the vendor scheme', () => {
    expect(verifyTerra(raw, `t=${T},v1=${terraSig('s', T, raw)}`, 's', NOW)).toEqual({ ok: true });
  });
  it('accepts when any of several v1 signatures matches', () => {
    expect(verifyTerra(raw, `t=${T},v1=${'0'.repeat(64)},v1=${terraSig('s', T, raw)}`, 's', NOW)).toEqual({ ok: true });
  });
  it('rejects a tampered body and a wrong secret', () => {
    const h = `t=${T},v1=${terraSig('s', T, raw)}`;
    expect(verifyTerra(raw + ' ', h, 's', NOW)).toEqual({ ok: false, error: 'signature_invalid' });
    expect(verifyTerra(raw, h, 'other', NOW)).toEqual({ ok: false, error: 'signature_invalid' });
  });
  it('rejects a timestamp outside ±300 s, in either direction', () => {
    for (const delta of [WEBHOOK_TOLERANCE_SECONDS + 1, -(WEBHOOK_TOLERANCE_SECONDS + 1)]) {
      const t = String(NOW / 1000 + delta);
      expect(verifyTerra(raw, `t=${t},v1=${terraSig('s', t, raw)}`, 's', NOW)).toEqual({
        ok: false,
        error: 'timestamp_out_of_tolerance',
      });
    }
    const edge = String(NOW / 1000 - WEBHOOK_TOLERANCE_SECONDS);
    expect(verifyTerra(raw, `t=${edge},v1=${terraSig('s', edge, raw)}`, 's', NOW).ok).toBe(true);
  });
  it('rejects a missing t, a missing v1, a missing header', () => {
    expect(verifyTerra(raw, `v1=${terraSig('s', T, raw)}`, 's', NOW)).toEqual({ ok: false, error: 'signature_missing' });
    expect(verifyTerra(raw, `t=${T}`, 's', NOW)).toEqual({ ok: false, error: 'signature_missing' });
    expect(verifyTerra(raw, undefined, 's', NOW)).toEqual({ ok: false, error: 'signature_missing' });
  });
  it('fails closed without a secret', () => {
    expect(verifyTerra(raw, `t=${T},v1=${terraSig('', T, raw)}`, undefined, NOW)).toEqual({ ok: false, error: 'secret_not_configured' });
    expect(verifyTerra(raw, `t=${T},v1=${terraSig('', T, raw)}`, '', NOW)).toEqual({ ok: false, error: 'secret_not_configured' });
  });
});

// ---------------------------------------------------------------------------
// 2. Svix (Vital / Junction)
// ---------------------------------------------------------------------------

describe('verifySvix (VTID-05031)', () => {
  // Svix's published test vector:
  // https://docs.svix.com/receiving/verifying-payloads/how-manual
  const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const TS = '1614265330';
  const BODY = '{"test": 2432232314}';
  const SIG = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
  const at = Number(TS) * 1000;

  it("matches Svix's published test vector", () => {
    expect(verifySvix(BODY, { id: ID, timestamp: TS, signature: SIG }, SECRET, at)).toEqual({ ok: true });
  });
  it('accepts when one of several space-separated signatures matches', () => {
    expect(verifySvix(BODY, { id: ID, timestamp: TS, signature: `v1,AAAA ${SIG}` }, SECRET, at)).toEqual({ ok: true });
  });
  it('rejects a wrong id, a tampered body, a stale timestamp', () => {
    expect(verifySvix(BODY, { id: 'msg_other', timestamp: TS, signature: SIG }, SECRET, at).ok).toBe(false);
    expect(verifySvix(BODY + ' ', { id: ID, timestamp: TS, signature: SIG }, SECRET, at).ok).toBe(false);
    expect(verifySvix(BODY, { id: ID, timestamp: TS, signature: SIG }, SECRET, at + 301_000)).toEqual({
      ok: false,
      error: 'timestamp_out_of_tolerance',
    });
  });
  it('rejects missing svix headers', () => {
    expect(verifySvix(BODY, { timestamp: TS, signature: SIG }, SECRET, at)).toEqual({ ok: false, error: 'signature_missing' });
  });
  it('fails closed without a secret', () => {
    expect(verifySvix(BODY, { id: ID, timestamp: TS, signature: SIG }, undefined, at)).toEqual({
      ok: false,
      error: 'secret_not_configured',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. DoctorBox
// ---------------------------------------------------------------------------

describe('verifyHexHmac (VTID-05031)', () => {
  const raw = '{"event":"test.status_changed"}';
  const sig = createHmac('sha256', 'd').update(raw).digest('hex');
  it('accepts a valid hex HMAC and rejects an invalid one', () => {
    expect(verifyHexHmac(raw, sig, 'd')).toEqual({ ok: true });
    expect(verifyHexHmac(raw, sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'), 'd')).toEqual({ ok: false, error: 'signature_invalid' });
    expect(verifyHexHmac(raw, 'short', 'd')).toEqual({ ok: false, error: 'signature_invalid' });
  });
  it('fails closed without a secret', () => {
    expect(verifyHexHmac(raw, sig, undefined)).toEqual({ ok: false, error: 'secret_not_configured' });
  });
});

// ---------------------------------------------------------------------------
// 4. Connectors fail closed; no dev-mode bypass remains in source
// ---------------------------------------------------------------------------

describe('connectors fail closed without a secret (VTID-05031)', () => {
  it('Terra, Vital and DoctorBox reject every delivery when the secret is unset', async () => {
    const req = { headers: {}, body: '{}', raw_body: '{}' };
    expect(await terra.handleWebhook!(req)).toEqual({ valid: false, events: [], error: 'secret_not_configured' });
    expect(await vital.handleWebhook!(req)).toEqual({ valid: false, events: [], error: 'secret_not_configured' });
    expect(await doctorbox.handleWebhook!(req)).toEqual({ valid: false, events: [], error: 'secret_not_configured' });
  });

  it('no connector keeps a dev-mode verification bypass', () => {
    for (const rel of ['connectors/wearable/terra.ts', 'connectors/wearable/vital.ts', 'connectors/health/doctorbox.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
      expect(src).not.toMatch(/skipping signature verification/);
      expect(src).not.toMatch(/createHmac/);
    }
  });

  it('index.ts mounts the raw body parser for the webhook route before express.json()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const raw = src.indexOf("app.use('/api/v1/connectors/webhook', express.raw(");
    const json = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    expect(raw).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(raw);
  });
});

// ---------------------------------------------------------------------------
// 5. Route over raw bytes
// ---------------------------------------------------------------------------

describe('POST /api/v1/connectors/webhook/:connector (VTID-05031)', () => {
  function app() {
    const a = express();
    a.use('/api/v1/connectors/webhook', express.raw({ type: '*/*', limit: '2mb' }));
    a.use(express.json({ limit: '2mb' }));
    a.use('/api/v1/connectors', connectorWebhooksRouter);
    return a;
  }

  it('verifies over the exact bytes sent, even when they differ from JSON.stringify', async () => {
    process.env.TERRA_WEBHOOK_SECRET = 'terra-secret';
    // Spacing that JSON.stringify would not reproduce.
    const raw = '{ "type" : "athlete",  "user": { "user_id": "terra-u" } }';
    const t = String(Math.floor(Date.now() / 1000));
    const res = await request(app())
      .post('/api/v1/connectors/webhook/terra')
      .set('Content-Type', 'application/json')
      .set('terra-signature', `t=${t},v1=${terraSig('terra-secret', t, raw)}`)
      .send(raw);
    expect(res.status).toBe(200);
    expect(raw).not.toBe(JSON.stringify(JSON.parse(raw)));
  });

  it('answers 401 and logs the row for an invalid delivery', async () => {
    process.env.TERRA_WEBHOOK_SECRET = 'terra-secret';
    const res = await request(app())
      .post('/api/v1/connectors/webhook/terra')
      .set('Content-Type', 'application/json')
      .set('terra-signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)
      .send('{"type":"sleep"}');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'signature_invalid' });
    expect(mockedRepo.insertConnectorWebhookLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event_type: 'invalid', signature_valid: false }),
    );
  });

  it('answers 401 when the secret is not configured', async () => {
    const res = await request(app())
      .post('/api/v1/connectors/webhook/vital')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('secret_not_configured');
  });

  it('a handler exception answers 500 without the exception text', async () => {
    const spy = jest.spyOn(terra, 'handleWebhook').mockRejectedValueOnce(new Error('db password=hunter2 refused'));
    const res = await request(app())
      .post('/api/v1/connectors/webhook/terra')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'handler_error' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    spy.mockRestore();
  });
});
