# Sparring round 2 — converged

Session: `12d09af7-a668-4c34-91e0-f7dbf010f29d` · plan hash `d61b11803866df427779c4f01dfd60db6818b8a65e7a8cfbfa7ee5fab7b18023`

## Summary

Round 2 review of the re-plan. Both R1-F1 and R1-F2 were accepted and properly addressed in the revision. I verified 6 distinct premises against the code at the pinned commit. All core technical premises hold: the `shapeOf()` exact-match function at parity-ledger.mjs:60, the `m.own !== 'A'` class-A gate in core-closure.mjs:153, the type-only import exclusion at extraction-deps.mjs:183-184, the `@/*` tsconfig alias at line 11, feed-compose.ts being IO-free (110 lines, single `import type`), and news-feed-ranker.ts tail (340-380) being pure helpers. One new minor finding: the plan's measured state ("all `status: not_started`") contradicts the pinned commit where all 27 home-feed rows show `status: native`. The core manifest correctly lacks feed-compose/news-feed-ranker entries, confirming that extraction is real remaining work. No blockers found.

## Findings

### R2-F1 [minor]

The plan's measured state claims all 27 home-feed parity rows are `status: "not_started"`, but at the pinned commit (3a690a9) every one of the 27 rows already shows `status: "native"` (e.g. HOME.OVERVIEW at line 1511, COMM.FIND_PARTNER at line 563, /home/compose at line 2603). The plan explains this is a re-plan of already-approved lanes (VTID-05296/05297/05298) being reissued under new VTIDs due to missing Collab trailers, so this is understandable — but the measured-state section should clarify that the row statuses describe the pre-implementation baseline, not the current state at the code pin. An implementor or reviewer reading 'all not_started' and checking the pinned commit will be confused.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:1504` — "key": "HOME.OVERVIEW",
"web_path": "/home",
"kind": "screen",
"source": "registry",
"scope": "in",
"lane": "home-feed",
"status": "native",
"exception": null,
"owner": "kiro",
"last_parity_check": "2026-10-21"
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:2597` — "key": "/home/compose",
"web_path": "/home/compose",
"kind": "route",
"source": "exclusion",
"scope": "in",
"lane": "home-feed",
"status": "native",
"exception": null,
"owner": "kiro",
"last_parity_check": "2026-10-21"

Suggestion: Add a note to the measured-state section: 'These statuses reflect the pre-implementation baseline on origin/main before the first VTID-05296/05297/05298 PRs. At the code pin for this re-plan, all 27 rows have already been flipped to native by the prior lanes; the core extraction (feed-compose/news-feed-ranker manifest entries) is the remaining deliverable requiring a new VTID.'

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and properly addressed. The plan now records the correct 379-line count, confirms lines 341-379 are pure helpers, and retains core-closure --check as the gate.
- R1-F2: acknowledged — Accepted and properly addressed. Decision 2 now enumerates every runtime dependency of useAllNewsFeed.ts:15-24 and useNewsFeed.ts:9-15 with its native substitute, and tasks.md task 2a sizes the re-implementation as the largest part of the home lane.
