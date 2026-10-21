-- Migration: 20260417000200_vtid_02100_register_ledger.sql
-- Purpose: Register VTID-02100 in vtid_ledger so the EXEC-DEPLOY VTID-0542
--          hard gate passes when Phase 1 merges (allocator API auto-increments
--          and can't be asked for a specific VTID — same issue as VTID-02000).

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
)
VALUES (
  'VTID-02100',
  'PLATFORM',
  'CONNECTORS',
  'in_progress',
  'Phase 1 — Connector framework + Terra wearable aggregator + wearable analyzer',
  'Phase 1 backend substrate: connector framework (types/registry/runtime), Terra aggregator connector (widget + HMAC webhook), user_connections + wearable_daily_metrics + wearable_rollup_7d view, wearable-analyzer (9th analyzer — sleep/HRV/activity classification), get_wearable_metrics assistant tool, context-pack-builder wearable_summary_7d injection. Deferred: Terra credentials + companion iOS Swift app + frontend wearable UI.',
  'Phase 1 wearables infrastructure: connector framework + Terra + analyzer + context.',
  'PLATFORM',
  'CONNECTORS',
  'claude-code',
  jsonb_build_object(
    'source', 'retroactive_migration',
    'registered_at', NOW(),
    'allocator_version', 'migration-20260417000200',
    'phase', 1
  ),
  NOW(),
  NOW()
)
ON CONFLICT (vtid) DO UPDATE
  SET updated_at = NOW(),
      status = EXCLUDED.status,
      description = EXCLUDED.description;
