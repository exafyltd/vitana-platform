// Coverage note: test/routes/tenant-admin/audit-log.test.ts exercises
// this route against a mocked '../../../lib/supabase' client (a
// functional fake, not a wholesale mock of this repository module), so
// these wrappers get genuine coverage, not a documented zero.
/**
 * routes/tenant-admin/audit-log.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in tenant-admin/audit-log.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * `fetchTenantAdminAuditLog` resolves the terminal await inside an
 * async function (rather than returning a partial builder) so the
 * source's optional `action` conditional `.eq()` step still runs before
 * the query executes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantAdminAuditLog(sb: SupabaseClient, args: { tenantId: string; limit: number; action: string }) {
  let query = sb
    .from('tenant_admin_audit_log')
    .select('*')
    .eq('tenant_id', args.tenantId)
    .order('created_at', { ascending: false })
    .limit(args.limit);

  if (args.action) query = query.eq('action', args.action);

  return query;
}

export async function fetchAuthOasisEvents(sb: SupabaseClient, limit: number) {
  return sb
    .from('oasis_events')
    .select('*')
    .in('topic', ['auth.login', 'auth.logout', 'auth.signup', 'role.changed'])
    .order('created_at', { ascending: false })
    .limit(limit);
}
