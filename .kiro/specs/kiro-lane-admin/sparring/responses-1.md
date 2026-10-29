# Sparring responses — round 1

Session: `7bf26903-b794-418f-9ddf-9567453ee4f7` · plan hash `a81bfd65bd35e68e996b0c165701fa2fccf13139a0fdbdff14b1e4177bcd5170`

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed against source: validateRange (the Collab handoff check, scripts/collab/queue.mjs:528) classifies every changed file (classifyPath at :575) and, at :584, continues only when the commit's Collab-Lane trailer equals the target file's own classified key; none of the exemptions at :585-590 cover a cross-lane-file edit, so :591 would emit an error on every lane-admin PR (whose commits carry Collab-Lane: <admin-slug>/<admin-lane> while editing .kiro/specs/<target-slug>/lanes/<target>.md). The plan never updated this function — a real blocker. Fix adopted: add one exemption in validateRange's section-2 loop (near :584), narrow and symmetric with scopeCheck's laneAdmin gate — skip the trailer-mismatch error for a changed file only when (a) the file is a lane file (c.kind === 'lane'), (b) it lies within the committing admin lane's declared paths read from the admin lane's TRUSTED front matter (merge-base / qualifying plan( PR / other-repo main — never the PR head), and (c) that trusted front matter has lane_admin: true, executor: kiro and reviewer_seat: agent:vitana-lane-reviewer. The admin lane is identified by the commit's own Collab-Lane trailer; its trusted front matter is read exactly as scopeCheck reads trustedFm, so a PR cannot self-grant lane_admin in its head to unlock the exemption. Added to the enforcement lane's changes (design §1a / plan Changes 1) and to the test list as a new red-on-base case (T-G) plus a negative control (T-H: an ordinary cross-lane-file edit is still refused).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Confirmed: PERM = ['executor','seat','reviewer_seat','paths'] (:679); the earlier design's allow condition (trustedFm.executor === 'claude' && claudeOnly) || laneAdmin would, because scopeCheck runs once per lane keyed on the PR's single Collab-Lane, let the admin lane keep its OWN head PERM values un-pinned (:686), so an admin lane could widen its own paths or flip its own executor/reviewer_seat and escape the lane_admin constraints on its next PR. That breaks 'narrow paths stay narrow'. Fix adopted (partner suggestion (a), the most conservative): the laneAdmin carve-out never applies to the admin lane's OWN front matter. The admin lane's own PERM fields (and lane_admin itself) stay trusted-pinned exactly as today — an admin lane that changes its own PERM fields in its PR is refused and its fields are pinned back to trusted. The carve-out applies only when the lane being scope-checked is a TARGET lane file administered by a trusted lane_admin lane present in the same PR whose trusted paths cover this target lane file. Mechanically: when the lane under check is itself the admin lane (its own trusted front matter is lane_admin), laneAdmin is false for its PERM check; the exemption is evaluated for the target lane file against the admin lane's trusted paths, the same predicate R1-F1 adds in validateRange. This keeps 'the admin lane can never self-widen' literally true and is covered by new red-on-base case T-I (self-widen of the admin lane's own paths/executor/reviewer_seat is refused even when lane_admin: true is trusted) alongside T-B (a target lane's seat/paths reassignment passes).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Confirmed: governanceMergeAllowed (services/gateway/src/services/project-manager/governance.ts:184) today returns {ok:true} for a protected gate file only when isLegacyClaudeReview(review) on the current head (:186-188), and queue.mjs scope-check (:699) independently refuses protected gate files for any non-claude lane — two independent layers. The earlier design replaced the legacy-claude unlock in the PM with an agent-accept, which would remove the PM's independent defense-in-depth: an agent-reviewed lane PR touching protected gate files would pass the PM guard, and a --admin override of Lane scope (allowed for governance-artifact false positives) would then be caught by nothing. Fix adopted (partner recommendation): governanceMergeAllowed ALWAYS returns {ok:false, reason:'protected_gate_file'} for a protected gate file PR — the programmatic unlock is retired entirely, not transferred to an agent accept. The owner instruction naming the plan is an out-of-band human authority recorded in the lane log (collaboration.md §7b already treats 'the owner's instruction' as merge authority), never a code-level unlock the PM can forge from a review row. The dead isLegacyClaudeReview branch for protected gate files is removed; the PM keeps refusing protected gate files in code, so both layers (queue.mjs scope-check AND governance.ts) still refuse them — defense-in-depth preserved, nothing less protected than today. design §5 and plan Changes 1 updated; Jest cases updated so a protected-gate PR with an agent accept on the current head still yields reason:'protected_gate_file' (T-E mirror on the gateway side).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified line numbers on origin/main-equivalent HEAD (c3ca9f601b, scripts/collab/queue.mjs): validateLane at :206 (not ~190); the validateLane protected-gate path check at :232-235 (the globTouchesProtected push is :233); trusted-source logic (mergeBase / trustedFm / trustedFrom / plan-pr / vitana-platform fallbacks) at :664-670 (not :671-677); PERM at :679, PERM-change refusal at :684; protected-gate refusal in scopeCheck at :699; seat-ownership refusal at :714-715 (the else-if branch opens at :714, the error push is :715). validateRange cross-lane-file check at :584 (continue) / :591 (error), classifyPath at :575. design.md and plan.md corrected to these numbers.",
    "deferred_to": ""
  }
]
```
