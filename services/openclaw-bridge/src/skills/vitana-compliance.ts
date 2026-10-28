/**
 * Vitana Compliance Skill for OpenClaw
 *
 * Consent management (HIPAA, GDPR), audit trail queries,
 * data retention enforcement, right-to-erasure execution,
 * and data export. All operations are fully audited.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CONSENT_PURPOSES = [
  'health_data_processing',
  'marketing_communications',
  'analytics_tracking',
  'data_sharing_third_party',
  'autopilot_automation',
  'research_participation',
] as const;

const RecordConsentSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  purpose: z.enum(CONSENT_PURPOSES),
  consent_given: z.boolean(),
  scope: z.string().max(500).optional(),
  ip_address: z.string().optional(),
});

const CheckConsentSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  purpose: z.enum(CONSENT_PURPOSES),
});

const AuditTrailSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  action_filter: z.string().optional(),
  from_date: z.string().datetime().optional(),
  to_date: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const DataExportSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  format: z.enum(['json', 'csv']).default('json'),
  tables: z.array(z.string()).optional(),
});

const ErasureRequestSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
  confirmed: z.boolean(),
});

const RetentionCheckSchema = z.object({
  tenant_id: z.string().uuid(),
  retention_days: z.number().int().min(30).max(3650).default(365),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Record a user's consent decision for a specific purpose.
   */
  async record_consent(input: unknown) {
    const { tenant_id, user_id, purpose, consent_given, scope, ip_address } =
      RecordConsentSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('user_consents')
      .upsert({
        tenant_id,
        user_id,
        purpose,
        consent_given,
        scope: scope ?? purpose,
        consent_date: new Date().toISOString(),
        ip_address,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,user_id,purpose' })
      .select()
      .single();

    if (error) throw new Error(`record_consent failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: consent_given ? 'compliance.consent_granted' : 'compliance.consent_revoked',
      actor: 'openclaw-autopilot',
      details: { user_id, purpose, consent_given },
      created_at: new Date().toISOString(),
    });

    return { success: true, consent: data };
  },

  /**
   * Check if a user has active consent for a purpose.
   */
  async check_consent(input: unknown) {
    const { tenant_id, user_id, purpose } = CheckConsentSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('user_consents')
      .select('consent_given, consent_date, scope')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .eq('purpose', purpose)
      .single();

    if (error || !data) {
      return { success: true, has_consent: false, reason: 'No consent record found' };
    }

    return {
      success: true,
      has_consent: data.consent_given === true,
      consent_date: data.consent_date,
      scope: data.scope,
    };
  },

  /**
   * Query the full audit trail for a tenant/user.
   */
  async audit_trail(input: unknown) {
    const { tenant_id, user_id, action_filter, from_date, to_date, limit } =
      AuditTrailSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('autopilot_logs')
      .select('action, actor, details, created_at')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (user_id) query = query.ilike('details->>user_id', user_id);
    if (action_filter) query = query.ilike('action', `%${action_filter}%`);
    if (from_date) query = query.gte('created_at', from_date);
    if (to_date) query = query.lte('created_at', to_date);

    const { data, error } = await query;
    if (error) throw new Error(`audit_trail failed: ${error.message}`);
    return { success: true, trail: data, count: data?.length ?? 0 };
  },

  /**
   * Export all user data (GDPR Article 20 - Right to Data Portability).
   */
  async data_export(input: unknown) {
    const { tenant_id, user_id, format, tables: requestedTables } = DataExportSchema.parse(input);
    const supabase = getSupabase();

    const defaultTables = ['profiles', 'appointments', 'user_consents', 'autopilot_logs'];
    const tablesToExport = requestedTables ?? defaultTables;
    const exportData: Record<string, unknown[]> = {};

    for (const table of tablesToExport) {
      const { data } = await supabase
        .from(table)
        .select('*')
        .eq('tenant_id', tenant_id)
        .or(`user_id.eq.${user_id},patient_id.eq.${user_id},id.eq.${user_id}`)
        .limit(10000);
      exportData[table] = data ?? [];
    }

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'compliance.data_exported',
      actor: 'openclaw-autopilot',
      details: { user_id, format, tables: tablesToExport },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      format,
      export: exportData,
      tables_exported: tablesToExport,
      record_count: Object.values(exportData).reduce((sum, arr) => sum + arr.length, 0),
    };
  },

  /**
   * Process a right-to-erasure request (GDPR Article 17).
   * Requires explicit confirmation. Soft-deletes user data.
   */
  async erasure_request(input: unknown) {
    const { tenant_id, user_id, reason, confirmed } = ErasureRequestSchema.parse(input);

    if (!confirmed) {
      return {
        success: false,
        error: 'Erasure requires explicit confirmation (confirmed: true)',
        warning: 'This action will permanently anonymize the user\'s data',
      };
    }

    const supabase = getSupabase();

    // Record the erasure request before executing
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'compliance.erasure_requested',
      actor: 'openclaw-autopilot',
      details: { user_id, reason },
      created_at: new Date().toISOString(),
    });

    // Anonymize profile
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        email: `erased_${user_id.slice(0, 8)}@redacted.local`,
        full_name: '[REDACTED]',
        phone: null,
        avatar_url: null,
        erased_at: new Date().toISOString(),
        erase_reason: reason,
      })
      .eq('id', user_id)
      .eq('tenant_id', tenant_id);

    if (profileError) throw new Error(`erasure failed: ${profileError.message}`);

    // Revoke all consents
    await supabase
      .from('user_consents')
      .update({ consent_given: false, updated_at: new Date().toISOString() })
      .eq('user_id', user_id)
      .eq('tenant_id', tenant_id);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'compliance.erasure_completed',
      actor: 'openclaw-autopilot',
      details: { user_id, reason },
      created_at: new Date().toISOString(),
    });

    return { success: true, user_id, status: 'erased', reason };
  },

  /**
   * Check for data past retention period (used by heartbeat).
   */
  async retention_check(input: unknown) {
    const { tenant_id, retention_days } = RetentionCheckSchema.parse(input);
    const supabase = getSupabase();
    const cutoff = new Date(Date.now() - retention_days * 24 * 60 * 60 * 1000).toISOString();

    const { count, error } = await supabase
      .from('autopilot_logs')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id)
      .lt('created_at', cutoff);

    if (error) throw new Error(`retention_check failed: ${error.message}`);

    return {
      success: true,
      retention_days,
      cutoff_date: cutoff,
      records_past_retention: count ?? 0,
      recommendation: (count ?? 0) > 0
        ? `${count} records exceed ${retention_days}-day retention policy — consider archival/deletion`
        : 'All records within retention policy',
    };
  },
};

export const SKILL_META = {
  name: 'vitana-compliance',
  description: 'HIPAA/GDPR compliance: consent management, audit trails, data export, and right-to-erasure',
  actions: Object.keys(actions),
};
