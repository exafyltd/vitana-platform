/**
 * VTID-04463 — the email a partner organization invite sends.
 *
 * Commerce self-service onboarding spec, Phase 1: an org admin invites a
 * colleague and the colleague receives the accept link by email, without
 * anyone at Vitana passing it on.
 *
 * Gated on PARTNER_INVITE_EMAIL_ENABLED (exact 'true') plus the Resend
 * configuration in resend-mailer.ts. When any of them is missing the invite
 * is still created and the route returns the accept link, so the admin can
 * share it by hand — sending email is an addition, never a precondition.
 *
 * The invitee may not have a Vitana account yet, so their language is
 * unknown; the inviter's locale is the best signal available.
 */

import { tt, type GatewayLocale } from '../../i18n/catalog';
import { escapeHtml, sendEmail, isResendConfigured, type SendEmailResult } from './resend-mailer';

export type InviteRole = 'org_admin' | 'staff' | 'professional';

export const INVITE_ACCEPT_PATH = '/commerce/invites/:token/accept';

export function isPartnerInviteEmailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PARTNER_INVITE_EMAIL_ENABLED === 'true';
}

/** The frontend the link points at. Same resolution as stripe-client.ts. */
export function resolveAppBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.APP_BASE_URL || env.FRONTEND_URL || 'https://vitanaland.com').trim();
  return raw.replace(/\/+$/, '');
}

export function buildInviteAcceptUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveAppBaseUrl(env) + INVITE_ACCEPT_PATH.replace(':token', encodeURIComponent(token));
}

export interface PartnerInviteEmailInput {
  to: string;
  orgName: string;
  role: InviteRole;
  acceptUrl: string;
  validDays: number;
  locale: GatewayLocale;
}

export function buildPartnerInviteEmail(input: PartnerInviteEmailInput) {
  const { orgName, role, acceptUrl, validDays, locale } = input;
  const roleLabel = tt(`email.partner_invite.role.${role}`, locale);
  const subject = tt('email.partner_invite.subject', locale, { org: orgName });
  const greeting = tt('email.partner_invite.greeting', locale);
  const body = tt('email.partner_invite.body', locale, { org: orgName, role: roleLabel });
  const instructions = tt('email.partner_invite.instructions', locale);
  const cta = tt('email.partner_invite.cta', locale);
  const expiry = tt('email.partner_invite.expiry', locale, { days: validDays });
  const ignore = tt('email.partner_invite.ignore', locale);

  const text = [greeting, '', body, '', instructions, acceptUrl, '', expiry, ignore].join('\n');

  const e = escapeHtml;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const html =
    `<!doctype html><html lang="${e(locale)}" dir="${dir}"><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">` +
    `<p>${e(greeting)}</p>` +
    `<p>${e(body)}</p>` +
    `<p>${e(instructions)}</p>` +
    `<p><a href="${e(acceptUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none">${e(cta)}</a></p>` +
    `<p style="font-size:13px;color:#555555;word-break:break-all">${e(acceptUrl)}</p>` +
    `<p style="font-size:13px;color:#555555">${e(expiry)} ${e(ignore)}</p>` +
    `</body></html>`;

  return { to: input.to, subject, html, text, tags: [{ name: 'category', value: 'partner_invite' }] };
}

export type InviteEmailOutcome =
  | { sent: true; status: 'sent'; provider_id: string | null }
  | { sent: false; status: 'disabled' | 'not_configured' | 'rejected' | 'failed'; error?: string };

export async function sendPartnerInviteEmail(
  input: PartnerInviteEmailInput,
  deps: { env?: NodeJS.ProcessEnv; send?: typeof sendEmail } = {},
): Promise<InviteEmailOutcome> {
  const env = deps.env ?? process.env;
  if (!isPartnerInviteEmailEnabled(env)) return { sent: false, status: 'disabled' };
  if (!isResendConfigured(env)) return { sent: false, status: 'not_configured' };
  const send = deps.send ?? sendEmail;
  const result: SendEmailResult = await send(buildPartnerInviteEmail(input), { env });
  if (result.ok) return { sent: true, status: 'sent', provider_id: result.id };
  return { sent: false, status: result.status, error: result.error };
}
