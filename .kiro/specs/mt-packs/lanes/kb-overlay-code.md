---
lane: kb-overlay-code
state: ready
next_actor: owner
depends_on: [kb-overlay-db]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/retrieval-router.ts
  - services/gateway/src/services/orb-tools-shared.ts
  - services/gateway/src/services/guided-journey/checklist-regenerate.ts
  - services/gateway/src/orb/live/instruction/live-system-instruction.ts
  - services/gateway/test/mt-packs-kb-overlay-*.test.ts
updated: 2026-10-15T19:05Z
---
# kb-overlay-code — KB baseline + tenant overlay resolution (repo vitana-platform)

Plan: `.kiro/specs/mt-packs/plan.md` (authoritative) and the `kb-overlay-code` section of `tasks.md` (K1–K3,
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

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; PLAN-SPAR flips it to `kiro`.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Branch
`kiro/mt-packs/kb-overlay-code`; PR title `VTID-xxxxx (mt-packs/kb-overlay-code): …`; trailers
`Collab-Session: <id>` / `Collab-Lane: mt-packs/kb-overlay-code`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-packs planner. Seat `jtadic` (platform gateway), reviewer `exafy` (≠ seat). `depends_on`
kb-overlay-db (needs the `knowledge_docs.tenant_id` column). Held at `owner` pending VTID.

### 2026-10-15T19:05Z · kiro-hotmail-202610151618-b437 · internal-review fix (round 2)
MEDIUM-1: removed the false `area: backoffice` label. Verified against `docs/programs/areas.yaml`: `backoffice`
covers only `routes/backoffice-*.ts` and `services/backoffice*/**`; this lane's paths (`retrieval-router.ts`,
`orb-tools-shared.ts`, `guided-journey/checklist-regenerate.ts`, `orb/live/instruction/live-system-instruction.ts`)
match no area, and no general `gateway` area exists. `area` dropped (optional); `seat: jtadic` kept. No path or
scope change.

### 2026-10-17T16:45Z · kiro-hotmail-202610151618-b437 · spar round 1 (session 1896989e) → ready
F5 (minor): clarified the lane BUILDS the pack-id resolution rather than assuming it exists. Verified
`resolveManualDir()` at `checklist-regenerate.ts:121` hardcodes `kb/instruction-manual/maxina` across five
candidates (`:124`–`:129`); `retrieval-router.ts:95` and `orb-tools-shared.ts:1991` reference the same literal.
No path change (all three files already in paths); design note added to the lane body and tasks.md K1.
