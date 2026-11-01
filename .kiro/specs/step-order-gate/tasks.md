# Tasks — step-order-gate
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `kiro/step-order-gate/land-guard`; title
`VTID-xxxxx (step-order-gate/land-guard): …`; trailers; `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: land-guard -->
## Lane `land-guard`
- [ ] T1 `step-order-gate.test.mjs` per plan §4, red on `origin/main`.
- [ ] T2 `step-order-gate.mjs` per plan §3 1–5.
- [ ] T3 `common-rules.md` rule 13 and `lane-land.md` steps 3d / 3f per plan §3.
- [ ] T4 `node --test scripts/collab/*.test.mjs`, the steering guard, preflight; the lane itself is landed and closed
      with `step-order-gate.mjs merge` / `release` (dogfood), recorded in `commands.log`.

**Acceptance**
- Each command refuses exactly the cases in plan §3 and never calls merge or release on a refusal.
- `checks` uses the latest attempt per check and never passes on zero checks.
- `release` reads `origin/main` and refuses while the lane (or, for `_plan` / heartbeat, any lane or the plan) is not
  `done` / `parked`.
- Only the lane paths change; `queue.mjs` and other protected files are untouched; deploys nothing.
