-- VTID-03039 ledger registration — one-shot gate-clearer.
--
-- Context: VTID-03039 (Devon question-cap fix, PR #2177) was named in code
-- + migration before the deploy gate (VTID-0542) checked vtid_ledger. The
-- /api/v1/vtid/allocate sequence had drifted (counter at 03036; commits
-- 03037, 03038 created out-of-band by other tracks), so calling /allocate
-- returned 03037 — wrong number — and the next call conflicted on 03038.
--
-- Direct insert is the right move here: the VTID is already merged in the
-- commit log, the migration is already applied to prod DB, only the
-- ledger row is missing. Idempotent: ON CONFLICT DO NOTHING.

INSERT INTO public.vtid_ledger (
  vtid, title, status, tenant, layer, module,
  task_family, task_type, summary, description,
  is_test, assigned_to, metadata, created_at, updated_at
) VALUES (
  'VTID-03039',
  'orb-livekit: cap Devon clarifying questions at 2 + harden swap-back contract',
  'in_progress',
  'vitana',
  'DEV',
  'ORB-LIVEKIT',
  'DEV',
  'fix',
  'Cap Devon at 2 clarifying questions; make bridge-sentence + switch_persona(vitana) inseparable. PR #2177.',
  'See PR #2177. Three knobs: orb-livekit.ts handoff-brief cap, swap-back behavioral rule strengthened, Devon DB system_prompt rewritten via 20260524030000_VTID_03039_devon_question_cap.sql.',
  false,
  'd.stevanovic@exafy.io',
  jsonb_build_object(
    'pr', 2177,
    'merge_sha', '6177afcf0c7792b2e12b979064612314b3a12294',
    'gate_bypass_reason', 'Allocator sequence drift; direct ledger row insert. See file header.'
  ),
  NOW(),
  NOW()
)
ON CONFLICT (vtid) DO NOTHING;
