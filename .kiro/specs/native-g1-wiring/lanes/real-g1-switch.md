---
lane: real-g1-switch
state: ready
next_actor: kiro
depends_on: [vitana-v1-verified, deep-link-push-smoke]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/env/test-g1.g1.example.json
  - docs/validation/g1/**
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-10-20T08:41Z
vtid: VTID-05251
---
# Point a test-g1 build at the REAL G1 backend (decision 5) — DEPENDS ON OWNER
Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: real-g1-switch -->` (tasks G1–G3) are authoritative. VTID: assigned by CI after PLAN-SPAR
converges; do not start before `vtid:` is set here.
**OWNER GATE — do not start the switch step (G3) until the owner provisions G1.** The G1 isolated test
backend (test Supabase project + Aurora test cluster behind the `postgrest-aurora` proxy) is an owner-only
gate that does not exist yet (program §2a `NATIVE-APP-PLAN.md:95`; `.kiro/specs/health-native/handoff.md:52`
"Waiting on the owner" #4). This lane stays `ready` with `next_actor: owner`; no Kiro/Claude session runs
G3 until the owner marks G1 available and supplies the real G1 `test-g1` profile inputs. G1/G2 (document
shape + procedure) can be written now; the switch itself waits.
**Goal.** Document the shape of the real G1 inputs (`apps/mobile/env/test-g1.g1.example.json`, keys only,
`<provided-by-owner>` placeholders — never real values) and the switch procedure
(`docs/validation/g1/README.md`): set the `test-g1` profile to the owner-provided real G1 Supabase +
Aurora-proxy endpoints, re-run the `deep-link-push-smoke` suite against real G1 on both platforms (program
§5 Wave 1 exit), record the evidence. `assertNotProduction` still gates every URL; never production or
staging.
**Acceptance (the reviewer seat checks these):**
- The example file lists exactly the required keys with placeholder values; no real/secret endpoint
  committed.
- `docs/validation/g1/README.md` states the switch + re-run-smoke + record procedure and the never-prod
  guard.
- G3 is marked owner-gated and not performed in this PR; when the owner acts, the real-G1 smoke evidence
  lands in `docs/validation/g1/`.
- **Lane scope** green; `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json`, `plan-sparring.md`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no
writes to Supabase/AWS, no test against production; never point a build at production or staging; the real
G1 switch is the owner's to trigger.
## Log
### 2026-10-17T10:56Z · <kiro-session-id> · created → ready
Lane drafted with the plan, `next_actor: owner`. Its own files (`env/test-g1.g1.example.json`,
`docs/validation/g1/**`) so the four buildable lanes never block on the owner gate. Depends on
`deep-link-push-smoke` (the suite re-run against real G1). Next: PLAN-SPAR spars the plan; the document
tasks (G1–G2) can be done once a VTID is set, but the switch (G3) waits for the owner to provision G1.

### 2026-10-20T08:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05251 allocated after policy approval (converged-auto-v1).
