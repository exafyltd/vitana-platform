-- VTID-03516 — CI RPC: does the OASIS ledger tell the truth?
--
-- WHY THIS EXISTS
-- ---------------
-- Between 2026-07-31 and 2026-08-06, 24 of the last 80 VTIDs were recorded as
-- status='rejected' / terminal_outcome='failed' — for work that was merged and
-- running in production. OASIS is the single source of truth for task state,
-- and it was asserting that almost all recent work had failed.
--
-- The mechanism: the worker-runner's claimable-task feed selected on
-- (status='in_progress' AND spec_status='approved' AND NOT is_terminal AND
-- unclaimed). That is EXACTLY the tuple CLAUDE.md §4.1 instructs every Claude
-- Code session to write onto its own VTID at the start of in-session work. The
-- worker-runner claimed those VTIDs ~20-30s after allocation, every worker
-- stage failed instantly on a missing ANTHROPIC_API_KEY (deliberately deferred
-- on the AWS task defs, §1b), vtid-terminalize wrote terminal_outcome='failed',
-- and autopilot-controller mapped that to status='rejected'.
--
-- Nothing alarmed, for six days, because nothing asserted that the ledger's
-- verdict matched reality — the same class of gap as VTID-03480, where a
-- fail-soft `ok:false` nobody watched hid four dead ORB features for two
-- months. This RPC closes that gap for the ledger itself.
--
-- WHAT IT ASSERTS
-- ---------------
-- A VTID may only be terminalized by the autonomous execution plane if it was
-- the autonomous plane's work to begin with. Concretely: if a ledger row was
-- claimed by a worker-runner (`worker_runner.claimed` in oasis_events) but its
-- metadata does not mark it as autonomous-plane work, the claim was a
-- misfire — and any 'failed' outcome that followed is a false failure.
--
-- This is deliberately NOT "alert on terminal_outcome='failed'". Real failures
-- exist and must stay quiet, or the check gets switched off within a week.
-- It fires only on the specific fingerprint of a false verdict.
--
-- TRANSPORT
-- ---------
-- PostgREST, not psql. Per VTID-03485/03486/03492: the Supabase project has a
-- network allow-list and GitHub runner IPs are not on it, so every
-- `psql "$SUPABASE_DB_URL"` health check in this repo is structurally unable
-- to connect. Building this detector on that transport would have produced a
-- detector that cannot run — which is the exact failure mode being fixed.
--
-- SECURITY
-- --------
-- SECURITY DEFINER, locked to service_role. Returns ledger identifiers and
-- aggregate provenance only — no user rows, no content.

CREATE OR REPLACE FUNCTION public.ci_ledger_integrity_check(p_lookback_days integer DEFAULT 7)
RETURNS TABLE (
  vtid text,
  title text,
  status text,
  terminal_outcome text,
  ledger_source text,
  claimed_by_worker boolean,
  anthropic_key_failure boolean,
  seconds_to_terminal numeric,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT
    l.vtid::text,
    l.title::text,
    l.status::text,
    l.terminal_outcome::text,
    (l.metadata->>'source')::text AS ledger_source,
    TRUE  AS claimed_by_worker,
    EXISTS (
      SELECT 1 FROM public.oasis_events e
       WHERE e.vtid = l.vtid
         AND e.message LIKE '%ANTHROPIC_API_KEY may be missing%'
    ) AS anthropic_key_failure,
    ROUND(EXTRACT(EPOCH FROM (l.updated_at - l.created_at))::numeric, 1) AS seconds_to_terminal,
    l.created_at
  FROM public.vtid_ledger l
  WHERE l.created_at > now() - make_interval(days => GREATEST(p_lookback_days, 1))
    AND l.terminal_outcome = 'failed'
    -- ...but NOT autonomous-plane work. Mirror of isAutonomousExecutionTask()
    -- in services/gateway/src/routes/worker-orchestrator.ts. Keep the two in
    -- step: this is the assertion, that is the enforcement.
    AND COALESCE(l.metadata->>'source', '') <> 'self-healing'
    AND COALESCE(l.metadata->>'autonomous_execution', 'false') <> 'true'
    -- ...that a worker-runner nonetheless claimed. Without this the check
    -- would flag every legitimately-failed session task too.
    AND EXISTS (
      SELECT 1 FROM public.oasis_events e
       WHERE e.vtid = l.vtid
         AND e.topic = 'worker_runner.claimed'
    )
  ORDER BY l.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.ci_ledger_integrity_check(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ci_ledger_integrity_check(integer) FROM anon;
REVOKE ALL ON FUNCTION public.ci_ledger_integrity_check(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ci_ledger_integrity_check(integer) TO service_role;

COMMENT ON FUNCTION public.ci_ledger_integrity_check(integer) IS
  'VTID-03516: returns VTIDs terminalized failed by the autonomous plane that were never autonomous-plane work. Non-empty = the ledger is recording false failures. service_role only.';
