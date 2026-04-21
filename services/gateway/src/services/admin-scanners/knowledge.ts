/**
 * BOOTSTRAP-ADMIN-BB678: knowledge scanner.
 *
 * Produces insights for the knowledge domain:
 *   - kb_docs_pending_review  — ≥ 3 kb_documents in status='pending'
 *   - kb_docs_failed          — ≥ 1 kb_documents in status='failed'
 *   - kb_empty                — tenant has zero kb_documents and not fully
 *                               opted out of the global baseline
 *
 * Reads kb_documents (tenant-scoped) + tenant_kb_baseline_optouts.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:knowledge]';
const PENDING_REVIEW_THRESHOLD = 3;

export const knowledgeScanner: AdminScanner = {
  id: 'knowledge',
  domain: 'knowledge',
  label: 'Knowledge Hub',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];

    // 1. Pending KB docs for this tenant
    try {
      const { count } = await supabase
        .from('kb_documents')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'pending');
      if (count !== null && count >= PENDING_REVIEW_THRESHOLD) {
        insights.push({
          natural_key: 'kb_docs_pending_review',
          domain: 'knowledge',
          title: `${count} knowledge document${count > 1 ? 's' : ''} waiting to be indexed`,
          description:
            `KB documents in 'pending' status haven't been embedded yet, so they don't ` +
            `show up in search or retrieval. A small backlog is normal; a persistent one ` +
            `usually means the indexing job has stalled or the embedding provider is erroring.`,
          severity: count >= 10 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'trigger_kb_reindex',
            endpoint: `/api/v1/admin/tenants/${tenantId}/kb/documents?status=pending`,
          },
          context: { pending_count: count, threshold: PENDING_REVIEW_THRESHOLD },
          confidence_score: 0.9,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} kb_docs_pending failed: ${err?.message}`);
    }

    // 2. Failed indexing
    try {
      const { data: failed } = await supabase
        .from('kb_documents')
        .select('id, title, updated_at')
        .eq('tenant_id', tenantId)
        .eq('status', 'failed')
        .order('updated_at', { ascending: false })
        .limit(20);
      if (failed && failed.length > 0) {
        insights.push({
          natural_key: 'kb_docs_failed_indexing',
          domain: 'knowledge',
          title: `${failed.length} knowledge document${failed.length > 1 ? 's' : ''} failed to index`,
          description:
            `Each failed doc is silently missing from retrieval. Usually caused by ` +
            `embedding-API errors, unreadable content, or encoding issues. Re-try after ` +
            `checking the doc bodies.`,
          severity: failed.length >= 5 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'retry_kb_indexing',
            document_ids: failed.map((d: { id: string }) => d.id).slice(0, 20),
          },
          context: {
            failed_count: failed.length,
            sample: failed.slice(0, 5).map((d: { id: string; title: string; updated_at: string }) => ({
              id: d.id,
              title: d.title,
              updated_at: d.updated_at,
            })),
          },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} kb_docs_failed failed: ${err?.message}`);
    }

    // 3. Empty knowledge base — tenant has zero docs AND hasn't explicitly
    // opted out of most of the global baseline. That usually means they
    // haven't set anything up at all.
    try {
      const [{ count: tenantDocs }, { count: optouts }, { count: baselineTotal }] = await Promise.all([
        supabase
          .from('kb_documents')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId),
        supabase
          .from('tenant_kb_baseline_optouts')
          .select('document_id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId),
        supabase
          .from('kb_documents')
          .select('id', { count: 'exact', head: true })
          .is('tenant_id', null),
      ]);
      const hasOwnDocs = (tenantDocs ?? 0) > 0;
      const hasBaseline = (baselineTotal ?? 0) > 0;
      const optedOutOfAll = hasBaseline && (optouts ?? 0) >= (baselineTotal ?? 0);
      if (!hasOwnDocs && (!hasBaseline || optedOutOfAll)) {
        insights.push({
          natural_key: 'kb_empty',
          domain: 'knowledge',
          title: hasBaseline ? 'Knowledge Hub is empty — all baseline docs opted out' : 'Knowledge Hub is empty',
          description:
            hasBaseline
              ? `This tenant has no custom KB docs and has opted out of the full baseline. ` +
                `The assistant will have very little to cite. Either restore some baseline ` +
                `docs or upload tenant-specific knowledge.`
              : `No custom KB documents AND no global baseline available. The assistant will ` +
                `rely only on general model knowledge — tenant-specific answers won't work.`,
          severity: 'warning',
          actionable: true,
          recommended_action: {
            type: 'seed_knowledge_hub',
            endpoint: `/api/v1/admin/tenants/${tenantId}/kb/documents`,
          },
          context: {
            tenant_docs: tenantDocs ?? 0,
            baseline_total: baselineTotal ?? 0,
            optouts: optouts ?? 0,
          },
          confidence_score: 0.9,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} kb_empty failed: ${err?.message}`);
    }

    return insights;
  },
};
