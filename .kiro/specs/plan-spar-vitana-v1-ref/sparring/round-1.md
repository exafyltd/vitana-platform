# Sparring round 1 — in_progress

Session: `b9c548f7-6f0e-4151-81f1-48a0b8a42d85` · plan hash `7e751e70f5f117b58d9ac9d13c16692b68b6e94bc8221e4483163739eca7976c`

## Summary

The gateway-side support for `extra_refs` is real and correct (premises verified). The plan's core gap is genuine, but the proposed fix has several unaddressed defects: (1) it does not define how `spar_refs` interacts with the always-on `--extra-ref-vitana-v1` CLI arg that CI unconditionally passes, and its "byte-identical no-op" claim is false relative to actual CI behavior; (2) `resolveRef` for branch/tag resolution is specified to use `PLAN_SPAR_PUSH_TOKEN || github.token`, neither of which can read the (private) `exafyltd/vitana-v1` repo, so branch/tag resolution will fail — only verbatim 40-hex SHAs work; (3) computing `extra_refs` "once before the branch" means a later-plan branch deletion/force-push on a session that already exists would fail-loud and block the round even though `round` never forwards `extra_refs`; (4) `handoff.md` is neither a workflow-trigger path nor currently parsed as a `create` input, so the declaration location premise is imprecise.

## Findings

### R1-F1 [major]

The plan defers retiring the always-on `--extra-ref-vitana-v1` CLI arg but never specifies precedence between that arg and the new `spar_refs` declaration. In CI, PLAN-SPAR.yml always resolves vitana-v1@main and passes `--extra-ref-vitana-v1 <sha>` (workflow lines 85-89), which main() turns into `extraRefs = { 'exafyltd/vitana-v1': <main-sha> }` (plan-spar.mjs:317-318) and passes into step(). Both mechanisms target the same map key `exafyltd/vitana-v1`. If the CLI arg wins (or the merge order is unspecified), a plan that declares a specific companion feature-branch/SHA in `spar_refs` would silently have its pin replaced by main, defeating the entire purpose. The plan's stated 'intent that spar_refs supersedes' is not backed by any code-level merge rule.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:85` — V1_SHA="$(gh api repos/exafyltd/vitana-v1/commits/main --jq .sha 2>/dev/null || true)" ... ${V1_SHA:+--extra-ref-vitana-v1 "$V1_SHA"}
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:317` — const extraRefs = /^[0-9a-f]{40}$/.test(v1Sha) ? { 'exafyltd/vitana-v1': v1Sha } : null; ... await step({ ... extraRefs })
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:194` — session = await client.create({ ... base_ref: baseSha, repo, approval_policy: POLICY, ...(extraRefs && Object.keys(extraRefs).length ? { extra_refs: extraRefs } : {}) })

Suggestion: Define and implement explicit precedence: `spar_refs` (from handoff.md) wins over the `--extra-ref-vitana-v1` CLI arg for the `exafyltd/vitana-v1` key (merge CLI arg first, then overlay spar_refs), OR retire the CLI arg in the same lane. Also correct the 'byte-identical no-op' claim: with the CLI arg still present, a plan declaring no `spar_refs` is NOT byte-identical to today's CI create body (which already includes extra_refs), so state the no-op in terms of the `step()` default-arg case, not production CI.

### R1-F2 [major]

resolveRef for branch/tag resolves via `GET /repos/{owner}/{repo}/commits/{ref}` using `secrets.PLAN_SPAR_PUSH_TOKEN || github.token`. Neither token can read the private `exafyltd/vitana-v1` repo: `github.token` (GITHUB_TOKEN) is scoped to the workflow's own repository (vitana-platform) only, and `PLAN_SPAR_PUSH_TOKEN` is described as 'a token whose pushes start the PR's checks' (i.e., a push token for vitana-platform, not a cross-repo read token). The dedicated cross-repo read credential `PLAN_SPARRING_GITHUB_TOKEN` is server-side only (github-tools.ts:11-14) and is not available to the CI job. So the only declaration that actually resolves is a verbatim 40-hex SHA (no API call); the advertised branch/tag path will 404/403 in CI and the plan's fail-loud requirement would then abort the step.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:11` — Credential: PLAN_SPARRING_GITHUB_TOKEN ONLY — a dedicated fine-grained token (contents:read + metadata:read, both repos). Deliberately never GITHUB_TOKEN or GITHUB_SAFE_MERGE_TOKEN
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:17` — Secret PLAN_SPAR_PUSH_TOKEN (optional): a token whose pushes start the PR's checks
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:74` — env: ... GH_TOKEN: ${{ github.token }}

Suggestion: Either restrict the feature to verbatim 40-hex SHAs (drop branch/tag resolution, or document it as SHA-only for cross-repo), or provide a CI-accessible credential that actually has contents:read on `exafyltd/vitana-v1` (e.g., a dedicated read-only secret), and verify that token's scope against a private repo. Do not rely on github.token/GITHUB_TOKEN which is single-repo scoped.

### R1-F3 [major]

The plan computes `extra_refs` 'once before the `if (!cur || retryInfra || replan)` branch'. But `extra_refs` is only consumed by `client.create`; once a session exists the subsequent `round` call does not receive it (the gateway pins refs from the stored round's `repo_refs`, plan-sparring-service.ts:358). If the declared branch ref is deleted or force-pushed after the session is created, `resolveRef` would fail on a later `step()` invocation whose action is `round`/`waiting_for_planner`/`nothing_to_do` and where no ref is actually needed — the fail-loud requirement would then abort the step and block the planner from answering findings.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:188` — const retryInfra = ...; const replan = ...; if (!cur || retryInfra || replan) { ... session = await client.create({ ... }) } else if (cur.verdict === 'in_progress') { ... session = await client.round(cur.id, n + 1, { ... }) }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:356` — const n = previous.round + 1; const refs = previous.repo_refs;

Suggestion: Resolve refs (and apply the fail-loud contract) only inside the `create`/`retry`/`replan` branch where `client.create` is actually called, so that a later round on an existing session is unaffected by the companion ref having moved or disappeared.

### R1-F4 [minor]

The plan states companion refs are declared in `handoff.md` front matter 'read from the PR head's files that plan-spar.mjs already reads', but `step()` does not currently parse `handoff.md` front matter as an input to the `create` call — it only reads/writes handoff.md in the converged/escalated write-back branches (lines 258-266, 274-277). Additionally, the workflow's `pull_request_target` `paths:` filter (lines 26-28) and `detectSlug` (lines 42-49) match only `plan.md` and `sparring/*responses-*.md`, never `handoff.md`, so a declaration edit that does not also touch plan.md/responses would not even trigger the spar step.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:168` — export async function step({ dir, slug, baseSha, repo, client, allocate = false, extraRefs = null, now = Date.now }) { ... const planText = readFileSync(planPath, 'utf8'); ... const changeClass = parseFrontMatter(planText)?.change_class || 'standard';
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:42` — const m = /^\.kiro\/specs\/([a-z0-9][a-z0-9-]*)\/(plan\.md|sparring\/(?:s\d+-)?responses-\d+\.md)$/.exec(p.trim());
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:26` — paths: - '.kiro/specs/*/plan.md' - '.kiro/specs/*/sparring/*responses-*.md'

Suggestion: State explicitly that step() will newly read `handoff.md` front matter for `spar_refs` (and add it to scope), and either document that a `spar_refs` declaration must accompany a plan.md or responses change to trigger, or extend `detectSlug`/the paths filter to include handoff.md when it carries a spar_refs change.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
