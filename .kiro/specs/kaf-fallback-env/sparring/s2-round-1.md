# Sparring round 1 — in_progress

Session: `d454dd62-b49c-4b9d-8e10-1f51caf1fdca` · plan hash `e2af6b55af540186563b767d243d3ea659c5b78dab27a96083b8b2d8c9ef75db`

## Summary

All six premises stated in the plan hold on the pinned commit. The core diagnosis is correct: `GithubRestReader.variable` returns `null` on 404 (never throws), so the `catch` in `observeClaude` never fires, `env.CLAUDE_AVAILABLE` is never consulted, and the staging task-definition fix alone would not suffice until the code fix also lands. The two-lane structure, merge order, size-cap guard, and test plan are coherent. Two minor gaps were found: an unverified env-wiring premise that is the live load-bearing path for Lane B's fix, and a mechanically unenforced merge-order requirement.

## Findings

### R1-F1 [minor]

The plan asserts that when `loop.ts` omits `env` from the `GithubObserver` constructor, `observe()` falls back to reading `process.env` each tick (stated as `observe-live.ts:286`). This is the live load-bearing path that makes Lane B's fix actually work in production: `GithubRestReader.variable` throws (404), the `catch` in `observeClaude` fires, and it reads `env.CLAUDE_AVAILABLE` — which is only `process.env.CLAUDE_AVAILABLE` (i.e., the task-definition variable) if that default is in place. The plan does not cite the specific line where `GithubObserverDeps.env` is declared optional with a `process.env` default. Lines 65–90 of observe-live.ts (the interface block) were confirmed readable, but the `GithubObserverDeps` definition starts at line 90 and was not read in this session; the env-wiring behaviour in loop.ts was likewise not verified. If `env` is not optional-defaulting-to-`process.env`, the fix functions only in injected tests and is a no-op on the live code path.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:563` — private async observeClaude(repos: string[], openItems: string[], prCommits: GhCommit[], env: NodeJS.ProcessEnv): Promise<ObservedClaude> {
  ...
  try {
    flag = parseFlag((await r.variable(PLATFORM, 'CLAUDE_AVAILABLE'))?.trim().toLowerCase());
  } catch {
    flag = parseFlag(env.CLAUDE_AVAILABLE?.trim().toLowerCase());
  }
- `exafyltd/vitana-platform:services/gateway/test/project-manager/observe-live.test.ts:179` — const bad = reader({ variable: async () => { throw new Error('403'); } });
const a = await new GithubObserver({ gh: bad, data: data(), repos: [P], now: () => NOW, env: { CLAUDE_AVAILABLE: 'false' } }).observe('live');

Suggestion: Add a cited line reference — either in `GithubObserverDeps` (where `env` is declared with a default of `process.env`) or in `loop.ts` (where `process.env` is explicitly passed) — so the evidence for the live code path is complete. If `env` is declared as `env?: NodeJS.ProcessEnv` and defaults to `process.env` inside the constructor, that single line settles the question and should be the cite for this premise.

### R1-F2 [minor]

The merge order 'ff-stage-env first, then ff-pm-flag' is required for STAGING-VERIFY on the `ff-pm-flag` merge commit to pass (the task definition must already carry `CLAUDE_AVAILABLE=false` when the code fix deploys), but the ordering has no mechanical enforcement. The merge lock serialises merges but enforces no ordering. If `ff-pm-flag` merges first, the staging deploy it triggers will have no `CLAUDE_AVAILABLE` in the task definition, `env.CLAUDE_AVAILABLE` will be undefined, `parseFlag(undefined) = null`, and the STAGING-VERIFY `/mode` assertion (`executor_mode: kiro_fallback`) fails — requiring at least one infra re-run after `ff-stage-env` catches up.

- `exafyltd/vitana-platform:.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1193` — "PM_AGENT_ENABLED","PM_MODE") | not) ]
  + [ ... {name:"PM_AGENT_ENABLED", value:"true"},
        {name:"PM_MODE", value:"live"}, ...
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:566` — const parseFlag = (v: string | null | undefined) => (v === 'false' ? false : v === 'true' ? true : null);
try {
  flag = parseFlag((await r.variable(PLATFORM, 'CLAUDE_AVAILABLE'))?.trim().toLowerCase());
} catch {
  flag = parseFlag(env.CLAUDE_AVAILABLE?.trim().toLowerCase());
}

Suggestion: Either add a lightweight gate (e.g., the `ff-pm-flag` pipeline step checks that `CLAUDE_AVAILABLE` is present in the current staging task definition before running STAGING-VERIFY, and retries after `ff-stage-env` lands if absent), or document this explicitly as an allowed single STAGING-VERIFY re-run under Risk 3's one-attempt allowance so the operator knows what to expect if order slips.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
