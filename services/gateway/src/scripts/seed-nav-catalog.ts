/**
 * VTID-NAV-02: Seed nav_catalog from the static NAVIGATION_CATALOG constant.
 *
 * Idempotent — safe to re-run. Upserts every entry (tenant_id = NULL shared)
 * so environments can transition from the compile-time catalog to the
 * DB-backed admin UI without losing any screen. Run once after the
 * migration is applied.
 *
 * Usage (from services/gateway):
 *   npx ts-node src/scripts/seed-nav-catalog.ts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE env vars (same as the
 * gateway itself).
 */

import { NAVIGATION_CATALOG } from '../lib/navigation-catalog';
import { getSupabase } from '../lib/supabase';

async function main() {
  const supabase = getSupabase();
  if (!supabase) {
    console.error('[seed-nav-catalog] Supabase client unavailable — check SUPABASE_URL + SUPABASE_SERVICE_ROLE');
    process.exit(1);
  }

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const entry of NAVIGATION_CATALOG) {
    try {
      // 1. Upsert the main row (shared catalog — tenant_id NULL).
      const { data: existing } = await supabase
        .from('nav_catalog')
        .select('id')
        .eq('screen_id', entry.screen_id)
        .is('tenant_id', null)
        .maybeSingle();

      let catalogId: string;
      if (existing) {
        const { error: updErr } = await supabase
          .from('nav_catalog')
          .update({
            route: entry.route,
            category: entry.category,
            access: entry.access,
            anonymous_safe: !!entry.anonymous_safe,
            priority: entry.priority || 0,
            related_kb_topics: entry.related_kb_topics || [],
            context_rules: {},
            override_triggers: [],
            is_active: true,
          })
          .eq('id', existing.id);
        if (updErr) throw updErr;
        catalogId = existing.id;
        updated++;
      } else {
        const { data: created_row, error: insErr } = await supabase
          .from('nav_catalog')
          .insert({
            screen_id: entry.screen_id,
            tenant_id: null,
            route: entry.route,
            category: entry.category,
            access: entry.access,
            anonymous_safe: !!entry.anonymous_safe,
            priority: entry.priority || 0,
            related_kb_topics: entry.related_kb_topics || [],
            context_rules: {},
            override_triggers: [],
            is_active: true,
          })
          .select('id')
          .single();
        if (insErr) throw insErr;
        catalogId = created_row!.id;
        created++;
      }

      // 2. Upsert i18n rows for each curated language.
      const i18nRows = Object.entries(entry.i18n).map(([lang, c]) => ({
        catalog_id: catalogId,
        lang,
        title: c.title,
        description: c.description,
        when_to_visit: c.when_to_visit,
      }));
      if (i18nRows.length > 0) {
        const { error: i18nErr } = await supabase
          .from('nav_catalog_i18n')
          .upsert(i18nRows, { onConflict: 'catalog_id,lang' });
        if (i18nErr) throw i18nErr;
      }
    } catch (err: any) {
      failed++;
      console.warn(`[seed-nav-catalog] ${entry.screen_id}: ${err.message || err}`);
    }
  }

  console.log(
    `[seed-nav-catalog] done: created=${created} updated=${updated} failed=${failed} total=${NAVIGATION_CATALOG.length}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[seed-nav-catalog] fatal:', err);
  process.exit(1);
});
