---
lane: native-tenant-switch
state: ready
next_actor: owner
depends_on: [switch-tenant-rpc-db]
executor: kiro
seat: exafy
reviewer_seat: exafyltd
paths:
  - apps/mobile/src/identity/**
  - apps/mobile/src/screens/tenant/**
  - apps/mobile/app/+native-intent.tsx
  - apps/mobile/app/(public)/**
  - apps/mobile/tests/tenant-switch.test.tsx
  - apps/mobile/parity/ledger.json
updated: 2026-10-17T13:30Z
---
# Native active-tenant switch + picker/join + universal-link routing — mt-native-health (repo vitana-v1)

Plan: `.kiro/specs/mt-native-health/plan.md` (native-tenant-switch) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID. Depends on `switch-tenant-rpc-db` only for the per-device transport
flag; the active-tenant switch itself already works client-side — `apps/mobile/src/identity/TenantProvider.tsx:112-126`
already calls `switch_to_tenant_by_slug`, maps 42501 → `not_joinable`, does `refreshSession()`, gates on the new claim
and re-validates the stored slug. This lane adds ONLY the DELTA: an in-app community picker (`list_public_tenants`), a
"join this community" screen reached on `not_joinable`, and `/<slug>` universal-link routing through
`apps/mobile/app/+native-intent.tsx` — never a parallel client switch and never a silent Maxina default. The spec lives
in vitana-platform; this lane's code is in vitana-v1 (`queue.mjs` reads the lane there, VTID-05213) — open the PR in
vitana-v1, branch `kiro/mt-native-health/native-tenant-switch`.

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy, no live writes, and never call the switch RPC
against any live system (fixture/local stack only). Work only inside the allowed paths. 11 locales DE-first du-form +
RTL; no Maxina constant beyond store identifiers (D16); update `parity/ledger.json`
(`node scripts/native/parity-ledger.mjs --sync`). This lane adds its own `docs/validation/<vtid>/` (plan-sparring copy,
scope.json, staging-tests.json) — not in `paths`.

PR title `VTID-xxxxx (mt-native-health/native-tenant-switch): …`; trailers `Collab-Session: <id>`,
`Collab-Lane: mt-native-health/native-tenant-switch`.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). `switchActiveTenant(slug)` → RPC → `refreshSession()` → gate tenant-data queries on the matching
claim; community picker (`list_public_tenants`) + "join this community"; `+native-intent.tsx` routes `/<slug>` to the
switch, never a silent Maxina default.

### 2026-10-17T13:30Z · kiro-hotmail-202610151618-b437 · internal-review fix (ready)
Internal review HIGH W2: the client switch, `refreshSession()`, claim-gate and stored-slug re-validation already exist
in `TenantProvider.tsx:112-126` and call `switch_to_tenant_by_slug`. Re-scoped this lane to the delta only (picker,
join screen on `not_joinable`, `/<slug>` routing via `+native-intent.tsx`); it no longer describes building the switch
from scratch and reuses the existing RPC. `paths` unchanged (already covered the delta files).
