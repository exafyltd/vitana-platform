# VTID-03572 — Aurora db-i18n seeder: bootstrap path could never have run

**Profile:** `gateway_backend`

Origin: four Codex review findings on #3075, which merged with them
unaddressed. All four confirmed against the code. Findings 1 and 2 are
seeder-side and land here; findings 3 and 4 are runner-side
(`scripts/db-i18n/seed-aurora.sh`) and ship separately under VTID-03574,
because `scripts/` is outside every `VALIDATOR-CHECK` profile allowlist and a
PR spanning both cannot pass this gate under any profile.

**Merge order matters:** this PR first. VTID-03574's runner passes
`--sync-locales`, which only exists after this change.

---

AC-1 — `--ensure-schema` no longer returns before the work it was combined with


`--ensure-schema --locale=x --apply` must create the schema **and** apply. It
previously returned after the schema, so the runner's apply never executed and
the reconciliation that followed compared an empty Aurora against a populated
Supabase — a failure surfacing three steps from its cause.

TEST: `test/db-i18n/aurora-integration.test.ts` — the suite's `beforeAll` calls
`ensureSchema()` and every later upsert test then writes through the same repo
instance, which is only reachable because the modifier falls through.

AC-2 — a fresh Aurora can be seeded at all


`ensureSchema()` CREATEs `supported_locales` and inserts nothing, so
`resolveLocales()` aborts with "supported_locales is empty". New
`--sync-locales` copies the registry in from Supabase, the upstream of record.

TEST: `aurora-integration.test.ts` → "inserts new locales, coalescing an absent
hint to the column default"

AC-3 — re-running converges on upstream instead of preserving first-write


`ON CONFLICT DO UPDATE`, not `DO NOTHING`. `informal_hint` is fed verbatim into
the translation prompt and `status` selects which locales are processed, so a
stale row yields wrong translations silently rather than an error.

TEST: `aurora-integration.test.ts` → "UPDATES on conflict rather than ignoring"

AC-4 — multi-row batches bind column-for-column


The `unnest` form fails silently-wrong if the arrays are transposed: every row
still inserts, with the fields swapped. One row cannot detect that; two rows
with distinguishable values can.

TEST: `aurora-integration.test.ts` → "binds a multi-row batch column-for-column"

AC-5 — the write flag still gates this write


Reaching Aurora is not permission to write to it. The registry bootstrap is a
write and must obey `AURORA_I18N_WRITES` like every other.

TEST: `aurora-integration.test.ts` → "is blocked without the write flag, like
every other write"

AC-6 — an absent hint does not abort the batch


`informal_hint` is `text NOT NULL DEFAULT ''`. Passing null through aborts the
whole batch on a not-null violation. **This was found by the integration test,
not by review** — the constraint lives in the schema, not in the call, so no
mock could have surfaced it.

TEST: `aurora-integration.test.ts` → "inserts new locales, coalescing an absent
hint to the column default"

AC-7 — an empty batch is a no-op, not an empty INSERT


TEST: `aurora-integration.test.ts` → "writes nothing for an empty batch"

AC-8 — no regression in the pre-existing adapter behaviour


The suite was 17/17 before this change and is 22/22 after; the 17 are unchanged.

TEST: `npx jest test/db-i18n test/i18n` → 110 passed, 22 skipped

---

## Known limitation, not fixed here

`aurora-integration.test.ts` is not re-runnable against the same database: its
`beforeAll` inserts a second `is_current` row into
`journey_checklist_versions`, so a second run reads the wrong version and
"maps camelCase snapshot fields" fails. Pre-existing, and it does not affect
CI, which uses a fresh `postgres:16` service container per run. Recorded
because it cost real debugging time and looks like a genuine failure.
