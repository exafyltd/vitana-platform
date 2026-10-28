# Tasks — step-order-guard
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `kiro/step-order-guard/land-guard`; title
`VTID-xxxxx (step-order-guard/land-guard): …`; trailers; `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: land-guard -->
## Lane `land-guard`
- [ ] T1 `step-order-guard.test.mjs` per plan §4, red on `origin/main`.
- [ ] T2 `step-order-guard.mjs` per plan §3 1–5.
- [ ] T3 `common-rules.md` rule 13 and `lane-land.md` steps 3d / 3f per plan §3.
- [ ] T4 `node --test scripts/collab/*.test.mjs`, the steering guard, preflight; the lane itself is landed and closed
      with `step-order-guard.mjs merge` / `release` (dogfood), recorded in `commands.log`.

**Acceptance**
- Each command refuses exactly the cases in plan §3 and never calls merge or release on a refusal.
- `checks` uses the latest attempt per check and never passes on zero checks.
- `release` reads `origin/main` and refuses while the lane (or, for `_plan` / heartbeat, any lane or the plan) is not
  `done` / `parked`.
- Only the lane paths change; `queue.mjs` and other protected files are untouched; deploys nothing.
- **R2-F1 (converging round, minor):** correction to plan §3. `driver.md` step 6 describes the merge inline and does
  not refer to `lane-land.md` or bind `common-rules.md`. The follow-up for #4392 is therefore to route `driver.md`
  step 6 through `land-guard.mjs merge`, bind `common-rules.md` rule 13 (or repeat it in `driver.md`), and point step 9
  at `land-guard.mjs release` / `release-heartbeat`. It is posted on #4392.
