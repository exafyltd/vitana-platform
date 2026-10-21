// Coverage note: test/persona-registry.test.ts exercises this module
// against a mocked '@supabase/supabase-js' createClient (a functional
// fake, not a wholesale mock of this repository module), so these
// wrappers get genuine coverage, not a documented zero.
/**
 * services/persona-registry.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in persona-registry.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAllAgentPersonas(sb: SupabaseClient) {
  return sb.from('agent_personas_registry').select('*');
}

export async function fetchTenantPersonaOverrides(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('agent_personas_tenant_overrides')
    .select('tenant_id, persona_id, enabled, intake_schema_extras, custom_greeting_templates')
    .eq('tenant_id', tenantId);
}
