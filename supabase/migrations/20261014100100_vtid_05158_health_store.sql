-- VTID-05158 (Health Hub Phase 1 / A1, program VTID-05020) — the canonical
-- health data store: catalogue, partitioned series tiers, discrete records,
-- ingest batches, quarantine, maintenance log, and the store functions.
-- impact-allow-solo-migration: by design (approved plan, merge order A1 -> B1 -> A2): the gateway code that writes and reads these tables lands in A2 (VTID-05159); the tables are Aurora-only and inert until then.
--
-- APPLY TARGET: Aurora only (0T; production after the cutover). Never Supabase.
--
-- The first statement refuses to run on a database that has both auth.users
-- and storage.objects (Supabase has both; Aurora and the CI Postgres have
-- neither), unless the session sets vitana.health_store_target = 'aurora'.
-- MIGRATION-DRIFT-CHECK lists these tables as Aurora-only
-- (scripts/ci/migration-drift-baseline.json `aurora_only_tables`) and FAILS if
-- any of them ever appears on Supabase.
--
-- If Aurora ever gains an `auth.users` shim (B4 identity work), the absence
-- test no longer distinguishes Aurora from Supabase: from then on every
-- health-store migration must run with `SET vitana.health_store_target =
-- 'aurora'`, and the runbook's migration step sets it.
--
-- Design (plan docs/validation/VTID-05158/plan-sparring.md, Change 1):
--   * schema public (erase_user_data() scans only public), every member table
--     has tenant_id + user_id NOT NULL and NO foreign key to auth.users (Aurora
--     has none, and a cascading FK would make erase_user_data() skip the table).
--   * no per-sample rows: 5-minute buckets (30 days, daily partitions dropped
--     by the purge), hourly + daily tiers (lifetime, monthly partitions),
--     discrete records (lifetime, monthly partitions).
--   * plain declarative partitioning, no extension (no pg_partman/pg_cron),
--     NO default partition: a missing partition fails the write loudly
--     (SQLSTATE 23514) instead of hiding rows; the gateway ensures partitions
--     and retries once (Change 7). Partitions are created with PARTITION OF, so
--     their column types are the parent's (the memory_audit_log typmod defect
--     cannot occur).
--   * RLS: authenticated may SELECT its own, un-suppressed rows of the four
--     store tiers; nobody but service_role reaches anything else; no browser
--     role can INSERT/UPDATE/DELETE. Writes only through the gateway.
--   * functions: SECURITY DEFINER, search_path public, pg_temp, EXECUTE for
--     service_role only.
--   * source_rank: smaller is better (1 = most trusted). Derived by the gateway
--     from the source kind (S2 sourceRankOf); a member override is applied by
--     updating source_rank on that member's rows.
-- No CGM / glucose / HbA1c code exists in the catalogue (owner decision 7;
-- enforced by a CHECK).

BEGIN;

-- 1a. Placement guard.
DO $guard$
BEGIN
  IF coalesce(current_setting('vitana.health_store_target', true), '') <> 'aurora'
     AND to_regclass('auth.users') IS NOT NULL
     AND to_regclass('storage.objects') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05158 health store placement guard: this database has auth.users and storage.objects (Supabase). The health store is Aurora-only. On Aurora with an auth shim, SET vitana.health_store_target = ''aurora'' first.'
      USING ERRCODE = 'P0001';
  END IF;
END
$guard$;

SET LOCAL lock_timeout = '5s';

-- 1b. Code catalogue (S2). Reference data: authenticated may read it.
CREATE TABLE IF NOT EXISTS public.health_codes (
  code_id           smallint PRIMARY KEY,
  key               text NOT NULL UNIQUE,
  unit              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('series_sum', 'series_stats', 'record')),
  category          text NOT NULL CHECK (category IN ('activity', 'sleep', 'heart', 'body', 'labs', 'habits')),
  plausible_min     numeric,
  plausible_max     numeric,
  catalogue_allowed boolean NOT NULL DEFAULT true,
  CONSTRAINT health_codes_range CHECK (plausible_min IS NULL OR plausible_max IS NULL OR plausible_min <= plausible_max),
  CONSTRAINT health_codes_no_glucose CHECK (key !~* '(gluc|hba1c|cgm)')
);

INSERT INTO public.health_codes (code_id, key, unit, kind, category, plausible_min, plausible_max, catalogue_allowed) VALUES
  -- activity
  (1,  'steps',                   '{steps}',  'series_sum',   'activity', 0,   100000, true),
  (2,  'active_energy',           'kcal',     'series_sum',   'activity', 0,   20000,  true),
  (3,  'exercise_minutes',        'min',      'series_sum',   'activity', 0,   1440,   true),
  (4,  'distance',                'm',        'series_sum',   'activity', 0,   300000, true),
  (5,  'workout',                 'min',      'record',       'activity', 0,   1440,   true),
  (6,  'vo2_max',                 'mL/kg/min','record',       'activity', 10,  90,     true),
  -- sleep
  (20, 'sleep_session',           'min',      'record',       'sleep',    0,   1440,   true),
  (21, 'sleep_efficiency',        '%',        'record',       'sleep',    0,   100,    true),
  -- heart
  (40, 'heart_rate',              '/min',     'series_stats', 'heart',    20,  250,    true),
  (41, 'resting_heart_rate',      '/min',     'record',       'heart',    20,  200,    true),
  (42, 'hrv_sdnn',                'ms',       'record',       'heart',    1,   300,    true),
  (43, 'hrv_rmssd',               'ms',       'record',       'heart',    1,   300,    true),
  (44, 'blood_pressure_systolic', 'mm[Hg]',   'record',       'heart',    50,  260,    false),
  (45, 'blood_pressure_diastolic','mm[Hg]',   'record',       'heart',    30,  160,    false),
  -- body
  (60, 'body_weight',             'kg',       'record',       'body',     20,  400,    true),
  (61, 'body_fat_percentage',     '%',        'record',       'body',     2,   75,     true),
  -- habits (self-logged; refused until the self_logged_health consent key exists, S7)
  (80, 'water_intake',            'mL',       'record',       'habits',   0,   10000,  true),
  (81, 'meal',                    '{meal}',   'record',       'habits',   0,   1,      true),
  (82, 'meditation_minutes',      'min',      'record',       'habits',   0,   1440,   true),
  (83, 'mood',                    '{score}',  'record',       'habits',   1,   10,     true)
ON CONFLICT (code_id) DO UPDATE SET
  key = EXCLUDED.key, unit = EXCLUDED.unit, kind = EXCLUDED.kind, category = EXCLUDED.category,
  plausible_min = EXCLUDED.plausible_min, plausible_max = EXCLUDED.plausible_max,
  catalogue_allowed = EXCLUDED.catalogue_allowed;

-- 1c. 5-minute series tier: daily partitions, 30 days.
CREATE TABLE IF NOT EXISTS public.health_series_5m (
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  source_id     uuid NOT NULL,
  source_kind   text NOT NULL,
  source_rank   smallint NOT NULL,
  code_id       smallint NOT NULL,
  bucket_start  timestamptz NOT NULL,
  n             integer,
  sum           double precision,
  min           double precision,
  max           double precision,
  consent_id    uuid,
  batch_id      uuid,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  suppressed_at timestamptz,
  CONSTRAINT health_series_5m_pk PRIMARY KEY (user_id, source_id, code_id, bucket_start),
  CONSTRAINT health_series_5m_aligned CHECK (extract(epoch FROM bucket_start)::bigint % 300 = 0)
) PARTITION BY RANGE (bucket_start);

-- 1d. Hourly series tier: monthly partitions, lifetime.
CREATE TABLE IF NOT EXISTS public.health_series_1h (
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  source_id     uuid NOT NULL,
  source_kind   text NOT NULL,
  source_rank   smallint NOT NULL,
  code_id       smallint NOT NULL,
  bucket_start  timestamptz NOT NULL,
  n             integer,
  sum           double precision,
  min           double precision,
  max           double precision,
  consent_id    uuid,
  batch_id      uuid,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  suppressed_at timestamptz,
  CONSTRAINT health_series_1h_pk PRIMARY KEY (user_id, source_id, code_id, bucket_start),
  CONSTRAINT health_series_1h_aligned CHECK (extract(epoch FROM bucket_start)::bigint % 3600 = 0)
) PARTITION BY RANGE (bucket_start);

-- 1e. Daily series tier (member's local date): monthly partitions, lifetime.
CREATE TABLE IF NOT EXISTS public.health_series_1d (
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  source_id     uuid NOT NULL,
  source_kind   text NOT NULL,
  source_rank   smallint NOT NULL,
  code_id       smallint NOT NULL,
  local_date    date NOT NULL,
  tz            text NOT NULL,
  n             integer,
  sum           double precision,
  min           double precision,
  max           double precision,
  consent_id    uuid,
  batch_id      uuid,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  suppressed_at timestamptz,
  CONSTRAINT health_series_1d_pk PRIMARY KEY (user_id, source_id, code_id, local_date)
) PARTITION BY RANGE (local_date);

-- 1f. Discrete records: monthly partitions on effective_start, lifetime.
CREATE TABLE IF NOT EXISTS public.health_observations (
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  source_id        uuid NOT NULL,
  source_kind      text NOT NULL,
  source_rank      smallint NOT NULL,
  source_record_id text NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 256),
  code_id          smallint NOT NULL,
  value            double precision,
  unit             text NOT NULL,
  effective_start  timestamptz NOT NULL,
  effective_end    timestamptz,
  device           text,
  detail           jsonb,
  consent_id       uuid,
  batch_id         uuid,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  suppressed_at    timestamptz,
  CONSTRAINT health_observations_pk PRIMARY KEY (user_id, source_id, source_record_id, effective_start),
  CONSTRAINT health_observations_detail_size CHECK (detail IS NULL OR pg_column_size(detail) <= 8192),
  CONSTRAINT health_observations_period CHECK (effective_end IS NULL OR effective_end >= effective_start)
) PARTITION BY RANGE (effective_start);

-- 1g. Ingest batches: monthly partitions on received_month, 30 days.
-- received_month is the partition key so the batch key (user_id, batch_id)
-- can be unique per month (a unique key must contain the partition key).
CREATE TABLE IF NOT EXISTS public.health_ingest_batches (
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  batch_id         uuid NOT NULL,
  client_batch_id  text,
  body_sha256      text NOT NULL,
  source_id        uuid NOT NULL,
  via              text NOT NULL CHECK (via IN ('health_sync_native', 'health_sync_aggregator', 'internal', 'reprocess')),
  contract_version text,
  tz               text,
  s3_key           text,
  consent_id       uuid,
  accepted         integer NOT NULL DEFAULT 0,
  quarantined      integer NOT NULL DEFAULT 0,
  rejected         integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'stored', 'partial', 'failed')),
  results          jsonb,
  received_at      timestamptz NOT NULL DEFAULT now(),
  received_month   date NOT NULL DEFAULT (date_trunc('month', now() AT TIME ZONE 'UTC'))::date,
  completed_at     timestamptz,
  CONSTRAINT health_ingest_batches_key UNIQUE (user_id, batch_id, received_month),
  CONSTRAINT health_ingest_batches_month CHECK (received_month = (date_trunc('month', received_at AT TIME ZONE 'UTC'))::date)
) PARTITION BY RANGE (received_month);

-- 1h. Quarantine: monthly partitions on received_at, 30 days. No value column:
-- the value stays in the S3 raw batch for 30 days.
CREATE TABLE IF NOT EXISTS public.health_ingest_quarantine (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  batch_id     uuid NOT NULL,
  item_index   integer NOT NULL,
  code_key     text,
  reason       text NOT NULL CHECK (reason IN ('UNIT_MISMATCH', 'IMPLAUSIBLE', 'MISALIGNED_BUCKET', 'FUTURE', 'TOO_OLD', 'UNKNOWN_CODE', 'CATEGORY_NOT_ALLOWED')),
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_ingest_quarantine_pk PRIMARY KEY (user_id, batch_id, item_index, received_at)
) PARTITION BY RANGE (received_at);

-- 1i. Maintenance runs (no member data).
CREATE TABLE IF NOT EXISTS public.health_store_maintenance_runs (
  run_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  partitions_created  integer,
  partitions_dropped  integer,
  rows_purged         bigint,
  error               text
);

-- 1j. Read and withdrawal indexes (on the parents; propagate to partitions).
CREATE INDEX IF NOT EXISTS health_series_5m_user_code_idx ON public.health_series_5m (user_id, code_id, bucket_start);
CREATE INDEX IF NOT EXISTS health_series_1h_user_code_idx ON public.health_series_1h (user_id, code_id, bucket_start);
CREATE INDEX IF NOT EXISTS health_series_1d_user_code_idx ON public.health_series_1d (user_id, code_id, local_date);
CREATE INDEX IF NOT EXISTS health_observations_user_code_idx ON public.health_observations (user_id, code_id, effective_start);
CREATE INDEX IF NOT EXISTS health_observations_record_idx ON public.health_observations (user_id, source_id, source_record_id);
CREATE INDEX IF NOT EXISTS health_series_5m_consent_idx ON public.health_series_5m (consent_id) WHERE suppressed_at IS NULL;
CREATE INDEX IF NOT EXISTS health_series_1h_consent_idx ON public.health_series_1h (consent_id) WHERE suppressed_at IS NULL;
CREATE INDEX IF NOT EXISTS health_series_1d_consent_idx ON public.health_series_1d (consent_id) WHERE suppressed_at IS NULL;
CREATE INDEX IF NOT EXISTS health_observations_consent_idx ON public.health_observations (consent_id) WHERE suppressed_at IS NULL;
CREATE INDEX IF NOT EXISTS health_ingest_batches_lookup_idx ON public.health_ingest_batches (user_id, batch_id);
CREATE INDEX IF NOT EXISTS health_ingest_quarantine_batch_idx ON public.health_ingest_quarantine (batch_id);

-- 1k. Row-level security and grants.
ALTER TABLE public.health_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_series_5m ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_series_1h ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_series_1d ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_ingest_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_ingest_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_store_maintenance_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.health_codes, public.health_series_5m, public.health_series_1h, public.health_series_1d,
  public.health_observations, public.health_ingest_batches, public.health_ingest_quarantine,
  public.health_store_maintenance_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.health_codes, public.health_series_5m, public.health_series_1h, public.health_series_1d,
  public.health_observations TO authenticated;
GRANT ALL ON public.health_codes, public.health_series_5m, public.health_series_1h, public.health_series_1d,
  public.health_observations, public.health_ingest_batches, public.health_ingest_quarantine,
  public.health_store_maintenance_runs TO service_role;

DROP POLICY IF EXISTS health_codes_read ON public.health_codes;
CREATE POLICY health_codes_read ON public.health_codes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS health_series_5m_own_read ON public.health_series_5m;
CREATE POLICY health_series_5m_own_read ON public.health_series_5m FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND suppressed_at IS NULL);
DROP POLICY IF EXISTS health_series_1h_own_read ON public.health_series_1h;
CREATE POLICY health_series_1h_own_read ON public.health_series_1h FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND suppressed_at IS NULL);
DROP POLICY IF EXISTS health_series_1d_own_read ON public.health_series_1d;
CREATE POLICY health_series_1d_own_read ON public.health_series_1d FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND suppressed_at IS NULL);
DROP POLICY IF EXISTS health_observations_own_read ON public.health_observations;
CREATE POLICY health_observations_own_read ON public.health_observations FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND suppressed_at IS NULL);

-- 1l. Functions.

-- Partition maintenance: 5-minute tier today-31 .. today+30 (daily); other
-- tiers 2025-07 .. now + 3 months (monthly; 2025-07-01 is the earliest
-- accepted date, older items are TOO_OLD). A 5-minute, batch or quarantine
-- partition the purge would drop at once (wholly older than now - 30 days) is
-- not created, so the hourly ensure -> purge run never churns tables. Each new
-- partition gets RLS on and no browser grants, so it cannot be read around
-- the parent's policy.
CREATE OR REPLACE FUNCTION public.health_store_ensure_partitions(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today   date := (p_now AT TIME ZONE 'UTC')::date;
  v_day     date;
  v_month   date;
  v_last    date := (date_trunc('month', p_now AT TIME ZONE 'UTC') + interval '3 months')::date;
  v_parent  text;
  v_name    text;
  v_created integer := 0;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'health_store_ensure_partitions: p_now is required';
  END IF;

  FOR v_day IN SELECT generate_series(v_today - 31, v_today + 30, interval '1 day')::date LOOP
    v_name := 'health_series_5m_p' || to_char(v_day, 'YYYYMMDD');
    IF to_regclass('public.' || v_name) IS NULL
       AND ((v_day + 1)::timestamp AT TIME ZONE 'UTC') >= p_now - interval '30 days' THEN
      EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.health_series_5m FOR VALUES FROM (%L) TO (%L)',
        v_name, (v_day::timestamp AT TIME ZONE 'UTC'), ((v_day + 1)::timestamp AT TIME ZONE 'UTC'));
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_name);
      v_created := v_created + 1;
    END IF;
  END LOOP;

  FOREACH v_parent IN ARRAY ARRAY['health_series_1h', 'health_series_1d', 'health_observations',
                                  'health_ingest_batches', 'health_ingest_quarantine'] LOOP
    FOR v_month IN SELECT generate_series(date '2025-07-01', v_last, interval '1 month')::date LOOP
      v_name := v_parent || '_p' || to_char(v_month, 'YYYYMM');
      IF to_regclass('public.' || v_name) IS NULL
         AND (v_parent NOT IN ('health_ingest_batches', 'health_ingest_quarantine')
              OR (((v_month + interval '1 month')::date)::timestamp AT TIME ZONE 'UTC') > p_now - interval '30 days') THEN
        IF v_parent IN ('health_series_1d', 'health_ingest_batches') THEN
          -- date partition keys
          EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
            v_name, v_parent, v_month, (v_month + interval '1 month')::date);
        ELSE
          EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
            v_name, v_parent, (v_month::timestamp AT TIME ZONE 'UTC'),
            ((v_month + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
        END IF;
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_name);
        v_created := v_created + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_created;
END;
$$;

-- Partitions that tomorrow's writes need but that do not exist (or are not
-- attached), across all tiers. Empty = healthy. Used by the daily check.
CREATE OR REPLACE FUNCTION public.health_store_partition_check(p_now timestamptz DEFAULT now())
RETURNS TABLE (parent text, partition_name text, for_date date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tomorrow date := (p_now AT TIME ZONE 'UTC')::date + 1;
  v_parent   text;
  v_name     text;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['health_series_5m', 'health_series_1h', 'health_series_1d', 'health_observations',
                                  'health_ingest_batches', 'health_ingest_quarantine'] LOOP
    v_name := v_parent || '_p' || CASE WHEN v_parent = 'health_series_5m' THEN to_char(v_tomorrow, 'YYYYMMDD')
                                       ELSE to_char(v_tomorrow, 'YYYYMM') END;
    IF NOT EXISTS (
      SELECT 1 FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = ('public.' || v_parent)::regclass
         AND c.relnamespace = 'public'::regnamespace
         AND c.relname = v_name) THEN
      parent := v_parent;
      partition_name := v_name;
      for_date := v_tomorrow;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

-- Retention: drop expired 5-minute partitions, expire batch/quarantine rows
-- after 30 days (dropping wholly expired partitions), hard-delete rows
-- suppressed more than 7 days ago. One maintenance-run row per call.
CREATE OR REPLACE FUNCTION public.health_store_purge(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cut      timestamptz := p_now - interval '30 days';
  v_supp_cut timestamptz := p_now - interval '7 days';
  v_run      uuid;
  v_dropped  integer := 0;
  v_rows     bigint := 0;
  v_n        bigint;
  r          record;
  v_day      date;
  v_month    date;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'health_store_purge: p_now is required';
  END IF;
  INSERT INTO public.health_store_maintenance_runs (started_at) VALUES (clock_timestamp()) RETURNING run_id INTO v_run;

  FOR r IN
    SELECT c.relname AS name, p.relname AS parent
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relnamespace = 'public'::regnamespace
       AND p.relname IN ('health_series_5m', 'health_ingest_batches', 'health_ingest_quarantine')
     ORDER BY c.relname
  LOOP
    IF r.parent = 'health_series_5m' AND r.name ~ '^health_series_5m_p[0-9]{8}$' THEN
      v_day := to_date(right(r.name, 8), 'YYYYMMDD');
      -- upper bound < now - 30 days
      IF ((v_day + 1)::timestamp AT TIME ZONE 'UTC') < v_cut THEN
        EXECUTE format('DROP TABLE IF EXISTS public.%I', r.name);
        v_dropped := v_dropped + 1;
      END IF;
    ELSIF r.parent IN ('health_ingest_batches', 'health_ingest_quarantine') AND r.name ~ '_p[0-9]{6}$' THEN
      v_month := to_date(right(r.name, 6) || '01', 'YYYYMMDD');
      IF (((v_month + interval '1 month')::date)::timestamp AT TIME ZONE 'UTC') <= v_cut THEN
        EXECUTE format('DROP TABLE IF EXISTS public.%I', r.name);
        v_dropped := v_dropped + 1;
      END IF;
    END IF;
  END LOOP;

  DELETE FROM public.health_ingest_batches WHERE received_at < v_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM public.health_ingest_quarantine WHERE received_at < v_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;

  DELETE FROM public.health_series_5m WHERE suppressed_at < v_supp_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM public.health_series_1h WHERE suppressed_at < v_supp_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM public.health_series_1d WHERE suppressed_at < v_supp_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM public.health_observations WHERE suppressed_at < v_supp_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;

  UPDATE public.health_store_maintenance_runs
     SET finished_at = clock_timestamp(), partitions_dropped = v_dropped, rows_purged = v_rows
   WHERE run_id = v_run;

  RETURN jsonb_build_object('run_id', v_run, 'partitions_dropped', v_dropped, 'rows_purged', v_rows);
END;
$$;

-- Withdrawal primitives (S9): suppressed rows are unusable at once (RLS and
-- every reader filter suppressed_at IS NULL), can be restored for 7 days, and
-- are hard-deleted by the purge afterwards. Optional data category and/or
-- source; NULL means all. Applied across all four store tiers.
CREATE OR REPLACE FUNCTION public.health_store_suppress(
  p_user uuid, p_category text DEFAULT NULL, p_source_id uuid DEFAULT NULL, p_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_codes smallint[];
  v_out   jsonb := '{}'::jsonb;
  v_n     bigint;
  v_t     text;
BEGIN
  IF p_user IS NULL OR p_at IS NULL THEN
    RAISE EXCEPTION 'health_store_suppress: p_user and p_at are required';
  END IF;
  IF p_category IS NOT NULL AND p_category NOT IN ('activity', 'sleep', 'heart', 'body', 'labs', 'habits') THEN
    RAISE EXCEPTION 'health_store_suppress: unknown category %', p_category;
  END IF;
  SELECT coalesce(array_agg(code_id), '{}') INTO v_codes FROM public.health_codes
   WHERE p_category IS NULL OR category = p_category;

  FOREACH v_t IN ARRAY ARRAY['health_series_5m', 'health_series_1h', 'health_series_1d', 'health_observations'] LOOP
    EXECUTE format('UPDATE public.%I SET suppressed_at = $1 WHERE user_id = $2 AND suppressed_at IS NULL'
                   ' AND ($3::uuid IS NULL OR source_id = $3) AND code_id = ANY ($4)', v_t)
      USING p_at, p_user, p_source_id, v_codes;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_out := v_out || jsonb_build_object(v_t, v_n);
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.health_store_unsuppress(
  p_user uuid, p_category text DEFAULT NULL, p_source_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_codes smallint[];
  v_out   jsonb := '{}'::jsonb;
  v_n     bigint;
  v_t     text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'health_store_unsuppress: p_user is required';
  END IF;
  IF p_category IS NOT NULL AND p_category NOT IN ('activity', 'sleep', 'heart', 'body', 'labs', 'habits') THEN
    RAISE EXCEPTION 'health_store_unsuppress: unknown category %', p_category;
  END IF;
  SELECT coalesce(array_agg(code_id), '{}') INTO v_codes FROM public.health_codes
   WHERE p_category IS NULL OR category = p_category;

  FOREACH v_t IN ARRAY ARRAY['health_series_5m', 'health_series_1h', 'health_series_1d', 'health_observations'] LOOP
    EXECUTE format('UPDATE public.%I SET suppressed_at = NULL WHERE user_id = $1 AND suppressed_at IS NOT NULL'
                   ' AND ($2::uuid IS NULL OR source_id = $2) AND code_id = ANY ($3)', v_t)
      USING p_user, p_source_id, v_codes;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_out := v_out || jsonb_build_object(v_t, v_n);
  END LOOP;
  RETURN v_out;
END;
$$;

-- Ingest one chunk (≤ 2,000 items; the gateway chunks). One transaction.
--
-- p_series: [{ "code_id": int, "bucket_start": ts, "n"?: int, "sum"?: num,
--              "min"?: num, "max"?: num, "op"?: "delete" }]
--   bucket_start >= now() - 30 days → 5-minute tier (5-minute aligned),
--   older → hourly tier (hour aligned). Replace by (source_id, code_id,
--   bucket_start), which is the item's source_record_id (S1).
-- p_records: [{ "source_record_id": text, "code_id": int, "value"?: num,
--               "unit": text, "effective_start": ts, "effective_end"?: ts,
--               "device"?: text, "detail"?: object, "op"?: "delete" }]
--   Replace by (source_id, source_record_id).
-- Then: affected hours (fully inside the 5-minute retention) are recomputed
-- from the 5-minute tier; affected local dates (p_tz) are recomputed from the
-- 5-minute tier when the whole day is inside retention, else from the hourly
-- tier. Suppressed rows are never overwritten and never feed a rollup.
-- Validation (units, plausibility, consent, TOO_OLD, FUTURE) is the gateway's;
-- here a misaligned or malformed item is 'invalid' and a suppressed key is
-- 'suppressed' (the gateway maps both). A missing partition raises 23514.
-- Returns { counts, series:[{i,status}], records:[{i,status}], deleted_dates }.
CREATE OR REPLACE FUNCTION public.health_store_ingest(
  p_tenant uuid, p_user uuid, p_batch_id uuid, p_source_id uuid, p_source_kind text, p_source_rank smallint,
  p_consent_id uuid, p_tz text, p_series jsonb, p_records jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now      timestamptz := now();
  v_cut      timestamptz := now() - interval '30 days';
  v_tz       text := coalesce(nullif(p_tz, ''), 'UTC');
  v_item     jsonb;
  v_i        integer;
  v_code     smallint;
  v_start    timestamptz;
  v_tier     text;
  v_status   text;
  v_old      record;
  v_found    boolean;
  v_hit      boolean;
  v_on       integer;
  v_osum     double precision;
  v_omin     double precision;
  v_omax     double precision;
  v_osupp    timestamptz;
  v_series   jsonb := '[]'::jsonb;
  v_records  jsonb := '[]'::jsonb;
  v_counts   jsonb := '{}'::jsonb;
  v_hours    timestamptz[] := '{}';
  v_hcodes   smallint[] := '{}';
  v_dates    date[] := '{}';
  v_dcodes   smallint[] := '{}';
  v_deleted  date[] := '{}';
  v_n        integer;
  v_sum      double precision;
  v_min      double precision;
  v_max      double precision;
  v_rec_id   text;
  v_value    double precision;
  v_unit     text;
  v_end      timestamptz;
  v_device   text;
  v_detail   jsonb;
  h          record;
  d          record;
  v_day_start timestamptz;
  v_day_end   timestamptz;
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL OR p_batch_id IS NULL OR p_source_id IS NULL
     OR p_source_kind IS NULL OR p_source_rank IS NULL THEN
    RAISE EXCEPTION 'health_store_ingest: tenant, user, batch, source, source kind and rank are required'
      USING ERRCODE = '22023';
  END IF;
  PERFORM v_now AT TIME ZONE v_tz;  -- invalid time zone raises here (22023)
  IF coalesce(jsonb_array_length(coalesce(p_series, '[]')), 0)
     + coalesce(jsonb_array_length(coalesce(p_records, '[]')), 0) > 2000 THEN
    RAISE EXCEPTION 'health_store_ingest: more than 2000 items in one chunk' USING ERRCODE = '22023';
  END IF;

  -- Series items.
  v_i := -1;
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_series, '[]')) LOOP
    v_i := v_i + 1;
    v_status := NULL;
    BEGIN
      v_code  := (v_item->>'code_id')::smallint;
      v_start := (v_item->>'bucket_start')::timestamptz;
    EXCEPTION WHEN others THEN
      v_status := 'invalid';
    END;
    IF v_status IS NULL AND (v_code IS NULL OR v_start IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.health_codes c WHERE c.code_id = v_code AND c.kind IN ('series_sum', 'series_stats'))) THEN
      v_status := 'invalid';
    END IF;
    IF v_status IS NULL THEN
      v_tier := CASE WHEN v_start >= v_cut THEN 'health_series_5m' ELSE 'health_series_1h' END;
      IF extract(epoch FROM v_start)::bigint % (CASE WHEN v_tier = 'health_series_5m' THEN 300 ELSE 3600 END) <> 0 THEN
        v_status := 'invalid';
      END IF;
    END IF;
    IF v_status IS NULL THEN
      BEGIN
        v_n   := (v_item->>'n')::integer;
        v_sum := (v_item->>'sum')::double precision;
        v_min := (v_item->>'min')::double precision;
        v_max := (v_item->>'max')::double precision;
      EXCEPTION WHEN others THEN
        v_status := 'invalid';
      END;
    END IF;

    IF v_status IS NULL THEN
      v_hit := NULL; v_on := NULL; v_osum := NULL; v_omin := NULL; v_omax := NULL; v_osupp := NULL;
      EXECUTE format('SELECT true, n, sum, min, max, suppressed_at FROM public.%I'
                     ' WHERE user_id = $1 AND source_id = $2 AND code_id = $3 AND bucket_start = $4', v_tier)
        INTO v_hit, v_on, v_osum, v_omin, v_omax, v_osupp USING p_user, p_source_id, v_code, v_start;
      v_found := coalesce(v_hit, false);

      IF v_found AND v_osupp IS NOT NULL THEN
        v_status := 'suppressed';
      ELSIF v_item->>'op' = 'delete' THEN
        IF v_found THEN
          EXECUTE format('DELETE FROM public.%I WHERE user_id = $1 AND source_id = $2 AND code_id = $3 AND bucket_start = $4', v_tier)
            USING p_user, p_source_id, v_code, v_start;
          v_status := 'deleted';
          v_deleted := v_deleted || (v_start AT TIME ZONE v_tz)::date;
        ELSE
          v_status := 'not_found';
        END IF;
      ELSIF v_found AND v_on IS NOT DISTINCT FROM v_n AND v_osum IS NOT DISTINCT FROM v_sum
            AND v_omin IS NOT DISTINCT FROM v_min AND v_omax IS NOT DISTINCT FROM v_max THEN
        v_status := 'duplicate';
      ELSE
        EXECUTE format('INSERT INTO public.%I (tenant_id, user_id, source_id, source_kind, source_rank, code_id, bucket_start,'
                       ' n, sum, min, max, consent_id, batch_id, ingested_at)'
                       ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)'
                       ' ON CONFLICT (user_id, source_id, code_id, bucket_start) DO UPDATE SET'
                       ' n = EXCLUDED.n, sum = EXCLUDED.sum, min = EXCLUDED.min, max = EXCLUDED.max,'
                       ' source_kind = EXCLUDED.source_kind, source_rank = EXCLUDED.source_rank,'
                       ' consent_id = EXCLUDED.consent_id, batch_id = EXCLUDED.batch_id, ingested_at = EXCLUDED.ingested_at'
                       ' WHERE %I.suppressed_at IS NULL', v_tier, v_tier)
          USING p_tenant, p_user, p_source_id, p_source_kind, p_source_rank, v_code, v_start,
                v_n, v_sum, v_min, v_max, p_consent_id, p_batch_id, v_now;
        v_status := CASE WHEN v_found THEN 'updated' ELSE 'stored' END;
      END IF;

      IF v_status IN ('stored', 'updated', 'deleted') THEN
        IF v_tier = 'health_series_5m' THEN
          v_hours  := v_hours || date_trunc('hour', v_start);
          v_hcodes := v_hcodes || v_code;
        END IF;
        v_dates  := v_dates || (v_start AT TIME ZONE v_tz)::date
                            || ((v_start + CASE WHEN v_tier = 'health_series_5m' THEN interval '299 seconds'
                                                ELSE interval '3599 seconds' END) AT TIME ZONE v_tz)::date;
        v_dcodes := v_dcodes || v_code || v_code;
      END IF;
    END IF;

    v_series := v_series || jsonb_build_object('i', v_i, 'status', v_status);
    v_counts := jsonb_set(v_counts, ARRAY[v_status], to_jsonb(coalesce((v_counts->>v_status)::int, 0) + 1));
  END LOOP;

  -- Hourly recompute from the 5-minute tier, for hours fully inside retention.
  FOR h IN
    SELECT DISTINCT u.hr, u.code
      FROM unnest(v_hours, v_hcodes) AS u(hr, code)
     WHERE u.hr >= v_cut
  LOOP
    SELECT sum(s.n)::integer, sum(s.sum), min(s.min), max(s.max), count(*)
      INTO v_n, v_sum, v_min, v_max, v_i
      FROM public.health_series_5m s
     WHERE s.user_id = p_user AND s.source_id = p_source_id AND s.code_id = h.code
       AND s.bucket_start >= h.hr AND s.bucket_start < h.hr + interval '1 hour'
       AND s.suppressed_at IS NULL;
    IF v_i = 0 THEN
      DELETE FROM public.health_series_1h
       WHERE user_id = p_user AND source_id = p_source_id AND code_id = h.code AND bucket_start = h.hr
         AND suppressed_at IS NULL;
    ELSE
      INSERT INTO public.health_series_1h (tenant_id, user_id, source_id, source_kind, source_rank, code_id, bucket_start,
                                           n, sum, min, max, consent_id, batch_id, ingested_at)
      VALUES (p_tenant, p_user, p_source_id, p_source_kind, p_source_rank, h.code, h.hr,
              v_n, v_sum, v_min, v_max, p_consent_id, p_batch_id, v_now)
      ON CONFLICT (user_id, source_id, code_id, bucket_start) DO UPDATE SET
        n = EXCLUDED.n, sum = EXCLUDED.sum, min = EXCLUDED.min, max = EXCLUDED.max,
        source_kind = EXCLUDED.source_kind, source_rank = EXCLUDED.source_rank,
        consent_id = EXCLUDED.consent_id, batch_id = EXCLUDED.batch_id, ingested_at = EXCLUDED.ingested_at
      WHERE health_series_1h.suppressed_at IS NULL;
    END IF;
  END LOOP;

  -- Daily recompute for the member's local dates.
  FOR d IN SELECT DISTINCT u.dt, u.code FROM unnest(v_dates, v_dcodes) AS u(dt, code) LOOP
    v_day_start := d.dt::timestamp AT TIME ZONE v_tz;
    v_day_end   := (d.dt + 1)::timestamp AT TIME ZONE v_tz;
    IF v_day_start >= v_cut THEN
      SELECT sum(s.n)::integer, sum(s.sum), min(s.min), max(s.max), count(*)
        INTO v_n, v_sum, v_min, v_max, v_i
        FROM public.health_series_5m s
       WHERE s.user_id = p_user AND s.source_id = p_source_id AND s.code_id = d.code
         AND s.bucket_start >= v_day_start AND s.bucket_start < v_day_end AND s.suppressed_at IS NULL;
    ELSE
      SELECT sum(s.n)::integer, sum(s.sum), min(s.min), max(s.max), count(*)
        INTO v_n, v_sum, v_min, v_max, v_i
        FROM public.health_series_1h s
       WHERE s.user_id = p_user AND s.source_id = p_source_id AND s.code_id = d.code
         AND s.bucket_start >= v_day_start AND s.bucket_start < v_day_end AND s.suppressed_at IS NULL;
    END IF;
    IF v_i = 0 THEN
      DELETE FROM public.health_series_1d
       WHERE user_id = p_user AND source_id = p_source_id AND code_id = d.code AND local_date = d.dt
         AND suppressed_at IS NULL;
    ELSE
      INSERT INTO public.health_series_1d (tenant_id, user_id, source_id, source_kind, source_rank, code_id, local_date, tz,
                                           n, sum, min, max, consent_id, batch_id, ingested_at)
      VALUES (p_tenant, p_user, p_source_id, p_source_kind, p_source_rank, d.code, d.dt, v_tz,
              v_n, v_sum, v_min, v_max, p_consent_id, p_batch_id, v_now)
      ON CONFLICT (user_id, source_id, code_id, local_date) DO UPDATE SET
        tz = EXCLUDED.tz, n = EXCLUDED.n, sum = EXCLUDED.sum, min = EXCLUDED.min, max = EXCLUDED.max,
        source_kind = EXCLUDED.source_kind, source_rank = EXCLUDED.source_rank,
        consent_id = EXCLUDED.consent_id, batch_id = EXCLUDED.batch_id, ingested_at = EXCLUDED.ingested_at
      WHERE health_series_1d.suppressed_at IS NULL;
    END IF;
  END LOOP;

  -- Records.
  v_i := -1;
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_records, '[]')) LOOP
    v_i := v_i + 1;
    v_status := NULL;
    BEGIN
      v_rec_id := v_item->>'source_record_id';
      v_code   := (v_item->>'code_id')::smallint;
      v_value  := (v_item->>'value')::double precision;
      v_unit   := v_item->>'unit';
      v_start  := (v_item->>'effective_start')::timestamptz;
      v_end    := (v_item->>'effective_end')::timestamptz;
      v_device := v_item->>'device';
      v_detail := v_item->'detail';
      IF v_detail = 'null'::jsonb THEN v_detail := NULL; END IF;
    EXCEPTION WHEN others THEN
      v_status := 'invalid';
    END;
    IF v_status IS NULL AND (v_rec_id IS NULL OR length(v_rec_id) NOT BETWEEN 1 AND 256) THEN
      v_status := 'invalid';
    END IF;

    IF v_status IS NULL THEN
      SELECT o.code_id, o.value, o.unit, o.effective_start, o.effective_end, o.device, o.detail, o.suppressed_at
        INTO v_old
        FROM public.health_observations o
       WHERE o.user_id = p_user AND o.source_id = p_source_id AND o.source_record_id = v_rec_id
       ORDER BY o.suppressed_at NULLS FIRST
       LIMIT 1;
      v_found := FOUND;

      IF v_found AND v_old.suppressed_at IS NOT NULL THEN
        v_status := 'suppressed';
      ELSIF v_item->>'op' = 'delete' THEN
        IF v_found THEN
          DELETE FROM public.health_observations
           WHERE user_id = p_user AND source_id = p_source_id AND source_record_id = v_rec_id;
          v_status := 'deleted';
          v_deleted := v_deleted || (v_old.effective_start AT TIME ZONE v_tz)::date;
        ELSE
          v_status := 'not_found';
        END IF;
      ELSIF v_code IS NULL OR v_start IS NULL OR v_unit IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.health_codes c WHERE c.code_id = v_code AND c.kind = 'record')
            OR (v_end IS NOT NULL AND v_end < v_start)
            OR (v_detail IS NOT NULL AND pg_column_size(v_detail) > 8192) THEN
        v_status := 'invalid';
      ELSIF v_found AND v_old.code_id = v_code AND v_old.value IS NOT DISTINCT FROM v_value
            AND v_old.unit = v_unit AND v_old.effective_start = v_start
            AND v_old.effective_end IS NOT DISTINCT FROM v_end AND v_old.device IS NOT DISTINCT FROM v_device
            AND v_old.detail IS NOT DISTINCT FROM v_detail THEN
        v_status := 'duplicate';
      ELSE
        IF v_found THEN
          DELETE FROM public.health_observations
           WHERE user_id = p_user AND source_id = p_source_id AND source_record_id = v_rec_id;
        END IF;
        INSERT INTO public.health_observations (tenant_id, user_id, source_id, source_kind, source_rank, source_record_id,
                                                code_id, value, unit, effective_start, effective_end, device, detail,
                                                consent_id, batch_id, ingested_at)
        VALUES (p_tenant, p_user, p_source_id, p_source_kind, p_source_rank, v_rec_id,
                v_code, v_value, v_unit, v_start, v_end, v_device, v_detail,
                p_consent_id, p_batch_id, v_now);
        v_status := CASE WHEN v_found THEN 'updated' ELSE 'stored' END;
      END IF;
    END IF;

    v_records := v_records || jsonb_build_object('i', v_i, 'status', v_status);
    v_counts := jsonb_set(v_counts, ARRAY[v_status], to_jsonb(coalesce((v_counts->>v_status)::int, 0) + 1));
  END LOOP;

  RETURN jsonb_build_object(
    'counts', v_counts,
    'series', v_series,
    'records', v_records,
    'deleted_dates', coalesce((SELECT jsonb_agg(DISTINCT x ORDER BY x) FROM unnest(v_deleted) x), '[]'::jsonb));
END;
$$;

-- Per (code, local_date) the daily row of the best-ranked source (smallest
-- source_rank; latest ingest breaks a tie). Suppressed rows never appear.
CREATE OR REPLACE FUNCTION public.health_series_daily_resolved(
  p_user uuid, p_codes smallint[], p_from date, p_to date)
RETURNS TABLE (local_date date, code_id smallint, source_id uuid, source_kind text, source_rank smallint,
               n integer, sum double precision, min double precision, max double precision, tz text,
               ingested_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT ON (d.code_id, d.local_date)
         d.local_date, d.code_id, d.source_id, d.source_kind, d.source_rank, d.n, d.sum, d.min, d.max, d.tz, d.ingested_at
    FROM public.health_series_1d d
   WHERE d.user_id = p_user
     AND d.code_id = ANY (p_codes)
     AND d.local_date BETWEEN p_from AND p_to
     AND d.suppressed_at IS NULL
   ORDER BY d.code_id, d.local_date, d.source_rank ASC, d.ingested_at DESC, d.source_id
$$;

REVOKE ALL ON FUNCTION public.health_store_ensure_partitions(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.health_store_partition_check(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.health_store_purge(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.health_store_suppress(uuid, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.health_store_unsuppress(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.health_store_ingest(uuid, uuid, uuid, uuid, text, smallint, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.health_series_daily_resolved(uuid, smallint[], date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_store_ensure_partitions(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.health_store_partition_check(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.health_store_purge(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.health_store_suppress(uuid, text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.health_store_unsuppress(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.health_store_ingest(uuid, uuid, uuid, uuid, text, smallint, uuid, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.health_series_daily_resolved(uuid, smallint[], date, date) TO service_role;

COMMENT ON TABLE public.health_codes IS 'VTID-05158: health store code catalogue (S2). Equal to services/gateway/src/services/health-store/catalogue.ts. No glucose/CGM/HbA1c code.';
COMMENT ON TABLE public.health_series_5m IS 'VTID-05158: 5-minute series buckets, daily partitions, 30 days. Aurora only.';
COMMENT ON TABLE public.health_series_1h IS 'VTID-05158: hourly series, monthly partitions, lifetime. Aurora only.';
COMMENT ON TABLE public.health_series_1d IS 'VTID-05158: daily series per member local date, monthly partitions, lifetime. Aurora only.';
COMMENT ON TABLE public.health_observations IS 'VTID-05158: discrete health records, monthly partitions, lifetime. Aurora only.';
COMMENT ON TABLE public.health_ingest_batches IS 'VTID-05158: ingest batches (idempotency by user_id+batch_id), 30 days. Aurora only.';
COMMENT ON TABLE public.health_ingest_quarantine IS 'VTID-05158: quarantined items without values, 30 days. Aurora only.';
COMMENT ON TABLE public.health_store_maintenance_runs IS 'VTID-05158: one row per health_store_purge run. No member data.';
COMMENT ON FUNCTION public.health_store_ingest(uuid, uuid, uuid, uuid, text, smallint, uuid, text, jsonb, jsonb) IS
  'VTID-05158: replace-upsert one chunk of series buckets and records, recompute hourly and daily rollups. service_role only.';

DO $ensure$ BEGIN PERFORM public.health_store_ensure_partitions(now()); END $ensure$;

COMMIT;
