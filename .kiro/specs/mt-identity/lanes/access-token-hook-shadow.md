---
lane: access-token-hook-shadow
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101032000_vtid_xxxxx_access_token_hook_shadow.sql
  - supabase/migrations/20261101032100_vtid_xxxxx_tenant_claim_mismatch_log.sql
  - supabase/migrations/20261101032000_vtid_xxxxx_access_token_hook_shadow_rollback.sql
updated: 2026-10-17T16:55Z
---
# access-token-hook-shadow — custom access-token hook in SHADOW (DB)

Plan: `.kiro/specs/mt-identity/plan.md`, `tasks.md` group `<!-- lane: access-token-hook-shadow -->`. Design: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID.

Scope (program plan §4.2 rollout step a): the Supabase custom access-token hook function that reads the user's active
`user_tenants` membership (validating `app_metadata.active_tenant_id` as a *preference* only) and emits
**`tenant_id_shadow` only** — never a top-level `tenant_id`. It must fail open (`EXCEPTION WHEN OTHERS` → original
claims; single indexed lookup; short statement timeout). Add a mismatch-log table that records, as decisions not
heartbeats, where the shadow claim disagrees with membership (the 7-day shadow soak). The log table is
**service-role-only**: the `…032100` migration runs `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT ALL … TO
service_role; ALTER TABLE … ENABLE ROW LEVEL SECURITY` with NO policy, so RLS denies every `authenticated`/PostgREST
read of another user's shadow-claim rows. A pgTAP test asserts the `authenticated` deny and the `service_role` admit.

**OUT OF SCOPE here, by owner rule and the brief:** the hook GO-LIVE (emitting real `tenant_id`) and its Supabase
auth-config enablement are a SEPARATE later lane, applied by the owner per D14 after the policy rewrite and
`tenant_id_for_policies()` land. This lane ships the function + log table as migrations only; it changes no auth
config. The committed enablement/disable runbook belongs to the later go-live lane.

§7a: migration files in the PR; Claude applies via RUN-MIGRATION; the owner (not any session) ever touches Supabase
auth-hook config. Add `docs/validation/<vtid>/` + MIGRATION-QUEUE rows.
Branch `kiro/mt-identity/access-token-hook-shadow`; PR title `VTID-xxxxx (mt-identity/access-token-hook-shadow): …`;
trailers `Collab-Session` + `Collab-Lane: mt-identity/access-token-hook-shadow`.

## Log
### 2026-11-01T00:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-identity planner. Verified read-only: no access-token hook exists in current migrations. Held
pending PLAN-SPAR VTID allocation.
### 2026-10-17T16:55Z · kiro-hotmail-202610151618-b437 · ready (answered sparring s2 R1-F1)
Blocker R1-F1: the net-new `tenant_claim_mismatch_log` table had no access-control spec. Added service-role-only
posture (REVOKE PUBLIC/anon/authenticated, GRANT service_role, RLS enabled with no policy = deny) + a pgTAP deny/admit
test. Paths unchanged.
