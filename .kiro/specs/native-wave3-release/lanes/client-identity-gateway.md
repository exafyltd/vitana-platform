---
lane: client-identity-gateway
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: backend
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/client-identity/**
  - services/gateway/test/client-identity*
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-07T10:33Z
---
# Gateway classification of native, Appilix and web requests (adoption measurement, gateway side)
Plan: `.kiro/specs/native-wave3-release/` — `plan.md` (decision 2) and the `tasks.md` section marked
`<!-- lane: client-identity-gateway -->` (tasks G1–G3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** Classify each request as `native` (from `X-Vitana-Client`), `appilix` (the Appilix web view) or `web` (the
fallback, and any missing or malformed header). Count distinct active members per class as aggregates. Member
identifiers are not stored in new tables.

**Acceptance (reviewer: hotmail):** Jest tests cover the three classes, a missing header and an unknown version; the
count query is read-only; a read-only staging probe of `preview-aws-gateway.vitanaland.com` proves a native and a web
classification and writes nothing. Governance checks green.

**Never:** no write to user data, no call to the production gateway or database from a session tool, no alteration of
the existing `AI-27` routing rule, no VTID by hand.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → ready
Drafted with the plan. Owner-visible numbers come only from the owner-run query described in the plan.
