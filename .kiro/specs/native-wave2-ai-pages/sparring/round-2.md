# Sparring round 2 — converged

Session: `49383635-606f-4531-bb85-d2206fcead9c` · plan hash `164116ab192f5eb5edd9d3faecc99fcb91ad47ba2bff113fee515c8450158d1b`

## Summary

The plan is well-structured and the key premises hold. The `useAIAssistants.ts` class-B classification, the `core-closure.mjs` class-A gate, the `shapeOf` query-dropping logic for the 6 `/assistant*` rows, and the Wave 1 shell are all verified against code. The 11 AI-lane rows I could read in the ledger (5 AI.* + 6 ASSISTANT.*) all match the plan's claims; the 12th (`/comm/talk-to-vitana`) is correctly routed to lane `ai` by the longest-prefix rule in `parity-scope.json`. One minor concern about shared directory structure between lanes.

## Findings

### R2-F1 [minor]

The plan claims 'three disjoint lanes by cluster and by route subtree' but the ai-chat lane's route file lands in the `comm/` subtree which already contains native route files from the home-feed lane (COMM.FIND_PARTNER, COMM.GROUPS, COMM.GROUP_DETAIL are already status `native` in the ledger). These lanes share the `comm/` route subtree, so they are not strictly disjoint by route subtree. If a `_layout.tsx` exists or needs modification in `comm/`, both lanes would touch the same file, creating a merge-conflict risk or layout regression.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:556` — COMM.FIND_PARTNER ... status: native ... COMM.GROUPS ... status: native ... COMM.GROUP_DETAIL ... status: native
- `exafyltd/vitana-v1:scripts/native/parity-scope.json:99` — { "prefix": "/comm/talk-to-vitana", "lane": "ai" }
- `exafyltd/vitana-v1:scripts/native/parity-scope.json:114` — { "prefix": "/comm", "lane": "home-feed" }

Suggestion: Clarify in the ai-chat lane spec that its route file goes into the existing `comm/` directory owned by home-feed, and explicitly state the lane must NOT modify or add a `_layout.tsx` in `comm/` (or if one already exists, must not touch it). Alternatively, note the shared-directory constraint so reviewers check for layout-file conflicts.
