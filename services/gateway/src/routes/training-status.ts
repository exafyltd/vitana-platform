/**
 * BOOTSTRAP-35DAY-TRACKER: Training cycle tracker — powers the "Training"
 * section on the Command Hub System Overview page
 * (/command-hub/overview/system-overview/).
 *
 * Purpose: give the operator a single screen to follow a multi-day training
 * program — the goal set for each day and the verified outcome at end of day.
 * Built generic so successive cycles (35-day now, then 30/60/90-day) reuse the
 * same section: a `training_cycles` row + N `training_cycle_days` rows.
 *
 * Data model (supabase/migrations/20260606010000_BOOTSTRAP_training_cycle_tracker.sql):
 *   training_cycles      — one row per cycle (label, length_days, start_date, status, job ref)
 *   training_cycle_days  — one row per day  (day_number, goal, status, outcome, evidence, initiated)
 *
 * Resilience: if the tables do not exist yet (migration not applied), the
 * endpoint falls back to an embedded bootstrap snapshot so the screen renders
 * immediately rather than erroring. Read-only and side-effect-free.
 *
 * Mounted at /api/v1/training.
 */

import { Router, Request, Response } from 'express';
import { cloudRunRevision } from '../env';

const router = Router();

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

interface CycleDay {
  day_number: number;
  day_date: string;
  goal: string | null;
  status: string; // pending | running | success | failure | partial
  outcome: string | null;
  evidence: string | null;
  initiated: Array<{ label: string; status?: string; detail?: string }> | null;
}

interface Cycle {
  id: string | null;
  label: string;
  length_days: number;
  start_date: string;
  status: string; // active | completed | aborted
  training_job_id: string | null;
  training_job_state: string | null;
  training_job_updated_at: string | null;
}

// ── Embedded bootstrap snapshot (Day 1 of the 35-day program) ──
// Mirrors the migration seed so the screen works before the migration lands.
const BOOTSTRAP_CYCLE: Cycle = {
  id: null,
  label: '35-Day Training',
  length_days: 35,
  start_date: '2026-06-02',
  status: 'active',
  training_job_id: '3932080612898242560',
  training_job_state: 'JOB_STATE_FAILED',
  training_job_updated_at: '2026-06-02T20:20:03Z',
};

const BOOTSTRAP_DAYS: CycleDay[] = [
  {
    day_number: 1,
    day_date: '2026-06-02',
    goal:
      'Synthetic training job completes successfully and writes a model artifact to GCS — ' +
      'proving the fine-tune pipeline end-to-end before any real-corpus (paid) training.',
    status: 'running',
    outcome: null,
    evidence: null,
    initiated: [
      {
        label: 'Merged 24 PRs to main (R0–R9 ORB recovery + 35-day Wave-0 + Training tracker)',
        status: 'done',
      },
      { label: 'Deployed gateway to production (/alive green)', status: 'done' },
      {
        label:
          'Attempt 1 (job 3852431990582149120): FAILED at import torch — NumPy 2.x vs container torch 2.3',
        status: 'failure',
      },
      {
        label:
          'Trainer fix #2545 (setup.py v0.1.2): pin numpy<2 + bound deps + startup env banner',
        status: 'done',
      },
      {
        label:
          'Attempt 2 (job 3932080612898242560, A100): training COMPLETED but FAILED at adapter save — safetensors tripped on Qwen2.5 tied weights. Confirms the numpy fix works end-to-end.',
        status: 'failure',
      },
      {
        label:
          'Save fix v0.1.3: PEFT save_pretrained(safe_serialization=False). Attempt 3 resubmit pending PR merge.',
        status: 'running',
      },
    ],
  },
];

// Curated set of program-relevant feature flags surfaced on the tracker so the
// operator can see at a glance which Wave-0 lanes are still inert (OFF).
const TRACKED_FLAGS = [
  'FEATURE_MATCH_JOURNEY_CONTEXT',
  'FEATURE_CONTEXT_CONTRACT_ASSERT',
  'AUTOPILOT_LOOP_ENABLED',
  'EXECUTION_DISARMED',
  'VTID_ALLOCATOR_ENABLED',
] as const;

function flagSnapshot(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of TRACKED_FLAGS) out[f] = process.env[f] === 'true';
  return out;
}

function currentDayNumber(startDate: string, lengthDays: number): number {
  const start = new Date(startDate + 'T00:00:00Z').getTime();
  const now = Date.now();
  const dayIdx = Math.floor((now - start) / 86_400_000) + 1; // 1-based
  return Math.min(Math.max(dayIdx, 1), lengthDays);
}

async function pgGet<T>(
  config: { url: string; key: string },
  pathAndQuery: string,
): Promise<T[] | null> {
  try {
    const r = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
    if (!r.ok) return null; // table missing / RLS / not migrated yet → fall back
    return (await r.json()) as T[];
  } catch {
    return null;
  }
}

router.get('/status', async (_req: Request, res: Response) => {
  const config = getSupabaseConfig();

  let cycle: Cycle = BOOTSTRAP_CYCLE;
  let days: CycleDay[] = BOOTSTRAP_DAYS;
  let source: 'db' | 'bootstrap' = 'bootstrap';

  if (config) {
    const cycles = await pgGet<Cycle>(
      config,
      'training_cycles?status=eq.active&select=id,label,length_days,start_date,status,training_job_id,training_job_state,training_job_updated_at&order=start_date.desc&limit=1',
    );
    if (cycles && cycles.length > 0) {
      cycle = cycles[0];
      const dayRows = await pgGet<CycleDay>(
        config,
        `training_cycle_days?cycle_id=eq.${encodeURIComponent(String(cycle.id))}&select=day_number,day_date,goal,status,outcome,evidence,initiated&order=day_number.asc`,
      );
      days = dayRows && dayRows.length > 0 ? dayRows : [];
      source = 'db';
    }
  }

  const currentDay = currentDayNumber(cycle.start_date, cycle.length_days);
  const todayRow = days.find((d) => d.day_number === currentDay) || null;

  return res.json({
    ok: true,
    generated_at: new Date().toISOString(),
    source,
    cycle: {
      label: cycle.label,
      length_days: cycle.length_days,
      start_date: cycle.start_date,
      status: cycle.status,
      current_day: currentDay,
    },
    today: todayRow,
    days,
    live: {
      gateway_revision: cloudRunRevision() || process.env.BUILD_INFO || 'local',
      training_job: {
        job_id: cycle.training_job_id,
        state: cycle.training_job_state,
        updated_at: cycle.training_job_updated_at,
        region: 'us-central1',
        project: 'lovable-vitana-vers1',
      },
      flags: flagSnapshot(),
    },
  });
});

export default router;
