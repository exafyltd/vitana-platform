# Plan — plan sparring forwards a companion `vitana-v1` ref

A plan PR declares companion repo refs in `handoff.md` front matter (`spar_refs:`); `plan-spar.mjs`
resolves each to a 40-hex SHA and forwards `extra_refs` to the gateway so the sparring partner can
`read_file` against `vitana-v1`. Absent → byte-identical no-op.

<!-- plan:begin -->
## Problem

A plan PR that spans both repos (a `vitana-platform` backend change with a companion `vitana-v1`
frontend change) cannot be sparred against the `vitana-v1` side. The CI sparring client
(`scripts/collab/plan-spar.mjs`, `step()`) calls `client.create({ plan_text, producer, change_class,
base_ref, repo, approval_policy })` with **no `extra_refs`** (the only `client.create`, at
`plan-spar.mjs:192–195`), so the gateway pins the partner's `read_file`/`list_dir` tools to
`input.repo` at `input.base_ref` only. Any finding about the frontend half is made blind, and the
partner's evidence rule (every finding cites a file it read) cannot be met for `vitana-v1`.

The gateway side already supports the companion ref:
- `validateCreateInput` parses and validates `extra_refs` against the repo allow-list — the
  `if (b.extra_refs !== undefined) { … }` block at
  `services/gateway/src/services/plan-sparring/plan-sparring-service.ts:108–117` (key-in-allow-list +
  `SHA_RE` value check at `:112`; the `repo` allow-list is `:106`).
- `createSparringSession` merges it into the pinned refs:
  `const refs = { ...(input.extra_refs ?? {}), [input.repo]: input.base_ref };`
  (`plan-sparring-service.ts:266`), and those refs pin the partner's tools (`makeToolExecutor(refs)`,
  `:284`) and the round-1 "Code is pinned at:" prompt line (`:142`).
- `vitana-v1` is already an allowed repo:
  `PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']`
  (`services/gateway/src/services/plan-sparring/github-tools.ts:21`).

The whole gap is upstream: the plan PR has no typed place to declare a companion commit, and
`plan-spar.mjs` never forwards one.

## Relationship to the existing `--extra-ref-vitana-v1` arg (VTID-05215, PR #4201)

VTID-05215 already landed a narrower mechanism on `main`: `PLAN-SPAR.yml` resolves `vitana-v1`'s
`main` HEAD (`gh api repos/exafyltd/vitana-v1/commits/main --jq .sha`) and passes it as a single
`--extra-ref-vitana-v1 <sha>` CLI arg, which `plan-spar.mjs` forwards as `extra_refs`. That pins
`vitana-v1@main` for **every** plan PR — it cannot pin a feature branch or a specific companion
commit, and it is not declared or reviewable in the PR diff.

This plan generalizes that into a per-plan, reviewable declaration: a plan names the exact
companion ref (branch, tag or SHA) it needs in `handoff.md` front matter, and only plans that
declare one forward it. The two can coexist — the front-matter path is additive and the design is
written so a plan that declares nothing stays byte-identical — but the intent is that the typed
`spar_refs:` declaration supersedes the always-`main` arg. Whether to retire the `--extra-ref-vitana-v1`
arg in the same lane or leave it as a fallback is a decision for the sparring partner / review (see
"Decisions deferred" below).

## Goal

Let a plan declare one or more companion repo refs and forward them as `extra_refs`, without changing
behavior for the common single-repo plan:

- A plan declares companion refs in `handoff.md` front matter under a new `spar_refs:` block list
  (`- exafyltd/vitana-v1: <branch|tag|40-hex-sha>`), read from the PR head's files that
  `plan-spar.mjs` already reads. No new secret, no new workflow input.
- `plan-spar.mjs` resolves each declared ref to an immutable 40-hex SHA (a 40-hex value verbatim with
  no API call; a branch/tag via `GET /repos/{owner}/{repo}/commits/{ref}` using the token already in
  the PLAN-SPAR job) and forwards `extra_refs = { '<repo>': <sha> }` on `create`.
- Only repos in `PLAN_SPARRING_REPOS` may be declared, and never the plan's own `--repo`; a bad
  declaration fails the step loudly (non-zero exit), never spars silently without the ref.
- **Byte-identical no-op (critical):** `spar_refs` absent → `extra_refs` stays `undefined` → the
  `create` body is byte-identical to today; `plan_text` is never touched (companion refs live in
  `handoff.md`, outside the hashed plan block), so dedup/replan detection is unaffected.

## Scope (what changes)

- `scripts/collab/plan-spar.mjs` — add a `PLAN_SPARRING_REPOS` const (mirroring
  `github-tools.ts:21`, with the gateway as the real validator), a pure exported `parseSparRefs(fm)`
  and an exported `resolveRef(repo, ref, { token, fetchImpl })`; thread `token`/`fetchImpl` through
  `step()`/`main()`; compute the conditional `extra_refs` once **before** the
  `if (!cur || retryInfra || replan)` branch (so create/retry/replan all forward the same ref) and
  spread it into the single `client.create` (`:192–195`).
- `.github/workflows/PLAN-SPAR.yml` — make the GitHub token available to the Spar step for
  `resolveRef` (one `env:` line, value `secrets.PLAN_SPAR_PUSH_TOKEN || github.token` — the same
  value already used for the head checkout at `:60`). The `run:` command line is unchanged; no new
  CLI arg.
- `scripts/collab/plan-spar.test.mjs` — the nine unit tests in design "Test plan" (all with an
  injected `client` and a test-only `fetchImpl`; no live calls).

## Out of scope

- Any gateway change — it already accepts and uses `extra_refs`. No migration, no new endpoint.
- A PR-GATE enforcement check that *blocks* a two-repo plan whose session did not pin `vitana-v1`
  (it would read `repo_refs` from `GET /api/v1/plans/spar/:id`, not the committed `sparring/` files).
  Documented as a follow-up (design F2), deliberately not built here.
- Writing `repo_refs` into `state.json` / rendering it in `renderRound()`.
- VTID allocation, approval policy, round/response flow, dedup, retry/escalation logic.
- Any `vitana-v1` `src/**` change — this lane touches only `scripts/collab/**` and
  `.github/workflows/PLAN-SPAR.yml` in `vitana-platform`.

## Verification

- Unit tests above (`node --test scripts/collab/plan-spar.test.mjs`), `node --check` on the script.
- The no-op case (no `spar_refs`) is proven by a byte-identical `create` body test, so every existing
  plan PR spars exactly as today.
- Integration (not automated here, no production write): the first real two-repo plan PR that
  declares `spar_refs` runs PLAN-SPAR on staging-gateway and shows `exafyltd/vitana-v1` in that
  session's per-round `repo_refs` (`GET /api/v1/plans/spar/:id`). Read-only, staging only.

## Decisions deferred to the sparring partner / review

- Whether this lane also retires the always-`main` `--extra-ref-vitana-v1` arg from `PLAN-SPAR.yml`
  (and the `v1Sha` handling in `plan-spar.mjs`), or leaves it as a fallback alongside `spar_refs`.
  Default in this plan: leave it, keep this lane additive and minimal; retiring it is a one-line
  follow-up once a real two-repo plan has exercised `spar_refs`.
- The exact fail-loud shape for a malformed `spar_refs` entry (anchored regex rejecting an
  inline-commented / multi-token value) — specified in design "Front-matter shape" / "Input
  validation" and covered by test 9.
<!-- plan:end -->
