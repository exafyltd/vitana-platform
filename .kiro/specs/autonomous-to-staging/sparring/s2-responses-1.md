# Responses to session 2 round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "In PR CI the gate-invariants script and its expectations are both loaded from the merge-base with git show into RUNNER_TEMP (PR-GATE.yml:169 pattern); only GATE-INVARIANTS.yml on main runs the main version."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "GATE-INVARIANTS.yml now checks every merge commit on main that touches a protected gate file for two accept entries from distinct chain models on the merged head (or the logged bootstrap authority of this plan for its bootstrap lanes) and fails loudly with an OASIS collab.gate.bypass_detected event otherwise."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Interface clarified: a separate entry point staging-db-apply-migration.sh --cluster <name> --file <f>, cluster required, refuses vitana-aurora-prod unconditionally with no override; the existing production script stays unchanged and dispatch-only after PUBLISH; --target phrasing removed from the script description."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "VTID-ALLOCATE uses pull_request_target: base-branch workflow and scripts, PR files read only as data, no PR code executed, contents: write on the commit job only, same-repo branches only; VTID-ALLOCATE.yml is added to protected-gate-files.json in lane machine-gate-protected."
  }
]
```
