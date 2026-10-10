/**
 * VTID-05031 (Health Hub D2): vendor-correct webhook signature verification.
 *
 * Every verifier fails closed: an unset or empty secret is a rejection, never
 * a "dev mode" pass. All comparisons are constant time and every input is the
 * RAW request body exactly as received (index.ts mounts express.raw on
 * /api/v1/connectors/webhook for this reason — a re-serialized JSON body does
 * not carry the vendor's signature).
 *
 *   Terra  — `terra-signature: t=<unix s>,v1=<hex>[,v1=<hex>…]`,
 *            HMAC-SHA256 hex of `${t}.${raw}`, any v1 may match.
 *   Svix   — (Vital/Junction) `svix-id`, `svix-timestamp`, `svix-signature:
 *            v1,<b64> [v1,<b64> …]`, HMAC-SHA256 base64 of `${id}.${ts}.${raw}`
 *            keyed by base64-decode of the secret after `whsec_`.
 *   Hex    — (DoctorBox, sandbox spec) hex HMAC-SHA256 of the raw body.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookVerdict =
  | { ok: true }
  | { ok: false; error: 'secret_not_configured' | 'signature_missing' | 'signature_invalid' | 'timestamp_out_of_tolerance' };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function withinTolerance(tsSeconds: number, nowMs: number): boolean {
  return Number.isFinite(tsSeconds) && Math.abs(nowMs / 1000 - tsSeconds) <= WEBHOOK_TOLERANCE_SECONDS;
}

export function verifyTerra(
  raw: string,
  header: string | undefined,
  secret: string | undefined,
  nowMs: number = Date.now(),
): WebhookVerdict {
  if (!secret) return { ok: false, error: 'secret_not_configured' };
  if (!header) return { ok: false, error: 'signature_missing' };
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!t || v1.length === 0 || !/^\d+$/.test(t)) return { ok: false, error: 'signature_missing' };
  if (!withinTolerance(Number(t), nowMs)) return { ok: false, error: 'timestamp_out_of_tolerance' };
  const computed = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return v1.some((sig) => safeEqual(computed, sig)) ? { ok: true } : { ok: false, error: 'signature_invalid' };
}

export function verifySvix(
  raw: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string | undefined,
  nowMs: number = Date.now(),
): WebhookVerdict {
  if (!secret) return { ok: false, error: 'secret_not_configured' };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, error: 'signature_missing' };
  if (!/^\d+$/.test(timestamp)) return { ok: false, error: 'signature_missing' };
  if (!withinTolerance(Number(timestamp), nowMs)) return { ok: false, error: 'timestamp_out_of_tolerance' };
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  if (key.length === 0) return { ok: false, error: 'secret_not_configured' };
  const computed = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64');
  const candidates = signature
    .split(' ')
    .map((p) => p.split(','))
    .filter(([scheme, sig]) => scheme === 'v1' && !!sig)
    .map(([, sig]) => sig);
  // some() stops at the first match, as Svix's own libraries do; each comparison
  // is constant time and every candidate is checked against the same digest.
  return candidates.some((sig) => safeEqual(computed, sig)) ? { ok: true } : { ok: false, error: 'signature_invalid' };
}

export function verifyHexHmac(raw: string, header: string | undefined, secret: string | undefined): WebhookVerdict {
  if (!secret) return { ok: false, error: 'secret_not_configured' };
  if (!header) return { ok: false, error: 'signature_missing' };
  const computed = createHmac('sha256', secret).update(raw).digest('hex');
  return safeEqual(computed, header.trim()) ? { ok: true } : { ok: false, error: 'signature_invalid' };
}

/** First value of a header that may arrive as an array. */
export function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
