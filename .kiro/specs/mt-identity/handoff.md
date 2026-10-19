---
slug: mt-identity
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: parked
updated: 2026-10-19T17:58Z
parked_from: drafted
---
# Handoff — mt-identity (WS1 identity, tenancy resolution & roles — the "rest" after VTID-05149)

Multi-tenant program spec (`docs/MULTI-TENANT-PLAN.md` v5.1, §4.2/§4.3, WS1). VTID-05149 already shipped
`tenants.is_default`/`is_platform`, the signup default tenant, `resolvePrimaryTenant()` + `TenantContext`
(`services/gateway/src/services/tenancy/tenant-context.ts`) and `ci_tenant_isolation_health()`. **This spec covers the
remaining WS1 work only** and builds on those; it does not re-plan them.

In scope: the Supabase access-token hook in **SHADOW** (emit `tenant_id_shadow` only; D14 owner applies the
go-live, which is a SEPARATE later lane, not here); the `tenant_id_for_policies()` + `is_member()` SQL helpers and the
rewrite of every bare `tenant_id = current_tenant_id()` policy (recounted this review: 19 bare policies on 11 tables;
N3 bare-policy lint = 0 gate, N2 degraded-path fallback); membership unification (`user_tenants` canonical, `memberships` → view, dual-write + nightly
drift report); a single role source of truth; `tenantDb(ctx)` + `TENANT_TABLES` with health tables EXCLUDED via the
canonical `isHealthTable()` predicate (cross-spec ruling **O1** — defined HERE, referenced by other specs) and routed
through `healthDb`; removing the slug maps / fake tenant ids / `limit(1)`; fixing `bootstrap_admin_user`.

Migration range: `20261101030000`–`20261101035959`. DB lanes are split from CODE lanes (§4.7).

Lanes (held at `next_actor: owner` until PLAN-SPAR allocates each VTID, then it flips to kiro):
- `helpers-and-policy-rewrite` — DB. `tenant_id_for_policies()` + `is_member()` helpers; rewrite the 19 bare policies
  on 11 tables (recounted this review); N3 bare-policy lint; N2 degraded-path. executor kiro, seat hotmail, reviewer
  exafy.
- `membership-unification` — DB. `user_tenants` canonical; `memberships` → view; dual-write triggers + nightly drift
  report. executor kiro, seat hotmail, reviewer exafy.
- `access-token-hook-shadow` — DB. The custom access-token hook emitting `tenant_id_shadow` + a mismatch-log table,
  SHADOW only. executor kiro, seat hotmail, reviewer jtadic.
- `role-source-and-bootstrap` — DB. One role source of truth; fix `bootstrap_admin_user` (drop the Maxina pin / wrong
  key column, use `tenants.is_default`). executor kiro, seat hotmail, reviewer exafy.
- `tenant-db-and-slug-cleanup` — CODE (gateway). `tenantDb(ctx)` + `TENANT_TABLES`; canonical `isHealthTable()` +
  `healthDb`; remove the `me.ts`/`dev-auth.ts`/`orb-memory-bridge.ts` slug maps, fake tenant ids and `limit(1)`.
  executor kiro, seat jtadic, reviewer hotmail.

The access-token hook **go-live** (emit real `tenant_id`, owner-applied per D14) is OUT OF SCOPE here and is a separate
later lane after the policy rewrite and `tenant_id_for_policies()` land.

## Log
### 2026-11-01T00:00Z · kiro-hotmail-202610151618-b437 · created → drafted
Spec shell created and pushed first (push-first, collaboration §1). Premises re-verified read-only against current
platform `origin/main`: slug maps + fake tenant ids live in `routes/me.ts:15-26`, `routes/dev-auth.ts:26-29`,
`services/orb-memory-bridge.ts:70-71`; `TenantContext`/`resolvePrimaryTenant` already exist
(`services/tenancy/tenant-context.ts`, VTID-05149); `tenantDb`/`TENANT_TABLES`/`isHealthTable`/`healthDb` do NOT exist
yet (only a forward reference comment in `middleware/auth-supabase-jwt-repository.ts:21`); no access-token hook exists;
`bootstrap_admin_user` pins `name IN ('Maxina','Alkalma','Earthlings')` in vitana-v1 migrations (`20250831083908_…`
through `20250831091149_…`). The program "26 on 18" bare-policy count has been superseded by a recount against current
migrations (see the 2026-11-01T12:00Z log entry). Awaiting PLAN-SPAR.

### 2026-11-01T12:00Z · kiro-hotmail-202610151618-b437 · drafted (internal-review revision 1)
Fixed internal-review Finding 1 (MEDIUM) and the two LOW nits. Independently recounted the bare
`tenant_id = current_tenant_id()` policies with a parser over all 668 `supabase/migrations/*.sql` (last-definition-wins
per policy name): **19 bare policies on 11 tables** — `community_groups` (insert/update/delete), `community_meetups`
(insert/update/delete), `community_listings` (`_select_public`), `d42_domain_weights` (`_select`), `event_attendance`
(`_select`), `live_highlights` (`_select`), `live_room_attendance` (`_select`), `live_rooms` (select/insert/update),
`products_catalog` (select/insert), `services_catalog` (select/insert), `tenant_catalog_overrides` (`_select`). Of the
18 program-listed tables: 7 are the health set (already `AND user_id = current_user_id()`, excluded via
`isHealthTable()`); `tenants` (`USING(true)` + service-role) and `relationship_edges` (all guarded/service-role) carry
no bare policy; and **5 have NO RLS policy at all** — `access_audit_log`, `consents`, `retrieval_traces`,
`role_sessions`, `user_roles` (verified: no `CREATE POLICY … ON` for any of them). This supersedes the program §2
"26 on 18" (2026-10-10 count, drifted). Updated plan.md (Problem #2, Fix #1, Tests, Out of scope), requirements.md
(R1.3 + new R1.3a), design.md (helpers lane + health note), tasks.md (H2 + acceptance), and
lanes/helpers-and-policy-rewrite.md to the verified set; scoped the pgTAP acceptance and N3 lint to the 11 tables that
actually have a user-private policy and marked the 5 no-policy tables out of scope (WS2/WS10). LOW nits fixed:
`orb-memory-bridge.ts` cited as `DEV_IDENTITY` ~lines 65-77 (was `:70-71`); `bootstrap_admin_user` cited as the
`20250831083908_…`–`20250831091149_…` range. O1 (`isHealthTable()` owned here) unchanged. queue.mjs validators
(parseFrontMatter/validatePlan/validateLane) re-run on handoff.md + all lanes = 0 errors; tasks.md Allowed paths
identical to each lane's paths (unchanged). No source-code edits, no live-system calls.

### 2026-10-17T10:53Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:29Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T16:30Z · kiro-hotmail-202610151618-b437 · drafted (round-2 replan after partner-harness escalation)
Round 1 escalated infra=false with partner error `evidence_floor_not_met` (partner-harness, not a plan defect). Per the
planner contract this is a REPLAN, not a hash-bump: made a genuine premise tightening grounded in fresh reads against
platform tip e0ef609b. Problem #5 understated the slug maps — re-reading `services/gateway/src/routes/me.ts`,
`routes/dev-auth.ts` and `services/orb-memory-bridge.ts` shows each map holds FOUR hardcoded `…0001`–`…0004` ids
(vitana/maxina/alkalma/earthlings), not two, and the stale ranges were split declarations: `me.ts:15` `TENANT_SLUGS`
(read `me.ts:270,408`) + `me.ts:23` `SLUG_TO_TENANT_ID`; `dev-auth.ts:26` `SLUG_TO_TENANT_ID` (read `dev-auth.ts:491`);
`orb-memory-bridge.ts:66` `DEV_IDENTITY` (`TENANT_ID`/`TENANT_SLUG` at `:70-71`). Corrected plan.md Problem #5 + Fix #5
and lanes/tenant-db-and-slug-cleanup.md to the verified citations; lane paths unchanged. O1 ownership unchanged; parent
`docs/MULTI-TENANT-PLAN.md` not amended. queue.mjs validators re-run = 0 errors. No source-code edits, no live-system
calls.

### 2026-10-17T16:55Z · kiro-hotmail-202610151618-b437 · drafted (answered sparring session 2, round 1)
New PLAN-SPAR session `2cc96038` reviewed the refined plan (plan_text_sha `12ceab50`) and raised 5 findings, all
code-cited. Answered in `sparring/s2-responses-1.md`: all five ACCEPTED. (F1 blocker) `tenant_claim_mismatch_log` now
specifies service-role-only access (REVOKE from PUBLIC/anon/authenticated, GRANT to service_role, RLS enabled with no
policy = deny), in plan.md Fix #3 + the hook-shadow lane + a pgTAP deny/admit test. (F2 major) corrected my own
round-2 over-reach: `orb-memory-bridge.ts:66` `DEV_IDENTITY` is a single dev-user struct (`…0099`) pinned to
`…0001`/vitana, NOT a four-entry map — split Problem #5 / Fix #5 into (a) the two four-entry maps and (b) the
`DEV_IDENTITY` constant driven by a `DEV_TENANT_SLUG` env var (default vitana). (F3) added the O1 TypeScript interface
signatures (`TENANT_TABLES`, `isHealthTable`, `tenantDb`, `healthDb`) to Fix #5 + the lane. (F4) split the policy cost
claim: `(select tenant_id_for_policies())` is an initPlan on hot user-private tables; `(select is_member(tenant_id))`
is correlated/per-row on tenant-shared tables, bounded by an EXPLAIN check on `live_rooms`. (F5) the dual-write trigger
steady-state path uses `ON CONFLICT (tenant_id, user_id) DO NOTHING` with a zero-side-effect pgTAP test. plan.md now
14,786 chars (< 15k), both markers + change_class intact. queue.mjs validators re-run on handoff + all lanes = 0
errors; tasks.md Allowed paths unchanged (no path edits). Parent plan not amended. No source-code edits, no live-system
calls.

### 2026-10-17T17:20Z · kiro-hotmail-202610151618-b437 · drafted (answered sparring session 2, round 2)
Round 2 acknowledged all five R1 findings as addressed and raised one new major, R2-F1. ACCEPTED. My R1-F2 fix added a
`…0001` lint whose carve-out was both self-contradictory (it exempted the two slug-map files that lane 5a DELETES — a
false safe harbour that would let a partially-applied removal pass) and incomplete (it omitted
`services/gateway/src/lib/vitana-bot.ts:9` `VITANA_BOT_USER_ID='…0001'`, a legitimate, intentional bot USER id — not a
tenant id — documented at `docs/MULTI-TENANT-PLAN.md:28`, which would make the lint fail on every run). Verified
`vitana-bot.ts:9` read-only. Rewrote the lint assertion in plan.md (Tests + Fix #5) and the tenant-db lane: no `…0001`
survives in gateway TS source outside exactly `lib/vitana-bot.ts` and `DEV_IDENTITY`'s resolved `DEV_TENANT_SLUG`
default; the removed slug-map files are explicitly NOT exempt. Answered in `sparring/s2-responses-2.md`. No path edits
(the lint lives in the lane's existing test file). queue.mjs validators re-run = 0 errors. Parent not amended. No
source-code edits, no live-system calls.

### 2026-10-18T20:01Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:08Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:15Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:22Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:27Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-19T17:45Z · kiro-hotmail-202610151618-b437 · drafted (answered sparring session ee011de1, round 1)
New session `ee011de1` raised R1-F1 (major), R1-F3, R1-F4 (minor); all ACCEPTED after verifying on platform
`origin/main`. F1: `fetchPrimaryTenantForUser` is still called at `routes/autopilot-prompts.ts:109` (plus local copies in
`presence.ts:55` / `presence-did-you-know.ts:63`) and the VTID-05149 comment at `auth-supabase-jwt-repository.ts:17`
defers it to this slice — lane `tenant-db-and-slug-cleanup` now moves them to `resolvePrimaryTenant()` behind the flag,
marks the repo fns `@deprecated` and gains 7 paths (tasks.md T4b). F3: the `…0001` lint was unsatisfiable as written
(~30 other gateway literals exist) and its `DEV_IDENTITY` carve-out vanishes after 5b — now zero literals in the three
touched files plus a baseline ratchet with `lib/vitana-bot.ts` the ONE exempt site. F4: bot user `…0001` and
`service_bot_accounts` excluded from the membership backfill/drift counts, pgTAP zero-side-effect check. Newest
migration re-verified `20261015180000` (range free). Parent plan not amended. No live-system calls.
### 2026-10-19T18:00Z · kiro-hotmail-202610151618-b437 · drafted (answered sparring session ee011de1, round 2)
Round 2 acknowledged R1-F1/F3/F4 and raised R2-F1 (major), ACCEPTED: verified `tenant-context.ts` has no slug→id
lookup (`loadTenantFlags()` builds only `byId`) while `dev-auth.ts:491` needs one. Lane `tenant-db-and-slug-cleanup`
adds `bySlug` + `getTenantIdBySlug()` (tasks T3b) and two paths. Validators = 0 errors. No live-system calls.

### 2026-10-19T17:58Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (round_cap_reached). Parked with the open findings in sparring/.
