# Tasks — pipeline-agent-wake-and-review
Authoritative plan: `plan.md` (between the plan markers). VTIDs: one per lane, from CI PLAN-SPAR after policy approval;
never by hand. Branches `kiro/pipeline-agent-wake-and-review/<lane-id>`; PR titles
`VTID-xxxxx (pipeline-agent-wake-and-review/<lane-id>): …`; `Collab-Session` + `Collab-Lane` trailers; identity
`kiro-agent[bot]`; no `Co-Authored-By: Claude`. Evidence in `docs/validation/<VTID>/` (`commands.log`,
`red-on-base.txt`, `acceptance.md`, `timings.json`). Nothing outside a lane's `paths`; nothing deploys.

<!-- lane: driver-wake -->
## Lane `driver-wake` (vitana-platform; executor kiro; reviewer agent)
- [ ] W1 `scripts/collab/driver-wake.test.mjs` per plan §3 lane 1 item 6, written first, red on `origin/main`.
- [ ] W2 `scripts/collab/driver-wake.mjs` (`decide`, marker write, CLI) per items 1-3.
- [ ] W3 `.kiro/automations/wake.md` per item 4; `docs/kiro/driver-wake.md` (setup of `KIRO_API_KEY`, what a wake
      does, how to switch it off: delete the secret).
- [ ] W4 `.github/workflows/DRIVER-WAKE.yml` per item 5; `actionlint` if available; a dry run with
      `workflow_dispatch` input `dry_run: true` on a real plan slug, recorded.
- [ ] W5 `node --test scripts/collab/*.test.mjs`, preflight.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs (governance paths, no protected gate file).
- The prompt passed to Kiro is a constant plus a slug that matched `SLUG_RE`; no PR/commit text reaches it.
- A live driver, a recent marker or the hourly budget each prevent a wake (tests); a missing `KIRO_API_KEY` is a
  green no-op with a summary line.
- `wake.md` never merges, never publishes, and points to driver.md rather than restating it.

<!-- lane: reviewer-fallback -->
## Lane `reviewer-fallback` (vitana-platform; executor claude; protected gate files)
- [ ] R1 Tests of plan §3 lane 2 item 7 (governance, guard, reviewer-qualify), written first, red on `origin/main`.
- [ ] R2 `governance.ts` items 1 and 4; `REVIEWER_AGENT_INDEPENDENT_MODELS` empty.
- [ ] R3 `.kiro/agents/vitana-lane-reviewer-independent.md` and the `guard.cjs` pin (item 2).
- [ ] R4 `scripts/collab/reviewer-qualify.mjs` and `docs/reviewer-qualification/README.md` (item 3).
- [ ] R5 `protected-gate-files.json` + `queue.mjs` `PROTECTED_GATE_BUILTIN` + `governance.ts` `PROTECTED_GATE_GLOBS`
      in one commit (item 4); collaboration.md §3 and §7b text (item 5).
- [ ] R6 gateway `npx jest test/project-manager`, `tsc --noEmit`; `node --test scripts/collab/*.test.mjs`;
      `node --test scripts/ci/kiro-steering/guard.test.cjs`; preflight.

**Acceptance**
- Change types: Backend (PM governance), Tooling/CI (protected gate files).
- With the list empty, no review that is accepted today changes outcome and no new identity is accepted (test).
- Each of conditions (a)-(c) is necessary (test per condition); a protected gate file still needs Claude or the
  owner.
- The three protected-list copies are equal (existing equality test extended).
- Merge only with a legacy Claude review on the current head or an owner instruction naming this plan (§3a).

<!-- lane: review-fallback-trailer -->
## Lane `review-fallback-trailer` (vitana-platform; executor kiro; reviewer agent)
- [ ] T1 `test/project-manager/observe-live-fallback-reason.test.ts` per plan §3 lane 2b item 3, red on `origin/main`.
- [ ] T2 `ReviewEntry.fallback_reason` (`types.ts`) and the trailer parse in `observe-live.ts` (items 1-2).
- [ ] T3 gateway `npx jest test/project-manager`, `tsc --noEmit`, preflight; staging-tests.json (read-only: gateway
      alive, PM mode endpoint serves).

**Acceptance**
- Change types: Backend (PM observer).
- No decision changes: no code reads the new field in this lane (diff).
- Trailer present / absent / other value each tested.

<!-- lane: plan-pr-merge -->
## Lane `plan-pr-merge` (vitana-platform; executor claude; protected after `reviewer-fallback`)
- [ ] M1 `scripts/collab/plan-merge.test.mjs` per plan §3 lane 3 item 3, red on `origin/main`.
- [ ] M2 `scripts/collab/plan-merge.mjs` (item 1) and `.github/workflows/PLAN-PR-MERGE.yml` (item 2).
- [ ] M3 `workflow_dispatch` dry run against an open converged plan PR and a non-converged one; both decisions
      recorded.
- [ ] M4 `node --test scripts/collab/*.test.mjs`, preflight.

**Acceptance**
- Change types: Infrastructure/CI (merge authority).
- Every §7b plan-PR condition is checked; any failing one → no merge, a reason line, job green.
- `GITHUB_TOKEN` only, no `--admin`, merge pinned to the checked head sha.

<!-- lane: v1-collab-sync -->
## Lane `v1-collab-sync` (vitana-v1; executor kiro; reviewer agent)
- [ ] V1 Copy `.claude/rules/collaboration.md` from platform `origin/main` after `reviewer-fallback` merges; record
      both sha256 values.
- [ ] V2 v1 guard / preflight with the v1 checkout as `--repo`.

**Acceptance**
- Byte-identical to platform; the diff against v1 base is only the text lane 2 added.
