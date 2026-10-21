/**
 * Vitana Integrations Skill for OpenClaw
 *
 * External system connectors: FHIR R4 (EHR/EMR), lab results import,
 * external calendar sync, and webhook management for third-party
 * integrations.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FhirQuerySchema = z.object({
  tenant_id: z.string().uuid(),
  resource_type: z.enum(['Patient', 'Observation', 'Condition', 'MedicationRequest', 'Appointment', 'DiagnosticReport']),
  patient_id: z.string().optional(),
  params: z.record(z.string()).optional(),
  fhir_base_url: z.string().url().optional(),
});

const ImportLabResultsSchema = z.object({
  tenant_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  results: z.array(z.object({
    test_name: z.string().min(1),
    value: z.string(),
    unit: z.string().optional(),
    reference_range: z.string().optional(),
    status: z.enum(['final', 'preliminary', 'corrected']).default('final'),
    performed_at: z.string().datetime(),
  })),
  source: z.string().min(1).max(255),
});

const CalendarSyncSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  provider: z.enum(['google', 'outlook', 'apple', 'caldav']),
  action: z.enum(['sync_inbound', 'sync_outbound', 'check_status']),
  calendar_id: z.string().optional(),
});

const RegisterWebhookSchema = z.object({
  tenant_id: z.string().uuid(),
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1).max(20),
  secret: z.string().min(16).optional(),
  description: z.string().max(500).optional(),
});

const ListWebhooksSchema = z.object({
  tenant_id: z.string().uuid(),
  active_only: z.boolean().default(true),
});

const TestWebhookSchema = z.object({
  tenant_id: z.string().uuid(),
  webhook_id: z.string().uuid(),
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
   * Query a FHIR R4 endpoint for patient data.
   * Requires tenant to have configured a FHIR base URL.
   */
  async fhir_query(input: unknown) {
    const { tenant_id, resource_type, patient_id, params, fhir_base_url } =
      FhirQuerySchema.parse(input);

    const supabase = getSupabase();

    // Get FHIR config for tenant (or use provided URL)
    let baseUrl = fhir_base_url;
    if (!baseUrl) {
      const { data: config } = await supabase
        .from('tenant_integrations')
        .select('config')
        .eq('tenant_id', tenant_id)
        .eq('provider', 'fhir')
        .eq('status', 'active')
        .single();

      baseUrl = (config?.config as Record<string, string>)?.base_url;
      if (!baseUrl) {
        return { success: false, error: 'No FHIR integration configured for tenant' };
      }
    }

    // Build FHIR query URL
    const queryParams = new URLSearchParams(params ?? {});
    if (patient_id) queryParams.set('patient', patient_id);
    const url = `${baseUrl}/${resource_type}?${queryParams.toString()}`;

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/fhir+json',
        'Content-Type': 'application/fhir+json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`FHIR query failed (${res.status}): ${text}`);
    }

    const bundle = await res.json();

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'integration.fhir_query',
      actor: 'openclaw-autopilot',
      details: { resource_type, patient_id, result_count: bundle.total ?? 0 },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      resource_type,
      total: bundle.total ?? 0,
      entries: bundle.entry?.map((e: Record<string, unknown>) => e.resource) ?? [],
    };
  },

  /**
   * Import lab results from an external source into Vitana.
   */
  async import_lab_results(input: unknown) {
    const { tenant_id, patient_id, results, source } = ImportLabResultsSchema.parse(input);
    const supabase = getSupabase();

    const rows = results.map((r) => ({
      tenant_id,
      patient_id,
      test_name: r.test_name,
      value: r.value,
      unit: r.unit,
      reference_range: r.reference_range,
      status: r.status,
      performed_at: r.performed_at,
      source,
      imported_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from('lab_results')
      .insert(rows)
      .select();

    if (error) throw new Error(`import_lab_results failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'integration.lab_results_imported',
      actor: 'openclaw-autopilot',
      details: { patient_id, source, count: results.length },
      created_at: new Date().toISOString(),
    });

    return { success: true, imported: data?.length ?? 0, source };
  },

  /**
   * Sync calendar data with external provider.
   */
  async calendar_sync(input: unknown) {
    const { tenant_id, user_id, provider, action, calendar_id } = CalendarSyncSchema.parse(input);

    const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
    const res = await fetch(`${gatewayUrl}/api/v1/integrations/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id,
        user_id,
        provider,
        action,
        calendar_id,
        source: 'openclaw-autopilot',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`calendar_sync failed (${res.status}): ${text}`);
    }

    const result = await res.json();

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: `integration.calendar_${action}`,
      actor: 'openclaw-autopilot',
      details: { user_id, provider, action },
      created_at: new Date().toISOString(),
    });

    return { success: true, provider, action, result };
  },

  /**
   * Register a webhook for event notifications to external systems.
   */
  async register_webhook(input: unknown) {
    const { tenant_id, url, events, secret, description } = RegisterWebhookSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('webhooks')
      .insert({
        tenant_id,
        url,
        events,
        secret: secret ?? crypto.randomUUID(),
        description,
        status: 'active',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`register_webhook failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'integration.webhook_registered',
      actor: 'openclaw-autopilot',
      details: { webhook_id: data.id, url, events },
      created_at: new Date().toISOString(),
    });

    return { success: true, webhook: data };
  },

  /**
   * List registered webhooks for a tenant.
   */
  async list_webhooks(input: unknown) {
    const { tenant_id, active_only } = ListWebhooksSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('webhooks')
      .select('id, url, events, status, description, created_at, last_triggered_at')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false });

    if (active_only) query = query.eq('status', 'active');

    const { data, error } = await query;
    if (error) throw new Error(`list_webhooks failed: ${error.message}`);
    return { success: true, webhooks: data, count: data?.length ?? 0 };
  },

  /**
   * Send a test payload to a registered webhook.
   */
  async test_webhook(input: unknown) {
    const { tenant_id, webhook_id } = TestWebhookSchema.parse(input);
    const supabase = getSupabase();

    const { data: webhook, error } = await supabase
      .from('webhooks')
      .select('url, secret')
      .eq('id', webhook_id)
      .eq('tenant_id', tenant_id)
      .single();

    if (error || !webhook) throw new Error(`Webhook ${webhook_id} not found`);

    const testPayload = {
      event: 'webhook.test',
      tenant_id,
      timestamp: new Date().toISOString(),
      data: { message: 'Test webhook delivery from Vitana Autopilot' },
    };

    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vitana-Signature': webhook.secret,
      },
      body: JSON.stringify(testPayload),
    });

    return {
      success: true,
      webhook_id,
      delivered: res.ok,
      status_code: res.status,
    };
  },
};

export const SKILL_META = {
  name: 'vitana-integrations',
  description: 'External integrations: FHIR R4, lab results import, calendar sync, and webhooks',
  actions: Object.keys(actions),
};
