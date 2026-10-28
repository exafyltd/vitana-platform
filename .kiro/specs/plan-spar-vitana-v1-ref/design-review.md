# Design review — plan sparring forwards a companion `vitana-v1` ref (`plan-spar-vitana-v1-ref`)

Reviewer: independent design-review subagent (fresh read, no planning context).
Scope reviewed: `design.md` + `requirements.md` in `.kiro/specs/plan-spar-vitana-v1-ref/`, verified against the live source in `vitana-platform` and `vitana-v1`.

This review re-reads every `file:line` the design pins and checks the three load-bearing claims against the actual code:
(1) `spar_refs` is deterministic/auditable and needs no secret at trigger time; (2) the no-`spar_refs` path is byte-identical to today's 3-arg-plus create body; (3) the cited lines are accurate; plus the R1-F3 design-ratchet done-criterion and the R1-F2 approval marker.

---

## Verdict basis

HIGH findings: 0. MEDIUM findings: 2. NIT findings: 4. Two MEDIUMs ⇒ **CHANGES_REQUESTED**.

Both MEDIUMs are citation-accuracy defects, not design defects. The mechanism itself is sound and the three core claims hold. But the design explicitly advertises that it re-pinned every citation against live source in its round-2 response, and two of those re-pinned citations are still wrong (one of them a flat factual error about where an import lives). A design review whose whole job is to catch exactly this cannot wave them through, especially when the spec's own FR4 ("byte-identical") and its citation discipline are the thing being trusted downstream.

---

## Findings

### MEDIUM-1 — `parseFrontMatter` import is cited at `plan-spar.mjs:40`; it is actually line 26

**Where:** `design.md`, "Technology stack (locked)" paragraph: *"Front matter is parsed with the existing `parseFrontMatter` imported from `queue.mjs` (already imported at `plan-spar.mjs:40`)."*

**Problem:** Verified against the live file — the import `import { parseFrontMatter } from './queue.mjs';` is at **`plan-spar.mjs:26`**, not `:40`. Lines 24–28 are:
```
24  import path from 'node:path';
25  import { fileURLToPath } from 'node:url';
26  import { parseFrontMatter } from './queue.mjs';
27  (blank)
28  export const POLICY = 'converged-auto-v1';
```
Line 40 is inside the `INFRA_REASONS`/`RETRYABLE_REASONS` region, not an import. This is a plain factual error in a citation the round-2 response claims was re-verified ("every re-pinned line was re-verified against the live source this round").

**Fix:** Change `plan-spar.mjs:40` to `plan-spar.mjs:26` in the "Technology stack" paragraph. (The *behavioural* claim — that `parseFrontMatter` is already imported and reused — is correct; only the line number is wrong.)

### MEDIUM-2 — `queue.mjs` citations for `parseFrontMatter` (`:102–121`) and `clean()` (`:123–125`) are off by one at both ends

**Where:** `design.md` — repeated in "Technology stack", "Front-matter shape", the `parseSparRefs` code comment, "Input validation", and round-2 response items 2 and 5; also `requirements.md` A1 and "Front-matter shape" reference.

**Problem:** Verified against the live `scripts/collab/queue.mjs`:
- `export function parseFrontMatter(text) {` opens at **line 103**, and its closing `}` is at **line 122**. The design pins it as `queue.mjs:102–121`. Line 102 is blank; line 122 is the function's closing brace, which the `:102–121` range excludes.
- `function clean(s) {` is **lines 123–126** (`123` signature, `126` closing `}`). The design pins it as `queue.mjs:123–125`, which stops one line short of the closing brace.
- The two *interior* lines the argument actually leans on are correct and should stay: `out[listKey].push(clean(item[1]))` is **`:111`** ✓ and the scalar-only inline-comment strip `const v = kv[2].replace(/\s+#.*$/, '').trim();` is **`:114`** ✓. The MEDIUM-2 reasoning (block-list items go through `clean()` only, never the `:114` strip) is factually correct — only the two *range* citations are off.

**Fix:** Replace `queue.mjs:102–121` with `queue.mjs:103–122` and `queue.mjs:123–125` with `queue.mjs:123–126` everywhere they appear in `design.md` and `requirements.md`. The behavioural claim is right; the ranges are wrong.

### NIT-1 — "Code is pinned at:" for round ≥ 2 reads a *different* field than round 1

**Where:** `design.md`, "Current behavior" and F2, citing the pinned-refs prompt line at `plan-sparring-service.ts:142`.

**Observation (not a defect):** `:142` (`round1Prompt`) builds the pinned-refs line from the `refs` object merged with `extra_refs` at `:266` — correct. For round ≥ 2 the equivalent line is `nextRoundPrompt` at **`:166`**, which reads `previous.repo_refs` (the stored per-round refs, set from the same `refs` at session create and reused at `:358`). The design's claim that the companion ref persists across rounds is therefore true, but it is carried by `repo_refs` on each stored round, not by re-reading `extra_refs`. The design already states this in round-2 item 4; no change required, but if a line is added for completeness, cite `:166`/`:358` alongside `:142`.

**Fix:** Optional — add `plan-sparring-service.ts:166` (nextRoundPrompt) / `:358` (round N refs = `previous.repo_refs`) next to `:142` where the design discusses round persistence.

### NIT-2 — FR6 / requirements lean on `GET /api/v1/plans/spar/:id` returning `repo_refs`, which is a `SparringRound` field, not a session field

**Where:** `requirements.md` FR6 and F2; `design.md` F2.

**Observation:** `repo_refs` is declared on the round interface at `types.ts:120` (verified — it is the last field of the round interface, immediately before `SparringSession` opens at `:122`). So "the session's `repo_refs`" is shorthand for "the `repo_refs` on each round of the session returned by `GET /api/v1/plans/spar/:id`". The design mostly says this correctly ("per-round `repo_refs`"), but FR6 in `requirements.md` says "what the gateway records on each round as `repo_refs` (declared at `plan-sparring/types.ts:120`)" — which is accurate — while a future reader could still mistake it for a top-level session field.

**Fix:** No code impact. If tightening, phrase the follow-up check as "`exafyltd/vitana-v1` ∈ `session.rounds.at(-1).repo_refs`" so the array-of-rounds shape is explicit.

### NIT-3 — The design asserts `PLAN_SPARRING_REPOS` will be redefined in the script, but does not note the one real divergence risk it creates

**Where:** `design.md`, "New code in plan-spar.mjs" §3: *"the script defines its own `const PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'];` with a comment pinning it to `github-tools.ts:21`"*.

**Observation:** Verified `github-tools.ts:21` is exactly that literal. The design correctly notes the gateway re-validates (`:112`) so drift "fails loudly server-side". That is true for an *added* repo (gateway rejects it). It is **not** symmetric: if the gateway ever *removes* a repo from its list, the script's stale copy would let a declaration through the client pre-check and the gateway would then reject it — still fails loud, so safe, but the "source of truth" comment is the only guard against the copy going stale silently in the permissive direction. Acceptable as designed; just worth an explicit "drift is always caught by the gateway, in both directions" line.

**Fix:** Optional — add one sentence to §3 stating the gateway `:112` re-validation catches drift in both directions (added or removed repo), so the local copy can never cause a wrong repo to actually be pinned.

### NIT-4 — Test plan does not assert the `main()` → `step()` token thread for the real (non-injected) path

**Where:** `design.md`, "Test plan": all nine tests construct `step()` directly with an injected `fetchImpl`; AC7 is explicitly "config, exercised by t1 + existing workflow".

**Observation:** Every test injects `fetchImpl`, so the production wiring — `main()` passing `token: process.env.GITHUB_TOKEN` and *not* passing `fetchImpl` so the global `fetch` is used — is never exercised by a test, only by the live workflow. This is a reasonable scoping choice (it matches the existing `client`-injection test style and a unit test cannot assert the global-fetch default without network), and the design states it. Not a gap that blocks, but the AC-to-test mapping should say plainly that the `main()` token-thread is covered only by the first real two-repo PR on staging, not by any unit test.

**Fix:** Optional — add a line under "What is integration-only" noting the `main()`→`step()` token thread (and the `fetchImpl`-defaulted-to-global path) is covered by the first live two-repo PLAN-SPAR run, not a unit test.

---

## Verified Assumptions

- **Gateway accepts and uses `extra_refs` with no change needed.** `plan-sparring-service.ts`: repo allow-list `:106`; `if (b.extra_refs !== undefined) {` block `:108`–`:117`; key-in-allow-list + `SHA_RE` value check `:112`; merge `const refs = { ...(input.extra_refs ?? {}), [input.repo]: input.base_ref }` `:266`; `round1Prompt` `:138` with "Code is pinned at:" `:142`; `makeToolExecutor(refs)` `:284`. All exactly as cited. ✓
- **`vitana-v1` is an allowed sparring repo.** `PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']` at `github-tools.ts:21`. ✓
- **Current create body is `{ plan_text, producer, change_class, base_ref, repo, approval_policy }` and there is exactly one `client.create`.** `plan-spar.mjs`: the single create opens `:192`, body literal `:194`, closes `:195`, inside the `if (!cur || retryInfra || replan)` branch at `:189`. The conditional-spread no-op (FR4) is therefore structurally byte-identical when `extraRefs` is `undefined`. ✓
- **`parseFrontMatter` yields raw strings for block lists and strips inline `#` only from scalars.** `queue.mjs`: block-list push `out[listKey].push(clean(item[1]))` at `:111`; scalar-only strip `kv[2].replace(/\s+#.*$/, '')` at `:114`; `clean()` trims/unquotes only (`:123`–`:126`). So an inline-commented block-list entry arrives verbatim and MEDIUM-2's fail-loud handling is justified. ✓ (Only the enclosing *range* citations are off — MEDIUM-2 above.)
- **`parseFrontMatter` is reused in the converged/escalated branches.** `plan-spar.mjs:252` and `:268` both `parseFrontMatter(ht) || {}`. ✓
- **`renderRound` does not render the round's `repo_refs`.** `renderRound()` is `plan-spar.mjs:59`–`:83`; its per-finding evidence loop `for (const e of f.evidence ?? [])` is `:69`, emitting `e.repo`/`e.path` per finding, never the round's pinned refs. ✓
- **`repo_refs` is a per-round field.** `types.ts:120`, last field of the `SparringRound` interface (session interface opens `:122`). ✓
- **PLAN-SPAR "Spar" step and node invocation.** `PLAN-SPAR.yml`: Spar step `:72`–`:83`; node invocation `:81`–`:83`; head-checkout token `secrets.PLAN_SPAR_PUSH_TOKEN || github.token` `:60`; `contents: write` `:31`. The one-line change (adding `GITHUB_TOKEN` to the Spar step `env:`) is consistent with the existing step shape and the `run:` line is genuinely unchanged. ✓
- **R1-F3 — vitana-v1 PR-GATE design ratchet.** `vitana-v1/.github/workflows/PR-GATE.yml`: step **"Design ratchet"**, `id: design`, `continue-on-error: true`, command `node scripts/ci/pr-gate/gate.mjs ratchet-design "$RUNNER_TEMP/eslint.json" --base "$BASE" --head "$HEAD"`, preceding comment `# VTID-05107: Spotlight design rules (design/*) may only go down per file, measured against the BASE commit's baseline/design.json`, outcome fed to Verdict as `design=${{ steps.design.outcome }}`. Every detail of the F3 citation matches the live workflow. ✓
- **R1-F2 — approval-gate marker is documented.** The design names the authoritative marker (`exafyltd/vitana-v1` ∈ the session's per-round `repo_refs`, via `GET /api/v1/plans/spar/:id`), states precisely that the committed `sparring/round-*.md` and `state.json` do NOT carry it, and defers the enforcing PR-GATE check as out-of-scope. The `state.json` field list in the design matches what `step()` actually writes (`id`, `submitted`, `plan_text_sha`, `rounds`, `verdict`, `infra`, `retryable`, `final_plan_hash`, `policy_approved_at`). Documented, as required. ✓
- **No new secret / token spans both repos.** The cross-repo analogy is correctly softened: `vitana-v1` PR-GATE "Collab handoff" uses `secrets.PLATFORM_DISPATCH_TOKEN` at `vitana-v1/.github/workflows/PR-GATE.yml:88` (verified), which proves *that* token spans both repos, not `github.token`; the real guarantee is the `PLAN_SPAR_PUSH_TOKEN || github.token` fallback. ✓
- **Node built-ins the new code needs are already imported.** `readFileSync`, `existsSync`, `path` are imported at the top of `plan-spar.mjs`; `Usage` and `sha` are in-file. The `extraRefs` snippet and `parseSparRefs`/`resolveRef` need nothing new. ✓

## Unverified / Wrong Assumptions

- **WRONG:** `parseFrontMatter` is imported "at `plan-spar.mjs:40`" — it is at `:26` (MEDIUM-1).
- **WRONG (ranges):** `parseFrontMatter` at `queue.mjs:102–121` (actually `103–122`) and `clean()` at `queue.mjs:123–125` (actually `123–126`) (MEDIUM-2). The interior lines `:111`/`:114` the argument relies on are correct.
- **UNVERIFIED (acknowledged by the design, not a defect):** the live GitHub `commits` resolve and the live gateway `create` with `extra_refs` reaching a real partner are integration-only, exercised first by a real two-repo PLAN-SPAR run on staging-gateway. The design states this and does not claim otherwise. The `main()`→`step()` token thread is likewise only live-exercised (NIT-4).
- **UNVERIFIED (out of scope, correctly deferred):** whether `github.token` (as opposed to `PLAN_SPAR_PUSH_TOKEN`) actually spans `vitana-v1`. The design does not assert it does; the `||` fallback makes it moot.
