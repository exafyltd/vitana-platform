# Design — mt-track-s

## What exists (read these, do not copy them)
- Program plan and Track S enumeration: `docs/MULTI-TENANT-PLAN.md` §3 (S-A..S-L) and WS10 (Health Phase 0 live
  defects).
- The shipped fixes (verified current `file:line` in `plan.md` ## Problem):
  - S-A/S-J debug routes: `services/gateway/src/routes/orb-live.ts:15332,15421,15513,15554`.
  - S-B/S-D memory + profile functions: `supabase/migrations/20261010164100_vtid_05041_definer_functions_lockdown.sql`.
  - S-C credits: `supabase/migrations/20261008170000_vtid_04981_consume_credits_lockdown.sql`.
  - S-E switch + side-effect guard: `supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql`,
    `20261010180000_vtid_05043_s3_membership_side_effect_guard.sql`.
  - S-F/S-L audit + partner-health: `services/gateway/src/routes/tenant-admin/audit-log.ts`,
    `services/gateway/src/routes/admin-partner-health.ts`.
  - S-G invitations: `services/gateway/src/routes/tenant-admin/invitations.ts`.
  - S-H edge functions: `vitana-v1/supabase/functions/social-media-import/index.ts`,
    `vitana-v1/supabase/functions/_shared/caller-auth.ts`, `vitana-v1/supabase/functions/linkedin-import/index.ts`.
  - S-I headers: `services/gateway/src/routes/{reminders,specs,governance-controls,autopilot-prompts}.ts`,
    `services/gateway/src/controllers/governance-controller.ts`.
  - S-K billing: `services/gateway/src/routes/billing.ts`, `billing-repository.ts`.
  - S-M membership lockdown: `supabase/migrations/20261013233000_vtid_05147_s_m_membership_role_lockdown.sql`,
    `docs/validation/VTID-05147/`.
  - WS10 tokens / webhooks: `services/gateway/src/routes/wearables.ts`, `lib/connection-token-crypto.ts`,
    `services/gateway/src/connectors/runtime/webhook-signature.ts`.
- The caller-auth gate the inventory test keys on: `vitana-v1/supabase/functions/_shared/caller-auth.ts`
  (`requireUser`, `forbidden`).

## Lane `s-j-route-inventory` (vitana-v1)
- **Delete** `vitana-v1/supabase/functions/linkedin-import/**` after proving no consumer (grep both repos for
  `linkedin-import` and `functions.invoke('linkedin-import'`). VTID-05049 already recorded it is unused. Two companion
  edits make the removal complete (both verified in current code 2026-10-15):
  - **`vitana-v1/supabase/config.toml:72-74`** carries a `[functions.linkedin-import]` block (`verify_jwt = true`) — a
    registration of the deleted function. Remove it; otherwise the dead-reference S-J is closing survives in config.
  - **`vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts`** is a collected vitest suite (`src/**`) that reads
    `linkedin-import/index.ts` and asserts on it at `:77-82` (the five-functions loop), `:90-93` (profile-import loop),
    `:107-110` (`flagged for removal`) and `:198` (`arrayContaining` dir scan). After deletion `readFileSync` throws
    and the `arrayContaining` fails, so drop `linkedin-import` from those four spots, keeping the
    `social-media-import`/`fetch-user-context` cases. Both files are in the lane `paths` and neither is a governance
    path.
- **Add** the inventory gate as a standalone node script `vitana-v1/scripts/check-edge-function-auth.mjs`, modelled on
  the repo's existing `scripts/check-edge-data-client.mjs` (same `walk(supabase/functions)` shape, same non-zero-exit
  contract), and wire it into `package.json` `"test"` next to the two existing `check-*.mjs` scripts. **Why a node
  script, not a vitest `.test.ts`:** `vitana-v1/vitest.config.ts:22` sets `include: ['src/**/*.test.{ts,tsx}']`, so a
  test under `supabase/functions/**` is never collected by `vitest run`; the repo's existing edge test
  (`supabase/functions/_shared/data-client.test.ts`) is likewise driven by a node check script in the `"test"` chain,
  not vitest. The script:
  1. enumerates each directory under `vitana-v1/supabase/functions/**` that has an `index.ts`;
  2. passes a function that imports `_shared/caller-auth.ts` or calls `requireUser`/an equivalent verified-identity
     gate, OR is on an explicit, in-file allowlist of genuinely public functions (each with a one-line reason —
     e.g. a webhook that verifies a vendor signature instead of a user JWT);
  3. exits non-zero otherwise, so a new ungated function (or a re-added `linkedin-import`) reddens CI inside `npm test`.
- No migration, no gateway change, no App.tsx route. The spec folder lives in `vitana-platform`
  (`.kiro/specs/mt-track-s/`, collaboration §2) because Track S spans both repos; the lane's code is vitana-v1 only.

## Rules every successor follows
1. **Do not re-plan or re-touch a CLOSED item.** Every S-A..S-M (except the S-J residual) and WS10 a–d is live in
   production; re-granting a privilege, recreating a dropped policy or reverting a hardened route is forbidden (program
   §3; mirrors VTID-05147 AC-5 for the membership/role tables).
2. **Production is read-only** for every session and every test (CLAUDE.md 31/31b/48). The executor never writes to
   Supabase or AWS and never calls a mutating endpoint against a live system (collaboration §7a). A DB change is a
   migration file in the lane's PR — this slice has none.
3. **Dark by default** unless the plan names an exception. This lane's exception (stated in `plan.md` ## Fix): deleting
   an uncalled edge function and adding a test is not a member-reachable behaviour change, so it ships without a flag.
4. **Migration discipline (for successors, not this slice):** multi-tenant migrations take the next version in the
   spec's range and are added to `docs/multitenancy/MIGRATION-QUEUE.md` in the same PR; a not-yet-live table is added to
   `scripts/ci/migration-drift-baseline.json` and removed after apply. This spec's reserved range is
   `20261101010000`–`20261101015959` (unused — no migration here).
5. **Test/service accounts never visible to members** (rules 43–45); i18n DE-first du-form; RTL via logical properties;
   Spotlight design contract; WCAG 2.2 AA — none are touched by this code-only lane, but any later Track-S-adjacent UI
   work must honour them.
6. **What's New:** no entry — this is removal of dead code + a test, not a finished member-facing feature.
