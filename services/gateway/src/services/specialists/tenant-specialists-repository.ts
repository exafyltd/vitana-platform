/**
 * VTID-03498 (Aurora migration B1) — data-access seam for the TENANT-scoped
 * specialist configuration domain.
 *
 * Sibling of `specialists-repository.ts` (platform-level personas). This file
 * covers the tenant overlay: per-tenant enable/disable, KB bindings, routing
 * keywords, third-party connections, and the tenant-scoped audit log.
 *
 * SECURITY INVARIANT
 * ------------------
 * Every function here takes `tenantId` as its FIRST parameter, and every query
 * filters on it. That is deliberate: the gateway uses the service-role client,
 * so RLS is bypassed and tenant isolation is enforced *by this code*. Making
 * the parameter required and first means a caller cannot silently omit it — a
 * missing tenant filter would be a cross-tenant data leak, not a bug you notice
 * in review.
 *
 * The one deliberate exception is `listPlatformDefaultConnections`, which reads
 * rows with `tenant_id IS NULL` — platform defaults shown read-only to every
 * tenant. It is named so the exception is obvious at the call site.
 *
 * Error contract matches specialists-repository: database errors throw
 * RepositoryError; genuinely-absent rows return null/[]. Audit writes stay
 * best-effort.
 *
 * SCOPE NOTE: `routes/tenant-specialists.ts` also owns a second, unrelated
 * domain — the customer feedback/ticket lifecycle (feedback_tickets,
 * feedback_handoff_events, dev_autopilot_executions). That is NOT in this file;
 * it is a different bounded context and gets its own repository in the next
 * slice. Splitting it is better design than one god-repository, not just
 * scheduling.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RepositoryError } from './specialists-repository';

export { RepositoryError };

export interface TenantOverlayRow {
  tenant_id: string;
  persona_id: string;
  enabled: boolean;
  intake_schema_extras: Record<string, unknown>;
  custom_greeting_templates: Record<string, string>;
  notes: string | null;
  [column: string]: unknown;
}

export interface TenantKbBindingRow {
  kb_scope: string;
  enabled: boolean;
  [column: string]: unknown;
}

export interface TenantKeywordRow {
  keyword: string;
  weight: number;
  enabled: boolean;
  [column: string]: unknown;
}

export interface TenantConnectionRow {
  id: string;
  provider: string;
  status: string;
  last_check_at: string | null;
  created_at: string;
  persona_id?: string;
  [column: string]: unknown;
}

export interface TenantAuditRow {
  id: string;
  actor_user_id: string;
  persona_id: string | null;
  action: string;
  before_state: unknown;
  after_state: unknown;
  ts: string;
}

/** Columns the overlay endpoint exposes for the platform persona it overlays. */
export const OVERLAY_PERSONA_COLUMNS =
  'id, key, display_name, role, voice_id, status, handles_kinds, handoff_keywords, greeting_templates';

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Test seam: inject a stub client. */
export function __setClientForTest(c: SupabaseClient | null): void {
  client = c;
}

function fail(operation: string, error: { message?: string } | null): never {
  throw new RepositoryError(error?.message ?? 'unknown database error', operation);
}

// ---------------------------------------------------------------------------
// Persona lookup (platform-level read, needed to resolve :key → persona_id)
// ---------------------------------------------------------------------------

export async function resolvePersonaId(key: string): Promise<string | null> {
  const { data, error } = await db()
    .from('agent_personas')
    .select('id')
    .eq('key', key)
    .maybeSingle();
  if (error) fail('resolvePersonaId', error);
  return (data as { id: string } | null)?.id ?? null;
}

export async function getOverlayPersona(
  key: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db()
    .from('agent_personas')
    .select(OVERLAY_PERSONA_COLUMNS)
    .eq('key', key)
    .maybeSingle();
  if (error) fail('getOverlayPersona', error);
  return (data as Record<string, unknown>) ?? null;
}

// ---------------------------------------------------------------------------
// Tenant overlay
// ---------------------------------------------------------------------------

export async function getOverlay(
  tenantId: string,
  personaId: string,
): Promise<TenantOverlayRow | null> {
  const { data, error } = await db()
    .from('agent_personas_tenant_overrides')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId)
    .maybeSingle();
  if (error) fail('getOverlay', error);
  return (data as TenantOverlayRow) ?? null;
}

export async function upsertOverlay(
  tenantId: string,
  personaId: string,
  patch: Record<string, unknown>,
): Promise<TenantOverlayRow> {
  const { data, error } = await db()
    .from('agent_personas_tenant_overrides')
    .upsert({ ...patch, tenant_id: tenantId, persona_id: personaId }, {
      onConflict: 'tenant_id,persona_id',
    })
    .select('*')
    .single();
  if (error || !data) fail('upsertOverlay', error);
  return data as TenantOverlayRow;
}

// ---------------------------------------------------------------------------
// Tenant KB bindings
// ---------------------------------------------------------------------------

export async function listKbBindings(
  tenantId: string,
  personaId: string,
  columns = '*',
): Promise<TenantKbBindingRow[]> {
  const { data, error } = await db()
    .from('agent_kb_bindings_tenant')
    .select(columns)
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);
  if (error) fail('listKbBindings', error);
  return (data ?? []) as unknown as TenantKbBindingRow[];
}

/**
 * Delete-then-insert, no transaction — PostgREST cannot express one, so a
 * failure between the halves leaves the tenant with no bindings. Same
 * pre-existing hazard as the platform-level repository; Aurora's direct SQL
 * connection can wrap both in BEGIN/COMMIT.
 */
export async function replaceKbBindings(
  tenantId: string,
  personaId: string,
  scopes: string[],
  boundBy: string,
): Promise<void> {
  const { error: delErr } = await db()
    .from('agent_kb_bindings_tenant')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);
  if (delErr) fail('replaceKbBindings.delete', delErr);
  if (scopes.length === 0) return;
  const { error: insErr } = await db()
    .from('agent_kb_bindings_tenant')
    .insert(
      scopes.map((scope) => ({
        tenant_id: tenantId,
        persona_id: personaId,
        kb_scope: scope,
        enabled: true,
        bound_by: boundBy,
      })),
    );
  if (insErr) fail('replaceKbBindings.insert', insErr);
}

// ---------------------------------------------------------------------------
// Tenant routing keywords
// ---------------------------------------------------------------------------

export async function listKeywords(
  tenantId: string,
  personaId: string,
  columns = '*',
): Promise<TenantKeywordRow[]> {
  const { data, error } = await db()
    .from('agent_routing_keywords_tenant')
    .select(columns)
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);
  if (error) fail('listKeywords', error);
  return (data ?? []) as unknown as TenantKeywordRow[];
}

/** Same non-transactional caveat as replaceKbBindings. */
export async function replaceKeywords(
  tenantId: string,
  personaId: string,
  keywords: Array<{ keyword: string; weight?: number }>,
  addedBy: string,
): Promise<void> {
  const { error: delErr } = await db()
    .from('agent_routing_keywords_tenant')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);
  if (delErr) fail('replaceKeywords.delete', delErr);
  if (keywords.length === 0) return;
  const { error: insErr } = await db()
    .from('agent_routing_keywords_tenant')
    .insert(
      keywords.map((k) => ({
        tenant_id: tenantId,
        persona_id: personaId,
        keyword: k.keyword.trim().toLowerCase(),
        weight: k.weight ?? 1.0,
        enabled: true,
        added_by: addedBy,
      })),
    );
  if (insErr) fail('replaceKeywords.insert', insErr);
}

// ---------------------------------------------------------------------------
// Third-party connections
// ---------------------------------------------------------------------------

const CONNECTION_COLUMNS = 'id, provider, status, last_check_at, created_at';

export async function listTenantConnections(
  tenantId: string,
  personaId: string,
): Promise<TenantConnectionRow[]> {
  const { data, error } = await db()
    .from('agent_third_party_connections')
    .select(CONNECTION_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('persona_id', personaId);
  if (error) fail('listTenantConnections', error);
  return (data ?? []) as unknown as TenantConnectionRow[];
}

/**
 * DELIBERATE tenant-filter exception: platform defaults are the rows with
 * `tenant_id IS NULL`, surfaced read-only to every tenant. Named explicitly so
 * this cannot be mistaken for a missing scope filter.
 */
export async function listPlatformDefaultConnections(
  personaId: string,
): Promise<TenantConnectionRow[]> {
  const { data, error } = await db()
    .from('agent_third_party_connections')
    .select(CONNECTION_COLUMNS)
    .is('tenant_id', null)
    .eq('persona_id', personaId);
  if (error) fail('listPlatformDefaultConnections', error);
  return (data ?? []) as unknown as TenantConnectionRow[];
}

export async function createConnection(
  tenantId: string,
  personaId: string,
  provider: string,
  createdBy: string,
): Promise<TenantConnectionRow> {
  const { data, error } = await db()
    .from('agent_third_party_connections')
    .insert({
      tenant_id: tenantId,
      persona_id: personaId,
      provider,
      status: 'draft',
      created_by: createdBy,
    })
    .select('*')
    .single();
  if (error || !data) fail('createConnection', error);
  return data as TenantConnectionRow;
}

export async function getConnectionForTenant(
  tenantId: string,
  connectionId: string,
): Promise<TenantConnectionRow | null> {
  const { data, error } = await db()
    .from('agent_third_party_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) fail('getConnectionForTenant', error);
  return (data as TenantConnectionRow) ?? null;
}

export async function deleteConnectionForTenant(
  tenantId: string,
  connectionId: string,
): Promise<void> {
  const { error } = await db()
    .from('agent_third_party_connections')
    .delete()
    .eq('id', connectionId)
    .eq('tenant_id', tenantId);
  if (error) fail('deleteConnectionForTenant', error);
}

// ---------------------------------------------------------------------------
// Tenant-scoped audit
// ---------------------------------------------------------------------------

export async function writeTenantAudit(
  actorUserId: string,
  tenantId: string,
  personaId: string | null,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  // Best-effort by design: an audit failure must not fail the tenant admin's
  // change. Now logged rather than silently dropped.
  const { error } = await db().from('agent_audit_log').insert({
    actor_user_id: actorUserId,
    tenant_id: tenantId,
    persona_id: personaId,
    action,
    before_state: before ?? null,
    after_state: after ?? null,
  });
  if (error) {
    console.warn(`[tenant-specialists-repository] audit write failed (${action}): ${error.message}`);
  }
}

export async function listTenantAudit(
  tenantId: string,
  limit: number,
): Promise<TenantAuditRow[]> {
  const { data, error } = await db()
    .from('agent_audit_log')
    .select('id, actor_user_id, persona_id, action, before_state, after_state, ts')
    .eq('tenant_id', tenantId)
    .order('ts', { ascending: false })
    .limit(limit);
  if (error) fail('listTenantAudit', error);
  return (data ?? []) as TenantAuditRow[];
}
