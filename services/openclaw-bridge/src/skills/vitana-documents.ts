/**
 * Vitana Documents Skill for OpenClaw
 *
 * Generates PDFs (invoices, health reports, consent forms),
 * manages document templates, and provides signed URL access.
 * Documents are stored in Supabase Storage with tenant isolation.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DOC_TYPES = ['invoice', 'health_report', 'consent_form', 'receipt', 'summary', 'custom'] as const;

const GenerateDocSchema = z.object({
  tenant_id: z.string().uuid(),
  type: z.enum(DOC_TYPES),
  template: z.string().min(1).max(255),
  data: z.record(z.unknown()),
  user_id: z.string().uuid().optional(),
  locale: z.string().default('en'),
});

const GetSignedUrlSchema = z.object({
  tenant_id: z.string().uuid(),
  document_id: z.string().uuid(),
  expires_in_seconds: z.number().int().min(60).max(86400).default(3600),
});

const ListDocumentsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  type: z.enum(DOC_TYPES).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

const DeleteDocSchema = z.object({
  tenant_id: z.string().uuid(),
  document_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
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
   * Generate a document from a template with tenant branding.
   * Delegates rendering to the gateway's document service.
   */
  async generate(input: unknown) {
    const { tenant_id, type, template, data, user_id, locale } = GenerateDocSchema.parse(input);

    const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
    const res = await fetch(`${gatewayUrl}/api/v1/documents/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id,
        type,
        template,
        data,
        user_id,
        locale,
        source: 'openclaw-autopilot',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Document generation failed (${res.status}): ${text}`);
    }

    const document = await res.json();

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: `document.generated.${type}`,
      actor: 'openclaw-autopilot',
      details: { document_id: document.id, type, template, user_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, document };
  },

  /**
   * Get a time-limited signed URL for document download.
   */
  async get_signed_url(input: unknown) {
    const { tenant_id, document_id, expires_in_seconds } = GetSignedUrlSchema.parse(input);
    const supabase = getSupabase();

    // Verify document belongs to tenant
    const { data: doc, error } = await supabase
      .from('documents')
      .select('id, storage_path, type')
      .eq('id', document_id)
      .eq('tenant_id', tenant_id)
      .single();

    if (error || !doc) throw new Error(`Document ${document_id} not found`);

    // Generate signed URL from Supabase Storage
    const { data: signed, error: signError } = await supabase.storage
      .from('documents')
      .createSignedUrl(doc.storage_path, expires_in_seconds);

    if (signError) throw new Error(`Failed to create signed URL: ${signError.message}`);

    return {
      success: true,
      document_id,
      url: signed.signedUrl,
      expires_in_seconds,
    };
  },

  /**
   * List documents for a tenant, optionally filtered by user or type.
   */
  async list(input: unknown) {
    const { tenant_id, user_id, type, limit } = ListDocumentsSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('documents')
      .select('id, type, template, created_at, user_id, status')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (user_id) query = query.eq('user_id', user_id);
    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw new Error(`list documents failed: ${error.message}`);
    return { success: true, documents: data, count: data?.length ?? 0 };
  },

  /**
   * Soft-delete a document with audit trail.
   */
  async delete(input: unknown) {
    const { tenant_id, document_id, reason } = DeleteDocSchema.parse(input);
    const supabase = getSupabase();

    const { error } = await supabase
      .from('documents')
      .update({
        status: 'deleted',
        deleted_at: new Date().toISOString(),
        delete_reason: reason,
      })
      .eq('id', document_id)
      .eq('tenant_id', tenant_id);

    if (error) throw new Error(`delete document failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'document.deleted',
      actor: 'openclaw-autopilot',
      details: { document_id, reason },
      created_at: new Date().toISOString(),
    });

    return { success: true, document_id, status: 'deleted' };
  },
};

export const SKILL_META = {
  name: 'vitana-documents',
  description: 'Document generation (PDF invoices, reports, consent forms) and signed URL access',
  actions: Object.keys(actions),
};
