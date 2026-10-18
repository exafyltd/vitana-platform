# Responses to s2-round-2 (mt-track-s)

Round 2 corrected the record: the partner's real round-1 findings were about this spec after all — the `s2-round-1.md`
*text* I answered in `s2-responses-1.md` was cross-contaminated with another spec's content (command-hub / tenant-admin
material that appears nowhere in mt-track-s), so those three rejections answered the wrong text. Round 2 restates the
true findings; I verified each against current code and answer them here. All three disputed items are now accepted or
deferred with a real fix, plus the new R2-F1 is accepted — the plan is updated accordingly.

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct and verified 2026-10-18. vitana-v1/.github/workflows/supabase-functions-deploy.yml deploys only changed/listed folders (push path: git diff of supabase/functions/, then `supabase functions deploy <fn>`) and has NO delete-removed-functions step — so deleting the linkedin-import directory + config.toml block only stops re-deploy; an already-deployed copy stays invocable. Undeploy is exclusively via vitana-v1/.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml (dispatch-only `supabase functions delete`, ALLOWLIST-gated with linkedin-import NOT currently on it, and it refuses to delete a name still present under supabase/functions/). STAGING-VERIFY cannot confirm undeployment (invoking is a POST the read-only guard aborts, rule 48). Fix: plan.md ## Fix + ## Rollout + ## Risks now name a two-move closure — (1) this Kiro lane deletes source/config/test refs; (2) a post-merge governance follow-up (executor claude: edits .github/workflows/**, dispatches the workflow, writes to live Supabase — not Kiro) adds linkedin-import to the RETIRE ALLOWLIST and dispatches it, proven by that workflow's own Confirm step (a read of the project function list). S-J's 'still shipped' wording is marked satisfied only once that run reports it absent.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The real finding (per round 2's acknowledgement) is that the partner's session has no pinned vitana-v1 ref ('no pinned ref for exafyltd/vitana-v1'), so it cannot verify the plan's exact vitana-v1 line citations. Those citations are nonetheless correct — re-verified in the local vitana-v1 checkout 2026-10-18: config.toml:72 `[functions.linkedin-import]`; vitest.config.ts:19 `include: ['src/**/*.test.{ts,tsx}']`; package.json:29 `\"test\": node scripts/check-edge-data-client.mjs && node scripts/check-realtime-helper.mjs && vitest run`; edge-functions-caller-identity.s4.test.ts linkedin-import at loop :77-88, profile loop :90-92, flagged-for-removal :107-110, arrayContaining scan :272; linkedin-import/index.ts imports requireUser, forbidden from _shared/caller-auth.ts (index.ts:1-4) with the VTID-05049 'flagged for removal' comment. To make the plan self-evidencing for a reviewer without a vitana-v1 pin, T1 already greps both repos before deletion and the lane carries docs/validation/<vtid>/ with the evidence; no citation changed because all were confirmed accurate. Disposition accepted as a documentation/evidence-surfacing improvement rather than a plan-logic change.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "The real finding is that check-edge-function-auth.mjs is a static import/call-name match and does not prove requireUser runs before any response-generating logic on every path. Accepted with a scoped tightening rather than a promise of control-flow analysis: plan.md ## Tests now requires the gate to assert BOTH the _shared/caller-auth.ts import AND an actual call to a gate function (requireUser / isServiceRoleCaller / isTriggerSecretCaller) — an unused import alone no longer passes — and states plainly it is a static heuristic (the functions are Deno that node/Vitest cannot execute, the same constraint the collected s4 suite already documents). Per-function before-the-body ordering (await requireUser precedes req.json()) is already asserted by that s4 suite for the known body-id readers; the inventory gate is the tree-wide floor that no NEW function ships ungated. Full control-flow proof is out of proportion for a dead-code-removal lane and would duplicate what the s4 suite already covers.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct and verified 2026-10-18. VTID-05044 closed BOTH S-G (invitations) and S-K (billing): the S-K fix (fetchTenantSettingsFeatureFlags .maybeSingle()->per-tenant aggregate) carries the VTID-05044 annotation at services/gateway/src/routes/billing.ts:1308 and services/gateway/src/routes/billing-repository.ts:281. The plan's Depends On listed 'VTID-05044 (S-G)' only. Fix: Depends On now reads 'VTID-05044 (S-G + S-K — one VTID closed both; see Problem #11)', and Problem #11 (S-K) now cites billing.ts:1305-1322 / billing-repository.ts:281-289 with VTID-05044 and notes both call sites carry its annotation. Ledger-accuracy gap closed.",
    "deferred_to": ""
  }
]
```
