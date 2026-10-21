// VTID-03413 — HTTP tests for the AWS SNS → Google Chat alert bridge.
//
// Contract under test (POST /api/v1/aws-alerts/sns):
//   - malformed body / missing SNS envelope fields → 400, nothing posted
//   - SigningCertURL on a non-SNS host → 403, and the cert is NEVER fetched
//     (an attacker-controlled "cert" would otherwise verify trivially)
//   - bad signature → 403, nothing posted
//   - valid Notification → 200 and forwarded to notifyGChat, formatted
//   - valid SubscriptionConfirmation → SubscribeURL fetched, 200
//
// The route is deliberately unauthenticated (SNS is a third party and cannot
// present a Vitana JWT), so signature verification IS the access control —
// which is exactly why the rejection paths below are the important cases.

import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';

const notifyGChatMock = jest.fn();
jest.mock('../src/services/self-healing-snapshot-service', () => ({
  notifyGChat: (...args: unknown[]) => notifyGChatMock(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const awsSnsAlertsRouter = require('../src/routes/aws-sns-alerts').default;

// A throwaway keypair so we can produce genuinely-valid signatures rather
// than stubbing out the verifier (which would defeat the point of the test).
const { privateKey, certPem } = (() => {
  const { privateKey: priv, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  // Node can't mint an X.509 cert without a CA lib; verify() accepts a bare
  // public key in PEM form, which is what we hand back as the "certificate".
  return {
    privateKey: priv,
    certPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
})();

function signingStringFor(msg: Record<string, string>): string {
  const isSub = msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation';
  const fields = isSub
    ? ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
  let out = '';
  for (const k of fields) {
    if (msg[k] === undefined || msg[k] === null) continue;
    out += `${k}\n${msg[k]}\n`;
  }
  return out;
}

function sign(msg: Record<string, string>): string {
  const v = crypto.createSign('RSA-SHA1');
  v.update(signingStringFor(msg), 'utf8');
  return v.sign(privateKey, 'base64');
}

function makeApp() {
  const app = express();
  app.use('/api/v1/aws-alerts/sns', express.text({ type: '*/*' }));
  app.use('/api/v1/aws-alerts', awsSnsAlertsRouter);
  return app;
}

const VALID_CERT_URL = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc123.pem';

let fetchMock: jest.Mock;

beforeEach(() => {
  notifyGChatMock.mockReset().mockResolvedValue({ ok: true, webhook_set: true });
  fetchMock = jest.fn(async (url: string) => {
    if (String(url).endsWith('.pem')) {
      return { ok: true, text: async () => certPem } as unknown as Response;
    }
    return { ok: true, text: async () => '' } as unknown as Response;
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('POST /api/v1/aws-alerts/sns', () => {
  it('400s on a body that is not JSON', async () => {
    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send('not json at all');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
    expect(notifyGChatMock).not.toHaveBeenCalled();
  });

  it('400s when the SNS envelope is missing signature fields', async () => {
    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ Type: 'Notification', Message: 'hi' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_sns_fields');
    expect(notifyGChatMock).not.toHaveBeenCalled();
  });

  it('403s on a SigningCertURL that is not an SNS host, without fetching it', async () => {
    const msg = {
      Type: 'Notification',
      MessageId: 'm1',
      TopicArn: 'arn:aws:sns:eu-central-1:1:t',
      Message: '{}',
      Timestamp: '2026-07-26T00:00:00Z',
      SignatureVersion: '1',
      Signature: 'whatever',
      SigningCertURL: 'https://evil.example.com/cert.pem',
    };
    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(msg));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signature_invalid');
    // The important assertion: we must not have reached out to the attacker host.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifyGChatMock).not.toHaveBeenCalled();
  });

  it('403s when the signature does not verify against the cert', async () => {
    const msg = {
      Type: 'Notification',
      MessageId: 'm1',
      TopicArn: 'arn:aws:sns:eu-central-1:1:t',
      Message: '{}',
      Timestamp: '2026-07-26T00:00:00Z',
      SignatureVersion: '1',
      Signature: Buffer.from('bogus').toString('base64'),
      SigningCertURL: VALID_CERT_URL,
    };
    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(msg));

    expect(res.status).toBe(403);
    expect(notifyGChatMock).not.toHaveBeenCalled();
  });

  it('forwards a correctly-signed CloudWatch alarm notification to Google Chat', async () => {
    const alarm = JSON.stringify({
      AlarmName: 'vitana-gateway-awsdr-cpu-high',
      NewStateValue: 'ALARM',
      OldStateValue: 'OK',
      NewStateReason: 'Threshold crossed',
      Region: 'eu-central-1',
    });
    const base = {
      Type: 'Notification',
      MessageId: 'm1',
      TopicArn: 'arn:aws:sns:eu-central-1:472838866351:vitana-alarms-prod',
      Message: alarm,
      Timestamp: '2026-07-26T00:00:00Z',
    };
    const msg = {
      ...base,
      SignatureVersion: '1',
      Signature: sign(base),
      SigningCertURL: VALID_CERT_URL,
    };

    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(msg));

    expect(res.status).toBe(200);
    expect(notifyGChatMock).toHaveBeenCalledTimes(1);
    const posted = notifyGChatMock.mock.calls[0][0] as string;
    expect(posted).toContain('vitana-gateway-awsdr-cpu-high');
    expect(posted).toContain('OK → ALARM');
  });

  it('confirms a correctly-signed subscription by fetching SubscribeURL', async () => {
    const base = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'm2',
      TopicArn: 'arn:aws:sns:eu-central-1:472838866351:vitana-alarms-prod',
      Message: 'confirm me',
      Timestamp: '2026-07-26T00:00:00Z',
      Token: 'tok',
      SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription',
    };
    const msg = {
      ...base,
      SignatureVersion: '1',
      Signature: sign(base),
      SigningCertURL: VALID_CERT_URL,
    };

    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(msg));

    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(base.SubscribeURL);
  });

  it('403s a correctly-signed message for a topic other than the expected one', async () => {
    const base = {
      Type: 'Notification',
      MessageId: 'm3',
      TopicArn: 'arn:aws:sns:eu-central-1:999999999999:some-other-topic',
      Message: '{}',
      Timestamp: '2026-07-26T00:00:00Z',
    };
    const msg = {
      ...base,
      SignatureVersion: '1',
      Signature: sign(base),
      SigningCertURL: VALID_CERT_URL,
    };

    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(msg));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unexpected_topic');
    expect(notifyGChatMock).not.toHaveBeenCalled();
  });

  it('502s when the SubscribeURL confirmation request itself fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('.pem')) {
        return { ok: true, text: async () => certPem } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => 'server error' } as unknown as Response;
    });

    const base = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'm4',
      TopicArn: 'arn:aws:sns:eu-central-1:472838866351:vitana-alarms-prod',
      Message: 'confirm me',
      Timestamp: '2026-07-26T00:00:00Z',
      Token: 'tok',
      SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription',
    };
    const msg = {
      ...base,
      SignatureVersion: '1',
      Signature: sign(base),
      SigningCertURL: VALID_CERT_URL,
    };

    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(msg));

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('subscribe_confirm_rejected');
    expect(notifyGChatMock).not.toHaveBeenCalled();
  });

  it('502s (so SNS retries) when Google Chat delivery fails', async () => {
    notifyGChatMock.mockReset().mockResolvedValue({ ok: false, webhook_set: true, status: 404 });

    const alarm = JSON.stringify({ AlarmName: 'x', NewStateValue: 'ALARM', OldStateValue: 'OK' });
    const base = {
      Type: 'Notification',
      MessageId: 'm5',
      TopicArn: 'arn:aws:sns:eu-central-1:472838866351:vitana-alarms-prod',
      Message: alarm,
      Timestamp: '2026-07-26T00:00:00Z',
    };
    const msg = {
      ...base,
      SignatureVersion: '1',
      Signature: sign(base),
      SigningCertURL: VALID_CERT_URL,
    };

    const res = await request(makeApp())
      .post('/api/v1/aws-alerts/sns')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(msg));

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('chat_delivery_failed');
    expect(notifyGChatMock).toHaveBeenCalledTimes(1);
  });
});
