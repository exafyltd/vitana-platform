/**
 * VTID-03885 — Partner Health Test Integration: consent enforcement.
 *
 * Reads/writes the platform-wide `data_sharing_consents` +
 * `data_sharing_consent_events` primitive (see the migration's own
 * comments for why this is generic rather than health-test-specific).
 *
 * This is the ONE choke point every ingestion path (webhook connector,
 * portal manual-upload confirm-match) must call before writing any
 * partner_health_results/biomarker_results row. Revocation is
 * future-ingestion-only by design — it never retroactively touches
 * already-ingested data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type DataSharingResourceType = 'partner_integration';
export type DataSharingScope = 'order_tracking' | 'result_ingestion';
export type DataSharingGrantedVia = 'checkout_flow' | 'settings_connected_apps' | 'portal_admin_backfill';

export interface ConsentIdentity {
  tenant_id: string;
  user_id: string;
}

/** True only if an active (non-revoked) consent row exists for this exact resource+scope. */
export async function checkDataSharingConsent(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  resourceType: DataSharingResourceType,
  resourceId: string,
  scope: DataSharingScope
): Promise<boolean> {
  const { data, error } = await sb
    .from('data_sharing_consents')
    .select('id')
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .eq('scope', scope)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    // Fail closed — a consent-check error must never be treated as consent granted.
    console.error('[partner-health/consent] checkDataSharingConsent error:', error.message);
    return false;
  }
  return !!data;
}

export async function grantDataSharingConsent(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  resourceType: DataSharingResourceType,
  resourceId: string,
  scope: DataSharingScope,
  grantedVia: DataSharingGrantedVia,
  actor: { role: string; id: string | null } = { role: 'user', id: identity.user_id }
): Promise<{ ok: boolean; error?: string }> {
  const { data: existing } = await sb
    .from('data_sharing_consents')
    .select('id, revoked_at')
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .eq('scope', scope)
    .maybeSingle();

  const before = existing ?? null;
  let after: Record<string, unknown>;

  if (existing) {
    const { data: updated, error } = await sb
      .from('data_sharing_consents')
      .update({ revoked_at: null, granted_at: new Date().toISOString(), granted_via: grantedVia })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) return { ok: false, error: error.message };
    after = updated;
  } else {
    const { data: inserted, error } = await sb
      .from('data_sharing_consents')
      .insert({
        tenant_id: identity.tenant_id,
        user_id: identity.user_id,
        resource_type: resourceType,
        resource_id: resourceId,
        scope,
        granted_via: grantedVia,
      })
      .select()
      .single();
    if (error) return { ok: false, error: error.message };
    after = inserted;
  }

  await sb.from('data_sharing_consent_events').insert({
    tenant_id: identity.tenant_id,
    user_id: identity.user_id,
    resource_type: resourceType,
    resource_id: resourceId,
    scope,
    action: 'grant',
    actor_role: actor.role,
    actor_id: actor.id,
    before,
    after,
  });

  return { ok: true };
}

export async function revokeDataSharingConsent(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  resourceType: DataSharingResourceType,
  resourceId: string,
  scope: DataSharingScope,
  actor: { role: string; id: string | null } = { role: 'user', id: identity.user_id }
): Promise<{ ok: boolean; error?: string }> {
  const { data: existing } = await sb
    .from('data_sharing_consents')
    .select('id, revoked_at')
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .eq('scope', scope)
    .maybeSingle();

  if (!existing) return { ok: true }; // nothing to revoke — idempotent
  if (existing.revoked_at) return { ok: true }; // already revoked — idempotent

  const revokedAt = new Date().toISOString();
  const { data: updated, error } = await sb
    .from('data_sharing_consents')
    .update({ revoked_at: revokedAt })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  await sb.from('data_sharing_consent_events').insert({
    tenant_id: identity.tenant_id,
    user_id: identity.user_id,
    resource_type: resourceType,
    resource_id: resourceId,
    scope,
    action: 'revoke',
    actor_role: actor.role,
    actor_id: actor.id,
    before: existing,
    after: updated,
  });

  return { ok: true };
}
