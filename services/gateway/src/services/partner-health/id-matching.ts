/**
 * VTID-03885 — Partner Health Test Integration: ID matching.
 *
 * DoctorBox has no order-read API today (confirmed: their storefront
 * blocks automated fetching, no Shopify Admin API grant) and its
 * checkout happens entirely off-platform, so there is no callback that
 * ever hands Vitana a deterministic partner-customer-ref -> user_id
 * mapping the way an OAuth flow would (see social-connect-service.ts for
 * that template, which this deliberately does NOT apply here since there
 * is no callback to hook).
 *
 * What DOES already exist, previously unused for this purpose:
 * click-redirect.ts stamps `sub1=sha256(user_id).slice(0,16)` onto every
 * outbound affiliate URL — including DoctorBox's — while product_clicks
 * logs the real user_id under the same click_id. This module uses that
 * as a *candidate* signal only. It is never used to auto-resolve a match;
 * only an explicit admin action (see routes/admin-partner-health.ts) can
 * turn a candidate into a real partner_customer_links row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface MatchCandidate {
  user_id: string;
  click_id: string;
  clicked_at: string;
  product_id: string | null;
}

/**
 * Ranked, time-window candidates for a partner order reported around
 * `orderTimestamp`. Purely informational — the caller decides whether to
 * present these to an admin; nothing here writes anything.
 */
export async function findClickCorrelationCandidates(
  sb: SupabaseClient,
  merchantId: string,
  orderTimestamp: string,
  windowHours = 72
): Promise<MatchCandidate[]> {
  const orderTime = new Date(orderTimestamp).getTime();
  const windowStart = new Date(orderTime - windowHours * 60 * 60 * 1000).toISOString();
  // Clicks must precede the order (a click can't happen after someone already
  // ordered) but may be reported slightly after due to network jitter, hence
  // the empty pad rather than an exact upper bound.
  const windowEnd = new Date(orderTime + 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('product_clicks')
    .select('user_id, click_id, clicked_at, product_id')
    .eq('merchant_id', merchantId)
    .not('user_id', 'is', null)
    .gte('clicked_at', windowStart)
    .lte('clicked_at', windowEnd)
    .order('clicked_at', { ascending: false })
    .limit(20);

  if (error || !data) return [];

  return data
    .filter((row): row is { user_id: string; click_id: string; clicked_at: string; product_id: string | null } => !!row.user_id)
    .map((row) => ({
      user_id: row.user_id,
      click_id: row.click_id,
      clicked_at: row.clicked_at,
      product_id: row.product_id,
    }));
}

/**
 * Exact click_id match — the only path that counts as "deterministic"
 * rather than "best guess". Only reachable if a partner ever echoes the
 * sub1/click_id token back (none does today for DoctorBox).
 */
export async function findExactClickMatch(
  sb: SupabaseClient,
  clickId: string
): Promise<{ user_id: string; tenant_id: string | null } | null> {
  const { data, error } = await sb
    .from('product_clicks')
    .select('user_id, tenant_id')
    .eq('click_id', clickId)
    .not('user_id', 'is', null)
    .maybeSingle();
  if (error || !data || !data.user_id) return null;
  return { user_id: data.user_id, tenant_id: data.tenant_id };
}
