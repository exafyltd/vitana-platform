# Requirements — mt-track-s (Track S security hotfixes + Health Phase 0 live defects)

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, §3 Track S; WS10 Health Phase 0 live defects). This spec links the
program's records and the shipped VTIDs rather than copying them.

## Program position
- **Predecessor:** none — Track S is the program's first, highest-priority workstream ("fix first", §3).
- **Successor:** WS0 (guard rails & test env), WS1 (identity/tenancy resolution & policy classification). This spec
  explicitly leaves the gateway-side generated route inventory, the DB lint, the isolation/golden suites and the
  realtime-channel RLS to WS0 (M0), each its own sparred slice.

## Status of Track S / WS10 (verified in current code 2026-10-15)
Almost all of Track S has shipped. Full evidence with current `file:line` is in `plan.md` ## Problem. Summary:

| Item | Status | Closed by |
|---|---|---|
| S-A debug/context-bootstrap anonymous | CLOSED | VTID-05040 |
| S-B memory DEFINER functions open to members | CLOSED | VTID-05041 |
| S-C fn_consume_credits open to members | CLOSED | VTID-04981 |
| S-D get_user_profile_by_identifier returns email | CLOSED | VTID-05041 |
| S-E switch_to_tenant_by_slug self-enrol any slug | CLOSED | VTID-05043 (+ VTID-05147) |
| S-F tenant-admin cross-tenant audit/community reads | CLOSED | VTID-05042 (+ VTID-05147) |
| S-G invitations accept/role allowlist | CLOSED | VTID-05044 |
| S-H edge functions trust body user_id | CLOSED | VTID-05049, VTID-05120 |
| S-I caller-supplied tenant/user headers | CLOSED | VTID-05048 |
| S-J debug routes + route inventory | PARTIAL — residual OPEN | VTID-05040/05049 (debug routes); this spec (residual) |
| S-K billing unscoped maybeSingle | CLOSED | (current `billing.ts`/`billing-repository.ts`) |
| S-L tenant-admin sees all tenants' lab data | CLOSED | VTID-05042, VTID-05055 |
| S-M member role/membership escalation | CLOSED | VTID-05147 |
| WS10 (a) plaintext OAuth tokens | CLOSED | VTID-05030 |
| WS10 (b) webhooks fail open without secret | CLOSED | VTID-05031 |
| WS10 (c) unlogged partner-staff reads | CLOSED | VTID-05055 (+ VTID-05042) |
| WS10 (d) staff link without member confirmation | CLOSED | VTID-05055 |

## This slice (lane `s-j-route-inventory`, vitana-v1)

### R1 — Remove the dead `linkedin-import` edge function (EARS)
1. WHEN the spec's lane merges THE SYSTEM SHALL no longer ship
   `vitana-v1/supabase/functions/linkedin-import/**` — VTID-05049 recorded that nothing calls it (`social-media-import`
   replaced it) and flagged it for removal in the Track S route inventory (S-J).
2. BEFORE deletion THE lane SHALL confirm no app or edge code references `linkedin-import` (string / `functions.invoke`
   search in both repos); IF a live consumer is found THE lane SHALL stop and record it rather than delete.
3. WHEN the function is deleted THE lane SHALL also remove its `[functions.linkedin-import]` registration from
   `vitana-v1/supabase/config.toml`, so no registration of a deleted function remains.
4. WHEN the function is deleted THE lane SHALL update the collected vitest suite
   `vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts` to no longer reference `linkedin-import`, so
   `npm test` stays green while `social-media-import`/`fetch-user-context` coverage is preserved.

### R2 — Edge-function caller-auth inventory gate (EARS)
1. THE repo SHALL carry a node check script (`scripts/check-edge-function-auth.mjs`, wired into `package.json` `"test"`
   beside the existing `check-*.mjs` gates) that exits non-zero IF any edge function under
   `vitana-v1/supabase/functions/**` neither gates the caller (imports `_shared/caller-auth.ts` or calls `requireUser`)
   NOR appears on an explicit public allowlist with a stated reason.
2. THE gate SHALL fail IF `linkedin-import` reappears without a gate.
3. THE gate SHALL be a node script in the `"test"` chain, not a vitest `.test.ts`, because `vitest.config.ts` `include`
   is `src/**/*.test.{ts,tsx}` and would never collect a test under `supabase/functions/**`.

### R3 — No behaviour change reachable by a member
1. THE lane SHALL add no App.tsx route (no nav-registry / screen-manifest / parity-ledger change), SHALL change no
   support/operator/role surface (42c/42e/42h untouched), and SHALL add no migration.

## Not in this slice
- Any still-shipped Track S item above (do not re-touch).
- The gateway-side generated route inventory, realtime-channel RLS (`system-notifications`, `user:<id>:calls`), DB
  lint, isolation suite, Maxina golden suite — WS0 (M0).
- Tenancy resolution/policy classification (WS1), data cleanup (WS2), Network layer (WS3), provisioning (WS4).
