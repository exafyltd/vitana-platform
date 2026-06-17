/**
 * Alias-mailbox routing + OTP/verification polling (VAULT-OTP-0002, runbook Sec. 4.5).
 *
 * Email/OTP verification during onboarding routes to a DETERMINISTIC per-onboarding
 * alias inbox on the SYSTEM domain — NEVER a human's personal inbox. worker-core
 * polls the alias, extracts the OTP or verification link, and resolves the job step.
 * Mockable: the `MailboxProvider` interface has an in-memory impl for tests/dev; a
 * real IMAP/API-backed impl is a runtime concern.
 */

/** System mail domain for alias inboxes. Configurable; default is a system domain. */
export const SYSTEM_MAIL_DOMAIN = 'mail.vcaop.dev';

export interface MailboxMessage {
  from: string;
  subject: string;
  body: string;
  receivedAt: number;
}

export interface MailboxProvider {
  /** Return messages currently in the alias inbox (most recent first). */
  poll(alias: string): Promise<MailboxMessage[]>;
}

/**
 * Build the deterministic alias for an onboarding: `provider+<slug>-<onboardingId>@domain`.
 * Same (slug, onboardingId) always yields the same alias (idempotent inbox).
 */
export function aliasFor(providerSlug: string, onboardingId: string, domain = SYSTEM_MAIL_DOMAIN): string {
  const slug = providerSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const oid = onboardingId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `provider+${slug}-${oid}@${domain}`;
}

/** Guard: refuse to route verification to anything other than a system alias. */
export function assertSystemAlias(alias: string, domain = SYSTEM_MAIL_DOMAIN): void {
  const at = alias.lastIndexOf('@');
  const host = at === -1 ? '' : alias.slice(at + 1).toLowerCase();
  if (host !== domain.toLowerCase() || !alias.startsWith('provider+')) {
    throw new Error(`refusing non-system mailbox "${alias}" — verification routes to system alias only (Sec. 4.5)`);
  }
}

/** Extract a numeric OTP (default 4–8 digits) from a message body, if present. */
export function extractOtp(body: string, minLen = 4, maxLen = 8): string | null {
  // Prefer a code that follows an OTP-ish keyword to avoid matching unrelated numbers.
  const keyed = new RegExp(`(?:code|otp|passcode|verification)[^0-9]{0,20}(\\d{${minLen},${maxLen}})`, 'i').exec(body);
  if (keyed) return keyed[1];
  const bare = new RegExp(`\\b(\\d{${minLen},${maxLen}})\\b`).exec(body);
  return bare ? bare[1] : null;
}

/** Extract the first https verification link from a message body, if present. */
export function extractVerificationLink(body: string): string | null {
  const m = /https:\/\/[^\s"'<>]+/i.exec(body);
  return m ? m[0] : null;
}

export interface VerificationResult {
  resolved: boolean;
  otp?: string;
  link?: string;
  message?: MailboxMessage;
}

/**
 * Poll the alias and resolve a verification step: returns the OTP and/or link found
 * in the newest matching message. `resolved` is false if nothing is found yet
 * (worker-core retries until timeout).
 */
export async function resolveVerificationStep(
  provider: MailboxProvider,
  alias: string,
): Promise<VerificationResult> {
  assertSystemAlias(alias);
  const messages = await provider.poll(alias);
  for (const msg of messages) {
    const otp = extractOtp(msg.body) ?? undefined;
    const link = extractVerificationLink(msg.body) ?? undefined;
    if (otp || link) {
      return { resolved: true, otp, link, message: msg };
    }
  }
  return { resolved: false };
}

/** In-memory mailbox for tests/dev. Messages are isolated per alias. */
export class InMemoryMailbox implements MailboxProvider {
  private readonly inboxes = new Map<string, MailboxMessage[]>();

  /** Simulate inbound delivery to an alias. */
  deliver(alias: string, message: Omit<MailboxMessage, 'receivedAt'> & { receivedAt?: number }): void {
    assertSystemAlias(alias);
    const box = this.inboxes.get(alias) ?? [];
    box.unshift({ ...message, receivedAt: message.receivedAt ?? Date.now() });
    this.inboxes.set(alias, box);
  }

  async poll(alias: string): Promise<MailboxMessage[]> {
    return [...(this.inboxes.get(alias) ?? [])];
  }
}
