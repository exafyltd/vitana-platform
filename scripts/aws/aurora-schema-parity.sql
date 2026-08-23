-- VTID-03413 / VTID-03412 — Aurora schema-parity remediation.
--
-- THE PROBLEM
-- -----------
-- The DMS task replicating Supabase -> Aurora runs with
-- `TargetTablePrepMode: DO_NOTHING`, i.e. it replicates ROWS into a
-- pre-existing schema and never creates or repairs target DDL. Whatever
-- created the Aurora schema did not carry over primary keys and unique
-- constraints. Data volume looked perfect ("495/495 tables under live CDC")
-- while the constraints were absent, so no row-count or table-count check
-- could have caught it.
--
-- Two production failures traced back to exactly this:
--
--   1. oasis-projector, 40x:
--        42P10 "there is no unique or exclusion constraint matching the
--        ON CONFLICT specification"  on prisma.projectionOffset.upsert()
--      Supabase HAS `projection_offsets_projector_name_key UNIQUE
--      (projector_name)`; Aurora does not, so the upsert's implied
--      ON CONFLICT (projector_name) has nothing to match.
--
--   2. vitana-autopilot-cdc DMS task, repeatedly:
--        "Postgres apply or data error" on TARGET_APPLY, ~23h after each
--        restart. DMS applies an UPDATE by matching the TARGET's primary
--        key. Supabase has `autopilot_recommendations_pkey PRIMARY KEY
--        (id)`; if Aurora's copy lacks it, every UPDATE fails to apply
--        while the initial full load (INSERT-only) succeeded — which is
--        precisely the observed pattern (17/18 updates applied, then dead).
--
-- Scale of the drift: Supabase `public` has 498 primary keys and 162
-- unique constraints across 498 tables. Any of those missing on Aurora
-- breaks the corresponding upsert or CDC update.
--
-- WHY THIS IS A GENERATOR, NOT A FIXED LIST
-- -----------------------------------------
-- Hard-coding ~660 ALTER statements would be stale the moment a migration
-- lands. STEP 1 derives the DDL from Supabase at run time, so it stays
-- correct. It is also idempotent, so it is safe to re-run.
--
-- IMPORTANT: this repairs CONSTRAINTS only (primary key + unique). It does
-- NOT reconcile columns, types, defaults, FKs, check constraints, indexes,
-- or RLS. Those may also have drifted — this closes the two failures that
-- are actually biting, and is not a claim of full schema equivalence.

-- ===========================================================================
-- STEP 0 — run against AURORA to see what is actually missing.
--          Compare this count against Supabase's 498 / 162.
-- ===========================================================================
-- SELECT
--   count(*) FILTER (WHERE contype='p') AS primary_keys,
--   count(*) FILTER (WHERE contype='u') AS unique_constraints
-- FROM pg_constraint c
-- JOIN pg_class t ON t.oid=c.conrelid
-- JOIN pg_namespace n ON n.oid=t.relnamespace
-- WHERE n.nspname='public' AND c.contype IN ('p','u') AND t.relkind='r';

-- ===========================================================================
-- STEP 1 — run against SUPABASE. Emits idempotent DDL for Aurora.
--
--   psql "$SUPABASE_DB_URL" -At -f scripts/aws/aurora-schema-parity.sql \
--     > /tmp/aurora-constraints.sql
--
-- Review the output, then apply it to Aurora:
--
--   psql "$AURORA_DB_URL" -f /tmp/aurora-constraints.sql
--
-- Each statement is wrapped so an already-present constraint is skipped
-- rather than erroring, and a genuine failure (e.g. duplicate rows that
-- would violate a unique constraint) is reported as a NOTICE and does not
-- abort the run — you want the other 659 to land.
-- ===========================================================================
SELECT
  format(
    $$DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = %L AND c.conname = %L
  ) THEN
    BEGIN
      EXECUTE %L;
      RAISE NOTICE 'added %%', %L;
    EXCEPTION WHEN others THEN
      -- Most likely duplicate rows blocking a UNIQUE, or a missing column.
      -- Surface it and keep going; aborting would strand the rest.
      RAISE WARNING 'FAILED %% on %%: %%', %L, %L, SQLERRM;
    END;
  END IF;
END $do$;$$,
    t.relname,
    c.conname,
    format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',
           t.relname, c.conname, pg_get_constraintdef(c.oid)),
    c.conname,
    c.conname,
    t.relname
  ) AS ddl
FROM pg_constraint c
JOIN pg_class     t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relkind = 'r'
  AND c.contype IN ('p', 'u')          -- primary key + unique only
ORDER BY
  -- Primary keys first: DMS needs the target PK to apply UPDATEs at all,
  -- so landing those unblocks CDC before the unique constraints matter.
  (c.contype <> 'p'),
  t.relname,
  c.conname;

-- ===========================================================================
-- STEP 2 — the two specific constraints behind the live failures.
--
-- If you only want to unblock the two known breakages before doing the full
-- sweep, these are the minimum. Run against AURORA:
--
--   ALTER TABLE public.projection_offsets
--     ADD CONSTRAINT projection_offsets_projector_name_key UNIQUE (projector_name);
--
--   ALTER TABLE public.autopilot_recommendations
--     ADD CONSTRAINT autopilot_recommendations_pkey PRIMARY KEY (id);
--
-- Then restart the DMS task so CDC resumes from a working state:
--
--   aws dms start-replication-task --region eu-central-1 \
--     --replication-task-arn <vitana-autopilot-cdc arn> \
--     --start-replication-task-type resume-processing
--
-- ===========================================================================
-- STEP 3 — before trusting Aurora as a cutover target, re-run STEP 0 and
-- confirm the counts match Supabase. Then re-run
-- `scripts/aws/verify-aws-production.sh`, which probes both of these
-- failures directly.
--
-- NOTE ON oasis-projector: adding the unique constraint makes its upsert
-- succeed, but does NOT make pointing it at Aurora correct.
-- `projection_offsets` is itself inside the DMS replication set, so the
-- projector would be writing to a table that CDC also writes from
-- Supabase — two writers, last-one-wins, silently. Its ECS service was
-- scaled to 0 for that reason. Resolve the ownership question (projector
-- reads/writes Supabase, or projection_offsets is excluded from DMS)
-- before scaling it back up. Turning a loud 42P10 into a silent write
-- conflict would be worse than the current failure.
