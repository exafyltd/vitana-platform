# Internal review — mt-identity (NN=03) — revision 1 re-review

Reviewer: independent adversarial internal reviewer, fresh read, no planning context.
Scope reviewed: `.kiro/specs/mt-identity/{plan,requirements,design,tasks,handoff}.md` and `lanes/*.md`.
Rubric: `BATCH-BRIEF.md` "Internal review" + `CROSS-SPEC-DECISIONS.md`. Premises re-verified against current
`vitana-platform` / `vitana-v1` trees (file:line below). No spec edits, no git.

This is a re-review after the planner's revision-1 pass (handoff log `2026-11-01T12:00Z`), which addressed the
previous review's single blocker (Finding 1 — the frozen "26 bare policies on 18 tables" count). I verified the
revised claims independently against current code rather than trusting the handoff log.

## Method
- Ran the `queue.mjs` validators (`parseFrontMatter`, `validatePlan`, `validateLane`) on `handoff.md` and all five
  lane files via a throwaway importer — all OK (see "Validator results").
- Spot-checked every ## Problem premise against current code, with emphasis on the recounted bare-policy set and the
  five "no-policy" tables that drove the prior blocker.
- Verified migration range freedom, MIGRATION-QUEUE position, depends_on graph, lane sizing, DB/CODE split,
  dark-by-default, standing rules, and cross-spec ruling O1.

## Validator results (queue.mjs — any error would be HIGH)
```
handoff.md: OK
lanes/access-token-hook-shadow.md: OK
lanes/helpers-and-policy-rewrite.md: OK
lanes/membership-unification.md: OK
lanes/role-source-and-bootstrap.md: OK
lanes/tenant-db-and-slug-cleanup.md: OK
```
No validator errors. Front matter, states (`drafted` plan / `ready` lanes, so no vtids/sparring_record/vtid required),
`executor`/`seat`/`reviewer_seat` (each `≠ seat`), `depends_on` targets (all resolve to this spec's lanes),
`paths` presence, and governance-path checks all pass.

## Verified assumptions (against current code)

1. **Bare-policy recount (the former blocker) is now accurate and well-supported.** Spot-checked each claimed table:
   - `live_rooms` select/insert/update — bare `tenant_id = public.current_tenant_id()`, no user/member guard
     (`supabase/migrations/20251231000001_vtid_01090_live_rooms_events_graph.sql:128-148`). ✓
   - `community_groups` insert/update/delete — bare
     (`20251231100000_vtid_01084_community_personalization_v1.sql:161-180`). ✓
   - `live_room_attendance._select`, `event_attendance._select`, `live_highlights._select` — bare SELECT only; their
     insert/update carry `AND user_id = public.current_user_id()` and are correctly NOT counted
     (`20251231000001_vtid_01090_…:190-350`). The plan's "(`_select`)" scoping is precise. ✓
   - `services_catalog`/`products_catalog` select+insert — bare
     (`20251231100000_vtid_01092_services_products_memory.sql:146-168`). Plan lists "(select, insert)". ✓
   - `d42_domain_weights._select` — `tenant_id = current_tenant_id() OR tenant_id = '…0001'`, bare
     (`20260102000000_vtid_01136_context_fusion_engine.sql:204-207`). ✓
   - `tenant_catalog_overrides._select` — bare (`20260416120000_vtid_02000_marketplace_foundation.sql:809-811`). ✓
   - `community_listings._select_public` — bare; its `_own` SELECT/INSERT/UPDATE carry `seller_user_id = auth.uid()`
     and are correctly NOT counted (`20260727090000_bootstrap_community_marketplace.sql:225-242`). ✓
   The "19 bare on 11 tables" set is consistent with every table I sampled. I did not re-run the planner's exact
   668-file parser, but the plan explicitly defers the exact figure to implementation ("the executor re-runs the
   recount … records the exact set in the PR; the number is a verified set, not a frozen constant"), which is the
   right framing and resolves the prior blocker. The direction and per-table claims hold.
2. **The 5 named "no-policy" tables genuinely have NO policy.** Grep for `CREATE POLICY … ON (public.)?(access_audit_log|consents|retrieval_traces|role_sessions|user_roles)` over `supabase/migrations/**` → **no matches**. The plan correctly marks them out of scope (WS2/WS10), neither rewriting nor creating a policy, and the pgTAP acceptance correctly excludes them. ✓
3. **Health tables already carry `AND user_id = public.current_user_id()`** — lab_reports, biomarker_results,
   wearable_samples, health_features_daily, vitana_index_scores, recommendations, safety_constraints
   (`20251231000000_vtid_01078_health_brain_phase_c1.sql:262-479`). Correctly excluded from the bare set and the basis
   for the canonical `isHealthTable()` (O1). ✓
4. **`current_tenant_id()` exists and is correctly treated as not-to-redefine** here
   (`20251229000000_vtid_01051_me_active_role_fix.sql:15`, GRANTed authenticated :273). N3 ordering is honored. ✓
5. **No `tenant_id_for_policies()`, no `is_member()`, no access-token hook** in `supabase/migrations/**` (grep: no
   matches). Net-new + shadow-only framing is correct. ✓
6. **`tenantDb`/`TENANT_TABLES`/`isHealthTable`/`healthDb` do not exist** — only the forward-reference comment at
   `services/gateway/src/middleware/auth-supabase-jwt-repository.ts:21`. Premise 4 holds. ✓
7. **Slug maps / fake tenant ids are live.** `routes/me.ts:14-27` (`TENANT_SLUGS`/`SLUG_TO_TENANT_ID`,
   `…0001`→vitana, `…0002`→maxina), `routes/dev-auth.ts:25-29` (`SLUG_TO_TENANT_ID`). Premise 5 holds (line cites are
   ~1 off — NIT, see Finding 1). ✓
8. **`bootstrap_admin_user` pins Maxina by name and writes `memberships`.** Latest definition is
   `vitana-v1/supabase/migrations/20250915132930_…` (12 copies total, 20250831083908 → 20250915132930): still
   `WHERE t.name IN ('Maxina','Alkalma','Earthlings')`, `SELECT id FROM public.tenants WHERE name = 'Maxina' LIMIT 1`,
   `INSERT INTO public.memberships …`. The premise (Maxina pin, wrong key column, writes memberships) holds in full;
   no later migration already keys on `is_default`. The plan's cited range *end* (`20250831091149`) is understated —
   NIT, see Finding 2. ✓
9. **VTID-05149 predecessor exists.** `resolvePrimaryTenant()` + `TenantContext`
   (`services/gateway/src/services/tenancy/tenant-context.ts:24,43`). The spec builds on it and does not re-plan. ✓
10. **Migration range free and ordered.** Newest existing platform migration is `20261015180000` (matches the plan);
    no file in `2026110103*`; the range `20261101030000`–`035959` sorts after. ✓
11. **MIGRATION-QUEUE position correct.** Latest applied row is `20261014000700` (VTID-05151 M2, row 8,
    `docs/multitenancy/MIGRATION-QUEUE.md:23`); "after the VTID-05151 rows" is accurate. ✓
12. **Lane structure.** Five lanes, each one VTID; four DB lanes (migrations only) split from the one CODE lane
    (§4.7). No lane crosses repos. `depends_on` edges (tenant-db → helpers; role-source → membership) are acyclic and
    resolve within the spec. Each lane is clearly ≥1 PR of substantive work, so the CROSS-SPEC merge rule does not
    apply; merging the distinct DB concerns would create oversized lanes. Dark-by-default (`MT_RESOLUTION_V2` /
    `tenant_settings.feature_flags.mt.*`) is stated for every CODE read. ✓
13. **Migration safety.** Expand/contract, pre-approved rollback files per slice, `lock_timeout` + retries, 30-day
    `bak_*` snapshot before data moves, read-only pre/post checks, applied by Claude via RUN-MIGRATION; N1
    side-effect-trigger suppression on the membership backfill; shadow hook fails open with a short statement timeout.
    Coherent and complete. ✓
14. **Hook go-live is a separate later lane.** Plan Out of scope, lane body, `tasks.md` S3, `requirements.md` R3.4 and
    `design.md` all keep go-live (real `tenant_id`, auth-config, `current_tenant_id()` alias) OUT and shadow-only IN.
    No live-system call. Honors D14. ✓
15. **Cross-spec ruling O1 applied.** `isHealthTable()` is defined in this spec's CODE lane and declared canonical;
    other specs reference it (consistent with `CROSS-SPEC-DECISIONS.md`). No stale moderation /
    `platform_only_accounts` / network-group references. No duplication of DONE work (VTID-05147/05149/05150/05151). ✓
16. **Standing rules present** (production read-only 31/31b/48, dark-by-default, Bedrock-only, rule 41, 43–45,
    42c/42e/42h when touched, i18n DE-first + RTL, Spotlight, nav-registry/manifest/parity N/A — no routes added,
    §7a no live writes). Present in `requirements.md` and `design.md` "Rules every successor follows". ✓

## Unverified / wrong assumptions
- None material. I did not re-run the planner's exact 668-file last-definition-wins parser (the brief asks for
  targeted spot-checks, not a full re-derivation); every per-table claim I sampled matched, and the plan correctly
  treats the exact count as implementation-verified rather than frozen.

## Findings

### Finding 1 — NIT — slug-map line cites are ~1 line off
- **Where:** `plan.md` Problem #5, `design.md`, `tasks.md` T3, lane `tenant-db-and-slug-cleanup`.
- **Problem:** `me.ts` constants are at ~`:14-27` (plan says `:15-26`); `dev-auth.ts` at ~`:25-29` (plan says
  `:26-29`). The constants exist and are the right targets; the drift is cosmetic.
- **Fix:** Optional — re-cite at implementation. Not blocking.

### Finding 2 — NIT — `bootstrap_admin_user` cited range end is understated
- **Where:** `plan.md` Problem #6, `design.md`, lane `role-source-and-bootstrap`.
- **Problem:** The plan cites copies `20250831083908_…`–`20250831091149_…`, but there are later copies through
  `20250915132930_…` (the authoritative latest). The premise (Maxina pin, writes memberships, wrong key column) holds
  in the latest copy, so the fix target is unaffected; only the range label is short.
- **Fix:** Optional — note "defined/redefined through `20250915132930`" and re-cite at implementation. Not blocking.

## Verdict basis
HIGH findings: 0. MEDIUM findings: 0. → APPROVED.
The prior blocker (Finding 1 of the previous review — the frozen "26/18" count) is resolved: the recount to "19 bare
on 11 tables" is accurate against current code, the five no-policy tables are correctly carved out of both the rewrite
and the pgTAP acceptance, and the exact figure is explicitly re-verified by the executor at implementation rather than
frozen. The two remaining findings are NITs (approximate line/filename cites) and do not block. The
'## Open questions for sparring' item (which of `role_preferences`/`active_role`/`user_permitted_roles` is canonical)
is non-blocking by rule. Validators, lane sizing, DB/CODE split, deps, migration safety, dark-by-default, standing
rules, cross-spec ruling O1, and no-duplication all pass.
