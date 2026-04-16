-- Migration: 20260416130000_vtid_02000_register_ledger.sql
-- Purpose: Register VTID-02000 in vtid_ledger so the EXEC-DEPLOY VTID gate
--          can verify its existence. The allocator API auto-increments from
--          ~VTID-01923 onward, so we could not allocate VTID-02000 normally.
--          This migration retroactively registers the VTID referenced across
--          the marketplace foundation code.

INSERT INTO public.vtid_ledger (
  vtid,
  layer,
  module,
  status,
  title,
  description,
  summary,
  task_family,
  task_type,
  assigned_to,
  metadata,
  created_at,
  updated_at
)
VALUES (
  'VTID-02000',
  'PLATFORM',
  'MARKETPLACE',
  'in_progress',
  'Marketplace Foundation — Discover + Ingestion + Brain-Wiring',
  'Phase 0 foundation for the Discover marketplace: catalog schema (merchants + products with geo + health metadata), ingestion API for Claude Code scraping agents, brain-wiring primitives (user-health-context, limitations-filter, condition-matcher, feed-ranker), lifecycle-aware search + feed, autonomous marketplace analyzer as 8th analyzer, Maxina tenant admin surface, and the committed reward-system OASIS event contract.',
  'Marketplace foundation: data model + ingestion + search/feed + admin + brain wiring + reward-prep.',
  'PLATFORM',
  'MARKETPLACE',
  'claude-code',
  jsonb_build_object(
    'source', 'retroactive_migration',
    'registered_at', NOW(),
    'allocator_version', 'migration-20260416130000'
  ),
  NOW(),
  NOW()
)
ON CONFLICT (vtid) DO UPDATE
  SET updated_at = NOW();
