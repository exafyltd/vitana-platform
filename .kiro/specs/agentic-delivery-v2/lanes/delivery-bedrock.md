---
lane: delivery-bedrock
state: executing
next_actor: kiro
branch: kiro/agentic-delivery-v2/delivery-bedrock
depends_on: []
executor: kiro
seat: exafy
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - scripts/aws/setup-delivery-bedrock.sh
  - services/gateway/src/providers/bedrock.ts
  - services/gateway/test/delivery/bedrock-role.test.ts
claimed_by: kiro-exafy-202611131759-6b38
updated: 2026-11-13T17:59Z
vtid: VTID-05702
---

# Lane: delivery-bedrock (repo exafyltd/vitana-platform)

Delivery stages call Bedrock through a role in the engineering account, outside production's quota (plan §10, §11,
Phase 0 P3). The owner applies the script.

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05702 allocated after policy approval (converged-auto-v1).

### 2026-11-13T17:59Z · kiro-exafy-202611131759-6b38 · ready → executing
Built within the lane's declared `paths` only:
- `services/gateway/src/providers/bedrock.ts`: `invokeBedrock()` takes a new optional `useDeliveryRole` flag.
  When true (and only then) it resolves credentials via `sts:AssumeRole` on `DELIVERY_BEDROCK_ROLE_ARN` (in
  the vitana-engineering account) instead of the caller's own task role, caches/refreshes them, and passes
  them explicitly to `BedrockRuntimeClient`. Gated independently of `BEDROCK_ROLE_ARN`. Omitted/false (every
  existing call site: `ai-bridge.ts`, `claude-text-client.ts`, `llm-router.ts`) is byte-for-byte unchanged.
  No `@aws-sdk/client-sts` / `@aws-sdk/credential-providers` dependency — neither is in this lane's `paths`
  (no `package.json`/`pnpm-lock.yaml`), and neither is already resolvable from this package even transitively
  (checked `node_modules/.pnpm` directly). The one `sts:AssumeRole` call is signed with Node's own `crypto`
  (`signAwsRequestV4`, AWS Signature Version 4, STS's Query protocol) — cross-checked byte-for-byte during
  development against the independent `aws4` npm reference signer for a fixed worked example (not a repo
  dependency; see the PR description for the transcript). The caller's own credentials still come from
  `@aws-sdk/credential-provider-node`'s `defaultProvider()`, already a direct dependency (same package
  `lib/google-access-token.ts` already uses the same way).
- `services/gateway/test/delivery/bedrock-role.test.ts` (new): pure SigV4 fixed-vector tests, `invokeBedrock`
  gate tests (not_configured for role/region, independent of `BEDROCK_ROLE_ARN`, default path unaffected),
  and `getDeliveryBedrockCredentials` tests (assume/parse, cache hit, cache refresh past skew, STS error
  surfacing) using an injected fake caller-credential provider plus the suite's already-mocked global `fetch`.
  Confirmed red on `main` (15/15 failing — the new exports do not exist there) before implementing, green
  after (15/15 passing). Full relevant regression sweep also run and green: `bedrock-vision-tools.test.ts`,
  `bedrock-region.test.ts`, `ai-bridge.test.ts`, `llm-router-agentic.test.ts`, `llm-provider-verify.test.ts`,
  `vtid-04233-spec-generator-planner-stage.test.ts`, `vtid-05077-planner-fallback-and-thinking.test.ts` — 8
  suites / 100 tests, all green. `tsc --noEmit` clean for this file (two unrelated pre-existing errors in
  `middleware/server-timing.ts`/`orb/live/latency-tracker.ts`, neither touched here).
- `scripts/aws/setup-delivery-bedrock.sh` (new): `discover` (read-only, run with 472838866351 credentials —
  prints the live staging gateway's task role ARN) and `provision` (dry-run by default, `--apply` to create;
  run with vitana-engineering credentials) creates/updates IAM role `vitana-delivery-bedrock`, trusting only
  `--task-role-arn`, with an inline `bedrock:InvokeModel*` policy scoped to the Claude inference profiles/
  foundation models across the plan's six EU regions (no DeepSeek resource yet — plan §14.3, D13 is a later
  lane). Hard account/region guards (refuses `provision` run against 472838866351, refuses any region but
  eu-central-1) checked by exercising only the non-AWS-call guard paths (wrong region, missing args, `--help`)
  — **not run against any real account**: this session has no credentials into vitana-engineering, and the
  owner applies this script (Phase 0 P3 of plan.md, waits for this lane).

No VTID was hand-allocated (it was already on this lane file, allocated by CI PLAN-SPAR per the log entry
below). Opening the PR next; a follow-up commit will move this lane `executing` → `in-review` with the PR URL
once it exists (`ready` → `in-review` directly is not a legal transition).

Pre-existing, unrelated `queue.mjs validate` finding surfaced by this same run, left untouched: lane
`agentic-delivery/retire-vtid-allocate.md` has a protected-gate-file path
(`.github/workflows/VTID-ALLOCATE.yml`) without `executor: claude` or a `protected_gate: two-model` +
`reviewer_seat` setup. Not this lane's file, not touched by this change, and not mine to fix without
coordinating with that lane's own seat.
