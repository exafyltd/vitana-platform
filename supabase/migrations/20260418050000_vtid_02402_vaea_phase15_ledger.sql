-- Migration: 20260418050000_vtid_02402_vaea_phase15_ledger.sql
-- Purpose: VTID-02402 Phase 1.5 — register the VTID in the ledger so EXEC-DEPLOY's
--          VTID-0542 hard gate (`gateway/api/v1/vtid/:vtid` must resolve) passes.
--          Phase 1.5 is backend-only (Gateway routes under /api/v1/vaea) so there
--          are no schema changes — this migration exists solely to register the VTID.

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
) VALUES (
  'VTID-02402', 'PLATFORM', 'VAEA', 'in_progress',
  'VAEA Phase 1.5 — /api/v1/vaea read + CRUD routes',
  'Gateway routes that expose Phase 0/1 VAEA tables (config, catalog, channels, detected_questions, drafts) to a future Business Hub panel. All routes tenant-scoped via requireAuth middleware; writes validated server-side against enum whitelists.',
  'Backend API surface for the Business Hub VAEA panel. No new tables. No external posting. No mesh. Read-first with minimal CRUD on user-owned entities.',
  'ECONOMIC_ACTOR',
  'api_surface',
  'platform',
  jsonb_build_object(
    'phase', 1.5,
    'service', 'gateway',
    'mount', '/api/v1/vaea',
    'routes', jsonb_build_array(
      'GET /summary',
      'GET/PUT /config',
      'GET/POST/PATCH/DELETE /catalog',
      'GET/POST/PATCH/DELETE /channels',
      'GET /detected-questions',
      'GET /drafts',
      'POST /drafts/:id/dismiss'
    )
  ),
  NOW(), NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  summary = EXCLUDED.summary,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
