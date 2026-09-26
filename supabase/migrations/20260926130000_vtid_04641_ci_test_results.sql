-- VTID-04641 — Testing & QA rebuild P2: the results store.
--
-- The Testing & QA screens need a history of every automated test run: which
-- workflow ran, where (dev_pr / nightly / staging / production), on which
-- commit, and whether it passed. GitHub keeps that for 90 days behind an API
-- the browser cannot call; this table keeps it for the Command Hub.
--
-- One row per GitHub Actions workflow run of a test / gate / monitor / e2e /
-- deploy-smoke workflow in either repository (the kinds come from the test
-- catalog, VTID-04637). The gateway fills it (services/testing/test-results-
-- sync.ts); nothing else writes it. Service role only: RLS is on with no
-- policy, so browser JWTs read nothing.
--
-- The old test_runs / test_results tables (Playwright runs started from the
-- hub) are untouched.

create table if not exists public.ci_test_runs (
  repo            text        not null,               -- 'exafyltd/vitana-platform' | 'exafyltd/vitana-v1'
  run_id          bigint      not null,               -- GitHub Actions run id
  run_attempt     integer     not null default 1,
  workflow_file   text        not null,               -- e.g. 'TEST-SUITE.yml'
  workflow_name   text,
  kind            text,                               -- catalog kind: test | gate | monitor | e2e | deploy_smoke
  environments    text[]      not null default '{}',  -- catalog environments at ingest time
  event           text,                               -- push | pull_request | schedule | workflow_dispatch | ...
  branch          text,
  head_sha        text,
  status          text        not null,               -- completed (only completed runs are stored)
  conclusion      text,                               -- success | failure | cancelled | skipped | timed_out | ...
  actor           text,
  html_url        text,
  run_created_at  timestamptz not null,
  run_started_at  timestamptz,
  run_updated_at  timestamptz,
  duration_s      integer,
  jobs            jsonb       not null default '[]'::jsonb, -- [{name, conclusion, started_at, completed_at}]
  ingested_at     timestamptz not null default now(),
  primary key (repo, run_id)
);

create index if not exists ci_test_runs_workflow_created_idx
  on public.ci_test_runs (repo, workflow_file, run_created_at desc);
create index if not exists ci_test_runs_created_idx
  on public.ci_test_runs (run_created_at desc);

alter table public.ci_test_runs enable row level security;

-- One row per repository: how far the sync has read, and what went wrong last.
create table if not exists public.ci_test_sync_state (
  repo             text        primary key,
  synced_through   timestamptz,                       -- newest run_created_at stored
  last_synced_at   timestamptz,
  last_error       text,
  last_ingested    integer     not null default 0,
  updated_at       timestamptz not null default now()
);

alter table public.ci_test_sync_state enable row level security;

comment on table public.ci_test_runs is
  'VTID-04641: completed GitHub Actions runs of test/gate/monitor/e2e/deploy-smoke workflows in both repos, for the Command Hub Testing & QA screens. Written by the gateway only.';
comment on table public.ci_test_sync_state is
  'VTID-04641: per-repo sync cursor for ci_test_runs.';
