---
lane: access-token-hook-shadow
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/migrations/20261102032000_vtid_*_access_token_hook_shadow.sql
  - supabase/migrations/20261102032100_vtid_*_tenant_claim_mismatch_log.sql
  - supabase/migrations/20261102032000_vtid_*_access_token_hook_shadow_rollback.sql
  - supabase/tests/mt_identity_hook_*.sql
updated: 2026-11-01T15:00Z
repos: [exafyltd/vitana-platform]
---
# access-token-hook-shadow — custom access-token hook in SHADOW only (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `access-token-hook-shadow` group of `tasks.md`
(S1–S3, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence.

Scope:
- The hook function reads the active `user_tenants` membership and treats `app_metadata.active_tenant_id` as a
  preference only.
- It emits `tenant_id_shadow` ONLY and fails open: `EXCEPTION WHEN OTHERS` returns the original claims. It does a
  single indexed lookup under a short statement timeout.
- Add the `tenant_claim_mismatch_log` table for the 7-day soak. It is service-role-only: REVOKE from PUBLIC, anon
  and authenticated, RLS on, no policy.
- Migrations only. No access-token hook exists in `supabase/migrations/**` on `62990ce285`.

Out of scope here: the hook GO-LIVE (emitting a real `tenant_id`) and its Supabase auth-config enablement. That is a
separate later lane, applied by the owner per D14.

Rules (§7a): migration files in this PR, and no live write. After merge, Kiro applies them only on the owner's
approval of the files and the target database (§7d). Branch `kiro/mt-identity-r2/access-token-hook-shadow`. PR
title `VTID-xxxxx (mt-identity-r2/access-token-hook-shadow): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-identity-r2/access-token-hook-shadow`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/access-token-hook-shadow`. Re-verified that no hook exists in the current migrations.
