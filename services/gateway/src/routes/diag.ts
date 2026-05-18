/**
 * BOOTSTRAP-NOTIF-MESSENGER-DIAG: Unauthenticated diagnostic ingestion.
 *
 * The Appilix WebView sometimes renders its native "Something went wrong"
 * screen when a chat-notification deep-link fails to load. We can't see
 * what's failing from logs alone — the WebView might be erroring before
 * React even mounts. This route accepts small beacons from the client
 * (boot, deep-link-detected, error, rejection) so we can trace exactly
 * what happens when a user taps a chat push notification.
 *
 * No auth on purpose: the failure modes we are trying to capture include
 * "auth never hydrates", so a 401 here would defeat the point. The route
 * does nothing but log — there's no DB write, no side effects.
 */

import { Router, Request, Response } from 'express';

export const router = Router();

const MAX_BODY_BYTES = 8 * 1024; // 8KB — beacons should be tiny

function clip(value: unknown, max = 512): unknown {
  if (typeof value !== 'string') return value;
  return value.length > max ? value.slice(0, max) + '…[clipped]' : value;
}

router.post('/notif-tap', (req: Request, res: Response) => {
  try {
    const raw = JSON.stringify(req.body ?? {});
    if (raw.length > MAX_BODY_BYTES) {
      console.warn('[NotifDiag] Body too large, ignoring:', raw.length);
      return res.status(413).json({ ok: false, error: 'body_too_large' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const event = String(body.event || 'unknown');
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
    const ua = clip(req.headers['user-agent'] || '', 300);
    const referer = clip(req.headers['referer'] || '', 300);

    // Single-line, grep-friendly log so Cloud Run logs are easy to filter:
    //   gcloud logging read 'textPayload:"[NotifDiag]"' --limit 50
    console.log(
      `[NotifDiag] event=${event} ip=${ip} ua=${JSON.stringify(ua)} ` +
      `referer=${JSON.stringify(referer)} body=${JSON.stringify(body)}`
    );

    return res.status(204).end();
  } catch (err: any) {
    console.error('[NotifDiag] handler error:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'diag_handler_error' });
  }
});

// Sanity: lets the client confirm the gateway is reachable from inside the
// Appilix WebView at all. Returns a small JSON blob with server time, which
// also doubles as a quick way to see in the user's network panel whether
// the deep-link page is even able to talk to the gateway.
router.get('/ping', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'gateway-diag', now: new Date().toISOString() });
});

export default router;
