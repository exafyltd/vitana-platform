# Responses — round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Option (b), plus a mechanical check. Rule 13 names the two merges that stay outside land-guard merge: spec-only plan( PRs (no reviewer entry) and the --admin governance-artifact false positive (common-rules rule 4). For each, land-guard checks must show that the only red is that logged false positive (run URL in merges.md). A real red never merges."},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "lane-land.md step 3f now says the closing record (lane state: done; handoff.md for _plan) must be merged to origin/main before land-guard release. A refusal prints the file path and the state it found on origin/main. §4 already tests that release of a lane at verified on origin/main exits 1 and leaves the claim."},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "The plan lists the imports exactly: globToRegex and PROTECTED_GATE_PATHS from queue.mjs. state: is read by land-guard's own one-line match, so parseFrontMatter and matchesAny are not imported."}
]
```
