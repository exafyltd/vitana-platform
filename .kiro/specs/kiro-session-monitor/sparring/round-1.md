# Sparring round 1 — in_progress

Session: `1b6a9871-3221-4fdd-83fc-24fd05263612` · plan hash `da9ba4993020f27ab5825fcfd00e1bc173ed29776fa9906f9f04bbd3c3745802`

## Summary

The plan is well-structured, read-only, and carefully scoped. All major premises about existing code (constants, functions, line numbers, OASIS events, PM thresholds) verified correctly against the pinned commit. The plan correctly identifies the gaps and proposes a pure-read classifier + acceptance suite with no new writes, migrations, or OASIS events. I have one minor finding regarding the `GithubReader` interface and one minor observation about route registration governance. No blockers or majors found.

## Findings

### R1-F1 [minor]

The plan says the monitor reads driver/claim ages through 'GithubReader.refDate (observe-live.ts:62)'. The interface `GithubReader` starts at line 62 but the visible portion (lines 62-75) declares tree, blob, file, openPulls, pullMergeable, pullFiles, pullCommits, commitFiles, checkRuns, behindBy, and variable — `refDate` is not shown in that range. The concrete `GithubRestReader` has `refDate` at line 716. If `refDate` is not on the interface (only on the concrete class), the monitor's injectable reader type would need to reference the concrete class, breaking the dependency-injection pattern used by PM tests.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:62` — export interface GithubReader {
  tree(repo: string, ref: string): Promise<Array<{ path: string; sha: string }>>;
  blob(repo: string, sha: string): Promise<string>;
  file(repo: string, path: string, ref: string): Promise<string | null>;
  openPulls(repo: string): Promise<GhPull[]>;
  pullMergeable(repo: string, n: number): Promise<boolean | null>;
  pullFiles(repo: string, n: number): Promise<string[]>;
  pullCommits(repo: string, n: number): Promise<GhCommit[]>;
  commitFiles(repo: string, sha: string): Promise<string[]>;
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
  behindBy(repo: string, base: string, head: string): Promise<number>;
  /**
   * A repository Actions variable.
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:716` — async refDate(repo: string, ref: string): Promise<string | null> {
    const r = await gh<{ commit?: { committer?: { date?: string } } }>(repo, `commits/${ref.split('/').map(enc).join('/')}`);
    return r.data?.commit?.committer?.date ?? null;
  }

Suggestion: Before implementation, confirm that `refDate` is declared on the `GithubReader` interface (it may be further down past line 75 — I could not read that far). If it is not on the interface, either add it to the interface (which touches an existing file the plan says is unchanged), or define a narrow reader type in the monitor that only requires `refDate`, keeping the DI testable.

### R1-F2 [minor]

The plan says the new route is mounted with 'one line in index.ts', but index.ts uses a route-guard system (`mountRouterSync` from `./governance/route-guard`, imported at line 65) for all route registration. The plan should explicitly state it will use `mountRouterSync` rather than bare `app.use()`, otherwise the route-guard duplicate-route detection and startup summary will not cover the new endpoint.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:64` — // VTID-01063: Route Guard for duplicate route detection
  const { mountRouterSync, logStartupSummary } = require('./governance/route-guard');

Suggestion: Explicitly state the route will be registered via `mountRouterSync` to satisfy the route-guard governance (VTID-01063).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
