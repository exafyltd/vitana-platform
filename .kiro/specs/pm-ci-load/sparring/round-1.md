# Sparring round 1 — in_progress

Session: `3b4bad67-1fa4-49d7-bf38-fe4fd45ec728` · plan hash `f798d9caeb65cc8f86052423e463faedf096b3e824298173ddf636df584f51ba`

## Summary

The plan is well-researched and the key premises about the existing system hold up under verification. The two lanes (CI concurrency, App token) are cleanly scoped and the sequencing constraint (Lane 2 after pm-reassign-idempotent) is correctly motivated by the AWS-STAGE-DEPLOY-GATEWAY trigger paths. I found one actionable issue in the App permissions list that could cause the variable endpoint to silently degrade, and one minor observation about the concurrency group key being over-general for pull_request-only workflows.

## Findings

### R1-F1 [major]

§4 lists 'Actions read (variables are under "Variables" read)' as one permission entry, but 'Actions' and 'Variables' are separate GitHub App permissions. The PM's only `/actions/` endpoint is `actions/variables/:name` (observe-live.ts:709), which requires the 'Variables: read' App permission, not 'Actions: read'. If the admin follows the §4 list literally and grants 'Actions: read' but not 'Variables: read', the variable endpoint will 404 — the code gracefully falls back to the env var (VTID-05281, observe-live.ts:706-714), so this wouldn't crash, but the PM would permanently be unable to read CLAUDE_AVAILABLE from the API, degrading its Claude-availability signal to a static env value.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:705` — async variable(repo: string, name: string): Promise<string | null> {
    // VTID-05281: GitHub answers 404 both for "not set" and for "this token has
    // no Variables access", so a 404 (or a 200 without a string value) is
    // unreadable, not unset — throw so observeClaude falls back to the env.
    const r = await gh<{ value?: unknown }>(repo, `actions/variables/${enc(name)}`);
    if (r.status === 200 && typeof r.data?.value === 'string') return r.data.value;
    throw new GithubHttpError(
      r.status,
      r.status === 404 ? 'variable unreadable (404: unset or no access)' : `variable unreadable (${r.status}: no string value)`,
    );

Suggestion: In §4, replace 'Actions read (variables are under "Variables" read)' with two explicit items: 'Variables read' (for actions/variables/:name) and, only if another Actions endpoint is actually needed, 'Actions read'. Since the only /actions/ call the PM makes is the variables endpoint, 'Actions read' may not be needed at all — verify against the GitHub App permissions page.

### R1-F2 [minor]

The proposed concurrency group key `<workflow>-${{ github.event.pull_request.number || github.ref }}` includes a `|| github.ref` fallback, but both UNIT.yml and PHASE-2B-DOC-GATE.yml trigger exclusively on `pull_request` events. `github.event.pull_request.number` is always populated for those events, making the fallback dead code. This is harmless, but diverges from the PR-GATE.yml pattern it claims to follow — PR-GATE uses `pr-gate-${{ github.event.pull_request.number }}` with no fallback (line 23). If either workflow ever gains a `push:` trigger in the future, the fallback would silently group all pushes to the same ref together, which may or may not be the desired behaviour.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:22` — concurrency:
    group: pr-gate-${{ github.event.pull_request.number }}
    cancel-in-progress: true
- `exafyltd/vitana-platform:.github/workflows/UNIT.yml:1` — name: unit
on: { pull_request: {} }
- `exafyltd/vitana-platform:.github/workflows/PHASE-2B-DOC-GATE.yml:1` — name: Phase 2B Documentation Gate
on:
  pull_request:
    branches: [ main, trunk, develop, release/** ]

Suggestion: Match the PR-GATE.yml pattern exactly: `group: <workflow>-${{ github.event.pull_request.number }}` — no `|| github.ref` fallback. This keeps all three concurrency groups consistent and avoids accidental grouping if a push trigger is added later.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
