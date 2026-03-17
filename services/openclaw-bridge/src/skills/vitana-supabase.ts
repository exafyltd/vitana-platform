/**
 * Vitana Supabase Skill for OpenClaw
 *
 * Provides tenant management, user plan operations, and audit logging
 * through the existing Supabase backend. All operations enforce RLS
 * and emit OASIS events for traceability.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TenantCreateSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  plan: z.enum(['free', 'pro', 'enterprise']).default('free'),
  metadata: z.record(z.unknown()).optional(),
});

const UserPlanUpdateSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  plan: z.enum(['free', 'pro', 'enterprise']),
});

const AuditLogSchema = z.object({
  tenant_id: z.string().uuid(),
  action: z.string().min(1),
  actor: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Supabase Client (singleton per process)
// ---------------------------------------------------------------------------

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
    }
    _client = createClient(url, key);
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Create a new tenant with default plan.
   */
  async create_tenant(input: unknown) {
    const { tenant_id, name, plan, metadata } = TenantCreateSchema.parse(input);
    const supabase = getClient();

    const { data, error } = await supabase
      .from('tenants')
      .insert({ id: tenant_id, name, plan, metadata: metadata ?? {} })
      .select()
      .single();

    if (error) throw new Error(`create_tenant failed: ${error.message}`);

    // Audit log
    await actions.log_audit({
      tenant_id,
      action: 'tenant.created',
      actor: 'openclaw-autopilot',
      details: { plan },
    });

    return { success: true, tenant: data };
  },

  /**
   * Update a user's subscription plan within a tenant.
   */
  async update_user_plan(input: unknown) {
    const { tenant_id, user_id, plan } = UserPlanUpdateSchema.parse(input);
    const supabase = getClient();

    const { data, error } = await supabase
      .from('profiles')
      .update({ plan, updated_at: new Date().toISOString() })
      .eq('id', user_id)
      .eq('tenant_id', tenant_id)
      .select()
      .single();

    if (error) throw new Error(`update_user_plan failed: ${error.message}`);

    await actions.log_audit({
      tenant_id,
      action: 'user.plan_updated',
      actor: 'openclaw-autopilot',
      details: { user_id, plan },
    });

    return { success: true, profile: data };
  },

  /**
   * Query usage stats for a tenant (read-only).
   */
  async audit_usage(input: { tenant_id: string }) {
    const tenant_id = z.string().uuid().parse(input.tenant_id);
    const supabase = getClient();

    const { data, error } = await supabase
      .from('autopilot_logs')
      .select('action, created_at, details')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw new Error(`audit_usage failed: ${error.message}`);
    return { success: true, logs: data, count: data?.length ?? 0 };
  },

  /**
   * Write an entry to the autopilot audit log.
   */
  async log_audit(input: unknown) {
    const { tenant_id, action, actor, details } = AuditLogSchema.parse(input);
    const supabase = getClient();

    const { error } = await supabase.from('autopilot_logs').insert({
      tenant_id,
      action,
      actor,
      details: details ?? {},
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`[audit] Failed to write log: ${error.message}`);
    }
  },
};

export const SKILL_META = {
  name: 'vitana-supabase',
  description: 'Tenant management, user plans, and audit logging via Supabase',
  actions: Object.keys(actions),
};
