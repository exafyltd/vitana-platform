# Tasks — mt-schema-queue-followup-r2

<!-- lane: migration-queue-rows -->
## migration-queue-rows — rows for VTID-05575 and VTID-05573 (repo vitana-platform)

Allowed paths: `docs/multitenancy/MIGRATION-QUEUE.md`

- [ ] Q1 Add rows 48-50 (VTID-05575) between rows 47 and 51 from the three files on `main`; rollbacks in order 053200, 053100, 053000.
- [ ] Q2 Add rows 53-56 (VTID-05573) between rows 47 and 48 if PR #4840 is merged; otherwise skip and record in the lane log.
- [ ] Q3 Replace the "Rows 48-50 are reserved" sentence and add one Notes bullet per VTID (30-day `bak_*` retention, owner approval, drift baseline).
- [ ] Q4 Evidence in `docs/validation/<vtid>/` (acceptance, commands.log, scope.json, staging-tests.json).

**Acceptance**
- Change types: Tooling/docs.
- **Outcome** — the owner approving 05575 sees its three files and apply order in the queue; nobody applies out of order.
- **States** — 05573 not yet on `main`: its rows are not invented.
- **Surfaces** — docs only; readers are owners and `queue.mjs` consumers.
- **Locales** — n/a: English-only internal doc.
- **Accessibility** — n/a: Markdown table.
- **Contract** — every file name in a row exists under `supabase/migrations/` on `main`; table order equals apply order.
- **Staging proof** — not verified on staging: docs only; covering check is the lane's `ls`/`grep` evidence and preflight.

<!-- lane: schema-entries -->
## schema-entries — DATABASE_SCHEMA.md entries and layout (repo vitana-platform)

Allowed paths: `DATABASE_SCHEMA.md`

- [ ] S1 Move the `connections_social ... new_follower` line (~1110) into the notification-categories entry above the 05569 section.
- [ ] S2 Add the VTID-05575 section: `daily_matches.scope`, `tenant_id`, `idx_daily_matches_scope_tenant`, four functions, trigger `trg_daily_matches_scope_guard`.
- [ ] S3 Add the VTID-05573 section (`bak_*`, dropped legacy messenger tables) if #4840 is on `main`; otherwise record as deferred.
- [ ] S4 Evidence in `docs/validation/<vtid>/`.

**Acceptance**
- Change types: Tooling/docs.
- **Outcome** — a reader of the schema doc finds the 05575 objects and the 05569 entry is not split.
- **States** — migrations unapplied: entries say so.
- **Surfaces** — docs only.
- **Locales** — n/a: English-only internal doc.
- **Accessibility** — n/a.
- **Contract** — each object named is created in a migration file on `main` (grep evidence, `file:line`); no other entry text changes.
- **Staging proof** — not verified on staging: docs only; covering check is the grep evidence and preflight.

<!-- lane: provision-test-flags-subset -->
## provision-test-flags-subset — feature_flags expectation (repo vitana-platform)

Allowed paths: `supabase/tests/vtid_05150_provision_tenant.test.sql`

- [ ] T1 Replace line 144 equality by `feature_flags -> 'jev'` equality plus `feature_flags - 'jev' - 'erp' = '{}'`.
- [ ] T2 Run the test in the PGlite shim on `main` (green) and with a simulated `erp.bootstrap_requested` flag (green; old assertion red).
- [ ] T3 Evidence in `docs/validation/<vtid>/`.

**Acceptance**
- Change types: Database, Tooling/docs.
- **Outcome** — CI stays green before and after VTID-05506's migration lands.
- **States** — with and without the `erp` key; an unknown extra key still fails.
- **Surfaces** — pgTAP file only.
- **Locales** — n/a.
- **Accessibility** — n/a.
- **Contract** — the assertion is strictly no looser than before except for the `erp` key.
- **Staging proof** — not verified on staging: test-only; covered by the PGlite run recorded in `commands.log`.
