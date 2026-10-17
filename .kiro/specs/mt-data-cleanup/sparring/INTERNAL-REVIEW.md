# Internal adversarial review — mt-data-cleanup (NN=04)

Reviewer: independent internal review (pre-CI-sparring), per `BATCH-BRIEF.md` "Internal review".
Date: 2026-11-01 (review run). Scope judged: `plan.md`, `requirements.md`, `design.md`, `tasks.md`,
`handoff.md`, `lanes/*.md`. Premises verified read-only against current platform `origin/main` at `file:line`.
Planning-only spec — no build/test suite to re-run; the queue.mjs validators were run (decisive, cheap).

## Verdict summary

**APPROVED.** Zero HIGH and zero MEDIUM findings. The spec's six premises each verify against current code,
the four lane files and handoff pass the queue.mjs validators with no errors, the cross-spec rulings are
correctly applied (none names mt-data-cleanup; the one generally-applicable rule — lane-count merge — is
applied and justified), the migration range is free, the DB/code split and §4.7 expand/contract pattern match
the program plan, and dark-by-default is correctly exempted with a stated reason.

## queue.mjs validators (decisive check)

Run with the correct signatures (`validatePlan(fm, slug)`, `validateLane(fm, slug, lane, laneIds)`):

```
handoff.md                              -> []   (0 errors)
orphan-analysis-and-quarantine.md       -> []   (0 errors)
memory-facts-supersede-merge.md         -> []   (0 errors)
profiles-tenant-backfill.md             -> []   (0 errors)
hot-tables-not-null-expand-contract.md  -> []   (0 errors)
```

All pass. (My first run passed the file text where the function expects the slug/lane name and produced
spurious "must equal the file/folder name" errors; re-run with the documented signatures is clean. The
validator errors are therefore an artifact of the first invocation, not a spec defect.)

Front-matter spot checks that the validators enforce and that hold here:
- handoff: `slug: mt-data-cleanup` = folder; `author/executor: kiro`; `next_actor: kiro`; `state: drafted`
  (so no `vtids`/`sparring_record` required yet); `author_seat: hotmail` (valid seat).
- each lane: `lane:` = file name; `state: ready` (so no `vtid` required yet); `next_actor: owner`;
  `executor: kiro`; `seat: hotmail`; `reviewer_seat` ≠ seat (`exafy` on three, `jtadic` on lane 4);
  `paths` are narrow globs; `depends_on` references only lanes of this spec; no `paths` reaches a governance
  path (all under `supabase/`, `docs/multitenancy/`, `scripts/ci/`).

## Premise verification (file:line, current origin/main)

1. **`…0001` overloaded (R1/premise 1).** `services/gateway/src/services/orb-memory-bridge.ts` lines 66-70:
   `DEV_IDENTITY = { USER_ID: '…099', TENANT_ID: '…001', TENANT_SLUG: 'vitana', ACTIVE_ROLE: 'developer', … }`.
   **VERIFIED** — `…0099` is the dev USER, `…0001` the dev TENANT. `vitana-v1/.env:17`
   `VITE_VITANA_BOT_USER_ID="…0001"` **VERIFIED** — so `…0001` is also the bot USER id. The column-split
   premise (same literal means different things on `tenant_id` vs `sender_id`/`user_id`) is correct.

2. **Legacy NULL→`…0001` tenant writers (premise 2).** `database/migrations/20260103_vtid_01144_…sql:192-193`
   `IF v_tenant_id IS NULL THEN v_tenant_id := '…0001'::uuid;` **VERIFIED** (also 453-454).
   `20260102_vtid_01135_…sql:356-357` same pattern **VERIFIED**. The other three files
   (`01137`, `01138`, `01139`) exist in `database/migrations/`. The dormant-writer claim (newest orphan row
   2026-07-21) is a program-recorded count, not independently re-counted here (correctly cited as program §2 /
   2026-10-06 and pinned by the lane's own read-only pre-check — not a planning defect).

3. **`…0001` is the bot sender, tenant from `NEW.tenant_id` (premise 3).** Design cites
   `fire_welcome_chat_on_membership` / `notify_on_chat_message`. The constants in 1–2 support the distinction;
   the trigger behaviour is a design assertion the lane's analysis step (`analyze_orphan_rows()` column split)
   exists precisely to confirm before moving rows. Appropriately handled as an analyze-first step, not an
   unverified move.

4. **`product_analytics_events.tenant_id` nullable, service-role insert, no client RLS (premise 5).**
   `DATABASE_SCHEMA.md` ~line 2536: table definition shows `tenant_id UUID` with no NOT NULL, read via
   `GET /api/v1/admin/tenants/:tenantId/analytics/*` "(gateway service role only)". **VERIFIED.**

5. **Memory supersede mechanism (premise 6 / lane 2).** `DATABASE_SCHEMA.md:3509` — `memory_facts` holds
   "Current key/value facts with provenance and supersession (`superseded_by IS NULL` = current). Written only
   through `write_fact()`." `extracted_at` is a real column (`:544`). VTID-04494 (`:1646`) documents
   `write_fact()` supersede-every-other-current-row semantics. **VERIFIED** — lane 2's supersede-merge
   (keep newest `extracted_at`, mark older superseded, no hard delete) is grounded in the real schema.

6. **Program WS2 scope match.** `docs/MULTI-TENANT-PLAN.md:109` describes WS2 verbatim: "supersede-merge
   memory_facts after reassignment; backfill `profiles.tenant_id`; NOT NULL via §4.7 on hot tables
   (chat_messages 49k, user_notifications 83k; product_analytics_events via insert default, no client RLS)."
   **VERIFIED** — the spec is a faithful WS2 slice, no scope creep beyond it.

7. **§4.7 expand/contract pattern.** `docs/MULTI-TENANT-PLAN.md:58`: "expand/contract only — nullable column →
   BEFORE INSERT trigger filling tenant from the actor's resolved tenant → batched backfill (1–5k rows/txn,
   off-peak, realtime fan-out considered) → `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL`; `lock_timeout`
   + retries; snapshot tables before data moves, retained 30 days, rollback restores from it." **VERIFIED** —
   lane 4 and design reproduce this exactly.

8. **Cross-spec dependency `mt-identity membership-unification`.** `.kiro/specs/mt-identity/handoff.md` and
   `.kiro/specs/mt-identity/lanes/membership-unification.md` both exist. **VERIFIED** — a real predecessor
   lane, correctly kept out of `depends_on:` front matter (which the validator requires to list only this
   spec's lanes) and recorded in prose + each lane body instead.

9. **Referenced paths exist.** `scripts/ci/migration-drift-baseline.json`, `supabase/migrations/`,
   `supabase/tests/`, `docs/multitenancy/MIGRATION-QUEUE.md` all present. **VERIFIED.**

## Cross-spec rulings (CROSS-SPEC-DECISIONS.md) — confirmation

No decision names mt-data-cleanup. Checked each:
- **C3 migration ordering** — names mt-community-isolation / mt-tenant-admin, reserved version `20261101070160`
  in spec 07's gap. This spec is NN=04 (`20261101040000`–`045959`), disjoint from 07's range. No overlap, no
  action required. **OK.**
- **O1 health table list** — mt-identity / mt-guardrails / mt-native-health. Not this spec. **OK.**
- **O2 deactivated tenants** — mt-tenant-admin / mt-m3. Not this spec. **OK.**
- **O3 What's New golden** — mt-packs / mt-guardrails. Not this spec (DB-only, no drafter). **OK.**
- **O4 moderation** — mt-tenant-admin. Not this spec; no stale `moderation-tenant-db` reference present. **OK.**
- **O5 platform_only_accounts** — mt-community-isolation / mt-discover. Not this spec. **OK.**
- **Network groups** — mt-network / mt-m3. Not this spec. **OK.**
- **Lane count (generally applicable)** — "merge sub-one-PR lanes; DB lanes stay separate from code lanes
  (§4.7); never merge across repos; ~90 lanes program-wide." The handoff states this was applied: four DB
  lanes, each a full §4.7-split lane, none sub-one-PR, so none merged. **Confirmed correct** — each lane is a
  distinct forward+rollback+checks+queue unit (2–4 PRs), and merging any two would either cross a dependency
  boundary (lane 1 is the foundation; 2/3 depend on 1; 4 depends on 1+3) or exceed one-VTID sizing. The split
  is justified, not padded.
  Migration ordering within the spec is coherent: 040* → 041* → 042* → 043*, matching the dependency DAG
  (orphan → {memfacts, profiles} → hot-tables), and all positioned after mt-identity WS1 and before WS3.

## Lane sizing, paths, deps, migration safety, DB/code split, dark-by-default

- **Sizing:** four lanes, one VTID each, each 2–4 PRs (forward migration + rollback + validation docs + pgTAP).
  No lane is sub-one-PR. **OK.**
- **Paths narrow + complete:** each lane's `paths` cover exactly its migration version prefix, its pgTAP test
  glob, the shared `MIGRATION-QUEUE.md`, and (lane 1 only) the drift baseline json. `tasks.md` "Allowed paths"
  is the exact union of the four lanes' paths (handoff asserts this; confirmed by inspection). `docs/validation`
  is correctly omitted from `paths` and each lane body notes it adds its own `docs/validation/<vtid>/`. **OK.**
- **Deps:** `depends_on` lists only this spec's lanes; the cross-spec mt-identity dependency is in prose, as
  the validator requires. DAG is acyclic. **OK.**
- **Migration safety:** expand/contract per §4.7, `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL`,
  `lock_timeout` + retries, off-peak, batched 1–5k/txn, `bak_*` snapshots before every move (30-day retention),
  pre-approved rollback per lane restoring from snapshot. Hot-table lane runs last, after the NULL residue is
  resolved by lanes 1 and 3, so `SET NOT NULL` has no residual NULLs. **OK.**
- **DB/code split (§4.7):** every lane is DB-only (migration files); read-only counting/verification SQL is
  delivered under `docs/validation/<vtid>/` for Claude to run; Kiro never runs SQL or writes to a live system.
  No client/gateway code in scope. **OK.**
- **Dark-by-default:** correctly exempted. A data move / NOT NULL cannot be behind a feature flag (program
  §4.7); the plan states the safety is snapshot + rollback + off-peak + `lock_timeout`, not a flag. This is the
  named exception the brief allows ("dark by default … unless the plan names an exception"). **OK.**

## Standing rules present

- Never remap test/ambiguous data to Maxina (dev user `…0099` and 0/2+-membership owners → quarantine) — R1.3,
  R1.6, R3.1, design rule 2, plan Fix 1. **Present.**
- Never test against production; staging read-only (rules 31/31b/48) — plan "Staging verification",
  requirements non-functional, design rule 5. **Present.**
- Snapshot before every data move, 30-day retention, rollback restores (§4.7) — all lanes. **Present.**
- Rules 43–45 (test/service/platform accounts invisible to members; `mt_orphan_quarantine` excluded from
  member-facing surfaces) — R-nonfunctional, O3, design. **Present.**
- No AI/spoken/i18n/route change (rule 41, i18n, Spotlight, What's New, nav registry) — explicitly N/A, stated
  as DB-only (design rule 7, requirements non-functional). **Present and correctly scoped out.**
- Collaboration §7a (no VTID allocation / no merge / no deploy / no live write by Kiro; DB change = migration
  file in the lane PR) — every lane body + design rule 5. **Present.**

## No duplication of DONE work or another spec

- VTID-05147 (S-M membership/role lockdown) and VTID-05149 (`is_default`/`is_platform`, `TenantContext`,
  `ci_tenant_isolation_health()`) are cited as predecessors/consumers, not re-planned. **OK.**
- mt-identity (WS1 unification) is a dependency, explicitly out of scope. The `DEV_IDENTITY` fallback removal
  and slug-map cleanup are deferred to mt-identity `tenant-db-and-slug-cleanup` (CODE), explicitly out of
  scope here. WS3 community `tenant_id`/RLS and `profiles.tenant_id NOT NULL` are deferred. No overlap. **OK.**

## Open questions for sparring (non-blocking by rule)

The plan lists one, under `## Open questions for sparring`: the exact `product_analytics_events` insert-time
tenant source (event payload `tenant_id` vs actor's resolved tenant), to be confirmed against the live insert
path at implementation time, defaulting to payload → actor → quarantine, never Maxina. This is appropriately a
sparring item, not a planning defect; it does not block, and its default is consistent with the never-Maxina
rule.

## Minor observations (NIT — do not block)

- NIT (`lanes/memory-facts-supersede-merge.md` / design): design says older facts are marked superseded
  "through the memory system's existing supersede path (not a hard delete)," while `write_fact()` is the sole
  writer of `memory_facts`. A one-off migration will likely set `superseded_by` directly rather than call
  `write_fact()`. This is an implementation detail correctly left to the executor; the acceptance (exactly one
  current fact per `(user_id, key)`; rollback restores duplicates) pins the observable outcome either way.
- NIT (handoff `updated` / lane `updated`): all timestamps are `2026-11-01T13:00Z`; fine for a push-first
  shell. No action.

## Conclusion

No HIGH or MEDIUM findings. Premises verified at current `file:line`, validators clean, cross-spec rulings
applied, migration safety and DB/code split correct, standing rules present, no duplication. **APPROVED.**
