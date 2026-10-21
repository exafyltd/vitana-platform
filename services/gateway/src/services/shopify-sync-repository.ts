// impact-allow-no-test: pure data-access seam (thin Supabase upsert
// wrappers, no independent request-handling behavior). Coverage note:
// test/routes/shopify-sync.test.ts only exercises the pure helper
// functions (toEurCents, deterministicUuid, mapShopifyProduct, etc.) —
// syncShopifyCatalog itself, which owns these two call sites, is not
// exercised — zero genuine coverage today.
/**
 * services/shopify-sync.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in shopify-sync.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * upserts, same onConflict options, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param — the source
 * already declared its client param as `any`, so this preserves that).
 */

export async function upsertShopifyMerchant(sb: any, row: Record<string, unknown>) {
  return sb.from('merchants').upsert(row, { onConflict: 'id' });
}

export async function upsertShopifyProductsChunk(sb: any, chunk: Record<string, unknown>[]) {
  return sb.from('products').upsert(chunk, { onConflict: 'id' });
}
