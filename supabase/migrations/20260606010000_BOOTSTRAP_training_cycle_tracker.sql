-- BOOTSTRAP-35DAY-TRACKER: Training cycle tracker
-- Backs the "Training" section on the Command Hub System Overview page.
-- Generic by design: one row per training cycle (35-day now, 30/60/90-day
-- later) and one row per day with the goal set that morning and the verified
-- outcome at end of day.

CREATE TABLE IF NOT EXISTS training_cycles (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label                   TEXT NOT NULL,                 -- e.g. "35-Day Training"
  length_days             INT  NOT NULL,
  start_date              DATE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active', -- active | completed | aborted
  training_job_id         TEXT,                          -- Vertex CustomJob id for the cycle
  training_job_state      TEXT,                          -- last recorded job state
  training_job_updated_at TIMESTAMPTZ,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_cycle_days (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    UUID NOT NULL REFERENCES training_cycles(id) ON DELETE CASCADE,
  day_number  INT  NOT NULL,                 -- 1-based within the cycle
  day_date    DATE NOT NULL,
  goal        TEXT,                          -- set each morning by the operator
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | running | success | failure | partial
  outcome     TEXT,                          -- verified result at end of day
  evidence    TEXT,                          -- proof (job state, deploy rev, metrics)
  initiated   JSONB,                         -- [{ label, status, detail }]
  set_by      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, day_number)
);

CREATE INDEX IF NOT EXISTS idx_training_cycle_days_cycle ON training_cycle_days(cycle_id);
CREATE INDEX IF NOT EXISTS idx_training_cycles_status    ON training_cycles(status);

-- RLS: ops/admin tables. The gateway reads/writes via the service role (which
-- bypasses RLS); no anon/community access. Enable RLS with no permissive
-- policy so direct client access is denied by default.
ALTER TABLE training_cycles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_cycle_days ENABLE ROW LEVEL SECURITY;

-- ── Seed: Cycle 1 — the 35-Day Training program (Day 1 = 2026-06-02) ──
INSERT INTO training_cycles (label, length_days, start_date, status, training_job_id, training_job_state, training_job_updated_at, notes)
SELECT '35-Day Training', 35, DATE '2026-06-02', 'active',
       '3852431990582149120', 'SUBMITTED', TIMESTAMPTZ '2026-06-02T07:52:17Z',
       'Synthetic GPU smoke (A100, Qwen2.5-0.5B, 4,800 rows). Real-corpus training pending consent SQL.'
WHERE NOT EXISTS (SELECT 1 FROM training_cycles WHERE label = '35-Day Training' AND start_date = DATE '2026-06-02');

INSERT INTO training_cycle_days (cycle_id, day_number, day_date, goal, status, initiated, set_by)
SELECT c.id, 1, DATE '2026-06-02',
       'Synthetic training job completes successfully and writes a model artifact to GCS — proving the fine-tune pipeline end-to-end before any real-corpus (paid) training.',
       'running',
       '[{"label":"Merged 23 PRs to main (R0-R9 ORB recovery + 35-day Wave-0)","status":"done"},{"label":"Deployed gateway to production (rev gateway-03855-r9b, /alive green)","status":"done"},{"label":"Launched first GPU training run — Vertex CustomJob 3852431990582149120 (A100, Qwen2.5-0.5B, 4,800 synthetic rows)","status":"running"}]'::jsonb,
       'operator'
FROM training_cycles c
WHERE c.label = '35-Day Training' AND c.start_date = DATE '2026-06-02'
  AND NOT EXISTS (SELECT 1 FROM training_cycle_days d WHERE d.cycle_id = c.id AND d.day_number = 1);
