# Tasks — loop-catalog-gate-invariants

<!-- lane: owner-gate-invariants -->
- [ ] T1 Confirm the coverage test fails on the base with `Expected: 29, Received: 28` (CI on the base commit).
- [ ] T2 Add `"GATE-INVARIANTS"` to the `workflows` list of loop `L5` in `services/gateway/specs/loop-catalog-v1.json`.
- [ ] T3 CI: the gateway shards pass on the PR head; `loop-catalog.test.ts` green.

Acceptance:
- Change types: CI, data.
- **Outcome** — the coverage test passes on `main` and on the PR head.
- **States** — the workflow is owned by exactly one loop; no other loop changes.
- **Surfaces** — the catalog is read by `loop-catalog.test.ts` and `src/services/loop-catalog.ts`.
- **Contract** — the JSON shape is unchanged; only one list gains one name.
- Diff only inside the lane `paths`: `services/gateway/specs/loop-catalog-v1.json`.
