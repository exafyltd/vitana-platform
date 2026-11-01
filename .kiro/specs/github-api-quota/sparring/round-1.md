# Sparring round 1 — in_progress

Session: `903feada-dfee-4210-9e75-21e59737ca48` · plan hash `5064393e28322220f0f7f5c09bef8c49d3b6caede9ab7094f852f64a85b51498`

## Summary

The plan is thorough and well-structured. Most premises about the existing codebase hold. I found one blocker (the cicd.ts polling math will triple the CI wait timeout), two major gaps (GitHub REST clients in dev-autopilot-ci-logs.ts and kiro-push-branch.ts/kiro-repo-readiness.ts that bypass the new central module), one major concern about the land-guard integration approach, and one minor inaccuracy.

## Findings

### R1-F1 [blocker]

Changing cicd.ts pollIntervalMs from 10000 to 30000 without updating the maxPolls divisor triples the effective CI wait timeout. maxPolls is calculated as `Math.ceil(max_ci_wait_seconds / 10)` (hardcoded divisor 10, not derived from pollIntervalMs). With pollIntervalMs=30000, the loop will sleep 30s per iteration × (max_ci_wait_seconds/10) iterations = max_ci_wait_seconds × 3 total wait. A caller requesting a 600s CI wait will actually wait up to 1800s.

- `exafyltd/vitana-platform:services/gateway/src/routes/cicd.ts:1718` — const pollIntervalMs = 10000; // 10 seconds
const maxPolls = Math.ceil(max_ci_wait_seconds / 10);
- `exafyltd/vitana-platform:services/gateway/src/routes/cicd.ts:1754` — await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

Suggestion: The polling-cadence lane must update the maxPolls calculation to use pollIntervalMs: `Math.ceil(max_ci_wait_seconds / (pollIntervalMs / 1000))`, or extract both the interval and the divisor from a single constant. Add a test that asserts the total maximum wait equals max_ci_wait_seconds regardless of the interval value.

### R1-F2 [major]

dev-autopilot-ci-logs.ts has its own private GitHub REST client (`githubGet`, line 157) that makes direct `fetch` calls to GITHUB_API_BASE. It is called from `collectCiFailureEvidence` (line 200-204) which the CI watcher invokes every tick for failing PRs (dev-autopilot-watcher.ts:950-951). This client bypasses the new github-http.ts module entirely: no rate-limit detection, no backoff, no cache. Under rate-limit pressure these calls will still fire, waste quota, and potentially get 403s that surface as 'log unavailable' rather than proper backoff.

- `exafyltd/vitana-platform:services/gateway/src/services/dev-autopilot-ci-logs.ts:157` — async function githubGet<T>(path: string, token: string, as: 'json' | 'text' = 'json'): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${GITHUB_API_BASE}${path}`, {
- `exafyltd/vitana-platform:services/gateway/src/services/dev-autopilot-watcher.ts:949` — const evidence = headSha
          ? await collectCiFailureEvidence({ owner: GITHUB_OWNER, repo: GITHUB_REPO_NAME, headSha, failedNames: analysis.failedNames })
          : [];

Suggestion: Either wire dev-autopilot-ci-logs.ts githubGet through the new github-http.ts githubFetch, or at minimum have the watcher's call site check isRateLimited() before calling collectCiFailureEvidence and skip it when blocked (the function is already best-effort). List this file in D14 out-of-scope with the reason if deferring, but acknowledge the bypass in the risk register.

### R1-F3 [major]

kiro-push-branch.ts callGitHub (line 104) and kiro-repo-readiness.ts (line 32) each have their own direct-fetch GitHub clients that bypass the new github-http.ts. kiro-push-branch.ts does both reads (GET ref at line 128-131) and writes; kiro-repo-readiness.ts is purely reads. Neither is mentioned in the plan's lanes, D14 out-of-scope, or the risk register. The plan's D1 states 'Every GitHub REST and GraphQL call goes through [github-http.ts]' which is therefore inaccurate.

- `exafyltd/vitana-platform:services/gateway/src/services/kiro/kiro-push-branch.ts:104` — async function callGitHub(token: string, method: string, endpoint: string, body?: unknown): Promise<any> {
    if (!token) throw new Error('GitHub token not configured');
    const res = await fetch(`https://api.github.com${endpoint}`, {
- `exafyltd/vitana-platform:services/gateway/src/services/kiro/kiro-repo-readiness.ts:32` — const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        });

Suggestion: Either add these files to a lane (wire their reads through github-http.ts), or explicitly list them in D14 out-of-scope with their volume estimate and the reason for deferral. Correct the D1 claim to say 'every GitHub call in github-service.ts and github-rest.ts goes through it' rather than 'every GitHub REST and GraphQL call'.

### R1-F4 [major]

The ci-scripts-backoff lane says it modifies land-guard.mjs's `ghJson` read path, but `ghJson` is a synchronous `execFileSync` call to the `gh` CLI — not an async `fetch`. The backoff module exports async `waitForRateLimit(...)`, but the land-guard's polling loop `waitChecks` (line 136-142) calls `checkRuns` → `ghJson` synchronously. An async backoff cannot wrap a synchronous exec. The plan does not address how the integration works for CLI-based callers.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:103` — const ghJson = (p) => JSON.parse(run('gh', ['api', p]) || 'null');
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:136` — async function waitChecks(gh, sha, waitSec) {
    const end = Date.now() + waitSec * 1000;
    for (;;) {
      const v = checksVerdict(checkRuns(gh, sha));
      if (v.state !== 'pending' || Date.now() >= end) return v;
      await sleep(60_000);
    }
  }

Suggestion: The lane must describe the actual integration strategy. Options: (a) make `ghJson` async and switch from `execFileSync` to `execFile` (or `fetch`), catching stderr for rate-limit detection; (b) wrap the synchronous `run('gh',...)` in a try/catch, detect the `gh` CLI's stderr rate-limit message, and `await sleep(retryWaitMs(...))` before the next iteration in `waitChecks`; (c) defer land-guard changes entirely (low volume). Whichever is chosen, the plan and the lane description must match the actual code shape.

### R1-F5 [minor]

D10 states the tick constants will be 'exported, so tests can pin them' as though this is a new change, but CI_TICK_MS, DEPLOY_TICK_MS, and VERIFY_TICK_MS are already exported at lines 1454-1461 of dev-autopilot-watcher.ts.

- `exafyltd/vitana-platform:services/gateway/src/services/dev-autopilot-watcher.ts:1454` — export {
  CI_TICK_MS,
  DEPLOY_TICK_MS,
  VERIFY_TICK_MS,
  VERIFICATION_WINDOW_MS,
  DRY_RUN,
  DRY_RUN_SETTLE_MS,
};

Suggestion: Correct D10 to note the constants are already exported. The plan only needs to change their values, not their export status.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
