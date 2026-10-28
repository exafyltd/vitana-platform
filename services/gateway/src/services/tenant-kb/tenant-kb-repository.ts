/**
 * routes/tenant-admin/knowledge.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/tenant-admin/knowledge.ts
 * (kb_documents, tenant_kb_baseline_optouts, knowledge_docs) now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same
 * `{ data, error }` shapes — no behavior change today. Mirrors the
 * community-marketplace/universal-cart/vcaop-portal/testing/ai-assistants/
 * admin-signups repository precedents from the same workstream.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== tenant_kb_baseline_optouts ====================

export async function fetchOptoutDocumentIds(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_kb_baseline_optouts').select('document_id').eq('tenant_id', tenantId);
}

export async function upsertBaselineOptout(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('tenant_kb_baseline_optouts').upsert(row, { onConflict: 'tenant_id,document_id' });
}

export async function deleteBaselineOptout(supabase: SupabaseClient, tenantId: string, documentId: string) {
  return supabase.from('tenant_kb_baseline_optouts').delete().eq('tenant_id', tenantId).eq('document_id', documentId);
}

// ==================== kb_documents ====================

export interface DocumentsFilters {
  tenantId: string;
  source?: string;
  status?: string;
  q?: string;
}

/** GET /documents — same branch structure as the original inline query builder. */
export async function fetchDocuments(supabase: SupabaseClient, f: DocumentsFilters) {
  let query = supabase
    .from('kb_documents')
    .select('*')
    .or(`tenant_id.eq.${f.tenantId},tenant_id.is.null`)
    .order('created_at', { ascending: false });

  if (f.source === 'tenant') {
    query = supabase.from('kb_documents').select('*').eq('tenant_id', f.tenantId).order('created_at', { ascending: false });
  } else if (f.source === 'baseline') {
    query = supabase.from('kb_documents').select('*').is('tenant_id', null).order('created_at', { ascending: false });
  }

  if (f.status) query = query.eq('status', f.status);
  if (f.q) query = query.ilike('title', `%${f.q}%`);

  return query;
}

export async function insertDocument(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('kb_documents').insert(row).select('*').single();
}

export async function fetchDocumentById(supabase: SupabaseClient, id: string, tenantId: string) {
  return supabase.from('kb_documents').select('*').eq('id', id).or(`tenant_id.eq.${tenantId},tenant_id.is.null`).single();
}

export async function updateDocument(supabase: SupabaseClient, id: string, tenantId: string, updates: Record<string, unknown>) {
  return supabase.from('kb_documents').update(updates).eq('id', id).eq('tenant_id', tenantId).select('*').single();
}

export async function deleteDocument(supabase: SupabaseClient, id: string, tenantId: string) {
  return supabase.from('kb_documents').delete().eq('id', id).eq('tenant_id', tenantId);
}

export async function markDocumentPendingReindex(supabase: SupabaseClient, id: string, tenantId: string) {
  return supabase.from('kb_documents').update({ status: 'pending', indexed_at: null }).eq('id', id).eq('tenant_id', tenantId);
}

export async function searchTenantDocs(supabase: SupabaseClient, tenantId: string, q: string) {
  return supabase
    .from('kb_documents')
    .select('id, title, topics, status')
    .eq('tenant_id', tenantId)
    .eq('status', 'indexed')
    .ilike('title', `%${q}%`)
    .limit(10);
}

export async function searchBaselineDocs(supabase: SupabaseClient, q: string) {
  return supabase
    .from('kb_documents')
    .select('id, title, topics, status')
    .is('tenant_id', null)
    .eq('status', 'indexed')
    .ilike('title', `%${q}%`)
    .limit(10);
}

export async function fetchKbDocsForUnifiedTree(supabase: SupabaseClient, tenantId: string) {
  return supabase
    .from('kb_documents')
    .select('id, title, tenant_id, topics, status, created_at, updated_at')
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
}

export async function fetchTopicsForTenant(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('kb_documents').select('topics').eq('tenant_id', tenantId);
}

// ==================== knowledge_docs ====================

export async function fetchSystemDocsForUnifiedTree(supabase: SupabaseClient) {
  return supabase
    .from('knowledge_docs')
    .select('id, title, path, tags, source_type, word_count, created_at, updated_at')
    .order('path', { ascending: true })
    .limit(500);
}

export async function fetchSystemDocById(supabase: SupabaseClient, id: string) {
  return supabase
    .from('knowledge_docs')
    .select('id, title, path, content, tags, source_type, word_count, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
}
