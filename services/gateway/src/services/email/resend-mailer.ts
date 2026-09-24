/**
 * VTID-04463 — transactional email over Resend's HTTP API.
 *
 * The gateway had no email sender at all (tenant invitations still carry a
 * "TODO: send email"). This is the one place outbound email goes through, so
 * the next caller reuses it instead of adding a second provider.
 *
 * Plain `fetch` on purpose: no SDK dependency, one POST to
 * https://api.resend.com/emails with a bearer key.
 *
 * Opt-in, same shape as every other provider here (Bedrock's BEDROCK_ROLE_ARN,
 * Fish's FISH_API_KEY): all three must be set or nothing is sent —
 *   RESEND_API_KEY   — the Resend API key (AWS Secrets Manager)
 *   EMAIL_FROM       — a sender on a domain verified in Resend,
 *                      e.g. "Vitanaland <noreply@vitanaland.com>"
 * and the caller's own feature flag. Unconfigured returns
 * { ok:false, status:'not_configured' } and never throws, so a caller can
 * always fall back to handing the link to a human.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 8000;

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend tags: letters, digits, _ and - only. */
  tags?: Array<{ name: string; value: string }>;
}

export type SendEmailResult =
  | { ok: true; status: 'sent'; id: string | null }
  | { ok: false; status: 'not_configured' | 'rejected' | 'failed'; error: string };

export function isResendConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim());
}

export async function sendEmail(
  message: OutboundEmail,
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<SendEmailResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  if (!isResendConfigured(env)) {
    return { ok: false, status: 'not_configured', error: 'RESEND_API_KEY and EMAIL_FROM must both be set' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM!.trim(),
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.tags && message.tags.length ? { tags: message.tags } : {}),
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
    if (!res.ok) {
      // 4xx is Resend refusing this message (unverified domain, bad address,
      // rate limit); 5xx is Resend itself failing.
      const detail = body?.message ?? body?.name ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status < 500 ? 'rejected' : 'failed', error: `Resend ${res.status}: ${detail}` };
    }
    return { ok: true, status: 'sent', id: body?.id ?? null };
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      ok: false,
      status: 'failed',
      error: aborted ? `Resend timed out after ${REQUEST_TIMEOUT_MS}ms` : `Resend request failed: ${(err as Error)?.message ?? String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal HTML escaping for values interpolated into email bodies. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
