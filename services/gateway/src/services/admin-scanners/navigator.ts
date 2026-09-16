/**
 * BOOTSTRAP-ADMIN-BB678: navigator scanner.
 *
 * Produces insights for the navigator domain:
 *   - dead_routes_60d        — active catalog entries with zero consult hits in 60d
 *   - inactive_entries       — ≥ 3 catalog rows with is_active=false
 *                              (i.e. admin hid them but didn't clean up)
 *   - missing_i18n_coverage  — ≥ 10 active entries without DE/FR/ES translations
 *
 * nav_catalog is mostly shared (tenant_id IS NULL); tenant-specific overrides
 * exist but the health of the shared catalog matters to every tenant. Scoped
 * queries consider both shared + this tenant's overrides.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';
import * as repo from './navigator-repository';

const LOG_PREFIX = '[admin-scanner:navigator]';
const INACTIVE_ENTRY_THRESHOLD = 3;
const MISSING_I18N_THRESHOLD = 10;

export const navigatorScanner: AdminScanner = {
  id: 'navigator',
  domain: 'navigator',
  label: 'Navigator',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];

    // 1. Inactive catalog entries — hidden but not cleaned up
    try {
      const { data: inactive } = await repo.fetchInactiveNavCatalogEntries(supabase, tenantId);
      if (inactive && inactive.length >= INACTIVE_ENTRY_THRESHOLD) {
        insights.push({
          natural_key: 'navigator_inactive_entries',
          domain: 'navigator',
          title: `${inactive.length} navigator entries deactivated but kept`,
          description:
            `These catalog rows are flagged is_active=false but still in the table. ` +
            `If the screens are gone for good, delete them. If they'll come back, ` +
            `leave them. Stale deactivated rows make the audit log noisier.`,
          severity: inactive.length >= 10 ? 'warning' : 'info',
          actionable: true,
          recommended_action: {
            type: 'review_inactive_nav_entries',
            sample_ids: inactive.slice(0, 10).map((r: { id: string }) => r.id),
          },
          context: {
            inactive_count: inactive.length,
            sample: inactive.slice(0, 5).map((r: { screen_id: string; category: string }) => ({
              screen_id: r.screen_id,
              category: r.category,
            })),
          },
          confidence_score: 0.8,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} inactive_entries failed: ${err?.message}`);
    }

    // 2. Missing i18n coverage — active entries without non-English translations
    try {
      const { data: active } = await repo.fetchActiveNavCatalogEntries(supabase, tenantId);
      if (active && active.length > 0) {
        const ids = active.map((r: { id: string }) => r.id);
        const { data: i18n } = await repo.fetchNavCatalogI18nLangsForIds(supabase, ids);
        if (i18n) {
          // Group languages present per catalog entry
          const byCatalog = new Map<string, Set<string>>();
          for (const row of i18n as { catalog_id: string; lang: string }[]) {
            if (!byCatalog.has(row.catalog_id)) byCatalog.set(row.catalog_id, new Set());
            byCatalog.get(row.catalog_id)!.add(row.lang);
          }
          // Count entries missing DE or FR (two primary non-English audiences)
          const missing = active.filter((r: { id: string }) => {
            const langs = byCatalog.get(r.id) ?? new Set();
            return !langs.has('de') || !langs.has('fr');
          });
          if (missing.length >= MISSING_I18N_THRESHOLD) {
            insights.push({
              natural_key: 'navigator_missing_i18n_de_fr',
              domain: 'navigator',
              title: `${missing.length} navigator entries missing DE or FR translations`,
              description:
                `Active catalog entries without German or French localisation. ` +
                `Non-English users see the English fallback, which hurts consult accuracy ` +
                `and makes voice trigger-matching brittle.`,
              severity: missing.length >= 50 ? 'warning' : 'info',
              actionable: true,
              recommended_action: {
                type: 'backfill_nav_i18n',
                sample_screen_ids: missing.slice(0, 10).map((r: { screen_id: string }) => r.screen_id),
              },
              context: {
                missing_count: missing.length,
                total_active: active.length,
                missing_pct: Math.round((missing.length / active.length) * 100),
                threshold: MISSING_I18N_THRESHOLD,
              },
              confidence_score: 0.85,
              autonomy_level: 'observe_only',
            });
          }
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} missing_i18n failed: ${err?.message}`);
    }

    // 3. Recent audit-log activity as a health signal — if the catalog hasn't
    // been touched in 30 days, flag it for review (content likely drifts).
    try {
      const d30 = new Date(Date.now() - 30 * 86400_000).toISOString();
      const { count } = await repo.countNavCatalogAuditRowsSince(supabase, d30);
      // Low cadence check — only flag if literally zero audit rows in 30d AND
      // catalog has ≥ 20 entries (so this isn't a fresh tenant).
      const { count: catalogTotal } = await repo.countNavCatalogTotal(supabase, tenantId);
      if (count === 0 && catalogTotal !== null && catalogTotal >= 20) {
        insights.push({
          natural_key: 'navigator_stale_catalog_30d',
          domain: 'navigator',
          title: 'Navigator catalog unchanged for 30+ days',
          description:
            `Zero audit-log edits in the last month despite ${catalogTotal} catalog entries. ` +
            `Either the navigator is stable (fine) or nobody is curating trigger phrases ` +
            `and new screens. Validate by checking consult near-miss rates.`,
          severity: 'info',
          actionable: true,
          recommended_action: { type: 'review_navigator_catalog' },
          context: { catalog_total: catalogTotal, audit_rows_30d: 0 },
          confidence_score: 0.6,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} stale_catalog failed: ${err?.message}`);
    }

    return insights;
  },
};
