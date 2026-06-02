-- BOOTSTRAP-35DAY-TRACKER follow-up: supersede the stale Day-1 seed.
--
-- The original seed (20260606010000) recorded attempt 1 — Vertex CustomJob
-- 3852431990582149120 in state SUBMITTED. That attempt FAILED: NumPy 2.x got
-- dragged into the trainer venv and broke the container's torch 2.3
-- (`import torch` -> "PyTorch not found"). The numpy<2 trainer fix shipped in
-- PR #2545, and attempt 2 — Vertex CustomJob 3932080612898242560 — was
-- resubmitted on A100 with the fixed v0.1.2 trainer tarball.
--
-- /api/v1/training/status reads the DB row in preference to the code's embedded
-- bootstrap snapshot, so without this a FRESH or re-migrated deployment would
-- keep showing attempt 1 on the System Overview Training section. This UPDATE is
-- idempotent and keyed on the cycle, so it converges both fresh environments
-- (seeded by the migration above, then updated here) and already-migrated ones
-- onto the current truth.

UPDATE training_cycles
SET training_job_id      = '3932080612898242560',
    training_job_state   = 'JOB_STATE_PENDING',
    training_job_updated_at = TIMESTAMPTZ '2026-06-02T18:13:19Z',
    notes = 'Synthetic GPU smoke (A100 a2-highgpu-1g / us-central1, Qwen2.5-0.5B, 6000 synthetic rows). '
         || 'Attempt 1 (job 3852431990582149120) FAILED: NumPy 2.x dragged into trainer venv broke container torch 2.3 '
         || '(import torch -> "PyTorch not found"). Fix merged (PR #2545): setup.py v0.1.2 pins numpy<2 + bounds '
         || 'transformers/datasets/peft/accelerate to torch-2.3-era; train.py prints a torch/numpy/transformers env banner. '
         || 'Attempt 2 (job 3932080612898242560) submitted on A100 with the fixed v0.1.2 trainer tarball.',
    updated_at = now()
WHERE label = '35-Day Training' AND start_date = DATE '2026-06-02';

UPDATE training_cycle_days d
SET status = 'running',
    initiated = '[
      {"label":"Merged 24 PRs to main (R0-R9 ORB recovery + 35-day Wave-0 + Training tracker)","status":"done"},
      {"label":"Deployed gateway to production (/alive green)","status":"done"},
      {"label":"Attempt 1 - Vertex CustomJob 3852431990582149120 (A100, Qwen2.5-0.5B): FAILED - NumPy 2.x broke container torch 2.3 (import torch: PyTorch not found)","status":"failure"},
      {"label":"Trainer fix merged to main (PR #2545): setup.py v0.1.2 pins numpy<2 + bounds transformers/datasets/peft/accelerate; train.py prints torch/numpy/transformers env banner","status":"done"},
      {"label":"Attempt 2 SUBMITTED - Vertex CustomJob 3932080612898242560 (A100 a2-highgpu-1g, us-central1, Qwen2.5-0.5B, 6000 synthetic rows, dataset preflight OK) with fixed v0.1.2 trainer tarball","status":"running"}
    ]'::jsonb,
    updated_at = now()
FROM training_cycles c
WHERE d.cycle_id = c.id
  AND c.label = '35-Day Training' AND c.start_date = DATE '2026-06-02'
  AND d.day_number = 1;
