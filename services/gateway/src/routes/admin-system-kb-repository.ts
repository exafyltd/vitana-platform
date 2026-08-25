// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/admin-system-kb.ts — zero coverage today.
/**
 * routes/admin-system-kb.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in admin-system-kb.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `buildKnowledgeDocsListQuery` preserves the source's conditional
 * path_prefix/tag/q filter chain.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchKnowledgeDocsList(
  sb: SupabaseClient,
  args: { pathPrefix?: string; tag?: string; q?: string },
) {
  let query = sb
    .from('knowledge_docs')
    .select('id, title, path, tags, word_count, source_type, created_at, updated_at')
    .order('path', { ascending: true });

  if (args.pathPrefix) {
    query = query.like('path', `${args.pathPrefix}%`);
  }
  if (args.tag) {
    query = query.contains('tags', [args.tag]);
  }
  if (args.q) {
    query = query.or(`title.ilike.%${args.q}%,path.ilike.%${args.q}%`);
  }

  return query.limit(500);
}

export async function fetchKnowledgeDocById(sb: SupabaseClient, id: string) {
  return sb
    .from('knowledge_docs')
    .select('id, title, path, content, tags, source_type, word_count, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
}

export async function updateKnowledgeDoc(sb: SupabaseClient, id: string, updates: Record<string, unknown>) {
  return sb
    .from('knowledge_docs')
    .update(updates)
    .eq('id', id)
    .select('id, title, path, content, tags, word_count, source_type, created_at, updated_at')
    .maybeSingle();
}

export async function updateBaselineKbDocument(sb: SupabaseClient, id: string, updates: Record<string, unknown>) {
  return sb
    .from('kb_documents')
    .update(updates)
    .eq('id', id)
    .is('tenant_id', null) // enforce baseline scope
    .select('*')
    .maybeSingle();
}
