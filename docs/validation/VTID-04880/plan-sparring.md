# Plan sparring record — VTID-04880

- Sparring session: `6ab0963f-97c5-40a4-99a5-0c7019299e34` (plan_sparring_sessions, attested)
- Plan hash (sha256 of the text between the plan markers): `54a2d7fa23ceabcaef833317700f2fd164d873a1f19723c7ffd79224acef9df6`
- Partner: independent read-only subagent following .claude/agents/plan-sparring-partner.md
- Rounds: 2. Round 1 NOT CONVERGED (4 major, 5 minor), round 2 CONVERGED (3 minor)
- Owner approval: in-session, 2026-10-05 ("Approve all", including the production RUN-MIGRATION dispatch)

---

# Plan A — retire the legacy navigator's leftovers

<!-- plan:begin -->
## Context
VTID-04846 (gateway) and VTID-04853 (frontend) deleted the legacy voice
navigator: the static catalog, the `nav_catalog` DB scorer, `navigator-consult`,
the admin Catalog/Coverage/History/Simulator pages and the `nav_catalog` CRUD
API. Both are live in production (gateway eaed51e, frontend bf464a3). The
screen registry (`src/navigation/registry/` in vitana-v1, published as
`/nav-registry.json`) is the only navigator. What is left still reads or
writes the retired tables, or sets a flag that no code reads:

1. The db-i18n pipeline still has a `nav-catalog` surface. The nightly
   `I18N-DB-SEED.yml` cron loads `nav_catalog` + `nav_catalog_i18n` and
   sends drifted rows to Bedrock for translation. Nothing reads those
   translations any more, so this spends money and keeps the table alive.
2. `ci_vital_systems_health()` (Supabase RPC) reports
   `nav_catalog_incomplete_ga_locales`. The gateway `/ops` health check
   (`evalLocaleCoverage`) and `MORNING-SYSTEM-HEALTH-CHECK.yml` report a
   locale as degraded when that list is not empty. That is a false alarm
   about a table nobody reads.
3. `scripts/nav/generate-nav-catalog-translations.mjs` writes `nav_catalog_i18n`.
4. `NAV_V2_ENABLED` is still set on the staging and production gateway task
   definitions by `AWS-STAGE-DEPLOY-GATEWAY.yml` and `AWS-PROD-DEPLOY-GATEWAY.yml`.
   No code reads it. `conversation-flag-pins.generated.ts` still lists it.
5. `domain-atlas.ts` lists `nav_catalog` and `nav_catalog_i18n` as tables of
   the identity domain.
6. vitana-v1: `scripts/i18n-parity-gate.mjs` (the `npm run i18n:gate`
   locale verdict) counts `nav_catalog_i18n` rows per locale as "DB content
   surface 6". `check-locale-registry.mjs` has comments explaining
   itself through nav_catalog_i18n.
7. The three tables (`nav_catalog` 291 rows, `nav_catalog_i18n` 3,201 rows,
   `nav_catalog_audit` 0 rows) remain in the public schema of the production
   Supabase project. Read-only checks of the live database:
   - No view depends on them.
   - The only function whose body names them is `ci_vital_systems_health`.
   - The touch trigger function `nav_catalog_touch_updated_at` drives the two
     tables' own triggers.
   - Foreign keys: `nav_catalog_i18n.catalog_id` references `nav_catalog`, and
     `nav_catalog_i18n.lang` references `public.supported_locales`.
   - Each table has one admin-read RLS policy.
   - `nav_catalog_i18n.updated_at` was last written 2026-10-04 11:58 UTC, so
     the seeder cron is still writing it today.
   - vitana-v1 edge functions do not reference it.

## Change class
standard (migration, `.github` workflows, deploy workflow env, two repos).

## Scope / files
vitana-platform:
- `services/gateway/src/services/db-i18n/surfaces.ts`: remove the NAV_CATALOG
  surface. `SurfaceId` becomes `'journey-checklist'`.
- `db-i18n-repository.ts` (Supabase + Aurora implementations and interface):
  remove `upsertNavCatalogI18n`, `navCatalogCoverage`, `navCatalogSource`,
  `NavCatalogI18nRow`.
- `aurora-client.ts`: remove the `nav_catalog_i18n` bootstrap DDL. This does
  not drop anything in Aurora.
- `notify-source-changed.ts`: `DbI18nSurface` becomes journey-checklist only.
- `src/scripts/seed-db-i18n.ts`: comments and log text only, where they say
  "both surfaces".
- `routes/ops-health-checks.ts`: `evalLocaleCoverage` judges the journey
  checklist only. The `nav_catalog_incomplete_ga_locales` field goes away.
- `orb/developer/domain-atlas.ts`: drop the two table names.
- `scripts/nav/generate-nav-catalog-translations.mjs`: delete.
- `.github/workflows/I18N-DB-SEED.yml`: remove the surface option and the
  comments about nav-catalog.
- `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml`: remove the NAV_BAD check.
- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`: stop setting `NAV_V2_ENABLED`.
  It stays in the strip list, so the next deploy removes it from the task def.
  `NAV_REGISTRY_URL` is unchanged.
- `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`: the same. It strips
  `NAV_V2_ENABLED` and no longer re-adds it. `NAV_REGISTRY_URL` is unchanged.
- `conversation-flag-pins.generated.ts`: regenerate with
  `scripts/conversation/generate-flag-pins.mjs`.
- Comments that name the tables or the deleted script: `routes/admin-navigator.ts`,
  `admin-navigator-repository.ts` (the history is kept, reworded),
  `db-i18n/translator.ts`, `services/gateway/.env.example`,
  `docs/DB-CONTENT-I18N.md`, and the `I18N-DB-SEED.yml` header.
- `I18N-DB-SEED.yml`: the `surface` input is removed entirely; the seeder
  runs every registered surface.
- `scripts/ci/check-migration-drift.cjs`: understand `ALTER TABLE [IF EXISTS]
  public.x SET SCHEMA <other>` as x leaving public, and do the same in `scripts/ci/triage-missing-tables.cjs`
  if it parses tables. Add a unit case in
  `test/scripts/check-migration-drift.test.ts`. Do not
  add these tables to the baseline. (Without this, the daily drift check goes
  red after the migration is applied.)
- Tests:
  - updated: `test/db-i18n/*` (including `aurora-integration.test.ts`),
    `test/vtid-04663-ops-health-checks.test.ts` (a payload with only nav gaps
    now returns `ok`), and `test/vtid-04517-staging-nav-v2-pinned.test.ts`
    (keeps the `NAV_REGISTRY_URL` pins for staging and prod, and asserts
    `NAV_V2_ENABLED` is stripped and never set);
  - `test/services/conversation/vtid-04525-conversation-flag-registry.test.ts`;
  - drop the now-meaningless `process.env.NAV_V2_ENABLED` setters from the
    navigation and nav-redirect tests;
  - a semantic guard test: no `.from('nav_catalog…')` or `public.nav_catalog`
    SQL in `services/gateway/src` or `scripts/` (Aurora restore SQL
    excepted), and no `{name:"NAV_V2_ENABLED", value:` pin in either deploy
    workflow.
- Migration `supabase/migrations/<ts>_vtid_XXXXX_archive_nav_catalog.sql`, in
  one transaction:
  1. `CREATE OR REPLACE FUNCTION ci_vital_systems_health()`: the same body
     minus `nav_catalog_canonical_entries` and `nav_catalog_incomplete_ga_locales`.
  2. `CREATE SCHEMA IF NOT EXISTS legacy_archive`; revoke all on it from
     PUBLIC, anon and authenticated.
  3. Drop `nav_catalog_i18n_lang_fkey`, so archived rows never block removing
     a locale from `supported_locales`. The FK inside the archive
     (`catalog_id` to `nav_catalog`) stays.
  4. `ALTER TABLE public.nav_catalog / nav_catalog_audit / nav_catalog_i18n
     SET SCHEMA legacy_archive`, and `ALTER FUNCTION
     public.nav_catalog_touch_updated_at() SET SCHEMA legacy_archive`. The
     triggers follow the tables. This **archives, it does not drop**: no row
     is lost and PostgREST stops exposing the tables.
  5. A guard that RAISEs if any `public` view depends on the moved tables
     (pg_depend/pg_rewrite), or if any `public` function body matches
     `\mnav_catalog(_i18n|_audit)?\M`.
  6. The migration header holds the full rollback: move the tables and the
     function back, delete orphaned `lang` rows, then re-add the FK as
     `NOT VALID` followed by `VALIDATE` (the VTID-03515 pattern).
  Apply order: platform PR merged, then vitana-v1 PR merged, then
  `RUN-MIGRATION.yml` (workflow_dispatch). That production DDL dispatch is
  part of what the owner approves with this plan, and the run is recorded in
  `docs/validation/<VTID>/`. The workflow reloads the PostgREST schema.
  Dry-run, with no production DDL:
  (a) the function body is built from the read-only `pg_get_functiondef`
      output, minus the two keys;
  (b) the migration is replayed on a local Postgres seeded with the three
      tables, the trigger function, the FKs and `supported_locales`, and
      must run clean twice: apply, rollback, apply.
- Aurora: `docs/AURORA-CUTOVER-RUNBOOK-2026-09-20.md` gets a note that the
  three tables now live in `legacy_archive` and are not part of the load.
  The restore scripts' nav statements are wrapped in `to_regclass(...) IS NOT
  NULL` guards, so a fresh load does not error. The Aurora `DB_I18N_TARGET`
  copy is not touched.
- `DATABASE_SCHEMA.md`, if it lists the tables.
- `docs/validation/<VTID>/`: acceptance, commands, outputs, staging-tests.json
  (read-only `GET /api/v1/ops/health/locale-coverage` on staging: the body
  never contains `nav_incomplete`; the unit test is the real proof).

vitana-v1 (same VTID, a second PR):
- `scripts/i18n-parity-gate.mjs`: the navigation surface becomes
  file-based, with no DB. Every target picker locale must have
  `src/navigation/registry/locales/<code>.json` with a title for every
  screen in `screens.json` (`de` and `en` read their source titles). The
  checklist DB check becomes a complete-row count against the `en`
  reference, `de` excluded as in VTID-03679, instead of `> 0`.
- `scripts/check-locale-registry.mjs`: comment update only. Its check
  (`supported_locales` vs the picker) is still valid for the journey
  checklist.
- `src/integrations/supabase/types.ts` (generated): leave it for the next type
  regeneration. It is types only, and no code uses those entries.

## Not in scope
- The Aurora copies of the tables and the `DB_I18N_TARGET` seam stay as
  they are. Only the restore scripts get `to_regclass` guards (see Scope).
- The orb-agent tool wrappers: that is Plan B, a separate VTID.

## Verification
- Gateway: full jest suite, typecheck, lint.
- vitana-v1: `node scripts/i18n-parity-gate.mjs --report-only` without the
  service role. It must give a navigation verdict from the files and UNKNOWN
  for the checklist, not crash. Plus `npm test`. Scripts-only, so no
  frontend deploy.
- Gateway extra: `npm run test:roles` (rule 42h, domain atlas) and
  `node scripts/conversation/generate-flag-pins.mjs --check`.
- Migration: the local replay above. After apply, read-only
  checks: `to_regclass('public.nav_catalog') IS NULL`,
  `to_regclass('legacy_archive.nav_catalog')` is not null with the row count
  unchanged, and `ci_vital_systems_health()` returns without the nav keys.
- Staging: STAGING-VERIFY on the deployed commit, then the ready message with
  every commit between production and it.
<!-- plan:end -->


## Planner responses (round 1)
- F1 ACCEPTED: the drift parser learns `SET SCHEMA`, with a unit case, in the same PR.
- F2 ACCEPTED: a semantic guard (no table reads in src/scripts, no flag pin in the workflows), and the env setters are removed.
- F3 ACCEPTED: a file-based registry locale check, and the checklist check becomes a count against the reference.
- F4 ACCEPTED: explicit order (platform PR, then v1 PR, then RUN-MIGRATION); Aurora runbook note plus to_regclass guards in the restore scripts.
- F5 ACCEPTED: the lang FK is dropped, the trigger function moves into the archive, the guard is pg_depend-based plus a word-bounded regex, and the full rollback is in the header.
- F6 ACCEPTED: the real route `/api/v1/ops/health/locale-coverage`; the unit test (nav-only gaps give ok) is the proof.
- F7 ACCEPTED: the dry-run is a local Postgres replay. The production dispatch is part of the owner approval and is recorded.
- F8 ACCEPTED: the tests and governed suites are named (test:roles, flag-pins --check).
- F9 ACCEPTED: the LanguageContext edit is dropped, so the v1 change does not deploy.
- Q1: checked live, read-only. No views; the only function body is ci_vital_systems_health, plus the touch trigger function; the FKs and policies are as listed; no edge-function references. nav_catalog_i18n was last written today at 11:58 UTC, so the cron is live.
- Q2: everything moves to the archive (all three tables and the trigger function); nothing is dropped.
- Q3: the owner, in this approval; the run id goes into docs/validation/<VTID>/.
- Q4: the input is removed entirely.

## Planner responses (round 2)
- F10 ACCEPTED: "Not in scope" reworded.
- F11 ACCEPTED: the doc path is fixed, the unit-test home is named, and triage-missing-tables.cjs is checked.
- F12 ACCEPTED: the rollback re-adds the FK NOT VALID then VALIDATE, after removing orphaned rows.
- Optional Q: yes, a unit test asserts `--surface=nav-catalog` throws "Unknown surface".

## Verdict
CONVERGED (round 2). No blocker or major is open or disputed.

---

## Partner findings (as raised)

### Round 1 — NOT CONVERGED
- F1 [major] Archiving the tables will make the daily Migration Drift Check go red after apply (`check-migration-drift.cjs` only understands CREATE/DROP/RENAME, not SET SCHEMA).
- F2 [major] The guard test as written contradicts the plan's own design and would fail on day one (strip lists, test env setters, Aurora restore SQL, comments).
- F3 [major] Replacing nav coverage with "the registry test covers it" weakens the parity gate (the registry test only covers hardcoded TRANSLATED_LOCALES; the checklist check was only `> 0`).
- F4 [major] Cross-repo apply order is not specified, and the Aurora restore path is left untouched (unguarded `ALTER TABLE public.nav_catalog …` in the restore dumps).
- F5 [minor] Archive hygiene: the lang FK and the trigger function keep the archived tables coupled to `public`; the step-4 guard regex would catch the trigger function.
- F6 [minor] The staging probe as described proves nothing (wrong route; old code already omits nav fields when ok).
- F7 [minor] The migration "dry-run" had no defined safe mechanism.
- F8 [minor] Name the tests to touch, including the governed suites (`test:roles`, flag-pins `--check`).
- F9 [minor] A comment edit in `src/contexts/LanguageContext.tsx` would trigger a full frontend staging deploy.

### Round 2 — CONVERGED
F1–F9 closed. New minor findings:
- F10 [minor] "Not in scope" still called the restore scripts untouched while Scope guards them.
- F11 [minor] Doc path is `docs/DB-CONTENT-I18N.md`; name `test/scripts/check-migration-drift.test.ts`; check `triage-missing-tables.cjs`.
- F12 [minor] The rollback FK re-add should be `NOT VALID` then `VALIDATE`, after removing orphaned rows.

All findings were ACCEPTED; the responses are in the plan file above.
