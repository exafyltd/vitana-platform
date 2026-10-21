---
slug: plan-spar-vitana-v1-ref
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: in-review
updated: 2026-10-21T22:03Z
sparring_record: .kiro/specs/plan-spar-vitana-v1-ref/sparring/verdict.md
vtids: [VTID-05299]
---
# Handoff — plan-spar-vitana-v1-ref

Lets a plan PR declare a companion `vitana-v1` ref in `handoff.md` front matter (`spar_refs:`) and
forwards it to the gateway as `extra_refs`, so a plan that spans both repos can be sparred against
`vitana-v1` too. The gateway already accepts and uses `extra_refs` (`plan-sparring-service.ts:108–117`,
`:266`); `vitana-v1` is already an allowed repo (`github-tools.ts:21`). The only missing link is
upstream: `plan-spar.mjs` never forwarded a companion ref and the plan PR had no typed place to
declare one. Generalizes the always-`main` `--extra-ref-vitana-v1` arg landed by VTID-05215 (PR #4201)
into a per-plan, reviewable declaration.

Plan: `plan.md` (between the plan markers — what PLAN-SPAR spars). Requirements, design, design
review and tasks alongside. Drafted — sparred by PLAN-SPAR; VTID allocated on convergence by CI
policy approval, and the lane then flips from `next_actor: claude` to `kiro`.

This spec's own code lives entirely in `vitana-platform` (`scripts/collab/**`,
`.github/workflows/PLAN-SPAR.yml`), so it declares **no** `spar_refs` of its own — PLAN-SPAR spars it
against `vitana-platform` only, which is correct.

Lanes:
- `wire-extra-refs` — repo vitana-platform, executor **kiro** (seat `exafy`, reviewer `jtadic`).
  `scripts/collab/plan-spar.mjs` (`parseSparRefs`, `resolveRef`, `extra_refs` wiring),
  `.github/workflows/PLAN-SPAR.yml` (one `env:` line for the token), plus the unit tests in
  `scripts/collab/plan-spar.test.mjs`. **This lane intentionally touches governance paths**
  (`.github/workflows/**`, `scripts/collab/**`) — it is a governance-path lane; the PR-GATE **Lane
  scope** check expects those paths from an `executor: claude`-class change, and this lane is built in
  the Stage A governance lane that is authorized for them. HELD at `next_actor: claude` until
  PLAN-SPAR allocates the VTID on policy approval.

## Log

### 2026-10-15T22:03Z · kiro-202610152203-0347 · drafted
Authored the plan( scaffolding (plan.md with plan:begin/plan:end, tasks.md, this handoff) alongside
the accepted requirements.md / design.md / design-review.* (not re-reviewed). Grounded in the real
code: `plan-spar.mjs` `step()` single `client.create` at `:192–195`, the gateway `extra_refs`
validator/merge at `plan-sparring-service.ts:108–117`/`:266`, and the already-merged VTID-05215
`--extra-ref-vitana-v1` arg on `main` (this plan generalizes it). No VTID allocated by this session —
VTIDs come only from PLAN-SPAR convergence → policy approval. Pushed as the plan( PR for PLAN-SPAR to
spar. Next: PLAN-SPAR round 1.

### 2026-10-19T23:07Z · ci-plan-spar · drafted → sparred
Converged; approved by policy converged-auto-v1. VTID allocation is off — next_actor claude allocates.

### 2026-10-21T11:21Z · ci-plan-spar · sparred → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.

### 2026-10-21T22:03Z · kiro-202610152203-0347 · approved → in-review
Implementation (`b38076f91`) merged into the PR head branch (#4202); the single `plan-spar.test.mjs`
conflict was resolved keeping both the VTID-05273 late-lane suite and the lane's `spar_refs:` AC tests.
PR retitled to the VTID-05299 form. Lane `wire-extra-refs` → in-review for the reviewer agent.

### 2026-10-21T22:30Z · kiro-202610152203-0347 · ready for Claude/owner (governance-path PR)
PR #4202 is COMPLETE and ready for Claude Code / owner to clear the protected-gate check and merge.
Title `VTID-05299 (plan-spar-vitana-v1-ref/wire-extra-refs): forward a vitana-v1 ref into PLAN-SPAR`,
impl merged in (`b38076f91`), reviewed APPROVED, `scope.json` with `collab_allow_initial` added. The
only required check (`validate`) is green, along with pr-gate, unit, change-suite, scan, spar, CI
scripts, Phase 2B. **Collab handoff / Lane scope stay red by design** — the lane edits protected gate
files (`scripts/collab/plan-spar.mjs`, `.github/workflows/PLAN-SPAR.yml`) and so is a Claude/owner
governance lane per `collaboration.md §7a`; only Claude Code / owner can clear the protected-gate check
and merge. Kiro did NOT flip the lane to `executor: claude`, did NOT unlock a protected-gate file, did
NOT force-push, did NOT merge — all correct for the implementer role.

This PR is a prerequisite ONLY for future cross-repo auto-sparring (the `spar_refs` mechanism), not for
the Spotlight redesign itself.
