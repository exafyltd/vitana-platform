# Plan — plan sparring forwards a companion `vitana-v1` ref

A plan PR declares a companion repo ref in `handoff.md` front matter (`spar_refs:`); `plan-spar.mjs`
reads it, overlays it (winning) on the always-on `--extra-ref-vitana-v1` CLI arg for the same key, and
forwards the merged `extra_refs` to the gateway so the sparring partner can `read_file` against
`vitana-v1`. For any repo other than the plan's own `--repo`, only a verbatim 40-hex SHA is accepted
(no cross-repo commits API call). Absent → `step()`'s `extra_refs` is exactly what the CLI arg alone
produces today.

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
companion commit (a 40-hex SHA) it needs in `handoff.md` front matter.

**Explicit precedence between the CLI arg and `spar_refs` (R1-F1, R2-F1).** Both the always-on
`--extra-ref-vitana-v1` arg and `spar_refs` target the same map key `exafyltd/vitana-v1`, so the merge
order must be pinned in code, not left to intent. The **logical precedence rule** is: the CLI-arg map
(today's `extraRefs = /^[0-9a-f]{40}$/.test(v1Sha) ? { 'exafyltd/vitana-v1': v1Sha } : null`) is the
base, and the parsed `spar_refs` overlay it (`{ ...(cliRefs || {}), ...sparRefs }`), so a plan that
declares a specific companion commit in `spar_refs` **wins** for that key and the always-`main` CLI
value is replaced; a plan that declares nothing keeps the CLI arg's value. Only when `spar_refs` is
absent AND the CLI arg resolves nothing is `extra_refs` omitted entirely.

**This is a precedence rule, not a statement of where the merge runs (R2-F1).** `main()` is unchanged:
it builds the CLI-arg map from `--extra-ref-vitana-v1` and passes it (or `null`) into `step()` as
`extraRefs`, exactly as today (`plan-spar.mjs:317-319` → the single `client.create` spread at
`:192-196`). The physical location of the `handoff.md` read, the `parseSparRefs` call, the
`{ ...(cliRefs || {}), ...sparRefs }` merge, the `resolveRef` call and the fail-loud throw is **inside
`step()`'s `if (!cur || retryInfra || replan)` create branch** — never in `main()` and never before
`step()`. Placing the merge/read in `main()` would run it on every invocation, including a `round` on
an existing in-progress session, which is exactly the R1-F3 bug (a moved/deleted companion ref
fail-louding during a round and blocking the planner from answering findings).

Because the CLI arg is still present and already sends `extra_refs` for every plan PR in production
CI, the no-op guarantee is stated precisely: **relative to `step()`'s default `extraRefs = null` (not
production CI)**, a plan that declares no `spar_refs` produces a byte-identical `create` body. The CLI
arg stays as a fallback for the common `vitana-v1@main` case; retiring it is a one-line follow-up (see
"Decisions deferred").

## Goal

Let a plan declare a companion repo ref and forward it as `extra_refs`, without changing behavior for
the common single-repo plan:

- A plan declares a companion ref in `handoff.md` front matter under a new `spar_refs:` block list
  (`- exafyltd/vitana-v1: <40-hex-sha>`). `step()` **newly reads and parses `handoff.md` front
  matter** for this (today it reads `plan.md` as the create input and only writes `handoff.md` in the
  converged/escalated branches); `handoff.md` is therefore added to this lane's `paths` scope. No new
  secret, no new workflow input. (R1-F4)
- **Trigger requirement (R1-F4):** the workflow `paths:` filter and `detectSlug` match only
  `.kiro/specs/*/plan.md` and `sparring/*responses-*.md`, never `handoff.md`, so a `spar_refs` edit
  **must accompany a `plan.md` or responses change** to fire the spar step. This lane relies on that
  (a first `spar_refs` is always introduced alongside the plan it belongs to); extending
  `detectSlug`/`paths:` to trigger on a lone `handoff.md` `spar_refs` change is a documented follow-up
  (design F3), not built here.
- **SHA-only for cross-repo (R1-F2):** `resolveRef` accepts a verbatim 40-hex SHA with **no API
  call**. Branch/tag resolution via `GET /repos/{owner}/{repo}/commits/{ref}` is **not** used for any
  repo other than the plan's own `--repo`, because the only CI tokens (`PLAN_SPAR_PUSH_TOKEN`,
  `github.token`) are scoped to `vitana-platform` and cannot read the private `exafyltd/vitana-v1`
  (the cross-repo read credential `PLAN_SPARRING_GITHUB_TOKEN` is server-side only,
  `github-tools.ts:11-14`). A non-SHA companion ref is a loud declaration error. Resolving a
  branch/tag cross-repo is deferred until a CI-accessible `contents:read` secret for `vitana-v1`
  exists (see "Decisions deferred").
- Only repos in `PLAN_SPARRING_REPOS` may be declared, and never the plan's own `--repo`; a bad
  declaration fails the step loudly (non-zero exit), never spars silently without the ref.
- **No-op relative to `step()`'s default (critical, R1-F1):** `spar_refs` absent and the CLI arg
  resolving nothing → `extra_refs` is omitted → the `create` body matches `step()` with its default
  `extraRefs = null`. (Against production CI, which already passes `--extra-ref-vitana-v1`, the body is
  unchanged from today's CLI-arg behavior, not from a no-`extra_refs` baseline.) `plan_text` is never
  touched (companion refs live in `handoff.md`, outside the hashed plan block), so dedup/replan
  detection is unaffected.

## Scope (what changes)

- `scripts/collab/plan-spar.mjs` — add a `PLAN_SPARRING_REPOS` const (mirroring
  `github-tools.ts:21`, with the gateway as the real validator), a pure exported
  `parseSparRefs(handoffFrontMatter)` and an exported `resolveRef(repo, ref, { ownRepo })` that
  returns a verbatim 40-hex SHA and throws loudly on a non-SHA cross-repo ref; `step()` reads
  `handoff.md` and parses its front matter for `spar_refs`.
- **Missing `handoff.md` at create time (R2-F2):** if `handoff.md` does not exist when `step()`
  enters the create branch, `parseSparRefs` returns `{}` (no companion refs declared) and no error is
  thrown. The read is behind an `existsSync` guard matching the pattern already used in the
  converged/escalated write-back paths (`plan-spar.mjs:258`, `:274`), so a brand-new plan PR with no
  `handoff.md` yet spars normally rather than failing the create step with a spurious `ENOENT` that
  would masquerade as a fail-loud `spar_refs` validation error.
- **Resolve inside the create branch only (R1-F3):** `extra_refs` is consumed only by `client.create`;
  a later `client.round` forwards nothing (the gateway pins refs from the stored round's `repo_refs`,
  `plan-sparring-service.ts:356-358`). So the merge (CLI arg overlaid by `spar_refs`), the `resolveRef`
  call and the fail-loud contract all live **inside** the `if (!cur || retryInfra || replan)` branch
  where `client.create` runs, and are spread into that single `create` (`:192-196`). The
  `round`/`waiting_for_planner`/`nothing_to_do` paths never touch `spar_refs`, so a companion ref that
  moved or was deleted after the session was created cannot fail-loud and block a later round.
- `.github/workflows/PLAN-SPAR.yml` — unchanged by this lane. The always-on `--extra-ref-vitana-v1`
  arg stays as-is; no new `env:` line and no new CLI arg are needed, because SHA-only resolution for
  the cross-repo key makes no commits API call (R1-F2).
- `scripts/collab/plan-spar.test.mjs` — the nine unit tests in design "Test plan" (all with an
  injected `client` and a test-only `fetchImpl`; no live calls).

## Out of scope

- Any gateway change — it already accepts and uses `extra_refs`. No migration, no new endpoint.
- A PR-GATE enforcement check that *blocks* a two-repo plan whose session did not pin `vitana-v1`
  (it would read `repo_refs` from `GET /api/v1/plans/spar/:id`, not the committed `sparring/` files).
  Documented as a follow-up (design F2), deliberately not built here.
- Writing `repo_refs` into `state.json` / rendering it in `renderRound()`.
- VTID allocation, approval policy, round/response flow, dedup, retry/escalation logic.
- Any `vitana-v1` `src/**` change — this lane touches only `scripts/collab/**` in `vitana-platform`
  (`plan-spar.mjs`, `plan-spar.test.mjs`); `.github/workflows/PLAN-SPAR.yml` is no longer changed
  (R1-F2). The lane's `paths` scope also includes `.kiro/specs/*/handoff.md` so `step()` may read the
  `spar_refs` front matter (R1-F4).

## Verification

- Unit tests above (`node --test scripts/collab/plan-spar.test.mjs`), `node --check` on the script.
- The no-op case is proven by a byte-identical `create` body test against `step()`'s default
  `extraRefs = null` (R1-F1); a second test asserts that with only the CLI arg present and no
  `spar_refs`, the `create` body equals today's CLI-arg behavior, so every existing plan PR spars
  exactly as today.
- A test asserts a non-SHA cross-repo `spar_refs` entry throws loudly and makes no API call (R1-F2),
  and that `spar_refs` overlays (wins over) the CLI arg for the `exafyltd/vitana-v1` key (R1-F1).
- A test asserts a `round` on an existing in-progress session never calls `resolveRef` and succeeds
  even if the declared companion ref is unresolvable (R1-F3).
- Integration (not automated here, no production write): the first real two-repo plan PR that
  declares `spar_refs` runs PLAN-SPAR on staging-gateway and shows `exafyltd/vitana-v1` in that
  session's per-round `repo_refs` (`GET /api/v1/plans/spar/:id`). Read-only, staging only.

## Decisions deferred to the sparring partner / review

- Retiring the always-`main` `--extra-ref-vitana-v1` arg from `PLAN-SPAR.yml` (and the `v1Sha`
  handling in `plan-spar.mjs`) is a separate one-line follow-up, deferred out of this lane. This plan
  now keeps the arg as a documented fallback with `spar_refs` overlaying it (R1-F1), so the two have a
  defined precedence rather than an undefined one; the follow-up only removes the redundant fallback
  once a real two-repo plan has exercised `spar_refs`.
- **Branch/tag resolution for `vitana-v1` (deferred, R1-F2):** resolving a non-SHA companion ref
  cross-repo needs a CI-accessible `contents:read` credential for the private `exafyltd/vitana-v1`
  (the server-side-only `PLAN_SPARRING_GITHUB_TOKEN` is not in the CI job; `github.token` /
  `PLAN_SPAR_PUSH_TOKEN` are single-repo). Deferred to a follow-up lane that provisions and
  scope-verifies such a secret. Until then this lane is SHA-only for the cross-repo key.
- The exact fail-loud shape for a malformed `spar_refs` entry (anchored 40-hex regex rejecting an
  inline-commented / multi-token / non-SHA value) — specified in design "Front-matter shape" / "Input
  validation" and covered by the validation test.
<!-- plan:end -->
<!-- sync: re-trigger PLAN-SPAR allocate_retry (owner 2026-10-19 collaboration.md 7b); plan text between markers unchanged -->
