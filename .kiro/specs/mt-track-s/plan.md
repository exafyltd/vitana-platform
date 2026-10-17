---
change_class: standard
---
# mt-track-s — Track S security hotfixes (S-A..S-L) + Health Phase 0 live defects (WS10)

<!-- plan:begin -->
## Problem
Track S (`docs/MULTI-TENANT-PLAN.md` §3) and the four Health Phase 0 live defects called out in WS10 were the
multi-tenant program's highest priority: live security exposures to fix before any tenancy work. Re-verified in current
code 2026-10-15, **almost all of Track S has already shipped** (VTID-05040..05055, 05147). Each premise below is marked
CLOSED (with the migration/route that closed it, cited at current `file:line`) or OPEN. Only the OPEN items are planned
(## Fix); the CLOSED ones are recorded so no successor re-plans shipped work (collaboration §7a, program §3).

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
   join restricted to `open_signup AND is_active AND NOT is_platform`
   (`supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:38-125`); the four primary-
   membership side-effect triggers are guarded (`20261010180000_vtid_05043_s3_membership_side_effect_guard.sql`); and
   members can no longer write `user_tenants`/role rows at all (VTID-05147, see S-M).
6. **S-F** tenant admins could read every tenant's auth audit log and other tenants' community events/groups/rooms.
   **CLOSED** — the access log (`oasis_events`, no tenant column) is platform-only/exafy_admin and the admin-action log
   is tenant-scoped (`services/gateway/src/routes/tenant-admin/audit-log.ts:9`,
   `audit-log-repository.ts:24-29`, VTID-05042); cross-tenant overview reads require `requirePlatformScope`
   (`tenant-admin/overview.ts:169,202`). `requireTenantAdmin` now also intersects the stored role with the permitted
   set (VTID-05147 AC-6).
7. **S-G** invitations: accept without email match; no role allowlist on create. **CLOSED** — create validates every
   role against `VITANA_ROLES` and refuses super-admin-only roles from a tenant admin; accept requires a confirmed,
   matching email and re-checks roles, claiming atomically before any write
   (`services/gateway/src/routes/tenant-admin/invitations.ts:15-24, 56-74, 207-253`, VTID-05044).
8. **S-H** edge functions trusting body `user_id` with service role. **CLOSED** — `social-media-import` derives the
   user from `auth.user.id` not the body (`vitana-v1/supabase/functions/social-media-import/index.ts:40,44`); the
   unused `linkedin-import` is auth-gated as defence in depth and flagged for removal
   (`vitana-v1/supabase/functions/linkedin-import/index.ts:5-9`, VTID-05049). Campaign/discount functions resolve
   audience from the campaign row, not caller identity (`vitana-v1/supabase/functions/_shared/campaign-audience.ts`,
   VTID-05120).
9. **S-I** caller-supplied `x-tenant-id` / `x-user-id` / `?tenant_id`. **CLOSED** — the headers are ignored and the
   tenant/user come only from the verified identity: `reminders.ts:37-61`, `specs.ts:1167-1170`,
   `governance-controls.ts:32-39,138`, `autopilot-prompts.ts:123-126`, and `controllers/governance-controller.ts:33-47`
   (a non-trusted caller is pinned to `SYSTEM`) — all VTID-05048.
10. **S-J** `/debug/*` routes and non-private realtime channels. **MOSTLY CLOSED, one residual OPEN** — `/debug/tts`
    and `/debug/context-bootstrap` are exafy_admin (`orb-live.ts:15513,15554`), `/debug/memory` and `/debug/intent` are
    dev-sandbox-gated (`:15332,15421`). **OPEN:** the dead `linkedin-import` edge function is still shipped (flagged for
    removal by VTID-05049) and there is no committed route/channel inventory test proving every mounted route has an
    auth gate. The broader "generated route inventory" and realtime-channel RLS are WS0 (M0), not Track S.
11. **S-K** billing `fetchTenantSettingsFeatureFlags` was an unscoped `.maybeSingle()` (silently null since the 2nd
    `tenant_settings` row). **CLOSED** — the admin-metrics path reads all rows and aggregates per tenant, no
    `.maybeSingle()` (`services/gateway/src/routes/billing.ts:1314-1320`,
    `billing-repository.ts:287-289`).
12. **S-L** tenant admins saw every tenant's lab orders/results via `requirePartnerHealthAccess`. **CLOSED** — the
    tenant-admin branch is removed; only exafy_admin or a partner-org membership grants access
    (`services/gateway/src/routes/admin-partner-health.ts:62-100`, VTID-05042). This also closes two WS10 defects
    (unlogged partner-staff reads → `auditStaffRead` fails closed, `:121-168`; staff linking a member to an order
    without confirmation → confirm-match is a member-confirmed proposal, `:36-53`, VTID-05055).
13. **S-M** members could escalate their own tenant role / move their membership. **CLOSED** (prior spec, VTID-05147):
    all client write paths to `user_tenants` / `role_preferences` / `user_active_roles` / `user_permitted_roles`
    revoked; `set_role_preference` checks membership; `requireTenantAdmin` tightened. Evidence:
    `docs/validation/VTID-05147/acceptance.md`, `supabase/migrations/20261013233000_vtid_05147_…sql`.
14. **WS10 Health Phase 0 live defects** (re-verified at slice start per the plan): **all CLOSED.**
    (a) plaintext OAuth tokens — wearable tokens are sealed and connect is refused without the key
    (`services/gateway/src/routes/wearables.ts:21,219-257`; `sealToken`/`openToken` via
    `lib/connection-token-crypto`, VTID-05030); (b) webhooks failing open without a secret — every verifier returns
    `secret_not_configured` on an unset secret (`services/gateway/src/connectors/runtime/webhook-signature.ts:1-96`,
    VTID-05031); (c) unlogged partner-staff reads and (d) staff linking without member confirmation — both closed by
    S-L above (VTID-05042/05055).

Net: of 13 Track S items + 4 WS10 defects, **16 are CLOSED and 1 (S-J) has a small open residual.**

## Fix
One lane only — the S-J residual. Everything else is already live; this spec exists to record that with evidence and to
close the last gap without re-touching shipped code.

- **Lane `s-j-route-inventory` (vitana-v1, seat `exafyltd`, repo vitana-v1).** Remove the dead `linkedin-import` edge
  function that VTID-05049 flagged for removal, and add a node inventory gate
  (`vitana-v1/scripts/check-edge-function-auth.mjs`, wired into `package.json` `"test"` beside the existing
  `check-edge-data-client.mjs`/`check-realtime-helper.mjs`) that exits non-zero if a Supabase edge function under
  `vitana-v1/supabase/functions/**` lacks a caller-auth gate (imports `_shared/caller-auth.ts` / calls `requireUser`,
  or is on an explicit public allowlist with a stated reason). A node script, not a vitest `.test.ts`: `vitest.config.ts:22`
  `include` is `src/**/*.test.{ts,tsx}`, so a test under `supabase/functions/**` is never collected. This is
  the narrow, in-repo, verifiable half of S-J's "route inventory"; the gateway-side generated route inventory and
  realtime-channel RLS stay in WS0 (M0), out of scope here. Confirm no app code imports `linkedin-import` before
  deleting it (grep `functions.invoke('linkedin-import'` / string references — `social-media-import` replaced it per
  VTID-05049). Code-only, no migration. The lane adds its own `docs/validation/<vtid>/`.
  Deleting the function requires two companion edits inside the same lane, so the removal is complete and `npm test`
  stays green (both verified in current code 2026-10-15):
  (i) remove the `[functions.linkedin-import]` block from `vitana-v1/supabase/config.toml:72-74` (an orphaned
  registration of the deleted function — leaving it is the exact dead-reference S-J closes); and
  (ii) update the existing **collected** vitest suite `vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts`,
  which today reads `linkedin-import/index.ts` and asserts on it in four spots (the `VTID-05049 the five functions`
  loop that includes `'linkedin-import'` at `:77-82`; the profile-import loop `['linkedin-import','social-media-import']`
  at `:90-93`; the `linkedin-import is flagged for removal` case at `:107-110`; and the `arrayContaining([...])` scan
  assertion at `:198`). After deletion `readFileSync` on the gone file throws and the `arrayContaining` expectation
  fails, so the suite must drop `linkedin-import` from those four places (keeping `social-media-import`/`fetch-user-context`
  coverage intact). That file is under `src/**`, so it IS collected by vitest — it must be inside the lane's `paths` or
  the Lane-scope CI check reddens the PR.

Because this lane changes only vitana-v1 code + a test, it ships dark-exempt (there is no runtime behaviour to flag —
deleting an uncalled function and adding a test change nothing a member can reach), stated here as the one named
exception, mirroring how prior Track S slices shipped (each was a security fix, not a flagged read path).

## Migrations
None. (The realtime-channel RLS that S-J alludes to is a WS0 item, not this slice; this spec adds no migration, so its
reserved range `20261101010000`–`20261101015959` stays unused and is recorded here only to reserve it against drift.)

## Tests
- `s-j-route-inventory`: a node inventory script `scripts/check-edge-function-auth.mjs` (the repo's convention for an
  edge-function gate — see `scripts/check-edge-data-client.mjs`, both wired into `package.json` `"test"`) over
  `vitana-v1/supabase/functions/**`, asserting each function either gates the caller (`_shared/caller-auth.ts` /
  `requireUser`) or is on a documented public allowlist; it exits non-zero if `linkedin-import` reappears without a gate.
  It runs inside the `"test"` chain, so a plain `npm test` executes it (a vitest `.test.ts` under
  `supabase/functions/**` would not run — `vitest.config.ts` `include` is `src/**/*.test.{ts,tsx}`). The rest of
  `npm test` (nav registry, design manifest, i18n lint) stays green — no App.tsx route added, so no nav-registry /
  screen-manifest / parity-ledger change. 42c/42e/42h untouched (no support/operator/role surface changed).
- No pgTAP/contract/golden here (no DB change, no shared instruction surface touched).

## Staging verification
Read-only (rule 48). The authoritative proof that the function is gone is the CI inventory gate plus the updated
Vitest suite — both run against the committed source, not a live service, and are the right place for this check. No
staging invoke is used to confirm the removal: invoking a Supabase edge function is a POST, and the staging network
guard aborts every non-GET, so such a probe could not run read-only. A read-only staging spec, if added at all, does
no more than sign in as the test user (`a27552a3-0257-4305-8ed0-351a80fd3701`) and load a GET-only page; it never
invokes a function and never writes. No production probe (rules 31/31b/48). exafy-admin-only / server-gated
behaviours are proven by Vitest, since staging writes to the production Supabase project.

## Rollout
Code-only; dark-exempt as stated in ## Fix. Kiro PR → reviewer_seat review → Project Manager merge → staging deploy →
STAGING-VERIFY → Gate 2 → PUBLISH. No DB apply (no migration). No owner-only step. Deleting the unused function is
reversible by reverting the PR; no data is touched.

## Risks
- A hidden consumer of `linkedin-import` (removed function). Mitigation: the lane greps both repos for
  `functions.invoke('linkedin-import'` and any string reference before deleting; VTID-05049 already recorded that
  `social-media-import` replaced it and nothing calls it.
- The inventory gate over-fits or misses a function. Mitigation: it enumerates directories under
  `supabase/functions/**` and checks for the gate import or allowlist membership, so a new ungated function fails CI.
  Running as a node script in the `"test"` chain (not a vitest file outside the `include` glob) is what guarantees it
  actually runs — a `.test.ts` under `supabase/functions/**` would be silently skipped and the gate would never fire.
- Deleting `linkedin-import` breaks the existing collected suite `src/lib/edge-functions-caller-identity.s4.test.ts`
  (it reads the gone file). Mitigation: that file is in the lane `paths` and T2a updates its four `linkedin-import`
  assertions in the same PR, so `npm test` stays green; the suite still covers `social-media-import`/`fetch-user-context`.

## Out of scope
- Everything already CLOSED above (S-A..S-I, S-K, S-L, S-M, WS10 a–d) — do not re-touch shipped code or migrations.
- The gateway-side **generated route inventory**, the **realtime-channel RLS** (`system-notifications`,
  `user:<id>:calls`), the DB lint and the isolation/golden suites — all WS0 (M0 foundation), each its own sparred slice.
- Any tenancy resolution / policy classification (WS1), data cleanup (WS2), Network layer (WS3).

## Depends on
- Done VTIDs this spec builds on and must not duplicate: VTID-05040 (S-A), VTID-05041 (S-B/S-D), VTID-04981 (S-C),
  VTID-05043 (S-E), VTID-05042 (S-F/S-L), VTID-05044 (S-G), VTID-05049/05120 (S-H), VTID-05048 (S-I), VTID-05030 (WS10
  tokens), VTID-05031 (WS10 webhooks), VTID-05055 (WS10 confirmation/audit), VTID-05147 (S-M).
- No lane in another mt-* spec; no lane dependency inside this spec (single lane).

## Owner decisions
None new. The dark-by-default exception for this code-only, member-invisible lane is stated in ## Fix for the record
(same shape as the exafy-only exception in the mt-spec example). D13 (no synthetic tenant in production) and the
production-read-only posture stand.
<!-- plan:end -->

## Open questions for sparring
- S-J's remaining realtime-channel exposure is only enumerable once WS0's generated route/channel inventory exists.
  Confirm the cross-spec intent that realtime-channel RLS lives in WS0 (M0), not Track S — this spec assumes so and
  plans only the in-repo dead-code + inventory-test half.
