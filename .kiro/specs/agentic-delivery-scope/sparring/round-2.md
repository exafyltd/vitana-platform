# Sparring round 2 — converged

Session: `90113972-d727-470c-b3c4-677c7e2478d9` · plan hash `4bfbb4b411310757ea55eef60935e49546a4c8843e698f48457a2313f935dd72`

## Summary

All three Round 1 findings were accepted and are addressed in the revised plan. The status-mapping allowlist (R1-F1), the `dispatcher-pm` lane with `act.ts` (R1-F2), and the `role`/`model`/`details` passthrough (R1-F3) are clearly specified. The plan is well-structured; the only new concern is the tighter heartbeat margin introduced by `heartbeat-30`.

## Findings

### R2-F1 [minor]

The `heartbeat-30` lane doubles the heartbeat interval from 15 min to 30 min while keeping the alive window at 45 min (`ALIVE_MS`). Today, with a 15-min heartbeat and 45-min alive window, one missed heartbeat commit still leaves the driver 'alive' (30 min < 45 min). After the change, a single missed heartbeat means the next successful one is ~60 min after the last, exceeding the 45-min window, so the PM treats the driver as dead. This zero-tolerance margin makes false-dead signals likely in practice (git push failures, transient network errors), which triggers PM reassignment of all the plan's stale-ready lanes.

- `exafyltd/vitana-platform:scripts/collab/plan-driver.mjs:30` — export const ALIVE_MS = 45 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/types.ts:393` — /** A driver is alive while its heartbeat ref's committer date is younger than this. */
export const DRIVER_ALIVE_MS = 45 * 60 * 1000; // 45 min

Suggestion: Either increase the alive window to 75 min (2.5× the new heartbeat) to maintain a one-missed-heartbeat tolerance, or keep the heartbeat at 15 min and cap commits (e.g., no-op when the last heartbeat ref is <30 min old, achieving the 'at most one commit per 30 min' goal without lengthening the interval).
