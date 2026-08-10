/**
 * VTID-03413: AWS SNS -> existing Google Chat alerting channel.
 *
 * POST /api/v1/aws-alerts/sns
 *
 * Bridges the AWS-side `vitana-alarms-prod` SNS topic (target for every
 * CloudWatch alarm plus the `vitana-dms-task-failure` EventBridge rule)
 * into the SAME Google Chat webhook already used for self-healing /
 * VTID-lifecycle notifications (`GCHAT_COMMANDHUB_WEBHOOK`, see
 * `services/self-healing-snapshot-service.ts` notifyGChat()) — reusing
 * the existing channel rather than standing up a new one.
 *
 * No auth — SNS calls this unauthenticated over HTTPS, same as any
 * third-party webhook in this codebase (see connector-webhooks.ts).
 * Security is via SNS message signature verification below, not a
 * shared secret: an unverified endpoint that free-formats input into a
 * Chat post is a spam/spoofing vector, so every Notification and
 * SubscriptionConfirmation is signature-checked against a certificate
 * fetched from a URL that must itself be on an *.amazonaws.com SNS
 * signing-cert host, before being trusted.
 */

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { notifyGChat } from '../services/self-healing-snapshot-service';

const router = Router();

interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

// SNS signing certs are always served from a regional SNS host — reject
// anything else outright to prevent a spoofed message pointing us at an
// attacker-controlled "certificate" that would trivially pass verification.
const SNS_CERT_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/i;

function buildSigningString(msg: SnsMessage): string {
  const isSubscribeType = msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation';
  const fields = isSubscribeType
    ? ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];

  let out = '';
  const asRecord = msg as unknown as Record<string, unknown>;
  for (const key of fields) {
    const value = asRecord[key];
    if (value === undefined || value === null) continue; // Subject is optional
    out += `${key}\n${value}\n`;
  }
  return out;
}

async function verifySnsSignature(msg: SnsMessage): Promise<boolean> {
  try {
    const certUrl = new URL(msg.SigningCertURL);
    if (certUrl.protocol !== 'https:' || !SNS_CERT_HOST_RE.test(certUrl.hostname)) {
      console.error(`[AwsSnsAlerts] Rejected SigningCertURL host: ${certUrl.hostname}`);
      return false;
    }

    const certResp = await fetch(certUrl.toString());
    if (!certResp.ok) {
      console.error(`[AwsSnsAlerts] Failed to fetch signing cert: HTTP ${certResp.status}`);
      return false;
    }
    const cert = await certResp.text();

    const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    const verifier = crypto.createVerify(algorithm);
    verifier.update(buildSigningString(msg), 'utf8');
    return verifier.verify(cert, msg.Signature, 'base64');
  } catch (e) {
    console.error('[AwsSnsAlerts] Signature verification error:', e);
    return false;
  }
}

function formatAlertText(messageBody: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(messageBody);
  } catch {
    return `*AWS alert* (unparsed payload)\n${messageBody.slice(0, 500)}`;
  }

  // CloudWatch Alarm state-change shape
  if (typeof parsed.AlarmName === 'string' && typeof parsed.NewStateValue === 'string') {
    const emoji = parsed.NewStateValue === 'ALARM' ? '🔴' : parsed.NewStateValue === 'OK' ? '🟢' : '⚪';
    return [
      `${emoji} *${parsed.AlarmName}*`,
      `State: ${parsed.OldStateValue ?? '?'} → ${parsed.NewStateValue}`,
      parsed.NewStateReason ? `Reason: ${parsed.NewStateReason}` : '',
      `Region: ${parsed.Region ?? 'eu-central-1'}`,
    ].filter(Boolean).join('\n');
  }

  // EventBridge event shape (e.g. vitana-dms-task-failure rule, source: aws.dms)
  if (typeof parsed.source === 'string' && parsed['detail-type']) {
    return [
      `🟠 *AWS event*: ${parsed['detail-type']}`,
      `Source: ${parsed.source}`,
      parsed.detail ? `Detail: ${JSON.stringify(parsed.detail).slice(0, 500)}` : '',
    ].filter(Boolean).join('\n');
  }

  // Unknown shape — still surface it rather than drop it silently.
  return `*AWS alert*\n${JSON.stringify(parsed).slice(0, 500)}`;
}

router.post('/sns', async (req: Request, res: Response) => { // public-route — SNS is a third party and cannot present a Vitana JWT; verifySnsSignature() below is the access control
  // impact-allow-no-oasis: an inbound CloudWatch/EventBridge alert is external
  // telemetry about AWS infrastructure, not a Vitana state transition. CLAUDE.md
  // §6 is explicit that telemetry must NEVER be emitted to OASIS ("Polling ≠
  // progress. Heartbeat ≠ event."). Emitting here would flood the event log with
  // infra noise the taxonomy deliberately excludes.
  let msg: SnsMessage;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    msg = JSON.parse(raw);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  if (!msg.Type || !msg.Signature || !msg.SigningCertURL) {
    return res.status(400).json({ ok: false, error: 'missing_sns_fields' });
  }

  const verified = await verifySnsSignature(msg);
  if (!verified) {
    console.error(`[AwsSnsAlerts] Signature verification FAILED for message ${msg.MessageId}`);
    return res.status(403).json({ ok: false, error: 'signature_invalid' });
  }

  if (msg.Type === 'SubscriptionConfirmation') {
    if (!msg.SubscribeURL) {
      return res.status(400).json({ ok: false, error: 'missing_subscribe_url' });
    }
    try {
      await fetch(msg.SubscribeURL);
      console.log(`[AwsSnsAlerts] Confirmed subscription for topic ${msg.TopicArn}`);
      await notifyGChat(`✅ AWS alerting subscription confirmed for topic \`${msg.TopicArn}\``);
    } catch (e) {
      console.error('[AwsSnsAlerts] Failed to confirm subscription:', e);
      return res.status(502).json({ ok: false, error: 'subscribe_confirm_failed' });
    }
    return res.status(200).json({ ok: true, confirmed: true });
  }

  if (msg.Type === 'UnsubscribeConfirmation') {
    console.warn(`[AwsSnsAlerts] Unsubscribed from topic ${msg.TopicArn}`);
    return res.status(200).json({ ok: true });
  }

  if (msg.Type === 'Notification') {
    const text = formatAlertText(msg.Message);
    await notifyGChat(text);
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true, ignored: msg.Type });
});

export default router;
