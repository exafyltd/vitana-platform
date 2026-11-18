---
lane: client-identity-store
state: ready
next_actor: kiro
depends_on: [client-identity-gateway]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: backend
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/middleware/client-identity.ts
  - services/gateway/src/index.ts
  - services/gateway/src/services/client-adoption/**
  - supabase/migrations/*_client_identity_daily_seen.sql
  - DATABASE_SCHEMA.md
  - services/gateway/test/client-adoption*
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:07Z
vtid: VTID-05658
---
# Gateway middleware, daily-seen storage and adoption query (adoption measurement, gateway side)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 2) and the `tasks.md` section marked
`<!-- lane: client-identity-store -->` (tasks S1–S3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** Mount one middleware that echoes the request class (`native` or `web`, from the classifier of lane
`client-identity-gateway`) and records one best-effort row per (day, tenant, member, class) in `client_identity_daily_seen`;
add the read-only adoption query where the `appilix` class is derived per member from `user_device_tokens` labels
`Appilix %`. Only aggregates leave the table. The migration file is in this lane's PR; applying it needs the owner's
approval of the file and the database (§7d).

**Acceptance (reviewer agent):** Jest tests cover the middleware and the adoption query (native-only, Appilix-only,
both, plain-web); the count query is read-only; a read-only staging probe proves the echoed class for a native and a
no-header request and writes nothing. Governance checks green.

**Never:** no write to user data, no call to the production gateway or database from a session tool, no migration
applied by a session, no VTID by hand.

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/client-identity-store`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05658 allocated after policy approval (converged-auto-v1).
