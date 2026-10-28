// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// the one referencing test (test/services/admin-awareness-worker.test.ts)
// wholesale jest.mocks services/admin-scanners — zero genuine coverage
// today.
/**
 * services/admin-scanners/index.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in admin-scanners/index.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function upsertAdminInsight(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('admin_insights').upsert(row, {
    onConflict: 'tenant_id,scanner,natural_key',
    ignoreDuplicates: false,
  });
}

export async function resolveStaleAdminInsightsNotIn(
  sb: SupabaseClient,
  tenantId: string,
  scannerId: string,
  activeKeysNotInList: string,
  resolvedAtIso: string,
) {
  return sb
    .from('admin_insights')
    .update({ status: 'resolved', resolved_at: resolvedAtIso, resolved_via: 'scanner_auto' })
    .eq('tenant_id', tenantId)
    .eq('scanner', scannerId)
    .eq('status', 'open')
    .not('natural_key', 'in', activeKeysNotInList)
    .select('id');
}

export async function resolveAllOpenAdminInsightsForScanner(
  sb: SupabaseClient,
  tenantId: string,
  scannerId: string,
  resolvedAtIso: string,
) {
  return sb
    .from('admin_insights')
    .update({ status: 'resolved', resolved_at: resolvedAtIso, resolved_via: 'scanner_auto' })
    .eq('tenant_id', tenantId)
    .eq('scanner', scannerId)
    .eq('status', 'open')
    .select('id');
}
