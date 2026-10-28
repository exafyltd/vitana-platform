# Tasks — land-guard
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `kiro/land-guard/land-guard`; title
`VTID-xxxxx (land-guard/land-guard): …`; trailers; `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: land-guard -->
## Lane `land-guard`
- [ ] T1 `land-guard.test.mjs` per plan §4, red on `origin/main`.
- [ ] T2 `land-guard.mjs` per plan §3 1–5.
- [ ] T3 `common-rules.md` rule 13 per plan §3.
- [ ] T4 `node --test scripts/collab/*.test.mjs`, the steering guard, preflight; the lane itself is landed and closed
      with `land-guard.mjs merge` / `release` (dogfood), recorded in `commands.log`.

**Acceptance**
- Each command refuses exactly the cases in plan §3 and never calls merge or release on a refusal.
- `checks` uses the latest attempt per check and never passes on zero checks.
- `release` reads `origin/main` and refuses while the lane (or, for `_plan` / heartbeat, any lane or the plan) is not
  `done` / `parked`.
- Only the lane paths change; `queue.mjs` and other protected files are untouched; deploys nothing.
