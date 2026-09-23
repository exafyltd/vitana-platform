/**
 * VTID-04312 — tell the member who reported a problem that it was fixed.
 *
 * Before this, a ticket's status changed silently: the completion reconciler
 * resolved it when its Dev Autopilot execution completed, an operator could
 * send an answer or resolve it, and the reporter only ever saw it by polling
 * their ticket list (and `/mine` did not even return the resolution text).
 *
 * `notifyFeedbackReporter` sends one translated in-app + push notification
 * (`feedback_ticket_resolved`, tt() catalog keys `notif.feedback_resolved.*`,
 * the reporter's own locale) through the standard notifyUser pipeline, so
 * preferences, DND and the VTID-03506 test-actor sink guard all apply.
 *
 * Only RESOLVED is announced. `needs_more_info` after a failed autopilot run
 * is a note for the supervisor (the fix attempt failed), not something to
 * push at the member. Best-effort by construction: never throws, and a
 * failure never undoes the status change that triggered it.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { tt } from '../i18n/catalog';
import { getUserLocale } from '../i18n/server-locale';
import { notifyUser } from './notification-service';
import { recordResolvedTicketMemory } from './memory/support-ticket';

const LOG_PREFIX = '[feedback-reporter-notify]';

export interface NotifyDeps {
  supabase?: SupabaseClient;
  notify?: typeof notifyUser;
  locale?: typeof getUserLocale;
  /** VTID-04412: writes the member + support memory episodes; injectable for tests. */
  rememberTicket?: typeof recordResolvedTicketMemory;
}

function serviceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
}

export async function notifyFeedbackReporter(
  ticketId: string,
  deps: NotifyDeps = {},
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const sb = deps.supabase ?? serviceClient();
    if (!sb) return { sent: false, reason: 'supabase_not_configured' };

    const { data: ticket } = await sb
      .from('feedback_tickets')
      .select('id, user_id, ticket_number, status')
      .eq('id', ticketId)
      .maybeSingle();
    const t = ticket as { id: string; user_id: string | null; ticket_number: string | null; status: string } | null;
    if (!t || !t.user_id) return { sent: false, reason: 'no_reporter' };
    if (t.status !== 'resolved' && t.status !== 'user_confirmed') return { sent: false, reason: `status_${t.status}` };

    // VTID-04412: every resolve path already comes through here, so this is
    // where a resolved ticket becomes memory. Fire-and-forget, never throws.
    void (deps.rememberTicket ?? recordResolvedTicketMemory)(sb, t.id)
      .then((m) => { if (m.status === 'failed') console.warn(`${LOG_PREFIX} ticket memory failed for ${t.id}: ${m.error}`); })
      .catch(() => undefined);

    const { data: membership } = await sb
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', t.user_id)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();
    const tenantId = (membership as { tenant_id?: string } | null)?.tenant_id;
    if (!tenantId) return { sent: false, reason: 'no_tenant' };

    const lc = await (deps.locale ?? getUserLocale)(sb, t.user_id);
    const ticketLabel = t.ticket_number ?? t.id.slice(0, 8);
    const r = await (deps.notify ?? notifyUser)(t.user_id, tenantId, 'feedback_ticket_resolved', {
      title: tt('notif.feedback_resolved.title', lc),
      body: tt('notif.feedback_resolved.body', lc, { ticket: ticketLabel }),
      data: { type: 'feedback_ticket_resolved', ticket_id: t.id, url: '/comm/talk-to-vitana' },
      tag: `feedback_resolved:${t.id}`,
    }, sb);
    return { sent: r.inapp || r.pushed > 0, reason: r.suppressed };
  } catch (err) {
    console.warn(`${LOG_PREFIX} notify failed for ${ticketId}:`, err instanceof Error ? err.message : err);
    return { sent: false, reason: 'error' };
  }
}
