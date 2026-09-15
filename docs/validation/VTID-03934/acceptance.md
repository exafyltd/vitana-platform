# VTID-03934 — Fix stale facts + add VTID-citation guardrail in `SPEC_GEN_SYSTEM_PROMPT`

Found via the same Command Hub Operator quality evaluation as VTID-03933: a
real frontend task was submitted through the live Operator chat API, traced
through task creation -> planner sweep -> spec draft (VTID-03931), and the
generated spec was checked line-by-line against the real codebase rather
than accepted at face value.

## Root causes (all in `services/gateway/src/routes/specs.ts`'s hardcoded
`SPEC_GEN_SYSTEM_PROMPT`, fed to Claude/Bedrock as the `system` argument
for every spec generation)

1. **Dead deploy path described as live.** The prompt said *"Deploy via
   GitHub Actions EXEC-DEPLOY.yml → Cloud Run source deploy"*. GCP/Cloud
   Run was fully decommissioned 2026-08-16 (this repo's own CLAUDE.md
   banner) — the generated spec's Rollback Plan reproduced this verbatim
   as `gcloud run services update-traffic vitana-gateway
   --to-revisions=...`, which would fail outright against decommissioned
   infrastructure if anyone tried to execute it.
2. **Stale line-count claim.** The prompt said the Command Hub frontend
   bundle is "~30k lines". `wc -l
   services/gateway/src/frontend/command-hub/app.js` shows **56,112**
   lines — nearly double the claimed figure — and the generated spec's
   risk section repeated the wrong number verbatim.
3. **No guardrail against inventing a VTID as a coordination risk.** The
   generated spec's Risk section cited *"VTID-03573 (in_progress, INFRA
   layer) is actively modifying internal auth flows"* as a coordination
   risk. A whole-repo grep for `VTID-03573` returns zero matches anywhere
   — the model invented a plausible-looking VTID number rather than
   grounding the claim in `gatherSystemContext()`'s real, live-queried
   "Related/Similar Tasks"/"OASIS Events" sections, which is the only
   legitimate source of real VTID references in this prompt.

## Fix

1. Corrected the deploy-path description to the real, staging-first AWS
   ECS model (`AWS-STAGE-DEPLOY-GATEWAY.yml` auto-deploys `main` to
   staging; production only via the Command Hub PUBLISH button or a manual
   `AWS-PROD-DEPLOY-GATEWAY.yml` dispatch), and explicitly flags
   GCP/Cloud Run/`EXEC-DEPLOY.yml` as decommissioned rather than silently
   dropping the mention (so the model knows NOT to reach for them, rather
   than just never having heard of them).
2. Replaced the stale "~30k lines" figure with a qualitative description
   ("a large single-file bundle — tens of thousands of lines") instead of
   another hardcoded number that will just go stale again the same way.
3. Added Output Rule #8: the model must NEVER cite a specific VTID number
   as a coordination risk/dependency unless that exact VTID appears
   verbatim in the "--- SYSTEM CONTEXT ---" section of the task message
   (built by `gatherSystemContext()` from real `vtid_ledger`/`oasis_events`
   queries) — otherwise it must describe the risk generically (by
   area/file/table) instead of inventing a VTID.
4. Exported `SPEC_GEN_SYSTEM_PROMPT` (previously an unexported `const`,
   matching this file's existing `SPEC_GEN_MODEL` convention) so its
   content can be asserted directly in a unit test without a live LLM call.

No other function in `specs.ts` was touched. `gatherSystemContext()`,
`generateSpecWithLLM()`, the `/generate` route handler, and
`SPEC_TEMPLATE` (the non-LLM fallback template) are all unchanged.

---

AC-1 — the prompt no longer describes EXEC-DEPLOY.yml/Cloud Run as the live
deploy mechanism

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "no longer
describes EXEC-DEPLOY.yml/Cloud Run as the live deploy mechanism"
Output: outputs/targeted-tests.txt

AC-2 — the prompt describes the real AWS ECS staging-first deploy path
(`AWS-STAGE-DEPLOY-GATEWAY.yml`, `AWS-PROD-DEPLOY-GATEWAY.yml`,
`vitana-gateway-awsdr`, PUBLISH button)

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "describes the
real AWS ECS staging-first deploy path instead"
Output: outputs/targeted-tests.txt

AC-3 — GCP/Cloud Run is explicitly flagged as decommissioned, not silently
dropped

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "explicitly flags
GCP/Cloud Run as decommissioned rather than silently omitting it"
Output: outputs/targeted-tests.txt

AC-4 — the stale "~30k lines" figure is gone, and is not replaced by
another hardcoded line count

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "no longer states
the stale \"~30k lines\" app.js line count" and "does not replace the
stale figure with another hardcoded line count that will just go stale
again"
Output: outputs/targeted-tests.txt

AC-5 — the gateway is described as running on AWS ECS, not "Cloud Run"

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "describes the
gateway as running on AWS ECS, not \"on Cloud Run\""
Output: outputs/targeted-tests.txt

AC-6 — a new Output Rule explicitly forbids citing a fabricated VTID as a
coordination risk unless it appears verbatim in the SYSTEM CONTEXT section

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "adds an explicit
output rule forbidding a fabricated VTID coordination-risk citation"
Output: outputs/targeted-tests.txt

AC-7 — the new rule is appended as rule 8, all 7 pre-existing output rules
are unchanged

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "the new
VTID-citation rule is appended to (not replacing) the existing 7 output
rules"
Output: outputs/targeted-tests.txt

AC-8 — the Required Spec Structure section (headings 1-9) is unaffected by
the fact corrections

TEST: `test/specs-gen-system-prompt-accuracy.test.ts` — "still contains the
required spec structure section headings, unaffected by the fact
corrections"
Output: outputs/targeted-tests.txt

AC-9 — mutation-verified: reverting the export + fact corrections
reproduces the pre-fix prompt and fails all 9 new tests

Verified manually: `git stash` (reverting the fix, restoring the
unexported `const SPEC_GEN_SYSTEM_PROMPT` with the stale facts) → re-ran
`test/specs-gen-system-prompt-accuracy.test.ts` → 9/9 tests failed (the
import resolves to `undefined` since the symbol isn't exported pre-fix,
which is itself proof the export is the load-bearing part of the fix).
`git stash pop` restored the fix and all 9 tests passed again.

AC-10 — no regression to the existing `specs-generate-claim.test.ts`
(the atomic-claim route tests, same file's other exported behavior)

TEST: `test/specs-generate-claim.test.ts` (full file)
Output: outputs/targeted-tests.txt

AC-11 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
Note: both show the same 2 pre-existing, unrelated `tsc` errors and 12
pre-existing failing suites already documented in VTID-03927/VTID-03933's
evidence packs (missing `@aws-sdk` sub-packages in this session's local
`node_modules`, not referenced by any file this VTID touches). Zero
failures in `specs.ts` or either specs test file. CI's own `npm ci` in the
Build Gate step installs from the committed lockfile fresh, which does not
carry this local `node_modules` gap forward.
