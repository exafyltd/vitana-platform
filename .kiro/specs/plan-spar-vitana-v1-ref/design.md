# Design — plan sparring forwards a companion `vitana-v1` ref

## Overview

The sparring partner already *can* read `vitana-v1` — the gateway accepts `extra_refs`, validates `exafyltd/vitana-v1` as an allowed key, merges it into the pinned refs the partner's `read_file` tool uses, and lists it in the round-1 prompt. The only missing link is upstream: the CI client (`scripts/collab/plan-spar.mjs`) never sends `extra_refs`, and the plan PR has no place to declare a companion commit. This design adds exactly that link and nothing else.

The chosen mechanism: a plan declares companion refs in `handoff.md` front matter under a new `spar_refs:` key (`repo: branch-or-sha`). `plan-spar.mjs` reads it from the checked-out plan files, resolves any branch/tag to a 40-hex SHA via the GitHub API (the token already in the PLAN-SPAR job), validates the repo against the gateway's own allow-list, and forwards `extra_refs = { 'exafyltd/vitana-v1': <sha> }` on the `create` call. When `spar_refs:` is absent — the overwhelming common case — the `create` body is byte-identical to today.

**Technology stack (locked):** Node 20 ESM (the script's existing runtime), no new dependency. Branch/tag→SHA resolution uses `GET /repos/{owner}/{repo}/commits/{ref}` on `api.github.com` via the built-in `fetch` (Node 20 global, already used by `gatewayClient`), with `Authorization: Bearer <token>` from the environment. Front matter is parsed with the existing `parseFrontMatter` imported from `queue.mjs` (already imported at `plan-spar.mjs:40`). YAML stays simple: `parseFrontMatter` reads scalars and block lists (it strips inline `#` comments from scalars only, not from block-list items — see "Front-matter shape" for why that matters here); `spar_refs` is modeled as block-list lines, see "Front-matter shape" below.

### Why `handoff.md` front matter, not plan.md or a workflow input

Three mechanisms were viable:

1. **`handoff.md` front matter `spar_refs:`** — chosen. `plan-spar.mjs` already parses `handoff.md` front matter (`parseFrontMatter`, used at the converged/escalated branches, `plan-spar.mjs:252`, `:268`), `handoff.md` is defined as the plan-level metadata file in the collaboration protocol (`.claude/rules/collaboration.md` §2), and the declaration is reviewable in the PR diff. It is data on the PR head, read by trusted base-checkout code — exactly the PLAN-SPAR trust model (`PLAN-SPAR.yml` header: "The PR head is checked out only as data"). No secret, no new workflow input.

2. **A fenced block in `plan.md`** — rejected. `plan.md`'s sparred region is hashed (`sha()` / the gateway's `canonicalPlanHash`); putting operational metadata there risks coupling the companion-ref declaration to the plan hash and the dedup/replan logic (the `plan_text_sha !== sha(planText)` comparison, `plan-spar.mjs:187`). Front matter in `handoff.md` is outside the hashed plan text, so FR4's byte-identical guarantee for `plan_text` is trivially preserved.

3. **A new `--extra-ref` workflow arg wired from a PLAN-SPAR input** — rejected as the primary path. `workflow_dispatch`-style inputs don't exist on this `pull_request_target` trigger, and encoding it in the PR title/body is less auditable and harder to validate than a typed front-matter key. (The workflow still needs a one-line change — see §PLAN-SPAR.yml — but only to make the token available for resolution, not to carry the ref value.)

## Current behavior (verified, with citations)

- `step()` builds the create body with no `extra_refs`. There is exactly **one** `client.create` call in the file, inside the `if (!cur || retryInfra || replan)` create/retry/replan branch — it opens at `plan-spar.mjs:192` (`session = await client.create({`), the body literal is `plan-spar.mjs:194` (`plan_text: planText, producer: \`ci-plan-spar.${slug}\`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,`) and it closes at `plan-spar.mjs:195` (`});`). Because it is the only create and sits inside that branch, the `extra_refs` computation below is placed **before** the branch so a `create`, a `retry` and a `replan` all forward the same companion ref.
- The gateway merges `extra_refs` into the pinned refs (gateway files live under `services/gateway/src/services/plan-sparring/`; cited by filename below):
  `plan-sparring-service.ts:266` — `const refs: Record<string, string> = { ...(input.extra_refs ?? {}), [input.repo as string]: input.base_ref };`
- Those refs pin the partner's tools and the round-1 prompt:
  `round1Prompt` is defined at `plan-sparring-service.ts:138`; its "Code is pinned at: …" line is `plan-sparring-service.ts:142`; `makeToolExecutor(refs)` is at `plan-sparring-service.ts:284`.
- `extra_refs` is validated against the same repo allow-list as `repo`:
  the `if (b.extra_refs !== undefined) { … }` block is `plan-sparring-service.ts:108–117` (the `extra_refs` key-in-allow-list + `SHA_RE` value check is `:112`); the `repo` allow-list is `plan-sparring-service.ts:106`; `PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']` at `plan-sparring/github-tools.ts:21`.
- The workflow call that must forward the data: the "Spar" step is `PLAN-SPAR.yml:72–83`; the node invocation itself is `PLAN-SPAR.yml:81–83` — `node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}" --changed "$RUNNER_TEMP/changed.txt" --summary "$GITHUB_STEP_SUMMARY"`.

## Front-matter shape

In `handoff.md`, a two-repo plan adds:

```yaml
---
slug: <slug>
author: kiro
# … existing keys …
spar_refs:
  - exafyltd/vitana-v1: claude/<slug>/<lane>   # a branch, a tag, or a 40-hex SHA
updated: 2026-10-15T22:00Z
---
```

A single-repo plan has no `spar_refs:` key at all — unchanged from today.

`parseFrontMatter` (from `queue.mjs`, defined at `queue.mjs:102–121`) returns a block list as an **array of raw strings** — never an array of nested objects. For `- exafyltd/vitana-v1: <ref>` the array element is the literal string `"exafyltd/vitana-v1: <ref>"`. So the design treats each list entry as a `"<repo>: <ref>"` string and splits on the first `: ` — deterministic and matched exactly to the existing parser's real output. This normalization lives in one new helper `parseSparRefs(frontMatter)` so it is unit-testable in isolation.

**One sharp edge of the real parser, specified here because `parseSparRefs` depends on it (MEDIUM-2):** `parseFrontMatter`'s inline-`#`-comment stripping runs **only on `key: value` scalars** (the `v.replace(/\s+#.*$/, '')` at `queue.mjs:114`), not on block-list items — a block-list line is pushed through `clean()` alone (`out[listKey].push(clean(item[1]))` at `queue.mjs:111`; `clean()` is defined at `queue.mjs:123–125`), which trims and unquotes but does **not** strip a trailing `# comment`. So `- exafyltd/vitana-v1: my-branch # note` reaches `parseSparRefs` verbatim as the string `"exafyltd/vitana-v1: my-branch # note"`. The chosen behavior is **fail-loud**: a `spar_refs` list entry must be exactly `"<repo>: <ref>"` with no trailing content, and `<ref>` may contain no whitespace; `parseSparRefs`'s anchored regex (`^\s*([^:\s]+)\s*:\s*(\S+)\s*$`) rejects an inline-commented or multi-token entry as malformed and the step exits non-zero (a `Usage` error). Inline comments on `spar_refs` list items are therefore not supported — a reviewer who wants a note puts it on a different line, not inline. This is deliberate: a silently truncated ref (`my-branch` resolved, `# note` dropped) would be worse than a clear error.

## New code in `plan-spar.mjs`

Three additions, all additive; no existing line changes behavior when `spar_refs` is absent.

### 1. `parseSparRefs(fm)` — pure, exported

```js
/** Companion repo refs a plan declares in handoff.md front matter: [[repo, branchOrSha], ...]. */
export function parseSparRefs(fm) {
  const raw = fm?.spar_refs;
  if (raw === undefined || raw === null) return [];           // FR4: nothing declared → nothing
  const entries = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const e of entries) {
    // parseFrontMatter yields raw strings only (queue.mjs:102-121), and does NOT strip
    // inline "#" comments from block-list items — so every entry is a verbatim
    // "<repo>: <ref>" string. The anchored regex rejects any trailing content (an inline
    // comment, a second token) as malformed rather than silently truncating the ref.
    const m = /^\s*([^:\s]+)\s*:\s*(\S+)\s*$/.exec(String(e));
    const repo = m?.[1];
    const ref = m?.[2];
    if (!repo || !ref) throw new Usage(`spar_refs entry is not "<repo>: <ref>": ${JSON.stringify(e)}`);
    out.push([repo.trim(), ref.trim()]);
  }
  return out;
}
```

`parseFrontMatter` yields raw strings only, so there is no object/nested-map branch — the single string-splitting path handles every entry the parser can produce. (If a future change swaps in a nested-map YAML parser, `parseSparRefs` is the one place to extend; it is deliberately not pre-generalized here.)

### 2. `resolveRef(repo, ref, { token, fetchImpl })` — branch/tag → SHA

```js
const SHA40 = /^[0-9a-f]{40}$/i;
/** A 40-hex ref is returned verbatim (no API call); anything else is resolved via the commits API. */
export async function resolveRef(repo, ref, { token, fetchImpl = fetch } = {}) {
  if (SHA40.test(ref)) return ref.toLowerCase();               // AC4: SHA → no network
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'plan-spar' },
  });
  if (res.status !== 200) throw new Error(`resolve ${repo}@${ref}: HTTP ${res.status}`);
  const sha = (await res.json())?.sha;
  if (!SHA40.test(String(sha))) throw new Error(`resolve ${repo}@${ref}: no commit sha in response`);
  return String(sha).toLowerCase();
}
```

### 3. Wire into `step()` — build `extra_refs` only when declared

`step()` gains two optional params: `token` (passed from `main()`) and `fetchImpl` (a **test-only injection point**, defaulted to the global `fetch`; `main()` does not pass it, so production always uses the default). The `extraRefs` computation is placed **once, before** the `if (!cur || retryInfra || replan)` branch that contains the only `client.create` (opens `plan-spar.mjs:192`), so a `create`, a `retry` and a `replan` all forward the same resolved companion ref:

```js
// Companion refs for a plan that spans repos (FR1–FR5). Absent → extra_refs stays undefined (FR4).
const handoffForRefs = path.join(spec, 'handoff.md');
const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : [];
let extraRefs;
for (const [r, ref] of declared) {
  if (!PLAN_SPARRING_REPOS.includes(r)) throw new Usage(`spar_refs: ${r} is not an allowed sparring repo`);  // FR5
  if (r === repo) throw new Usage(`spar_refs: ${r} is the plan's own repo; it is pinned by --base-sha`);
  (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl });   // FR2/FR3
}
```

and the create call becomes:

```js
session = await client.create({
  plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
  ...(extraRefs ? { extra_refs: extraRefs } : {}),           // FR4: key absent when nothing declared
});
```

`PLAN_SPARRING_REPOS` is a small constant; to avoid importing from the gateway TypeScript, the script defines its own `const PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'];` with a comment pinning it to `services/gateway/src/services/plan-sparring/github-tools.ts:21` as the source of truth. (The gateway re-validates regardless — `plan-sparring-service.ts:112` — so a drift fails loudly server-side, it cannot silently spar the wrong repo.)

`main()` passes the token through — and only the token, never `fetchImpl` (so production `step()` uses the default global `fetch`; tests that need to assert on network calls construct `step()` directly with an injected `fetchImpl`):

```js
const r = await step({ dir: a.dir, slug, baseSha: a['base-sha'], repo: a.repo, client,
  allocate: process.env.PLAN_SPAR_ALLOCATE === 'true', token: process.env.GITHUB_TOKEN });
```

The `retryInfra`/`replan` branch reuses the same `extraRefs` (it is computed once per `step()` run, before the branch), so a re-plan or infra-retry pins the same companion ref the first pass used, which is correct — the plan's declared companion did not change.

## No-op guarantee (FR4), precisely

- `spar_refs` absent → `declared` is `[]` → `extraRefs` stays `undefined` → the spread `...(extraRefs ? { extra_refs } : {})` contributes nothing → the object is byte-identical to the current literal, key-for-key.
- `plan_text` is never touched by any of this (companion refs live in `handoff.md`, outside the hashed plan block), so dedup, `plan_text_sha` and replan detection are unaffected.
- No GitHub API call happens unless a non-SHA ref is declared (AC4), and none happens at all for a single-repo plan.

## Error handling (per operation)

| Operation | Failure | Recoverable? | Caller sees | Logged |
|---|---|---|---|---|
| `parseSparRefs` malformed entry | entry not `"<repo>: <ref>"` | fatal (usage) | `Usage` → exit 2 | `plan-spar: <msg>` on stderr (existing `main` catch) |
| repo not in allow-list (FR5) | typo / disallowed repo | fatal (usage) | `Usage` → exit 2 | same |
| repo == plan's own repo | redundant/invalid declaration | fatal (usage) | `Usage` → exit 2 | same |
| `resolveRef` HTTP ≠ 200 | bad branch name, token lacks read, API down | fatal | `Error` → exit 1 | same |
| `resolveRef` 200 but no sha | unexpected payload | fatal | `Error` → exit 1 | same |
| gateway rejects `extra_refs` | drift vs allow-list / non-SHA slipped through | fatal | `create: HTTP 400 {"error":"extra_refs_invalid"}` from `gatewayClient.create` | same |

All failures are **fatal and loud** — a two-repo plan must not spar *without* the companion ref and silently produce findings blind to half the change. Exit codes follow the existing convention (`Usage`→2, everything else→1) at `plan-spar.mjs`'s `main()` catch. No new logging level is introduced; the script's single stderr line plus the `--summary` step output are the existing channels.

## Input validation (external inputs)

- **`spar_refs` entries** (from the PR head's `handoff.md`, untrusted data): each must match the anchored `^\s*([^:\s]+)\s*:\s*(\S+)\s*$` — i.e. exactly `"<repo>: <ref>"` with no trailing content. Because `parseFrontMatter` does **not** strip inline `#` comments from block-list items (the strip at `queue.mjs:114` runs only on scalars; a list item goes through `clean()` at `queue.mjs:111`), an entry like `- exafyltd/vitana-v1: my-branch # note` arrives verbatim and is **rejected as malformed** (fail-loud `Usage`), never resolved as `my-branch` with the comment silently dropped; the same anchoring rejects any second whitespace-separated token. `repo` must be in `PLAN_SPARRING_REPOS` and not equal the plan's own `--repo`; `ref` is any non-space token, further constrained by `resolveRef` to resolve to a 40-hex SHA. A ref that is 40-hex is accepted verbatim; anything else must resolve through the API or the step fails. This bounds the forwarded `extra_refs` to `{ allowed-repo: 40-hex-sha }`, exactly what the gateway's `validateCreateInput` requires (`plan-sparring-service.ts:112` — key in allow-list, value `SHA_RE`).
- **GitHub API response**: `.sha` is re-validated against `SHA40` before use; a non-matching value is a fatal error, never forwarded.

## Invariant ownership

- *"The partner only reads immutable, pinned commits"* — owned jointly: `resolveRef` pins a mutable branch to a SHA in CI, and the gateway pins its `read_file` tool to `refs` at session create (`plan-sparring-service.ts:266`, `:284`). The branch is resolved once, at trigger time, so a later push to that branch cannot change what the partner read.
- *"Only allowed repos are ever pinned"* — owned by the gateway (`validateCreateInput`, `plan-sparring-service.ts:106`/`:112`), with a client-side pre-check (FR5) purely for a clearer CI error. The gateway is the real gate.
- *"A single-repo plan is unaffected"* — owned by `step()`'s `extraRefs === undefined` path and the conditional spread (FR4).

## F2 — machine-readable marker for lane approval

The gateway records, on every round, the exact refs the session was pinned to: `repo_refs` on each `SparringRound` (the field is declared at `plan-sparring/types.ts:120` and written on every round when the gateway merges `refs`). That is where the auditable fact lives. **The authoritative marker that a two-repo plan's sparring actually read `vitana-v1` is: `exafyltd/vitana-v1` appears in the session's per-round `repo_refs`, fetched via `GET /api/v1/plans/spar/:id`.**

Two things the committed `sparring/` artifacts do **not** carry, called out precisely so a follow-up check is not specced against the wrong source:

- `renderRound()` (`plan-spar.mjs:59–83`) renders the verdict, session id, plan hash, `partner_error`, summary, **per-finding** evidence entries (the `for (const e of f.evidence ?? [])` loop at `plan-spar.mjs:69`, emitting `e.repo`/`e.path` only when the partner cited a file *in a finding*), acknowledgements and the "Next" block. It never renders the round's `repo_refs`.
- `state.json` written by `step()` carries only `id`, `submitted`, `plan_text_sha`, `rounds`, `verdict`, `infra`, `retryable`, `final_plan_hash`, `policy_approved_at` — no `repo_refs`.

So the pinned-refs fact is reachable **only** from the gateway session (`GET /api/v1/plans/spar/:id`), and `repo_refs` is additionally surfaced inside the LLM prompt line "Code is pinned at:" (`plan-sparring-service.ts:142`), which is not an API-readable artifact. The round `*.md` files happen to show `exafyltd/vitana-v1` paths *if and only if* the partner cited a vitana-v1 file in a finding — that is evidence the partner read it, but it is not the pinned-refs marker and must not be relied on as one (a session can pin a repo and raise no finding citing it).

This design **documents** the gate and names the authoritative marker; it does not add an enforcing check. The deferred follow-up (Out of Scope / tasks) is a PR-GATE assertion phrased against the real source: *for a plan whose `handoff.md` declares `spar_refs` including `exafyltd/vitana-v1`, fail unless the session for the latest round — fetched via `GET /api/v1/plans/spar/:id` (session id from `state.json.id`) — has `exafyltd/vitana-v1` in its `repo_refs`.* It belongs with the other PR-GATE governance checks, not in this script, and is deferred so this lane stays the smallest robust fix. (A cheaper alternative, if a committed-artifact marker is ever wanted, is to have a future lane add `entry.repo_refs = session.rounds.at(-1)?.repo_refs ?? null` to `state.json` in `step()` — one line — but that is explicitly *not* done here.)

## F3 — design-ratchet done-criterion references the real vitana-v1 PR-GATE

Verified in `c:\Users\dstev\vitana-v1\.github\workflows\PR-GATE.yml`: the design ratchet is the step named **"Design ratchet"** (`id: design`, `continue-on-error: true`) in the `pr-gate` job, which runs:

```
node scripts/ci/pr-gate/gate.mjs ratchet-design "$RUNNER_TEMP/eslint.json" --base "$BASE" --head "$HEAD"
```

with the preceding comment `# VTID-05107: Spotlight design rules (design/*) may only go down per file, measured against the BASE commit's baseline/design.json`. Its outcome feeds the aggregated **Verdict** step as `design=${{ steps.design.outcome }}`.

Consequently, any "done" criterion in this spec's `tasks.md` that depends on the frontend design ratchet must be phrased as: *"the vitana-v1 PR-GATE **Design ratchet** step (`gate.mjs ratchet-design`) is green on the companion PR"* — not an invented step name. This spec changes only `scripts/collab/**` and `.github/workflows/PLAN-SPAR.yml` in `vitana-platform` and touches no `vitana-v1` `src/**`, so the design ratchet is not expected to be exercised by this lane's own changes; the citation exists so a two-repo plan's done-criteria point at the real gate.

## `PLAN-SPAR.yml` change

One minimal change to the "Spar" step (`PLAN-SPAR.yml:72–83`): make the GitHub token available to the script for `resolveRef`. The same token value `secrets.PLAN_SPAR_PUSH_TOKEN || github.token` is already used for the head checkout at `PLAN-SPAR.yml:60`. Add `GITHUB_TOKEN` to the Spar step's `env:`:

```yaml
      - name: Spar
        if: steps.guard.outputs.skip != 'true'
        env:
          GATEWAY_URL: ${{ vars.PLAN_SPAR_GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com' }}
          GATEWAY_SERVICE_TOKEN: ${{ secrets.GATEWAY_SERVICE_TOKEN }}
          PLAN_SPAR_ALLOCATE: ${{ vars.PLAN_SPAR_ALLOCATE }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          GITHUB_TOKEN: ${{ secrets.PLAN_SPAR_PUSH_TOKEN || github.token }}   # new: resolveRef reads vitana-v1
        run: |
          git -C head diff --name-only "$BASE_SHA"...HEAD > "$RUNNER_TEMP/changed.txt"
          node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}" \
            --changed "$RUNNER_TEMP/changed.txt" --summary "$GITHUB_STEP_SUMMARY"
```

The `run:` command line is unchanged — no new CLI arg is needed because the ref value comes from `handoff.md`, not the command line. A plan that declares no `spar_refs` never calls `resolveRef`, so the token is simply unused; the workflow behaves identically for every existing plan.

On cross-repo read access: a comparable cross-repo read already works in this org's CI — vitana-v1's PR-GATE "Collab handoff" step reads vitana-platform via `secrets.PLATFORM_DISPATCH_TOKEN` (`vitana-v1/.github/workflows/PR-GATE.yml:88`). That proves `PLATFORM_DISPATCH_TOKEN` spans both repos, **not** that `github.token` does — they are different secrets, so it is an analogy, not proof for the default token. The actual safety net is this design's own `||` fallback: the Spar step uses `secrets.PLAN_SPAR_PUSH_TOKEN || github.token` (the exact value already used for the head checkout at `PLAN-SPAR.yml:60`). If `github.token` does not span `vitana-v1`, `PLAN_SPAR_PUSH_TOKEN` is the guaranteed path and is preferred by the `||`. `github.token`'s default `contents:read`, plus the job's `contents: write` permission (`PLAN-SPAR.yml:31`), is sufficient when it does span both repos.

## Test plan

All unit tests, no live calls. Tests construct `step()` directly and inject the mocked `client` and the test-only `fetchImpl` (production `main()` passes neither an injected `fetchImpl` nor a mock client — it uses the global `fetch` default and the real `gatewayClient`). This matches the existing `plan-spar` test style, where `client` is already an injected `step()` parameter.

1. **No-op (AC1, AC6).** `parseSparRefs({})` and `parseSparRefs({ spar_refs: undefined })` → `[]`. `step()` with a `handoff.md` that has no `spar_refs` → the captured `client.create` body deep-equals the current literal and has no `extra_refs` key (`'extra_refs' in body === false`). Existing round/converged/escalated tests pass unmodified.
2. **SHA forwarded (AC2, AC4).** `handoff.md` declares `exafyltd/vitana-v1: <40-hex>` → `step()` forwards `extra_refs = { 'exafyltd/vitana-v1': <that-sha-lowercased> }`; the injected `fetchImpl` is asserted **not** called.
3. **Branch resolved (AC3).** Declares a branch; `fetchImpl` mock returns `{ status: 200, json: async () => ({ sha: '<40-hex>' }) }` → forwarded `extra_refs` carries that SHA; `fetchImpl` called once with the `…/commits/<branch>` URL and an `Authorization` header.
4. **Disallowed repo (AC5).** Declares `exafyltd/other-repo` → `step()` throws `Usage`; nothing is sent to `client.create`.
5. **Own-repo rejected.** Declares `exafyltd/vitana-platform` (the plan's own `--repo`) → `Usage`.
6. **Resolve failure (AC5).** `fetchImpl` returns `{ status: 404 }` → `step()` throws (exit 1 class); `client.create` not called.
7. **Round reuse.** A `replan`/`retryInfra` scenario with a declared SHA → the re-created session is passed the same `extra_refs` (assert on the second `client.create` body).
8. **`resolveRef` unit.** 40-hex in → returned verbatim, no fetch. Non-SHA in, 200 with `.sha` → that sha. 200 with no `.sha` → throws. Non-200 → throws.
9. **Inline-commented entry rejected (AC5, MEDIUM-2).** `parseSparRefs({ spar_refs: ['exafyltd/vitana-v1: my-branch # note'] })` → throws `Usage` (the trailing `# note` is not stripped by `parseFrontMatter` for block-list items, and the anchored regex rejects the multi-token value rather than resolving `my-branch` and silently dropping `# note`). A multi-token entry with no `#` (e.g. `exafyltd/vitana-v1: a b`) throws the same way.

**AC → test mapping.** AC1 → t1; AC2 → t2; AC3 → t3; AC4 → t2 (SHA path) + t8 (`resolveRef` no-fetch); AC5 → t4 (disallowed repo) + t6 (resolve failure) + t9 (malformed/inline-commented entry); AC6 → t1; AC7 → the `PLAN-SPAR.yml` one-line env addition is config, exercised by t1's byte-identical no-op plus the existing workflow (no new unit test); round-reuse (FR-level, not a numbered AC) → t7. Every acceptance criterion therefore has at least one covering test.

What is unit-testable: everything above (pure parsing, resolution with injected `fetch`, create-body shape with injected `client`). What is integration-only and deliberately not automated here: a real GitHub `commits` call and a real gateway `create` with `extra_refs` reaching a live partner — both are exercised naturally the first time a real two-repo plan PR runs PLAN-SPAR on staging-gateway, observable by `exafyltd/vitana-v1` appearing in that session's `repo_refs`. No production write, no live test as the test user — consistent with the staging-only, read-only posture.

## Files to change

- `scripts/collab/plan-spar.mjs` — add `PLAN_SPARRING_REPOS` const (cite `github-tools.ts:21`), `parseSparRefs`, `resolveRef`; thread `token`/`fetchImpl` through `step()`/`main()`; compute the conditional `extra_refs` once before the `if (!cur || retryInfra || replan)` branch and spread it into the single `client.create` (`:192`).
- `.github/workflows/PLAN-SPAR.yml` — add `GITHUB_TOKEN` to the Spar step `env:` (one line).
- `scripts/collab/__tests__/plan-spar*.test.mjs` (or the existing plan-spar test file) — the nine tests above.
- No gateway change. No migration. No `vitana-v1` change.

## Response to review findings — round 2

Round-2 verdict: **CHANGES_REQUESTED** (2 MEDIUM, 4 NITs numbered NIT-1…NIT-6 in `design-review.json`, two of which — NIT-2 is MEDIUM-severity in substance), `design-review.md` / `design-review.json`. All addressed; every re-pinned line was re-verified against the live source this round rather than carried over.

1. **[MEDIUM-1] `extra_refs` validation citations off by one (whole cluster).** **Accepted.** Re-pinned against the live `plan-sparring-service.ts`: the `repo` allow-list is **`:106`**, the `if (b.extra_refs !== undefined) { … }` block is **`:108–117`**, and the `extra_refs` key-in-allow-list + `SHA_RE` value check is **`:112`**. Corrected in the design's "Current behavior" bullet and in `requirements.md` (Summary, FR5, the `extra_refs` whitelist reference). The round-1 numbers (`:105`, `:107–118`, `:111`) are gone.

2. **[MEDIUM-2] `parseSparRefs` behavior on an inline-commented / multi-token ref unspecified.** **Accepted.** Documented the chosen behavior explicitly in both the "Front-matter shape" section and "Input validation": `parseFrontMatter` strips inline `#` comments from scalars only (the `v.replace(/\s+#.*$/, '')` at `queue.mjs:114`), never from block-list items (which go through `clean()` at `queue.mjs:111`, defined `queue.mjs:123–125`), so `- exafyltd/vitana-v1: my-branch # note` reaches `parseSparRefs` verbatim. The chosen behavior is fail-loud — the anchored regex rejects an inline-commented or multi-token entry as malformed (`Usage`, non-zero exit) rather than silently resolving `my-branch` and dropping the comment. Added **Test 9** asserting the inline-commented and the multi-token entries both throw `Usage`, and mapped it under AC5.

3. **[NIT-1] `step()` create-call line-range phrasing.** **Accepted.** Verified the range `:192–195` is correct and tightened the prose: the create call opens at `plan-spar.mjs:192`, its body literal is `:194`, it closes at `:195`, and it is the file's only `client.create`, sitting inside the create/retry/replan branch.

4. **[NIT-2] `Code is pinned at:` reuse across rounds.** **Accepted.** The round1Prompt pinned-refs line stays cited at `plan-sparring-service.ts:142`; the F2 marker claim does not depend on it. (The companion ref persists across later rounds because the gateway merges the same `refs` on every round at `:266`; CI reuse is covered by Test 7.)

5. **[NIT-3] `parseFrontMatter` cited `queue.mjs:103–120`; opens at 102.** **Accepted.** Re-pinned to **`queue.mjs:102–121`** in the design (Technology stack, Front-matter shape, the `parseSparRefs` code comment) and in `requirements.md` A1.

6. **[NIT-4] `PLATFORM_DISPATCH_TOKEN` analogy overstated for `github.token`.** **Accepted.** Softened the parenthetical in the "`PLAN-SPAR.yml` change" section: the PR-GATE "Collab handoff" cross-repo read uses `secrets.PLATFORM_DISPATCH_TOKEN` (`vitana-v1/.github/workflows/PR-GATE.yml:88`), which proves *that* token spans both repos, not that `github.token` does — it is an analogy. The real guarantee is this design's own `secrets.PLAN_SPAR_PUSH_TOKEN || github.token` fallback (the exact value already used for the head checkout at `PLAN-SPAR.yml:60`).

7. **[NIT-5] `renderRound` evidence-loop line not independently re-pinned.** **Accepted.** Re-pinned against the live file: `renderRound()` is **`plan-spar.mjs:59–83`** and the per-finding `for (const e of f.evidence ?? [])` loop is **`plan-spar.mjs:69`** (round 1 had erroneously moved it to `:68`; the live line is `:69`). It is referenced only to describe what `renderRound()` does *not* render; the F2 marker remains the gateway's `repo_refs` via `GET /api/v1/plans/spar/:id`.

8. **[NIT-6] AC-to-test mapping not spelled out.** **Accepted.** Added an explicit **AC → test mapping** line in the Test plan: AC1 → t1, AC2 → t2, AC3 → t3, AC4 → t2/t8, AC5 → t4/t6/t9, AC6 → t1, AC7 → config (t1 no-op + existing workflow), round-reuse → t7.

Also corrected while re-pinning: the PLAN-SPAR.yml node-invocation citation (round 1 said `:79–81`; the Spar step is `:72–83` and the node command is `:81–83`), and the `plan_text_sha` dedup comparison confirmed at `plan-spar.mjs:187`.
