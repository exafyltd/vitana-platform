# Requirements — mt-guardrails (WS0 guardrails and test tooling)

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, owner-approved 2026-10-10). This spec is the Kiro-readable
hand-off of WS0 ("Guard rails & test env", the M0 blocker). It links the program's records instead of
copying them.

## Program position
- **Predecessors (done, in production):** VTID-05147 (S-M), VTID-05149 (A — `tenants.is_default`,
  `TenantContext`, `ci_tenant_isolation_health()`), VTID-05150 (B), VTID-05151 (C). Records under
  `docs/validation/VTID-0514{7,9}/` and `docs/validation/VTID-0515{0,1}/`,
  `docs/multitenancy/MIGRATION-QUEUE.md`, `docs/multitenancy/LANE-C.md`.
- **Successors (depend on this spec):** WS1 identity/resolver (`tenant_id_for_policies()`, policy
  classification — consumes the bare-policy count and inventories here); mt-identity owns
  `isHealthTable()` (CROSS-SPEC O1) which this spec's lints reference; mt-packs P4 regenerates the
  `v1-golden-edge` golden fixture (CROSS-SPEC O3).

## Program goal (linked, not copied)
`docs/MULTI-TENANT-PLAN.md` §1. WS0 delivers the guardrails that must exist before any isolation code:
a local test stack, generated inventories, DB and gateway lints, pgTAP isolation, contract tests, the
Maxina golden suite and a MIGRATION-QUEUE CI check — all read-only against production, nothing deployed.

## Requirements (EARS)

### R1 — Local test stack and fixtures (lane `local-test-stack`, D11)
1. THE SYSTEM SHALL provide a committed local Supabase stack config snapshot whose schema comes from a
   production *schema* dump (structure only), never production data.
2. THE SYSTEM SHALL seed fixture tenants T_A and T_B and members a_member, a_admin, b_member, b_admin,
   ab_dual, with a `CANARY_A_<uuid>` marker in representative T_A rows.
3. THE stack SHALL be brought up and seeded by a committed script with no call to any live system.

### R2 — Generated inventories and DB lint (lane `generated-inventories`)
1. THE SYSTEM SHALL generate (never hand-list) inventories of tables, functions, routes, edge
   functions, realtime tables and storage buckets from the local schema.
2. THE SYSTEM SHALL lint for nullable `tenant_id`, missing tenant policy, SECURITY DEFINER without a
   revoke/caller check, realtime tables without tenant RLS, and storage policies, honouring an
   owner-tagged allowlist file.
3. THE SYSTEM SHALL count bare `current_tenant_id()` policies (no `auth.uid()`/`current_user_id()`/
   `is_member`/`is_tenant_admin`, outside the allowlist) and report the current count (the N3 gate reads
   this; WS0 does not force it to 0).

### R3 — pgTAP isolation suite (lane `pgtap-isolation-suite`)
1. WHEN run against the local stack THE pgTAP suite SHALL assert that b_member reads 0 T_A rows on each
   of the 18 tenant tables and the health tables (health list via mt-identity `isHealthTable()`).
2. THE suite SHALL assert that a write by b_member with a T_A `tenant_id` fails, and that ab_dual reads
   and writes a single health series.

### R4 — Gateway tenant-scope lint and contract tests (lane `gateway-scope-lint-contract`)
1. THE lint SHALL fail a gateway repository that reads tenant from a header or query parameter outside
   admin routes.
2. THE route-inventory test SHALL require every route with no auth middleware to be on a committed
   public allowlist.
3. THE contract tests SHALL assert no `CANARY_A` value appears in response bodies for route×role×tenant
   combinations, including edge functions called with no JWT, the anon key, or as b_member.

### R5 — Maxina golden suite (lane `maxina-golden-suite`, rule 41)
1. THE golden suite SHALL assert byte-identical assembled instruction/intents and UI/push/email strings
   rendered with Maxina config for persona, pre-login, greetings, journey-modes, first-time welcome,
   push copy, What's New drafter, OG previews, signup default tenant and role routing.
2. THE suite SHALL NOT compare spoken output (rule 41).
3. THE suite SHALL own the `v1-golden-edge` fixture that mt-packs P4 regenerates (CROSS-SPEC O3).

### R6 — CI wiring and MIGRATION-QUEUE check (lane `ci-wiring`, governance)
1. THE SYSTEM SHALL run R2–R5 in CI, report-only first (the PR-GATE `config.json` enforce pattern),
   then enforcing.
2. THE SYSTEM SHALL add a CI check that validates `docs/multitenancy/MIGRATION-QUEUE.md` (shape, apply
   order, one row per migration file), replacing the current review rule.

## Not in this spec
Policy classification / resolver cutover (WS1); membership unification; the access-token hook (D14);
WS2 data cleanup; any migration altering a policy or `current_tenant_id()`; health/commerce/native
isolation beyond the referenced table list. Each is its own sparred slice.
