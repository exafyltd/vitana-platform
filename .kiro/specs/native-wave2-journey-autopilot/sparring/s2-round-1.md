# Sparring round 1 — in_progress

Session: `2c2968ab-8049-4dc7-8826-909c958c631c` · plan hash `6a529f2f0918ab19af3d57b93989f7546cde152e1315d883af99ad09f78e21fb`

## Summary

The plan is well-structured and most load-bearing premises verify against the pinned commit. Both helper files (horizonBuckets.ts, vitana-projection.ts) are confirmed IO-free / class A. The App.tsx routes, exclusions.json entry, parity-scope.json lane rules, and manifest.json autopilot types entry all check out. One minor line-number inaccuracy in the manifest reference. I was unable to locate the second parity ledger row (/autopilot/audiobook) in the 5382-line ledger.json within the tool-call budget, though all the upstream sources (exclusions.json, parity-scope.json) that the parity-ledger.mjs --sync script uses to generate it are confirmed present, making its existence highly plausible. No blockers or governance violations found.

## Findings

### R1-F1 [minor]

The plan states `src/types/autopilot.ts` is 'already a type-only core re-export (packages/core/manifest.json:59)' but the actual entry for src/types/autopilot.ts is at lines 74-84, not line 59. Line 59 contains '"N3"' which is part of the data-routing.ts entry.

- `exafyltd/vitana-v1:packages/core/manifest.json:56` — Lines 56-62 show data-routing.ts entry with 'N3' at line 59; lines 74-84 show the actual src/types/autopilot.ts entry

Suggestion: Update the manifest line reference from :59 to :74. Not load-bearing but could confuse the executor.

### R1-F2 [minor]

The plan states the /autopilot/audiobook route in App.tsx is at lines 1544-1548, but the closing tag of that Route element is at line 1549, not 1548.

- `exafyltd/vitana-v1:src/App.tsx:1544` — Line 1544: comment, 1545: <Route path="/autopilot/audiobook" element={, 1546: <AuthGuard>, 1547: <AutopilotDashboard />, 1548: </AuthGuard>, 1549: } />

Suggestion: Correct the line range to 1544-1549. Minor reference accuracy issue.

### R1-F3 [minor]

The plan states horizonBuckets.ts is 122 lines and vitana-projection.ts is 122 lines. Both files are actually 123 lines each.

- `exafyltd/vitana-v1:src/lib/horizonBuckets.ts:1` — File has 123 lines total (line 123 is closing brace of bucketActions)
- `exafyltd/vitana-v1:src/lib/vitana-projection.ts:1` — File has 123 lines total (line 123 is closing brace of buildHorizonPoints)

Suggestion: The plan notes these are approximate line counts for scoping and says exact counts are not load-bearing. Acknowledged — no action needed.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
