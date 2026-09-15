/**
 * VCAOP Partner Portal — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Shared by BOTH routes/vcaop-portal.ts (admin, tenant-scoped) and
 * routes/vcaop-portal-my.ts (merchant self-service, owner-scoped) — the two
 * routers are near-identical over the same mesh factory tables
 * (partner_tenant, integration_manifest, integration_version, schema_source,
 * schema_mapping, mapping_decision, connector_certification, oasis_events),
 * differing only in the ownership-scoping predicate and a handful of
 * actor/payload fields. Rather than duplicate the seam per-router, one
 * repository serves both — same DRY reasoning that made the two routers
 * near-duplicates of each other's data-access code in the first place.
 *
 * PURE MOVE, not a rewrite: each function is the exact same query chain
 * that used to live inline in whichever router called it — same columns,
 * same filters, same `{ data, error }`/`{ data }` shapes — no behavior
 * change today. Where the two routers' original queries differed only in
 * the ownership column (tenant_id vs owner_user_id), that's kept as two
 * explicitly named functions rather than one parameterized one, so this
 * stays a literal move and not a refactor of the scoping logic itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const MANIFEST_SELECT_BY_TENANT =
  'id,partner_tenant_id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(id,tenant_id,name,jurisdiction)';
const MANIFEST_SELECT_BY_OWNER =
  'id,partner_tenant_id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(id,tenant_id,name,jurisdiction,owner_user_id)';
const CONNECTIONS_LIST_SELECT_BY_TENANT =
  'id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(tenant_id,name,jurisdiction)';
const CONNECTIONS_LIST_SELECT_BY_OWNER =
  'id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(tenant_id,name,jurisdiction,owner_user_id)';

// ==================== oasis_events ====================

export async function insertOasisEvent(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('oasis_events').insert(row);
}

// ==================== integration_manifest ====================

/**
 * Admin router's ownership scope: partner_tenant.tenant_id === the caller's
 * tenant. Cast to `any`: postgrest-js's select-string type parser can't know
 * the manifest->partner_tenant FK is to-one without generated schema types,
 * so it infers `partner_tenant` as an array — but `!inner` + `.maybeSingle()`
 * genuinely returns one joined object at runtime (same as the original
 * inline query this was moved from, which read `rec.partner_tenant?.name`
 * directly with no array indexing).
 */
export async function fetchOwnedManifestByTenant(supabase: SupabaseClient, manifestId: string, tenantId: string): Promise<any> {
  const { data } = await supabase
    .from('integration_manifest')
    .select(MANIFEST_SELECT_BY_TENANT)
    .eq('id', manifestId)
    .eq('partner_tenant.tenant_id', tenantId)
    .maybeSingle();
  return data ?? null;
}

/** Merchant self-service router's ownership scope: partner_tenant.owner_user_id === the caller. Same array-vs-object typing note as fetchOwnedManifestByTenant above. */
export async function fetchOwnedManifestByOwner(supabase: SupabaseClient, manifestId: string, ownerUserId: string): Promise<any> {
  const { data } = await supabase
    .from('integration_manifest')
    .select(MANIFEST_SELECT_BY_OWNER)
    .eq('id', manifestId)
    .eq('partner_tenant.owner_user_id', ownerUserId)
    .maybeSingle();
  return data ?? null;
}

export async function fetchConnectionsForTenant(supabase: SupabaseClient, tenantId: string) {
  return supabase
    .from('integration_manifest')
    .select(CONNECTIONS_LIST_SELECT_BY_TENANT)
    .eq('partner_tenant.tenant_id', tenantId)
    .order('updated_at', { ascending: false });
}

export async function fetchConnectionsForOwner(supabase: SupabaseClient, ownerUserId: string) {
  return supabase
    .from('integration_manifest')
    .select(CONNECTIONS_LIST_SELECT_BY_OWNER)
    .eq('partner_tenant.owner_user_id', ownerUserId)
    .order('updated_at', { ascending: false });
}

export async function insertIntegrationManifest(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('integration_manifest').insert(row);
}

export async function updateManifestStatus(supabase: SupabaseClient, manifestId: string, status: string, updatedAt: string) {
  return supabase.from('integration_manifest').update({ status, updated_at: updatedAt }).eq('id', manifestId);
}

// ==================== partner_tenant ====================

export async function fetchPartnerTenantByTenantAndName(supabase: SupabaseClient, tenantId: string, name: string) {
  return supabase.from('partner_tenant').select('id').eq('tenant_id', tenantId).eq('name', name).maybeSingle();
}

export async function fetchPartnerTenantByOwnerAndName(supabase: SupabaseClient, ownerUserId: string, name: string) {
  return supabase.from('partner_tenant').select('id').eq('owner_user_id', ownerUserId).eq('name', name).maybeSingle();
}

export async function insertPartnerTenant(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('partner_tenant').insert(row);
}

// ==================== integration_version ====================

export async function fetchLatestVersion(supabase: SupabaseClient, manifestId: string) {
  const { data } = await supabase
    .from('integration_version')
    .select('id,version,certification_status,document_hash,created_at')
    .eq('manifest_id', manifestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function insertIntegrationVersion(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('integration_version').insert(row);
}

export async function updateVersionCertificationStatus(supabase: SupabaseClient, versionId: string, certificationStatus: string) {
  return supabase.from('integration_version').update({ certification_status: certificationStatus }).eq('id', versionId);
}

// ==================== schema_source ====================

export async function insertSchemaSource(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('schema_source').insert(row);
}

export async function fetchSchemaSourcesForVersion(supabase: SupabaseClient, versionId: string) {
  return supabase.from('schema_source').select('id,name,fields').eq('version_id', versionId);
}

// ==================== schema_mapping ====================

export async function fetchSchemaMappingsForVersion(supabase: SupabaseClient, versionId: string) {
  return supabase
    .from('schema_mapping')
    .select('id,source_schema,source_field,canonical_entity,canonical_field,transform,confidence,decided_by,sensitive')
    .eq('version_id', versionId);
}

export async function fetchMappingForDecision(supabase: SupabaseClient, mappingId: string, versionId: string) {
  const { data } = await supabase
    .from('schema_mapping')
    .select('id,version_id')
    .eq('id', mappingId)
    .eq('version_id', versionId)
    .maybeSingle();
  return data ?? null;
}

export async function approveMapping(supabase: SupabaseClient, mappingId: string) {
  return supabase.from('schema_mapping').update({ decided_by: 'human' }).eq('id', mappingId);
}

export async function deleteRejectedMapping(supabase: SupabaseClient, mappingId: string) {
  return supabase.from('schema_mapping').delete().eq('id', mappingId);
}

export async function fetchMappingsForSandboxTest(supabase: SupabaseClient, versionId: string) {
  return supabase.from('schema_mapping').select('id,sensitive,confidence,decided_by').eq('version_id', versionId);
}

// ==================== mapping_decision ====================

export async function insertMappingDecision(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('mapping_decision').insert(row);
}

// ==================== connector_certification ====================

export async function insertConnectorCertification(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('connector_certification').insert(row);
}

export async function fetchLatestCertification(supabase: SupabaseClient, versionId: string) {
  const { data } = await supabase
    .from('connector_certification')
    .select('id,status,test_results,pending_mappings,reasons,created_at')
    .eq('version_id', versionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Admin-only: stamps the certified_by approver on the one-approval activation. */
export async function markCertificationApprovedBy(supabase: SupabaseClient, versionId: string, approvedBy: string) {
  return supabase
    .from('connector_certification')
    .update({ certified_by: approvedBy })
    .eq('version_id', versionId)
    .eq('status', 'certified')
    .is('certified_by', null);
}
