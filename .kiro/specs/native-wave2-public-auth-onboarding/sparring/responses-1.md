```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Round 1 escalated on a partner-side evidence_floor_not_met error: the session raised R1-F1..R1-F5 but could cite no file it read with read_file, because exafyltd/vitana-v1 (where every premise this plan makes lives — apps/mobile/parity/ledger.json, src/App.tsx, the PublicAppShell web sources, apps/mobile/src/linking/* and apps/mobile/src/auth/*) had no pinned ref in the session. The finding bodies were never produced, so there is no substantive claim to accept or rebut on the merits; the root cause is the blind spar. Accepted as root-caused: handoff.md now declares `spar_refs:\n  - exafyltd/vitana-v1: main`, which PLAN-SPAR forwards as extra_refs so the next (fresh) session can read vitana-v1@main, meet the evidence floor (>=3 premise checks citing read_file), and raise verifiable findings. This is the recovery path by which the sibling native-wave2-home-feed-news converged after PR #4201 (fa73aabd0).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Same root cause as R1-F1: this finding id was named in the evidence_floor_not_met escalation with no body produced (the partner could not read vitana-v1 to cite evidence). No substantive premise to answer on the merits. Accepted as root-caused by the now-declared vitana-v1 spar_ref; the re-triggered round will read the source and raise a verifiable finding if a real defect exists.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Same root cause as R1-F1: named in the evidence_floor_not_met escalation with no body; the partner cited no read_file evidence because vitana-v1 was inaccessible. No substantive premise to answer. Accepted as root-caused by the declared spar_refs: exafyltd/vitana-v1: main; verifiable findings follow in the re-triggered round.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Same root cause as R1-F1: named in the evidence_floor_not_met escalation with no body; no read_file evidence because vitana-v1 was unpinned. No substantive premise to answer. Accepted as root-caused by the declared vitana-v1 spar_ref; the re-triggered round reads vitana-v1@main and raises verifiable findings.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Same root cause as R1-F1: named in the evidence_floor_not_met escalation with no body; the partner cited no file it read because vitana-v1 had no pinned ref. No substantive premise to answer on the merits. Accepted as root-caused by the now-declared spar_refs: exafyltd/vitana-v1: main; the fresh session can meet the evidence floor and verify the plan's public/auth/onboarding premises against source.",
    "deferred_to": ""
  }
]
```
