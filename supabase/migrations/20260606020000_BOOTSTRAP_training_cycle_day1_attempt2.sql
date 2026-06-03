-- BOOTSTRAP-35DAY-TRACKER follow-up: supersede the stale Day-1 seed.
--
-- The original seed (20260606010000) recorded attempt 1 — Vertex CustomJob
-- 3852431990582149120 in state SUBMITTED. Day-1 then played out as a sequence of
-- two distinct, diagnosed trainer failures (each fixed), so /api/v1/training/status
-- — which reads the DB row in preference to the code's embedded bootstrap snapshot
-- — must reflect the current truth or a fresh/re-migrated deployment would keep
-- showing attempt 1. This UPDATE is idempotent and keyed on the cycle, so it
-- converges both fresh and already-migrated environments.
--
-- Day-1 trail:
--   * Attempt 1 (3852431990582149120): FAILED at `import torch` — NumPy 2.x
--     dragged into the trainer venv vs the container's torch 2.3.
--   * Fix #2545 (trainer v0.1.2): pin numpy<2 + bound deps. Training then COMPLETED.
--   * Attempt 2 (3932080612898242560, A100): trained end-to-end but FAILED at the
--     adapter save — safetensors tripped on Qwen2.5's tied embeddings/LM-head.
--   * Save fix (trainer v0.1.3): save_pretrained(safe_serialization=False).
--     Attempt 3 is the artifact-producing resubmit.

UPDATE training_cycles
SET training_job_id      = '3932080612898242560',
    training_job_state   = 'JOB_STATE_FAILED',
    training_job_updated_at = now(),
    notes = 'Synthetic GPU smoke (A100 a2-highgpu-1g / us-central1, Qwen2.5-0.5B, 6000 rows). '
         || 'Attempt 1 (3852431990582149120) FAILED at import torch (NumPy 2.x vs container torch 2.3). '
         || 'Fix #2545 (trainer v0.1.2 numpy<2) let training COMPLETE. '
         || 'Attempt 2 (3932080612898242560) trained end-to-end but FAILED at adapter save: safetensors tripped '
         || 'on Qwen2.5 tied embeddings/LM-head. Save fix (trainer v0.1.3, save_pretrained safe_serialization=False) '
         || 'prepared; attempt 3 is the artifact-producing resubmit.',
    updated_at = now()
WHERE label = '35-Day Training' AND start_date = DATE '2026-06-02';

UPDATE training_cycle_days d
SET status = 'running',
    initiated = '[
      {"label":"Merged 24 PRs to main (R0-R9 ORB recovery + 35-day Wave-0 + Training tracker)","status":"done"},
      {"label":"Deployed gateway to production (/alive green)","status":"done"},
      {"label":"Attempt 1 (job 3852431990582149120): FAILED at import torch - NumPy 2.x vs container torch 2.3","status":"failure"},
      {"label":"Trainer fix #2545 (setup.py v0.1.2): pin numpy<2 + bound deps + startup env banner","status":"done"},
      {"label":"Attempt 2 (job 3932080612898242560, A100): training COMPLETED but FAILED at adapter save - safetensors tripped on Qwen2.5 tied weights. Confirms the numpy fix works end-to-end.","status":"failure"},
      {"label":"Save fix v0.1.3: PEFT save_pretrained(safe_serialization=False). Attempt 3 resubmit pending PR merge.","status":"running"}
    ]'::jsonb,
    updated_at = now()
FROM training_cycles c
WHERE d.cycle_id = c.id
  AND c.label = '35-Day Training' AND c.start_date = DATE '2026-06-02'
  AND d.day_number = 1;
