/**
 * VTID-04463 — partner organization invite email over Resend.
 *
 * Covers the mailer (gates, request shape, error mapping, timeout) and the
 * invite email itself (link building, localisation, HTML escaping, opt-in).
 * No network: every fetch is a stub.
 */

import {
  escapeHtml,
  isResendConfigured,
  sendEmail,
} from '../src/services/email/resend-mailer';
import {
  buildInviteAcceptUrl,
  buildPartnerInviteEmail,
  isPartnerInviteEmailEnabled,
  resolveAppBaseUrl,
  sendPartnerInviteEmail,
} from '../src/services/email/partner-invite-email';

const CONFIGURED_ENV = {
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'Vitanaland <noreply@vitanaland.com>',
} as unknown as NodeJS.ProcessEnv;

const MESSAGE = { to: 'new@example.com', subject: 'S', html: '<p>H</p>', text: 'T' };

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('resend-mailer', () => {
  it('is not configured unless both RESEND_API_KEY and EMAIL_FROM are set', () => {
    expect(isResendConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isResendConfigured({ RESEND_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isResendConfigured({ EMAIL_FROM: 'a@b.c' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isResendConfigured({ RESEND_API_KEY: '  ', EMAIL_FROM: 'a@b.c' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isResendConfigured(CONFIGURED_ENV)).toBe(true);
  });

  it('returns not_configured without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const r = await sendEmail(MESSAGE, { env: {} as NodeJS.ProcessEnv, fetchImpl: fetchImpl as any });
    expect(r).toMatchObject({ ok: false, status: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the Resend request shape with a bearer key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(200, { id: 'email_123' }));
    const r = await sendEmail(
      { ...MESSAGE, tags: [{ name: 'category', value: 'partner_invite' }] },
      { env: CONFIGURED_ENV, fetchImpl: fetchImpl as any },
    );
    expect(r).toEqual({ ok: true, status: 'sent', id: 'email_123' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      from: 'Vitanaland <noreply@vitanaland.com>',
      to: ['new@example.com'],
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
      tags: [{ name: 'category', value: 'partner_invite' }],
    });
  });

  it('maps a 4xx to rejected and a 5xx to failed', async () => {
    const rejected = await sendEmail(MESSAGE, {
      env: CONFIGURED_ENV,
      fetchImpl: jest.fn().mockResolvedValue(fakeResponse(403, { message: 'domain not verified' })) as any,
    });
    expect(rejected).toMatchObject({ ok: false, status: 'rejected' });
    expect((rejected as any).error).toContain('domain not verified');

    const failed = await sendEmail(MESSAGE, {
      env: CONFIGURED_ENV,
      fetchImpl: jest.fn().mockResolvedValue(fakeResponse(502, null)) as any,
    });
    expect(failed).toMatchObject({ ok: false, status: 'failed' });
    expect((failed as any).error).toContain('502');
  });

  it('maps a network error or abort to failed and never throws', async () => {
    const netErr = await sendEmail(MESSAGE, {
      env: CONFIGURED_ENV,
      fetchImpl: jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any,
    });
    expect(netErr).toMatchObject({ ok: false, status: 'failed' });
    expect((netErr as any).error).toContain('ECONNRESET');

    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timedOut = await sendEmail(MESSAGE, {
      env: CONFIGURED_ENV,
      fetchImpl: jest.fn().mockRejectedValue(abortErr) as any,
    });
    expect(timedOut).toMatchObject({ ok: false, status: 'failed' });
    expect((timedOut as any).error).toContain('timed out');
  });

  it('passes an abort signal so a hanging request is bounded', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(200, { id: 'x' }));
    await sendEmail(MESSAGE, { env: CONFIGURED_ENV, fetchImpl: fetchImpl as any });
    expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
  });

  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<b>"A&B"</b> 'x'`)).toBe('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt; &#39;x&#39;');
  });
});

describe('partner-invite-email', () => {
  const INPUT = {
    to: 'new@example.com',
    orgName: 'Praxis <Nord> & Co',
    role: 'staff' as const,
    acceptUrl: 'https://vitanaland.com/commerce/invites/abc/accept',
    validDays: 7,
    locale: 'en' as const,
  };

  it('builds the accept URL from APP_BASE_URL, stripping trailing slashes', () => {
    expect(buildInviteAcceptUrl('tok', { APP_BASE_URL: 'https://preview-aws.vitanaland.com//' } as any)).toBe(
      'https://preview-aws.vitanaland.com/commerce/invites/tok/accept',
    );
    expect(resolveAppBaseUrl({ FRONTEND_URL: 'https://x.test/' } as any)).toBe('https://x.test');
    expect(resolveAppBaseUrl({} as any)).toBe('https://vitanaland.com');
  });

  it('is enabled only by the exact string true', () => {
    expect(isPartnerInviteEmailEnabled({} as any)).toBe(false);
    expect(isPartnerInviteEmailEnabled({ PARTNER_INVITE_EMAIL_ENABLED: 'TRUE' } as any)).toBe(false);
    expect(isPartnerInviteEmailEnabled({ PARTNER_INVITE_EMAIL_ENABLED: 'true' } as any)).toBe(true);
  });

  it('renders the English email with role, link and expiry', () => {
    const m = buildPartnerInviteEmail(INPUT);
    expect(m.to).toBe('new@example.com');
    expect(m.subject).toBe('Invitation to Praxis <Nord> & Co on Vitanaland');
    expect(m.text).toContain('as Team member');
    expect(m.text).toContain(INPUT.acceptUrl);
    expect(m.text).toContain('valid for 7 days');
    expect(m.tags).toEqual([{ name: 'category', value: 'partner_invite' }]);
  });

  it('escapes the organization name in the HTML body', () => {
    const m = buildPartnerInviteEmail(INPUT);
    expect(m.html).toContain('Praxis &lt;Nord&gt; &amp; Co');
    expect(m.html).not.toContain('<Nord>');
    expect(m.html).toContain(`href="${INPUT.acceptUrl}"`);
  });

  it('localises to German (du-form) and never leaves a placeholder behind', () => {
    const m = buildPartnerInviteEmail({ ...INPUT, locale: 'de', role: 'professional' });
    expect(m.subject).toBe('Einladung zu Praxis <Nord> & Co auf Vitanaland');
    expect(m.text).toContain('du wurdest eingeladen');
    expect(m.text).toContain('Fachperson');
    expect(m.text).not.toMatch(/\{\w+\}/);
    expect(m.html).toContain('lang="de"');
  });

  it('does nothing when disabled or unconfigured', async () => {
    const send = jest.fn();
    expect(await sendPartnerInviteEmail(INPUT, { env: CONFIGURED_ENV, send })).toEqual({
      sent: false,
      status: 'disabled',
    });
    expect(
      await sendPartnerInviteEmail(INPUT, { env: { PARTNER_INVITE_EMAIL_ENABLED: 'true' } as any, send }),
    ).toEqual({ sent: false, status: 'not_configured' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends when enabled and configured, and maps the provider result', async () => {
    const env = { ...CONFIGURED_ENV, PARTNER_INVITE_EMAIL_ENABLED: 'true' } as any;
    const ok = jest.fn().mockResolvedValue({ ok: true, status: 'sent', id: 'email_9' });
    expect(await sendPartnerInviteEmail(INPUT, { env, send: ok })).toEqual({
      sent: true,
      status: 'sent',
      provider_id: 'email_9',
    });
    expect(ok.mock.calls[0][0].subject).toContain('Praxis');

    const bad = jest.fn().mockResolvedValue({ ok: false, status: 'rejected', error: 'Resend 403: x' });
    expect(await sendPartnerInviteEmail(INPUT, { env, send: bad })).toEqual({
      sent: false,
      status: 'rejected',
      error: 'Resend 403: x',
    });
  });
});
