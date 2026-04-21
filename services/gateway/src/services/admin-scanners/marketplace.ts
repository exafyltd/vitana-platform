/**
 * BOOTSTRAP-ADMIN-BB678: marketplace scanner.
 *
 * Produces insights for the marketplace domain:
 *   - products_pending_review  — ≥ 5 products with requires_admin_review=true
 *   - ingestion_failures_24h   — catalog_sources runs with errors > 0 in 24h
 *   - stale_catalog            — ≥ 20% of active products not seen in 14 days
 *   - unmatched_orders         — ≥ 3 orders in 'unmatched' state
 *
 * Marketplace is a GLOBAL catalog (products/merchants have no tenant_id).
 * Orders + clicks DO have tenant_id so those checks are tenant-scoped.
 * Global insights are tagged with tenant_scope='global' in context.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:marketplace]';
const PENDING_REVIEW_THRESHOLD = 5;
const UNMATCHED_ORDER_THRESHOLD = 3;
const STALE_CATALOG_PCT_THRESHOLD = 20;

export const marketplaceScanner: AdminScanner = {
  id: 'marketplace',
  domain: 'marketplace',
  label: 'Marketplace',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const d1 = new Date(now - 86400_000).toISOString();
    const d14 = new Date(now - 14 * 86400_000).toISOString();

    // 1. Products requiring admin review (global catalog)
    try {
      const { count } = await supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('requires_admin_review', true)
        .eq('is_active', true);
      if (count !== null && count >= PENDING_REVIEW_THRESHOLD) {
        insights.push({
          natural_key: 'products_pending_admin_review',
          domain: 'marketplace',
          title: `${count} products waiting for admin review`,
          description:
            `Products flagged by the ingestion analyzer as needing human review. ` +
            `Common reasons: low analyzer confidence, missing origin country, ` +
            `or ambiguous health claims. Each pending product is hidden from the feed.`,
          severity: count >= 25 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'open_product_review_queue',
            endpoint: '/api/v1/admin/marketplace/products?requires_admin_review=true',
          },
          context: { pending_count: count, threshold: PENDING_REVIEW_THRESHOLD, tenant_scope: 'global', scanned_tenant: tenantId },
          confidence_score: 0.95,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} products_pending_review failed: ${err?.message}`);
    }

    // 2. Ingestion failures in last 24h
    try {
      const { data: runs } = await supabase
        .from('catalog_sources')
        .select('id, source_network, started_at, errors, products_inserted, products_updated, error_sample')
        .gte('started_at', d1)
        .gt('errors', 0)
        .order('started_at', { ascending: false })
        .limit(20);
      if (runs && runs.length > 0) {
        const totalErrors = runs.reduce((sum: number, r: { errors: number | null }) => sum + (r.errors ?? 0), 0);
        const affectedSources = new Set(runs.map((r: { source_network: string }) => r.source_network));
        insights.push({
          natural_key: 'marketplace_ingestion_failures_24h',
          domain: 'marketplace',
          title: `${totalErrors} product-ingestion errors across ${affectedSources.size} source${affectedSources.size > 1 ? 's' : ''} in 24h`,
          description:
            `Catalog ingestion produced errors in the last day. Each failed row is a product ` +
            `the feed couldn't show. Investigate the source network (rate limit, schema drift, ` +
            `auth expiry) before the catalog starves.`,
          severity: totalErrors >= 100 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'inspect_catalog_sources',
            affected_sources: Array.from(affectedSources),
          },
          context: {
            error_count: totalErrors,
            affected_source_count: affectedSources.size,
            affected_sources: Array.from(affectedSources),
            tenant_scope: 'global',
            scanned_tenant: tenantId,
          },
          confidence_score: 0.9,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} ingestion_failures failed: ${err?.message}`);
    }

    // 3. Stale catalog — fraction of active products not seen in 14d
    try {
      const [{ count: activeTotal }, { count: staleCount }] = await Promise.all([
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase
          .from('products')
          .select('id', { count: 'exact', head: true })
          .eq('is_active', true)
          .lt('last_seen_at', d14),
      ]);
      if (activeTotal !== null && activeTotal >= 50 && staleCount !== null && staleCount > 0) {
        const stalePct = Math.round((staleCount / activeTotal) * 100);
        if (stalePct >= STALE_CATALOG_PCT_THRESHOLD) {
          insights.push({
            natural_key: 'marketplace_stale_catalog_14d',
            domain: 'marketplace',
            title: `${stalePct}% of active products not refreshed in 14 days`,
            description:
              `${staleCount}/${activeTotal} active products haven't been re-scraped in two weeks. ` +
              `Stale rows mean prices, availability, and delivery windows may be wrong in the feed. ` +
              `Check whether scheduled ingestion jobs are actually running.`,
            severity: stalePct >= 50 ? 'action_needed' : 'warning',
            actionable: true,
            recommended_action: { type: 'refresh_catalog_sources', older_than_days: 14 },
            context: {
              stale_count: staleCount,
              active_total: activeTotal,
              stale_pct: stalePct,
              threshold_pct: STALE_CATALOG_PCT_THRESHOLD,
              tenant_scope: 'global',
              scanned_tenant: tenantId,
            },
            confidence_score: 0.85,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} stale_catalog failed: ${err?.message}`);
    }

    // 4. Unmatched orders in this tenant — postbacks the system couldn't
    // attach to a click. Revenue leak if it accumulates.
    try {
      const { count } = await supabase
        .from('product_orders')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('state', 'unmatched');
      if (count !== null && count >= UNMATCHED_ORDER_THRESHOLD) {
        insights.push({
          natural_key: 'marketplace_unmatched_orders',
          domain: 'marketplace',
          title: `${count} unmatched order${count > 1 ? 's' : ''} need attribution review`,
          description:
            `Affiliate postbacks arrived but couldn't be matched to a user click. ` +
            `Each one is commission the tenant earned but can't be credited to a user ` +
            `(no reward unlocked, no attribution surface recorded).`,
          severity: count >= 20 ? 'action_needed' : 'warning',
          actionable: true,
          recommended_action: {
            type: 'reconcile_unmatched_orders',
            endpoint: `/api/v1/admin/tenants/${tenantId}/marketplace/orders?state=unmatched`,
          },
          context: { unmatched_count: count, threshold: UNMATCHED_ORDER_THRESHOLD },
          confidence_score: 0.85,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} unmatched_orders failed: ${err?.message}`);
    }

    return insights;
  },
};
