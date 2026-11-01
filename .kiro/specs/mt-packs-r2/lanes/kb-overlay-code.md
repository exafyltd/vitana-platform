---
lane: kb-overlay-code
state: ready
next_actor: kiro
depends_on: [kb-overlay-db]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/retrieval-router.ts
  - services/gateway/src/services/orb-tools-shared.ts
  - services/gateway/src/services/guided-journey/checklist-regenerate.ts
  - services/gateway/src/orb/live/instruction/live-system-instruction.ts
  - services/gateway/test/mt-packs-kb-overlay-*.test.ts
updated: 2026-11-01T15:40Z
repos: [exafyltd/vitana-platform]
---
# kb-overlay-code — KB baseline + tenant overlay resolution (repo vitana-platform)

Plan: `.kiro/specs/mt-packs-r2/plan.md` (authoritative) and the `kb-overlay-code` section of `tasks.md` (K1–K3,
allowed paths, acceptance). Design + successor rules: `design.md`.

Baseline pack id defaults to `maxina` (neutral baseline id; the `kb/instruction-manual/maxina/*` directory is
NOT moved). The pack-id abstraction does not exist today and this lane BUILDS it: a single helper derives the KB
directory from a resolved pack id, replacing the hardcoded `kb/instruction-manual/maxina` in
`checklist-regenerate.ts:121 resolveManualDir()` (`:124`–`:129`), `retrieval-router.ts:95` and
`orb-tools-shared.ts:1991`. KB resolution reads the baseline then overlays `knowledge_docs WHERE tenant_id =
ctx.tenantId`; the readers (`retrieval-router.ts:95`, `orb-tools-shared.ts:1991`, `checklist-regenerate.ts:125-131`,
`live-system-instruction.ts:1282`) pass the resolved tenant. Baseline-only tenants resolve unchanged. No
cross-tenant overlay leak (WS0 isolation). **Depends on `kb-overlay-db`** (the `tenant_id` column must exist).
This lane adds its own `docs/validation/<vtid>/`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Branch
`kiro/mt-packs-r2/kb-overlay-code`; PR title `VTID-xxxxx (mt-packs-r2/kb-overlay-code): …`; trailers
`Collab-Session: <id>` / `Collab-Lane: mt-packs-r2/kb-overlay-code`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-packs/kb-overlay-code`. No scope change; lane follows today's §3a/§7 rules.
