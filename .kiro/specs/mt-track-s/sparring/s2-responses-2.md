# Responses to sparring round 2 (session d0c274cd)

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified: vitana-v1 .github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml:42-45 ALLOWLIST lacks linkedin-import, and .github/** is a governance path (collaboration.md:99), so the follow-up needs an executor: claude lane with its own VTID. Added lane s-j-retire-function (vitana-v1, executor claude, reviewer_seat jtadic, depends_on [s-j-route-inventory] because RETIRE refuses names still under supabase/functions/, paths .github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml + docs/validation/**). Its commit adds linkedin-import to ALLOWLIST; after merge the same lane, under its VTID, dispatches the workflow and records the Confirm read in docs/validation/<vtid>/. S-J closes when that lane is done. plan.md ## Fix/## Tests/## Rollout/## Risks/## Depends on, tasks.md (new lane section R1-R2), lanes/s-j-retire-function.md and handoff.md updated.",
    "deferred_to": ""
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified at vitana-v1@32a82e6b6: 65 edge functions; only 6 import _shared/caller-auth.ts (fetch-user-context, linkedin-import, process-campaign-queue, queue-campaign-recipients, send-welcome-discount, social-media-import; each also calls requireUser/isServiceRoleCaller/isTriggerSecretCaller). The other 59 would fail the gate as written. Fixed by making the gate a ratchet with a frozen in-script LEGACY map of all 59, enumerated in plan.md ## Fix and each tagged with its observed pattern: B-user 33 (own auth.getUser/getClaims, incl. get-proactive-context, generate-proactive-greeting, remove_super_admin), B-sig 1 (stripe-webhook), B-secret 3 (send-test-user-confirmation, test-api-integration, verify-package-payment), C-unreviewed 22 (listed by name). Functions not in LEGACY must import + call caller-auth; a LEGACY key without a folder fails, so the map only shrinks. The map lives inside scripts/check-edge-function-auth.mjs (already in paths), so no legacy function file is edited or added to paths and the first CI run is green. LEGACY tags are not approvals: the 22 C-unreviewed functions are tracked residual (c) in plan ## Out of scope and handoff.md for the WS0 route-inventory backlog.",
    "deferred_to": ""
  }
]
```
