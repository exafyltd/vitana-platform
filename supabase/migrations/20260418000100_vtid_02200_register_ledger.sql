-- Migration: 20260418000100_vtid_02200_register_ledger.sql
-- Purpose: Register VTID-02200 in vtid_ledger so EXEC-DEPLOY VTID-0542 gate
--          passes when Phase 2 merges.

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
)
VALUES (
  'VTID-02200',
  'PLATFORM',
  'MARKETPLACE',
  'in_progress',
  'Phase 2 — Multi-source marketplace sync (Shopify + CJ)',
  'Phase 2 backend: Shopify Storefront GraphQL multi-shop sync, CJ Affiliate Product Search API, unified upsert to products table via content_hash deduplication, marketplace_sources_config table for admin-managed per-source config, daily 3 AM UTC scheduler hook, manual admin trigger route /api/v1/admin/marketplace/sync/:network.',
  'Phase 2 marketplace sync: Shopify + CJ → products table.',
  'PLATFORM',
  'MARKETPLACE',
  'claude-code',
  jsonb_build_object('source','retroactive_migration','registered_at',NOW(),'phase',2),
  NOW(),
  NOW()
)
ON CONFLICT (vtid) DO UPDATE
  SET updated_at = NOW(),
      status = EXCLUDED.status,
      description = EXCLUDED.description;
