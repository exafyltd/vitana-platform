# Requirements — plan sparring can read vitana-v1 (`extra_refs` forwarding)

**Lane:** Stage A governance lane (`plan-spar-vitana-v1-ref`)
**Repos in scope:** `exafyltd/vitana-platform` (CI + sparring client), `exafyltd/vitana-v1` (frontend; read-only citation only)
**Change class:** governance-path (edits under `scripts/collab/**` and `.github/workflows/**`)

## Summary

When a plan PR describes work that spans both repos (a backend change in `vitana-platform` with a companion frontend change in `vitana-v1`), the CI sparring partner cannot read the `vitana-v1` side of the change. It only ever sees `vitana-platform` at the PR base SHA, so any finding about the frontend half is made blind, and the partner's own evidence rule (every finding must cite a file it read with `read_file`) cannot be satisfied for `vitana-v1`.

Root cause (verified in code):

- `scripts/collab/plan-spar.mjs` `step()` calls `client.create({ plan_text, producer, change_class, base_ref, repo, approval_policy })` — `plan-spar.mjs:192–195` — with **no `extra_refs`**. The gateway therefore builds the partner's code refs from `input.repo` + `input.base_ref` only.
- The gateway *accepts* `extra_refs`: `validateCreateInput` parses and validates it in the `if (b.extra_refs !== undefined) { … }` block (`services/gateway/src/services/plan-sparring/plan-sparring-service.ts:108–117`), and `createSparringSession` merges it into the pinned refs: `const refs = { ...(input.extra_refs ?? {}), [input.repo]: input.base_ref };` (`plan-sparring-service.ts:266`). Those `refs` are what the partner's `read_file`/`list_dir` tools are pinned to and what round 1's prompt lists as "Code is pinned at:" — the prompt is built by `round1Prompt` (`plan-sparring-service.ts:138`) and the pinned-refs line is `plan-sparring-service.ts:142`.
- `vitana-v1` is already an allowed sparring repo: `PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']` (`services/gateway/src/services/plan-sparring/github-tools.ts:21`), so both the `repo` whitelist (`plan-sparring-service.ts:106`) and the `extra_refs` key whitelist (`plan-sparring-service.ts:112`) already permit it.
- `.github/workflows/PLAN-SPAR.yml` invokes `plan-spar.mjs` with `--dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}" --changed … --summary …` (the "Spar" step, lines 72–83) and provides no `vitana-v1` SHA at all.

The whole gap is: the plan PR has no way to declare a companion `vitana-v1` commit, and `plan-spar.mjs` never forwards one. The gateway side needs no change.

## Functional Requirements

**FR1 — Declare a companion ref.** A plan PR must be able to declare one or more companion repo refs for its sparring session, as data checked into the PR branch (no secret, no cross-repo API call at trigger time to *discover* it). The declaration lives in the plan's own spec folder files that `plan-spar.mjs` already reads.

**FR2 — Forward as `extra_refs`.** When a companion ref is declared, `plan-spar.mjs` must resolve it to a 40-hex commit SHA and pass it to the gateway as `extra_refs = { 'exafyltd/vitana-v1': <sha> }` on the `create` call, so the partner can `read_file` against `vitana-v1` at that pinned commit.

**FR3 — Branch resolution in CI.** A declaration may name a branch or a tag rather than a raw SHA for ergonomics; `plan-spar.mjs` must resolve it to an immutable commit SHA via the GitHub API using the token already present in the PLAN-SPAR job, before calling the gateway. A declared value that is already a 40-hex SHA is used verbatim with no API call.

**FR4 — Byte-identical no-op default (CRITICAL).** When no companion ref is declared, `plan_text`, the `create` call body, and every existing output must be byte-identical to today. Every existing plan PR (which declares nothing) must spar exactly as it does now. `extra_refs` must be *absent* from the request body in that case, not an empty object.

**FR5 — Allowed repos only.** Only repos in `PLAN_SPARRING_REPOS` may be declared. The practical case is `exafyltd/vitana-v1`; a declaration naming a repo the gateway does not allow must fail loudly in CI (the gateway would reject it with `extra_refs_invalid` anyway), not be silently dropped.

**FR6 — Deterministic and auditable.** The resolved SHA each session was pinned to must be observable after the fact: it is what the gateway records on each round as `repo_refs` (declared at `plan-sparring/types.ts:120`), fetched via `GET /api/v1/plans/spar/:id`. The committed `sparring/round-*.md` and `state.json` do **not** carry `repo_refs` (see R1-F2); the declaration itself is in the PR diff.

## Non-Functional Requirements

**NFR1 — No new secret.** The mechanism uses only `GITHUB_TOKEN` (already in the PLAN-SPAR job for the head checkout and the PR comment). No new repository secret, no `PLAN_SPAR_PUSH_TOKEN` dependence.

**NFR2 — Security posture unchanged.** PLAN-SPAR runs `plan-spar.mjs` from the trusted base checkout and reads the PR head only as data (`PLAN-SPAR.yml` header). Reading a declared ref value out of the head's spec files is reading data, consistent with that model. The resolved SHA pins the partner's reads to an immutable commit; the partner's token stays the read-only `PLAN_SPARRING_GITHUB_TOKEN` (`github-tools.ts:12–17`).

**NFR3 — No live-system writes.** This lane writes no VTID, dispatches no workflow, deploys nothing. VTID allocation stays exactly where it is (CI policy approval → `PLAN_SPAR_ALLOCATE`).

## Acceptance Criteria

1. With no companion ref declared, the `create` request body is byte-identical to the current `{ plan_text, producer, change_class, base_ref, repo, approval_policy }` — proven by a unit test asserting `extra_refs` is `undefined` (absent) in the forwarded body.
2. With a companion `vitana-v1` SHA declared, `plan-spar.mjs` forwards `extra_refs = { 'exafyltd/vitana-v1': <that-sha> }` on `create` — proven by a unit test on the forwarded body.
3. With a companion `vitana-v1` **branch** declared, `plan-spar.mjs` resolves it to the branch's head SHA via the GitHub API and forwards that SHA — proven by a unit test with a mocked resolver.
4. A declared value that is already a 40-hex SHA is forwarded verbatim with no GitHub API call — proven by a unit test asserting the resolver is not invoked.
5. A declaration naming a repo not in `PLAN_SPARRING_REPOS`, or a value that resolves to a non-SHA, fails the PLAN-SPAR step with a clear message (non-zero exit), rather than silently sparring without the ref.
6. `renderRound()`/`step()` output for an existing (no-ref) plan is unchanged — the existing plan-spar tests pass without modification.
7. `PLAN-SPAR.yml` passes the new information to `plan-spar.mjs` without requiring any new secret; a plan that declares nothing runs the workflow identically to today.
8. F3: the design-ratchet done-criterion in this spec cites the real vitana-v1 PR-GATE step by name and command (verified below), not an invented one.

## F2 / F3 (secondary findings to address if cheap)

- **R1-F2 (lane-approval gate for the companion session).** Document the gate: lane approval for a two-repo plan must not proceed unless the sparring session actually pinned `vitana-v1`. The authoritative machine-readable marker is the round's `repo_refs` (declared `plan-sparring/types.ts:120`), fetched via `GET /api/v1/plans/spar/:id` with the session id from `state.json.id` — a reviewer/automation confirms `exafyltd/vitana-v1` is present there. **Correction (design review finding 1):** the committed `sparring/round-*.md` files do **not** render `repo_refs` (`renderRound()` renders per-finding `evidence`, not the round's pinned refs), and `state.json` does not contain `repo_refs` at all — so a future enforcement check must read the GET endpoint, not those files. Full enforcement (a PR-GATE assertion against that endpoint) is out of scope for this lane and is noted as a follow-up; see design F2.
- **R1-F3 (design-ratchet done-criterion references the real PR-GATE).** The vitana-v1 PR-GATE design ratchet is the step named **"Design ratchet"** (`id: design`) in `.github/workflows/PR-GATE.yml` (vitana-v1), running `node scripts/ci/pr-gate/gate.mjs ratchet-design "$RUNNER_TEMP/eslint.json" --base "$BASE" --head "$HEAD"`, commented `VTID-05107: Spotlight design rules (design/*) may only go down per file, measured against the BASE commit's baseline/design.json`. Any done-criterion that claims "the design ratchet is green" must reference that step, not a hypothetical one.

## Out of Scope

- Any change to the gateway (`services/gateway/src/services/plan-sparring/plan-sparring-service.ts`, `services/gateway/src/services/plan-sparring/github-tools.ts`): it already accepts and uses `extra_refs`. No migration, no new endpoint.
- VTID allocation behavior, approval policy, round/response flow, dedup, retry/escalation logic.
- A PR-GATE enforcement check that *blocks* merge of a two-repo plan lacking a `vitana-v1` session — it would read `repo_refs` from `GET /api/v1/plans/spar/:id` (session id from `state.json.id`), not from the committed `sparring/` files (documented as a follow-up under F2).
- Writing `repo_refs` into `state.json` (or rendering it in `renderRound()`) to create a committed-artifact marker — noted in design F2 as a cheaper alternative for a future lane, deliberately not done here.
- Supporting more than branch/tag/SHA resolution, or more than the two repos already in `PLAN_SPARRING_REPOS`.

## Assumptions

- A1: Companion-ref declaration belongs in the plan's spec folder (`handoff.md` front matter is the natural home — `plan-spar.mjs` already imports and uses `parseFrontMatter` from `queue.mjs` (defined at `queue.mjs:102–121`, which parses a block list into an array of raw strings and does **not** strip inline `#` comments from list items — see design "Front-matter shape"), and `handoff.md` is where lane/plan metadata lives). Confirmed cheap in design.
- A2: The GitHub token in the PLAN-SPAR job can read `exafyltd/vitana-v1` refs (`GET /repos/{owner}/{repo}/commits/{ref}`). It is `GITHUB_TOKEN`/`PLAN_SPAR_PUSH_TOKEN`, authed as `exafyltd`, with both repos in scope.
- A3: Two-repo plans are the minority; the common case is a single-repo plan that declares nothing and must stay byte-identical (FR4).
