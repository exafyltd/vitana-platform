# VTID-05006 - Kiro phase B: write tools behind an in-thread Allow/Deny, repos in the workspace

Owner approval 2026-10-09 (Gate 1: "Yes, ship both to production and build phase B."). Sparring: `plan-sparring.md` (converged, 3 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/operator/kiro/confirmations` and `POST /api/v1/operator/kiro/confirmations/:id` (new, in `routes/operator.ts`, `requireAdminAuth`, caller's own rows only). Write tools are served by the existing `POST /api/v1/operator/kiro/mcp`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/confirmations (staging).

CURL_PROOF: unauthenticated GET answers 401 application/json; POST with an invalid bearer answers 401 application/json.

OASIS_PROOF: `operator.kiro.write_tool_called` (tool, thread, for_vtid, outcome), `operator.kiro.write_confirmed` / `operator.kiro.write_denied` (confirmation id), `operator.kiro.branch_pushed` (repo, branch, commit, file count, bytes; never content) — vtid VTID-05006, declared in the CicdEventType union.

## Acceptance criteria

AC-1: Every Kiro write passes, in order: KIRO_MCP_WRITE_ENABLED, the autopilot kill switch (autopilot_* only), an open in_progress+approved VTID, and the user's Allow; anything else refuses with "Nothing was done".
  TEST: services/gateway/test/vtid-05006-kiro-write-tools.test.ts
AC-2: The Allow/Deny is DB-backed: the held call polls its row; 60 s window; the call going away expires it at once; a late or second answer changes nothing; only the owner can answer.
  TEST: services/gateway/test/vtid-05006-kiro-write-tools.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  CURL: staging GET/POST of the confirmation routes without a valid caller -> 401 application/json
AC-3: The write set excludes deploys and every tool that mints a VTID; dev_push_kiro_branch writes one fast-forward commit to the caller's own kiro/<user8>/<slug> branch with size, count, text-only and denied-path limits.
  TEST: services/gateway/test/vtid-05006-kiro-write-tools.test.ts
AC-4: While a Kiro turn runs the Command Hub shows each pending write as an Allow/Deny card and answers through the confirmation route.
  TEST: services/gateway/test/vtid-05006-kiro-write-tools.test.ts
  UI: screenshots outputs/kiro-write-card-*.png (desktop 1400x900, mobile 390x844), no horizontal overflow
AC-5: Each Kiro session gets worktrees of both repos from shared mirrors without blocking its start; MCP cancellation from Kiro aborts the held call.
  TEST: services/kiro-runner/test/runner.test.ts
