# Sparring round 2 — in_progress

Session: `1df87f89-7dc3-4dfa-bd1e-064c69be6c18` · plan hash `61bcaa8281da4d3998f91dfcc31eccf4989bd9a65e59cebf03d0da0d374b5019`

## Summary

The revision addresses all four prior findings correctly. R1-F2 (Usage errors now caught inside main, --comment-file read first), R1-F3 (missing-review guard), R1-F4 (concurrency cap removed entirely — the right call, since a durable pending-round state is out of scope), and R1-F5 (deterministic tie-break: main first, then lexical) are all genuinely incorporated, and the code I read confirms each premise. Two new issues remain: (1) change C's health route hardcodes a "main HEAD" read, but queue.mjs's defaultRemoteBranch explicitly falls back to origin/master, so a repo whose default branch is not `main` would make the health check read a nonexistent ref → 404 → `ok:false` → step() returns code_access_down and blocks ALL new sparring sessions (a false full-pipeline outage), and (2) the `--comment-file` argument is not validated as required, so a manual invocation without it would throw while writing the report rather than produce the intended Usage report. Neither blocks the PLAN-SPAR.yml path in practice, but the first is a real correctness gap on the exact repo (vitana-v1) whose broken token motivated the feature.

## Findings

### R2-F1 [major]

Change C's health route reads `README.md` at each repo's 'main HEAD', hardcoding the branch name `main`. But queue.mjs's `defaultRemoteBranch` explicitly falls back to `origin/master` when `origin/main` does not exist (symbolic-ref origin/HEAD then `rev-parse --verify -q origin/main` / `origin/master`), so the platform code itself treats `master` as a possible default branch. If any repo in PLAN_SPARRING_REPOS (notably vitana-v1, which is the repo whose broken token motivated this feature) uses `master` as its default, the health route's contents GET at `?ref=main` (or equivalent) returns 404, the route reports `ok:false` for that repo, and step() returns `code_access_down`, blocking ALL new sparring sessions across every repo — a false full-pipeline outage with zero symptom except 'no session was started'. The plan neither derives the default branch from the repo nor documents that `main` is guaranteed.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:223` — function defaultRemoteBranch(repo) { const sym = gitOk(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']); if (sym) return sym; for (const b of ['origin/main', 'origin/master']) if (gitOk(repo, ['rev-parse', '--verify', '-q', b])) return b; return null; }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:21` — export const PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;

Suggestion: Derive the default branch per repo (symbolic-ref origin/HEAD, with a main→master fallback mirroring defaultRemoteBranch) instead of hardcoding `main`, or explicitly document and verify that both repos' default branch is `main` and add a test pinning the default-branch resolution so a non-`main` default cannot silently produce a false `ok:false` that blocks every session.

### R2-F2 [minor]

The plan adds `--comment-file <path>` as an argument read 'first, before any validation', so that even a Usage error writes the comment file. But `--comment-file` is not among the validated required args, and the comment file is written from inside the single try/catch that now wraps main(). If the script is invoked without `--comment-file` (a manual/dev invocation outside PLAN-SPAR.yml), the 'always writes the comment file' path would call writeFileSync with an undefined path and throw a TypeError, replacing the intended 'needs --dir ...' Usage report (exit 2) with an unexpected crash. This is not a live blocker because PLAN-SPAR.yml will always pass `$RUNNER_TEMP/plan-spar-comment.md`, but the claim 'the comment file always exists when the job fails' is not fully self-defending for a missing --comment-file.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:287` — function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i++) { const m = /^--([\w-]+)$/.exec(argv[i]); if (m) out[m[1]] = argv[++i]; } return out; } async function main(argv) { const a = parseArgs(argv); if (!a.dir || !a['base-sha'] || !a.repo || !a.changed) throw new Usage('needs --dir --base-sha --repo --changed');

Suggestion: Treat a missing `--comment-file` as a Usage error too (exit 2) with a clear message, or make the comment-file write a no-op / fall back to console when the path is absent, so a manual invocation without --comment-file still produces a coherent Usage report rather than a TypeError from writing to an undefined path.

## Acknowledgements of earlier responses

- R1-F2: acknowledged — The revision wraps the whole of main() (including arg parsing) in one try/catch and reads --comment-file first, so a Usage error now writes the comment file and still exits 2. A missing --dir test is added. Sound.
- R1-F3: acknowledged — The revision guards live.rounds[n-1]?.review and returns responses_invalid with 'no_review_to_answer' before indexing .findings, plus a test for a prior round without a review. Sound.
- R1-F4: acknowledged — The revision removes the concurrency cap entirely, correctly reasoning that a durable pending-round state is needed to make server-side queueing safe and is out of scope for this plan's change class. The round path still has no durable state before the pass, but without a semaphore there is no new queueing hazard introduced. Sound.
- R1-F5: acknowledged — The revision feeds candidates in a fixed order (main first, then branch refs lexically sorted) so equal `updated` resolves deterministically, and the fixture gains two branches with identical `updated`. Sound and consistent with consider()'s strict `>` and main being considered first.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
