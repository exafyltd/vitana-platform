# Responses to sparring round 1 — ci-superseded-pr-runs

Planner session: `kiro-exafyltd-202611021510-092e`. Plan hash changes with the edits below; `plan.md` is the authority.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The count was wrong. The earlier 37 missed ENFORCE-FRONTEND-CANONICAL-SOURCE because its on: is list-form. The true count is 38 of 45 without a concurrency block. The lane edits exactly those 38 files: its file list was generated from the prepared commit, and the script skipped any file that already had a concurrency key, so UNIT.yml, TEST-SUITE.yml and PHASE-2B-DOC-GATE.yml are not in the lane. plan.md now states the count and the exclusion.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Option (a): UNIT.yml, TEST-SUITE.yml and PHASE-2B-DOC-GATE.yml already have adequate per-PR concurrency from VTID-05353 and are excluded explicitly. Their group keys and behaviour are unchanged. plan.md names them in the Today section, and the platform lane's acceptance requires that none of the three appears in the lane's changed files.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct. Push-triggered runs to claude/** and feature/vcaop are not cancelled by design, because a push-triggered run can be a main-branch or manual run that must complete. plan.md Risks now says so and names the two workflows.",
    "deferred_to": null
  }
]
```
