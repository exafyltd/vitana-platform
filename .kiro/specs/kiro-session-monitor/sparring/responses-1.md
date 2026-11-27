# Responses to round 1

R1-F1: accepted in substance. `refDate` is declared on the `GithubReader` interface (`observe-live.ts:81`; the finding's excerpt stopped before it), so the interface needs no change. To keep the dependency injectable and `observe-live.ts` untouched, the plan now types the monitor's reader as `Pick<GithubReader, 'refDate'>`.

R1-F2: accepted. The plan and `tasks.md` now state that the route is registered with `mountRouterSync(..., { owner: 'operator-kiro-monitor' })` beside `operator-kiro-runs` (`index.ts:896`), and the lane acceptance requires a test of the mount line.

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "refDate is on the GithubReader interface at observe-live.ts:81; the plan now types the monitor reader as Pick<GithubReader, 'refDate'> so tests inject a one-method fake and observe-live.ts stays unchanged."},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "The plan and tasks now require registration through mountRouterSync with owner 'operator-kiro-monitor' (index.ts:896 pattern, route guard VTID-01063), and a test asserts the mount line."}
]
```
