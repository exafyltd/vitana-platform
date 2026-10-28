/**
 * VTID-05029 — email backstop for important notifications a push never reached.
 *
 * Push reaches most active members, but not all: some have no registered
 * device and browser push still depends on FCM. For the notifications that
 * matter (a chat message, a reminder, anything p0/p1) whose recorded push
 * outcome (VTID-04962) is `no_device` or `fcm_error`, and that the member has
 * not read in-app within an hour, this job sends ONE digest email per member,
 * at most one every six hours.
 *
 * Ships inert. It runs only when all of these hold:
 *   - EMAIL_FALLBACK_ENABLED is exactly 'true'
 *   - Resend is configured (RESEND_API_KEY + EMAIL_FROM, resend-mailer.ts)
 *   - this is not staging — staging shares the production database, so a
 *     staging job would email real members; there is no override.
 *
 * Skips: test and service accounts, members with push switched off entirely
 * (a deliberate opt-out), members with email_fallback_enabled = false, and
 * members without a confirmed email. The email lists titles only (never
 * message bodies), links to the app's notifications and settings, and carries
 * no tracking. A row is stamped email_fallback_sent_at only after Resend
 * accepted the email; a failure is retried on the next tick while the row is
 * still inside the 24 h window.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { tt, type GatewayLocale } from '../../i18n/catalog';
import { bulkGetUserLocales } from '../../i18n/server-locale';
import { escapeHtml, isResendConfigured, sendEmail, type OutboundEmail, type SendEmailResult } from './resend-mailer';
import { resolveAppBaseUrl } from './partner-invite-email';

export const EMAIL_FALLBACK_TYPES: ReadonlySet<string> = new Set(['new_chat_message', 'reminder_due']);
export const EMAIL_FALLBACK_PRIORITIES: ReadonlySet<string> = new Set(['p0', 'p1']);
export const EMAIL_FALLBACK_OUTCOMES = ['no_device', 'fcm_error'] as const;
export const EMAIL_FALLBACK_MIN_AGE_MS = 60 * 60 * 1000;
export const EMAIL_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EMAIL_FALLBACK_MEMBER_CAP_MS = 6 * 60 * 60 * 1000;
export const EMAIL_FALLBACK_MAX_ITEMS = 5;
export const EMAIL_FALLBACK_TICK_MS = 15 * 60 * 1000;
const CANDIDATE_LIMIT = 500;

export const NOTIFICATIONS_PATH = '/inbox';
export const NOTIFICATION_SETTINGS_PATH = '/settings/notifications';

export interface FallbackCandidate {
  id: string;
  user_id: string;
  type: string;
  priority: string | null;
  title: string | null;
  created_at: string;
}

export type SkipReason = 'test_or_service_account' | 'push_disabled' | 'email_opt_out' | 'recently_emailed' | 'no_confirmed_email';

export interface FallbackRunResult {
  ok: boolean;
  candidates: number;
  members: number;
  sent: number;
  failed: number;
  skipped: Partial<Record<SkipReason, number>>;
  error?: string;
}

export function isEmailFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMAIL_FALLBACK_ENABLED === 'true' && isResendConfigured(env) && env.VITANA_ENV !== 'staging';
}

export function isFallbackWorthy(row: Pick<FallbackCandidate, 'type' | 'priority'>): boolean {
  return EMAIL_FALLBACK_TYPES.has(row.type) || (row.priority != null && EMAIL_FALLBACK_PRIORITIES.has(row.priority));
}

/** Allowlisted rows grouped by member, oldest first within each member. */
export function groupByMember(rows: FallbackCandidate[]): Map<string, FallbackCandidate[]> {
  const out = new Map<string, FallbackCandidate[]>();
  for (const r of rows) {
    if (!r.user_id || !isFallbackWorthy(r)) continue;
    const list = out.get(r.user_id) ?? [];
    list.push(r);
    out.set(r.user_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

export function buildFallbackDigestEmail(input: {
  to: string;
  items: FallbackCandidate[];
  locale: GatewayLocale;
  env?: NodeJS.ProcessEnv;
}): OutboundEmail {
  const { to, items, locale } = input;
  const base = resolveAppBaseUrl(input.env);
  const inboxUrl = base + NOTIFICATIONS_PATH;
  const settingsUrl = base + NOTIFICATION_SETTINGS_PATH;
  const shown = items.slice(0, EMAIL_FALLBACK_MAX_ITEMS);
  const more = items.length - shown.length;
  const fallbackTitle = tt('notif.fallback_app_name', locale);
  const titles = shown.map((i) => (i.title && i.title.trim()) || fallbackTitle);

  const subject = tt('email.push_fallback.subject', locale, { count: items.length });
  const greeting = tt('email.push_fallback.greeting', locale);
  const intro = tt('email.push_fallback.intro', locale);
  const moreLine = more > 0 ? tt('email.push_fallback.more', locale, { count: more }) : '';
  const cta = tt('email.push_fallback.cta', locale);
  const why = tt('email.push_fallback.why', locale);
  const settings = tt('email.push_fallback.settings', locale);

  const text = [greeting, '', intro, ...titles.map((t) => `- ${t}`), ...(moreLine ? [moreLine] : []), '', `${cta}: ${inboxUrl}`, '', why, `${settings}: ${settingsUrl}`].join('\n');

  const e = escapeHtml;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const html =
    `<!doctype html><html lang="${e(locale)}" dir="${dir}"><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">` +
    `<p>${e(greeting)}</p>` +
    `<p>${e(intro)}</p>` +
    `<ul>${titles.map((t) => `<li>${e(t)}</li>`).join('')}</ul>` +
    (moreLine ? `<p>${e(moreLine)}</p>` : '') +
    `<p><a href="${e(inboxUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none">${e(cta)}</a></p>` +
    `<p style="font-size:13px;color:#555555">${e(why)} <a href="${e(settingsUrl)}" style="color:#555555">${e(settings)}</a></p>` +
    `</body></html>`;

  return { to, subject, html, text, tags: [{ name: 'category', value: 'push_fallback' }] };
}

// ── I/O ─────────────────────────────────────────────────────────────────────

export interface FallbackDeps {
  now?: () => number;
  send?: (m: OutboundEmail) => Promise<SendEmailResult>;
  getLocales?: (ids: string[]) => Promise<Map<string, GatewayLocale>>;
  getConfirmedEmail?: (userId: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

async function idsIn(sb: SupabaseClient, table: string, ids: string[]): Promise<Set<string>> {
  const { data, error } = await sb.from(table).select('user_id').in('user_id', ids);
  if (error) throw new Error(`${table}: ${error.message}`);
  return new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
}

async function confirmedEmailFromAuth(sb: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await sb.auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  const u = data.user;
  return u.email && u.email_confirmed_at ? u.email : null;
}

export async function runEmailFallbackTick(sb: SupabaseClient, deps: FallbackDeps = {}): Promise<FallbackRunResult> {
  const now = (deps.now ?? Date.now)();
  const send = deps.send ?? ((m: OutboundEmail) => sendEmail(m, { env: deps.env }));
  const getLocales = deps.getLocales ?? ((ids: string[]) => bulkGetUserLocales(sb, ids));
  const getConfirmedEmail = deps.getConfirmedEmail ?? ((id: string) => confirmedEmailFromAuth(sb, id));
  const result: FallbackRunResult = { ok: true, candidates: 0, members: 0, sent: 0, failed: 0, skipped: {} };
  const skip = (r: SkipReason) => { result.skipped[r] = (result.skipped[r] ?? 0) + 1; };

  try {
    const { data, error } = await sb
      .from('user_notifications')
      .select('id, user_id, type, priority, title, created_at')
      .in('push_outcome', [...EMAIL_FALLBACK_OUTCOMES])
      .is('read_at', null)
      .is('email_fallback_sent_at', null)
      .gte('created_at', new Date(now - EMAIL_FALLBACK_MAX_AGE_MS).toISOString())
      .lte('created_at', new Date(now - EMAIL_FALLBACK_MIN_AGE_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(CANDIDATE_LIMIT);
    if (error) throw new Error(`user_notifications: ${error.message}`);
    const rows = (data ?? []) as FallbackCandidate[];
    result.candidates = rows.length;
    const byMember = groupByMember(rows);
    result.members = byMember.size;
    if (byMember.size === 0) return result;

    const ids = [...byMember.keys()];
    const [testActors, bots] = await Promise.all([idsIn(sb, 'notification_test_actors', ids), idsIn(sb, 'service_bot_accounts', ids)]);

    const { data: prefRows, error: prefErr } = await sb
      .from('user_notification_preferences')
      .select('user_id, push_enabled, email_fallback_enabled')
      .in('user_id', ids);
    if (prefErr) throw new Error(`user_notification_preferences: ${prefErr.message}`);
    const prefs = new Map(((prefRows ?? []) as Array<{ user_id: string; push_enabled: boolean | null; email_fallback_enabled: boolean | null }>).map((p) => [p.user_id, p]));

    const { data: recentRows, error: recentErr } = await sb
      .from('user_notifications')
      .select('user_id, email_fallback_sent_at')
      .in('user_id', ids)
      .gte('email_fallback_sent_at', new Date(now - EMAIL_FALLBACK_MEMBER_CAP_MS).toISOString());
    if (recentErr) throw new Error(`user_notifications (recent): ${recentErr.message}`);
    const recentlyEmailed = new Set(((recentRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));

    const locales = await getLocales(ids);

    for (const [userId, items] of byMember) {
      if (testActors.has(userId) || bots.has(userId)) { skip('test_or_service_account'); continue; }
      const p = prefs.get(userId);
      if (p?.push_enabled === false) { skip('push_disabled'); continue; }
      if (p?.email_fallback_enabled === false) { skip('email_opt_out'); continue; }
      if (recentlyEmailed.has(userId)) { skip('recently_emailed'); continue; }
      const to = await getConfirmedEmail(userId);
      if (!to) { skip('no_confirmed_email'); continue; }

      const message = buildFallbackDigestEmail({ to, items, locale: locales.get(userId) ?? 'de', env: deps.env });
      const sent = await send(message);
      if (!sent.ok) {
        result.failed++;
        console.warn(`[email-fallback] digest for ${userId} not sent: ${sent.status} ${sent.error}`);
        continue;
      }
      const { error: stampErr } = await sb
        .from('user_notifications')
        .update({ email_fallback_sent_at: new Date(now).toISOString() })
        .in('id', items.map((i) => i.id));
      if (stampErr) console.error(`[email-fallback] sent to ${userId} but stamping failed: ${stampErr.message}`);
      result.sent++;
    }
    return result;
  } catch (err) {
    return { ...result, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let loopStarted = false;

/**
 * Starts the 15-minute loop when isEmailFallbackEnabled(). Idempotent; a tick
 * is skipped while the previous one is still running. Returns whether it
 * started.
 */
export function startEmailFallbackLoop(getClient: () => SupabaseClient | null): boolean {
  if (loopStarted || !isEmailFallbackEnabled()) return false;
  loopStarted = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const sb = getClient();
      if (!sb) return;
      const r = await runEmailFallbackTick(sb);
      if (!r.ok) console.warn('[email-fallback] tick error:', r.error);
      else if (r.sent || r.failed) console.log(`[email-fallback] sent=${r.sent} failed=${r.failed} members=${r.members} skipped=${JSON.stringify(r.skipped)}`);
    } catch (err) {
      console.warn('[email-fallback] tick exception:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, EMAIL_FALLBACK_TICK_MS);
  timer.unref?.();
  return true;
}
