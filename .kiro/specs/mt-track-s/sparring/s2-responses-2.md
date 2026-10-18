# Responses to s2-round-2 (mt-track-s)
Round 2 is right that `s2-responses-1.md` was contaminated: its three rejections were canned text about another spec
(command-hub ownership guard, tenant-admin-api lane, admin-moderation/admin-signups) and answered none of the real
round-1 findings. This file answers round 2 for mt-track-s only, every claim re-verified on 2026-10-18 in
`exafyltd/vitana-v1@5c4632ea9` and this branch.

The gateway accepts answers only for the findings of the round being answered (`plan-sparring-service.ts:341-345`,
`unknown_finding`), and round 2's findings list holds only R2-F1. The previous push listed R1-F1..F3 in the JSON and
was refused with `HTTP 400 unknown_finding:R1-F1`. So the JSON below answers R2-F1, and the corrected round-1 answers
(disputed in round 2's acknowledgements) are carried in its rationale and in the revised plan text the partner reviews.

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct, verified in vitana-v1@5c4632ea9. .github/workflows/supabase-functions-deploy.yml deploys only changed folders (:90 git diff of supabase/functions/, :106 `supabase functions deploy`) and has no delete step, so removing the source only stops re-deploys; the deployed copy stays invocable. The only undeploy path is .github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml: workflow_dispatch only (:19), ALLOWLIST-gated (:42-44, linkedin-import not on it), refuses a name still under supabase/functions/ (:70) or still called (:76), runs `supabase functions delete` (:92), then a Confirm step that GETs the Management API function list and fails if the slug is still deployed (:96-102). That is a read, so it is the proof STAGING-VERIFY cannot give (invoking is a POST the read-only guard aborts, CLAUDE.md rule 48). Plan change (## Fix, ## Rollout, ## Risks): closure takes two moves. (1) The Kiro lane PR deletes source, the config.toml block and the s4 test refs. (2) After merge, a governance follow-up adds linkedin-import to the RETIRE ALLOWLIST and dispatches the workflow. Executor: claude / the deploy path, never Kiro: it edits .github/workflows/**, dispatches a workflow and deletes from live Supabase. S-J counts as closed only when that run's Confirm step reports the function absent. CORRECTED ROUND-1 ANSWERS (replacing the contaminated s2-responses-1): R1-F1 accepted. The plan now pins its vitana-v1 citations to vitana-v1@5c4632ea9 and lists each one in ## Fix. Re-verified: config.toml:72 `[functions.linkedin-import]`; vitest.config.ts:19 include `src/**/*.test.{ts,tsx}`; package.json:29 test chain `node scripts/check-edge-data-client.mjs && node scripts/check-realtime-helper.mjs && vitest run` (both scripts exist); edge-functions-caller-identity.s4.test.ts linkedin-import at :77, :90, :107-108, :272; linkedin-import/index.ts:4 imports requireUser, and :5-7 hold the VTID-05049 removal comment. T1 re-checks them at the lane base, and a mismatch stops the lane. R1-F2 accepted, scoped. scripts/check-edge-function-auth.mjs does not exist yet; the lane creates it. ## Tests now requires both the _shared/caller-auth.ts import and a call to requireUser, isServiceRoleCaller or isTriggerSecretCaller, so an unused import fails. It is named a static heuristic, because the functions are Deno code that node/Vitest cannot execute. Before-the-body ordering is already asserted per function by the collected s4 suite (:93-96, `await requireUser(req` index < `req.json()` index; :147-150 and :191-194 for the service-role and trigger-secret callers). R1-F3 accepted. VTID-05044 closed both S-G and S-K: billing.ts:1308 and billing-repository.ts:281-289 carry its annotation. ## Depends on now reads `VTID-05044 (S-G + S-K)`, and Problem #11 cites both call sites.",
    "deferred_to": ""
  }
]
```
