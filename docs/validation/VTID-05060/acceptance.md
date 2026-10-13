# VTID-05060 - Resume a VTID from anywhere; keep the developer's Kiro model pick

Owner approval 2026-10-10 (Gate 1: "Yes"; item 6 replaced by the owner: the developer selects the model). Sparring: `plan-sparring.md` (converged, 3 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/dev-memory/resume/:vtid` on the existing dev-memory router (`requireDevMemoryAccess`: exafy_admin session, read-only `X-Dev-Memory-Token`, or `X-Gateway-Internal`).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/dev-memory/resume/VTID-05047 (staging).

CURL_PROOF: anonymous GET answers 401 application/json, also for a malformed id (auth before validation).

OASIS_PROOF: no new events. The model pick is READ from the existing `operator.kiro.model_selected` event (VTID-04984); nothing new is written.

## Acceptance criteria

AC-1: The resume pack builds ledger, PRs (one multi-repo search, one PR read), evidence (acceptance.md and the approved plan block, from main once merged, the PR branch while open), handoff notes and deploy state (merge commit contained in staging / production via compare), fails open per section with the reason, caps its text at 8,000 characters, keeps the instructions block separate and caches for 60 s per VTID.
  TEST: services/gateway/test/vtid-05060-resume-and-model-pick.test.ts
AC-2: The route answers 401 without a caller (also for a malformed id), 403 for a non-admin, 400 for a malformed id, 404 for an unknown VTID, 200 with the pack; the pack token works; `?format=text` appends the instructions.
  TEST: services/gateway/test/vtid-05060-resume-and-model-pick.test.ts
  CURL: staging GET /api/v1/dev-memory/resume/VTID-05047 -> 401 application/json
  CURL: staging GET /api/v1/dev-memory/resume/not-a-vtid -> 401 application/json
AC-3: The Operator tool `dev_resume_vtid` is declared, dispatched, classed code_lookup (read-only), developer/admin only (dev_ prefix gate) and offered to Kiro over MCP; `scripts/dev/resume-vtid.sh` reads the route with the pack token and never prints it.
  TEST: services/gateway/test/vtid-05060-resume-and-model-pick.test.ts
AC-4: The developer's model choice (Auto or any model in Kiro's own drop-down) survives a Kiro session reopen: on a NEW session the last pick for the thread (owner's own event) is re-applied before the first prompt when Kiro offers it; a pick Kiro no longer offers keeps Kiro's model and sets `kiro_model_restore: unavailable:<id>`; no pick or the current one sends nothing; a live session never looks it up. No server-side default model exists.
  TEST: services/gateway/test/vtid-05060-resume-and-model-pick.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts (scenario "Kiro model pick", mutation-checked)

## Decisions taken
- The evidence directory listing was dropped from the pack: the 6-call GitHub budget is spent on 1 search + 1 PR read (branch / merge commit) + 2 evidence files + 2 compares. The two files that matter are read directly.
- Deploy containment is computed only for a vitana-platform merge (only the gateway's build-info is read).
- `test/vtid-05018-kiro-thread-memory.test.ts` source check widened from "`loadHistory })`" to "`loadHistory` among the arguments" because `loadModelPick` is now passed too; it still requires `loadHistory`.
