```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct and verified in the pipeline code. spar_refs is applied only at client.create (scripts/collab/plan-spar.mjs:312-320); client.round (plan-spar.mjs:332-333) forwards only { responses, revised_plan_text } with no extra_refs, and the gateway pins repo_refs from the round-1 session record, which was created before spar_refs was on the PR branch. So this in_progress session cannot gain exafyltd/vitana-v1 read access by answering another round. The fix is a FRESH client.create that picks up `spar_refs: - exafyltd/vitana-v1: main` from handoff.md. The reachable path for this non-infra session is the replan branch (plan-spar.mjs:307): once this session's verdict is escalated and the plan text has changed, the next PLAN-SPAR run creates session #2 (state.sessions.length 1 < MAX_SESSIONS 2) with extra_refs applied. This commit changes the plan text so that condition is pre-satisfied.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Accepted as the consequence of R1-F1: the load-bearing premises (CallProvider/CallManager mounted inside Messages.tsx; the chat/call hooks runtime-importing @/integrations/supabase/client as class B; the 9 parity-ledger rows partitioned 3+6; parity-ledger.mjs shapeOf driving the exclusion-route flips; the App.tsx route lines) are all vitana-v1 files and remain independently unverified while the partner is blind. The fresh, vitana-v1-pinned session must read each and cite it. Per the VTID-05253 precedent the finding names, the practical gate form is that every lane is built and reviewed against the real vitana-v1 source with the lane reviewer re-verifying these premises during implementation-PR review; that re-verification requirement is recorded here and belongs in the lane review, not deferred to implementer trust.",
    "deferred_to": "fresh vitana-v1-pinned sparring session (replan branch) + lane-reviewer re-verification per VTID-05253; flagged for owner/operator if replan does not auto-fire"
  },
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct: this is the root-cause structural gap. extraRefs is computed from handoff.md spar_refs on every run (plan-spar.mjs:286-293) but consumed only in the client.create branch (:312-320); client.round (:333) never spreads it, so any cross-repo plan that adds spar_refs AFTER its first session loses companion-repo access for every later round. The partner's suggested one-line patch (spread `...(extraRefs ? { extra_refs: extraRefs } : {})` into the client.round body) is the correct permanent fix and is safe because the gateway re-validates extra_refs keys against PLAN_SPARRING_REPOS server-side. That patch is a vitana-platform PIPELINE change outside this plan PR's scope (this is a native screen-port plan, no pipeline files), so it cannot be made inside this plan's _plan commit; it is flagged for owner/operator as a pipeline fix. For THIS plan, the in-scope recovery is the replan fresh-session path set up by this commit's plan-text change.",
    "deferred_to": "vitana-platform pipeline fix to plan-spar.mjs client.round (owner/operator) — out of scope for this screen-port plan PR"
  }
]
```
