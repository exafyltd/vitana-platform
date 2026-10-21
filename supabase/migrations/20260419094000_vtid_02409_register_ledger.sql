-- Migration: 20260419094000_vtid_02409_register_ledger.sql
-- Purpose: Register VTID-02409 in vtid_ledger so the EXEC-DEPLOY
--          VTID-0541/0542 HARD GATE passes for the Assistant Speeches deploy.

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
)
VALUES (
  'VTID-02409',
  'PLATFORM',
  'ADMIN',
  'in_progress',
  'Assistant Speeches admin — manage Vitana speech across user journey phases',
  'Adds an admin-editable registry of named user-journey speeches (pre_login_intro, post_login_onboarding, general_onboarding, proactive_guidance_character) under /admin/assistant/speeches. Backend: services/gateway/src/services/assistant-speeches/{registry,service}.ts, routes/tenant-admin/assistant-speeches.ts, migration tenant_assistant_speeches. Frontend: pages/admin/assistant/Speeches.tsx, hooks/useAdminAssistantSpeeches.ts, admin-navigation tab.',
  'Admin screen to manage user-journey speeches.',
  'PLATFORM',
  'ADMIN',
  'claude-code',
  jsonb_build_object('source','retroactive_migration','registered_at',NOW(),'phase',1),
  NOW(),
  NOW()
)
ON CONFLICT (vtid) DO UPDATE
  SET updated_at = NOW(),
      status = EXCLUDED.status,
      description = EXCLUDED.description;
