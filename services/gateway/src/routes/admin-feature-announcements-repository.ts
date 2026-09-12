// Genuinely tested via test/admin-feature-announcements.test.ts, which
// drives a functional fake Supabase client (makeFakeSupabase) — not a
// wholesale module mock.
/**
 * routes/admin-feature-announcements.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in admin-feature-announcements.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same queries, same columns, same conditional-filter
 * logic, same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertFeatureAnnouncement(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('feature_announcements').insert(row).select('id').single();
}

export async function fetchTenantMemberUserIds(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId);
}

export async function markFeatureAnnouncementNotified(sb: SupabaseClient, announcementId: string, notifiedAtIso: string) {
  return sb.from('feature_announcements').update({ notified_at: notifiedAtIso }).eq('id', announcementId);
}

export async function listFeatureAnnouncements(sb: SupabaseClient, tenantId: string | undefined) {
  let query = sb.from('feature_announcements').select('*').order('created_at', { ascending: false }).limit(50);
  if (tenantId) {
    query = query.eq('tenant_id', tenantId);
  }
  return query;
}
