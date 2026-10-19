---
change_class: standard
---
# mt-track-s — Track S security hotfixes (S-A..S-L) + Health Phase 0 live defects (WS10)

<!-- plan:begin -->
## Problem
Track S (`docs/MULTI-TENANT-PLAN.md` §3) + the four WS10 Health Phase 0 live defects are the program's top priority.
Re-verified in code, **almost all has shipped** (VTID-05040..05055, 05147). Each item is CLOSED (cited `file:line`) or
OPEN; only OPEN is planned, CLOSED is recorded so no successor re-plans shipped work (collaboration §7a).

1. **S-A** `GET /orb/debug/context-bootstrap` was anonymous and leaked any user's memory/context. **CLOSED** — now
   `requireAuth, requireExafyAdmin` (`services/gateway/src/routes/orb-live.ts:15554`, VTID-05040).
2. **S-B** `write_fact` / `get_current_facts` / `recall_at_time_range` / `memory_facts_semantic_search` were
   SECURITY DEFINER with `authenticated` EXECUTE. **CLOSED** — revoked from PUBLIC/anon/authenticated, service_role only,
   with an end-state self-check (`supabase/migrations/20261010164100_vtid_05041_definer_functions_lockdown.sql:48-66`).
3. **S-C** `fn_consume_credits` was DEFINER + `authenticated` (drain another user's credits). **CLOSED** —
   `REVOKE … FROM PUBLIC, anon, authenticated` (`supabase/migrations/20261008170000_vtid_04981_consume_credits_lockdown.sql:20-21`).
4. **S-D** `get_user_profile_by_identifier` returned `email` to `anon`. **CLOSED** — `email` dropped from the return
   shape, anon EXECUTE kept, a self-check refuses to apply if the result type still mentions email
   (`20261010164100_vtid_05041_…sql:70-120, 206-215`).
5. **S-E** `switch_to_tenant_by_slug` self-enrolled into ANY slug + gateway trusted `active_metadata`. **CLOSED** —
   self-join only when `tenants.open_signup` (the parent §3 S-E rule; `.../20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:57,77`
   — this RPC checks ONLY `open_signup`; the `is_active AND NOT is_platform` triple is in the signup triggers,
   `20261014000200_vtid_05149_signup_default_tenant.sql:113,173`, not here — residual in ## Out of scope); the four primary-membership
   side-effect triggers guarded (`20261010180000_vtid_05043_s3_membership_side_effect_guard.sql`); and members can no
   longer write `user_tenants`/role rows at all (VTID-05147, see S-M).
6. **S-F** tenant admins could read every tenant's auth audit log and other tenants' community events/groups/rooms.
   **CLOSED** — the access log (`oasis_events`) is platform-only/exafy_admin, the admin-action log tenant-scoped
   (`services/gateway/src/routes/tenant-admin/audit-log.ts:9`, `audit-log-repository.ts:24-29`, VTID-05042);
   cross-tenant overview reads need `requirePlatformScope` (`tenant-admin/overview.ts:169,202`); `requireTenantAdmin`
   intersects stored role with the permitted set (VTID-05147 AC-6).
7. **S-G** invitations: accept without email match; no role allowlist on create. **CLOSED** — create validates every
   role against `VITANA_ROLES` and refuses super-admin-only roles from a tenant admin; accept requires a confirmed,
   matching email and re-checks roles, claiming atomically before any write
   (`services/gateway/src/routes/tenant-admin/invitations.ts:15-24, 56-74, 207-253`, VTID-05044).
8. **S-H** edge functions trusting body `user_id` with service role. **CLOSED** — `social-media-import` derives the
   user from `auth.user.id` not the body (`vitana-v1/supabase/functions/social-media-import/index.ts:33,40,43`); the
   unused `linkedin-import` is auth-gated as defence in depth and flagged for removal
   (`vitana-v1/supabase/functions/linkedin-import/index.ts:4,6-8`, VTID-05049). Campaign/discount functions resolve
   audience from the campaign row, not caller identity (`vitana-v1/supabase/functions/_shared/campaign-audience.ts`,
   VTID-05120).
9. **S-I** caller-supplied `x-tenant-id` / `x-user-id` / `?tenant_id`. **CLOSED** — the headers are ignored and the
   tenant/user come only from the verified identity: `reminders.ts:37-61`, `specs.ts:1167-1170`,
   `governance-controls.ts:32-39,138`, `autopilot-prompts.ts:123-126`, and `controllers/governance-controller.ts:33-47`
   (a non-trusted caller is pinned to `SYSTEM`) — all VTID-05048.
10. **S-J** `/debug/*` routes and non-private realtime channels. **MOSTLY CLOSED, one residual OPEN** — `/debug/tts`
    and `/debug/context-bootstrap` are exafy_admin (`orb-live.ts:15513,15554`), `/debug/memory` and `/debug/intent` are
    dev-sandbox-only and ANONYMOUS (no `requireAuth`; 404 outside dev-sandbox, `:15332,15421`) — adding
    `requireAuth` is a WS0 backlog item (## Out of scope). **OPEN:** the dead `linkedin-import` (VTID-05049) still
    ships, and no committed edge-function auth inventory exists. Generated route inventory + channel RLS are WS0.
11. **S-K** billing `fetchTenantSettingsFeatureFlags` was an unscoped `.maybeSingle()` (silently null since the 2nd
    `tenant_settings` row). **CLOSED** — the admin-metrics path reads all rows and aggregates per tenant, no
    `.maybeSingle()` (`services/gateway/src/routes/billing.ts:1305-1322`, `billing-repository.ts:281-289`, VTID-05044).
12. **S-L** tenant admins saw every tenant's lab orders/results via `requirePartnerHealthAccess`. **CLOSED** — the
    tenant-admin branch is removed; only exafy_admin or a partner-org membership grants access
    (`services/gateway/src/routes/admin-partner-health.ts:62-100`, VTID-05042). This also closes two WS10 defects
    (unlogged partner-staff reads → `auditStaffRead` fails closed, `:121-168`; staff linking a member to an order
    without confirmation → confirm-match is a member-confirmed proposal, `:36-53`, VTID-05055).
13. **S-M** members could escalate their own tenant role / move their membership. **CLOSED** (prior spec, VTID-05147):
    all client write paths to `user_tenants`/`role_preferences`/`user_active_roles`/`user_permitted_roles` revoked;
    `set_role_preference` checks membership; `requireTenantAdmin` tightened. Evidence:
    `docs/validation/VTID-05147/acceptance.md`, `supabase/migrations/20261013233000_vtid_05147_…sql`.
14. **WS10 Health Phase 0 live defects**: **all CLOSED.** (a) plaintext OAuth tokens — wearable tokens sealed, connect
    refused without the key (`services/gateway/src/routes/wearables.ts:21,219-257`; `sealToken`/`openToken` via
    `lib/connection-token-crypto`, VTID-05030); (b) webhooks failing open — every verifier returns
    `secret_not_configured` on an unset secret (`.../connectors/runtime/webhook-signature.ts:1-96`, VTID-05031);
    (c)/(d) unlogged partner-staff reads and staff linking without confirmation — both closed by S-L (VTID-05042/05055).

Net: of 13 Track S items + 4 WS10 defects, **16 are CLOSED and 1 (S-J) has a small open residual.**

## Fix
Two lanes, both the S-J residual. Everything else is live; this spec records that and closes the last gap.

- **Lane `s-j-route-inventory` (vitana-v1, seat `exafyltd`, repo vitana-v1).** Remove the dead `linkedin-import` edge
  function that VTID-05049 flagged for removal, and add a node inventory gate
  (`vitana-v1/scripts/check-edge-function-auth.mjs`, wired into `package.json` `"test"` beside the existing
  `check-edge-data-client.mjs`/`check-realtime-helper.mjs`) — a **ratchet**, enumerated at `vitana-v1@32a82e6b6`
  (s2 R2-F2): 65 functions; **class A** (6) import `_shared/caller-auth.ts` — `fetch-user-context`, `linkedin-import`
  (deleted here), `process-campaign-queue`, `queue-campaign-recipients`, `send-welcome-discount`, `social-media-import`;
  the other **59** predate it and go on a frozen in-script `LEGACY` map, each tagged with its observed pattern —
  **B-user** (33, own `auth.getUser`/`getClaims`, e.g. `get-proactive-context`, `generate-proactive-greeting`,
  `remove_super_admin`), **B-sig** (1, `stripe-webhook`), **B-secret** (3, `send-test-user-confirmation`,
  `test-api-integration`, `verify-package-payment`), **C-unreviewed** (22, no recognised gate: `api-event-by-slug`,
  `appilix-push`, `autopilot-profile`, `cj-get-product-details`, `cj-get-token`, `cj-search-products`,
  `cj-webhook-handler`, `crewai-proxy`, `distribute-post`, `extract-video-meta`, `google-cloud-tts`,
  `google-gemini-tts`, `integration-discovery`, `list_my_memberships`, `og-campaign`, `og-event`, `og-share`,
  `og-short`, `run-uptime-checks`, `send-appointment-reminder`, `trigger-scheduled-campaigns`, `vertex-auth`). The gate
  fails if any function NOT in `LEGACY` lacks the caller-auth import + call, or if a `LEGACY` key has no folder (the
  map only shrinks). The map lives inside the script, so no function file enters `paths`; no legacy function is
  edited. The 22 C entries are a tracked residual (## Out of scope). A node script, not vitest: `vitest.config.ts:19`
  collects only `src/**/*.test.{ts,tsx}`. The gateway-side generated inventory and realtime-channel RLS stay in WS0.
  Code-only, no migration; the lane adds its own `docs/validation/<vtid>/`.
  **vitana-v1 citations pinned to `exafyltd/vitana-v1@32a82e6b6`** (re-verified 2026-10-19; the partner has no v1
  ref, so these are the planner's verified reads): `supabase/config.toml:72-73` `[functions.linkedin-import]` +
  `verify_jwt = true`; `vitest.config.ts:19` `include: ['src/**/*.test.{ts,tsx}']`; `package.json:29` `"test"` =
  `check-edge-data-client.mjs && check-realtime-helper.mjs && vitest run` (both scripts exist); `linkedin-import/index.ts:4`
  imports `requireUser`, `:6-8` the VTID-05049 removal comment; `git grep linkedin-import -- src supabase/functions`
  (excl. its own dir) hits ONLY the s4 test, no `functions.invoke` in v1 or platform `services/`;
  `SUPABASE-FUNCTIONS-RETIRE.yml:42-45` `ALLOWLIST` lacks it. T1 re-checks all of these at the lane's base commit
  first; any mismatch stops the lane (log + `next_actor: claude`).
  Two companion edits keep `npm test` green: (i) drop the `[functions.linkedin-import]` block (`config.toml:72-74`);
  (ii) drop `linkedin-import` from the **collected** suite `src/lib/edge-functions-caller-identity.s4.test.ts` at
  `:77-88`, `:90-92`, `:107-110`, `:272` (+ `:6` header), keeping `social-media-import`/`fetch-user-context`. Both are
  in the lane `paths`.

Both lanes ship dark-exempt (deleting an uncalled function and adding a CI gate change nothing a member can reach) —
the one named exception, as prior Track S security slices shipped.

**Source deletion does NOT undeploy the function (verified 2026-10-18).** `supabase-functions-deploy.yml` never
deletes removed folders, so a deployed copy stays invocable. Undeploy is only via `SUPABASE-FUNCTIONS-RETIRE.yml`
(dispatch-only `supabase functions delete`, `ALLOWLIST`-gated at `:42-45` — `linkedin-import` not on it — refusing any
name still under `supabase/functions/`). So closure is a **second lane** (s2 R2-F1):

- **Lane `s-j-retire-function` (vitana-v1, executor `claude`, `depends_on: [s-j-route-inventory]`, its own VTID
  allocated by PLAN-SPAR with the first).** `paths`: `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml`,
  `docs/validation/**`. One commit adds `linkedin-import` to `ALLOWLIST` (a governance path, so `executor: claude` per
  collaboration §3a; the Lane-scope gate enforces it). After that PR merges, the same lane, under its VTID, dispatches
  the workflow and records the `Confirm` step (a read of the project function list) in its `docs/validation/<vtid>/`.
  S-J closes when that lane is `done` — Kiro never dispatches or writes live (§7a).

## Migrations
None. Reserved range `20261101010000`–`20261101015959` stays unused (realtime-channel RLS is WS0).

## Tests
- `s-j-route-inventory`: a node inventory script `scripts/check-edge-function-auth.mjs` (the repo's convention for an
  edge-function gate — see `scripts/check-edge-data-client.mjs`, both wired into `package.json` `"test"`) over
  `vitana-v1/supabase/functions/**`: every function not in the frozen `LEGACY` map (## Fix) must BOTH import
  `_shared/caller-auth.ts` AND call a gate (`requireUser` / `isServiceRoleCaller` / `isTriggerSecretCaller`); a
  `LEGACY` key without a folder also fails. Exits 0 on the 64 functions left at `32a82e6b6`, non-zero on a planted
  ungated function and on `linkedin-import` reappearing ungated. Static heuristic, not control-flow proof (Deno that
  node cannot run); ordering stays asserted by the s4 suite. It runs in the `"test"` chain; the rest of `npm test` stays
  green — no App.tsx route, so no nav-registry / screen-manifest / parity-ledger change. 42c/42e/42h untouched.
- `s-j-retire-function`: no code test (a one-line ALLOWLIST edit); proof is the retire run's `Confirm` read.
- No pgTAP/contract/golden here (no DB change, no shared instruction surface touched).

## Staging verification
Read-only (rule 48). Source proof: the CI gate + updated Vitest suite. Deployed proof: the retire run's `Confirm` read.
No staging invoke (an edge-function call is a POST the guard aborts). No production probe (rules 31/31b/48).

## Rollout
Code-only; dark-exempt as stated in ## Fix. Kiro PR → reviewer_seat review → Project Manager merge → staging deploy →
STAGING-VERIFY → Gate 2 → PUBLISH. No DB apply. Reversible by reverting the PR. Then lane `s-j-retire-function`
(executor claude, the only live-system step): ALLOWLIST PR → merge → dispatch → `Confirm` read recorded.

## Risks
- A hidden consumer of `linkedin-import`. Mitigation: T1's both-repo grep (pin block in ## Fix) before deleting.
- The gate fires on legacy functions. Mitigation: all 59 pre-caller-auth functions are enumerated in `LEGACY`
  (## Fix), so the first run is green and only NEW functions are held to the import-and-call rule.
- `LEGACY` blesses a weak function. It does not: entries are tagged, not approved; the 22 C entries stay a residual.
- Deleting `linkedin-import` breaks the existing collected suite `src/lib/edge-functions-caller-identity.s4.test.ts`
  (it reads the gone file). Mitigation: that file is in the lane `paths` and T2a updates its four `linkedin-import`
  assertions in the same PR, so `npm test` stays green; the suite still covers `social-media-import`/`fetch-user-context`.
- Source deletion leaves an already-deployed `linkedin-import` live (the deploy workflow never deletes removed
  functions). Mitigation: lane `s-j-retire-function` (own VTID) undeploys it; S-J closes only when that lane is done.

## Out of scope
- Everything already CLOSED above (S-A..S-I, S-K, S-L, S-M, WS10 a–d) — do not re-touch shipped code or migrations.
- The gateway-side **generated route inventory**, the **realtime-channel RLS** (`system-notifications`,
  `user:<id>:calls`), the DB lint and the isolation/golden suites — all WS0 (M0 foundation), each its own sparred slice.
- Any tenancy resolution / policy classification (WS1), data cleanup (WS2), Network layer (WS3).
- **Tracked residuals (not this lane, noted in `handoff.md`):** (a) hardening `switch_to_tenant_by_slug`'s lookup to
  `open_signup AND is_active AND NOT is_platform` (matching the VTID-05149 signup triggers) — the parent §3 S-E rule
  is `open_signup` only and hands the full join flow to WS3, so it belongs to that slice; today `open_signup` defaults
  `false` and no tenant has `is_platform` (`20261014000100_vtid_05149_…sql:13,44`). (b) `requireAuth` on the anonymous
  dev-sandbox `/debug/memory` / `/debug/intent` — WS0 route-inventory backlog. (c) security review of the 22
  `LEGACY` C-unreviewed edge functions (## Fix) — WS0 route-inventory backlog; fixes leave `LEGACY` as they land.

## Depends on
- Done VTIDs this spec builds on and must not duplicate: VTID-05040 (S-A), VTID-05041 (S-B/S-D), VTID-04981 (S-C),
  VTID-05043 (S-E), VTID-05042 (S-F/S-L), VTID-05044 (S-G + S-K — one VTID closed both; see Problem #11),
  VTID-05049/05120 (S-H), VTID-05048 (S-I), VTID-05030 (WS10 tokens), VTID-05031 (WS10 webhooks), VTID-05055 (WS10
  confirmation/audit), VTID-05147 (S-M).
- No lane in another mt-* spec. Inside: `s-j-retire-function` depends on `s-j-route-inventory` (RETIRE refuses while
  the source folder exists).

## Owner decisions
None new (dark-exempt stated in ## Fix). D13 and the production-read-only posture stand.
<!-- plan:end -->

## Open questions for sparring
- S-J's remaining realtime-channel exposure is only enumerable once WS0's generated route/channel inventory exists.
  Confirm the cross-spec intent that realtime-channel RLS lives in WS0 (M0), not Track S — this spec assumes so and
  plans only the in-repo dead-code + inventory-test half.
