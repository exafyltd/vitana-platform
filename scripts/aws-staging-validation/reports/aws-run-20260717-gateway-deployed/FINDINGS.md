# AWS staging validation — gateway deployed, 2026-07-17

Fourth parity run, after ECR push permission was granted and the staged
gateway image shipped.

## Applied this run

1. **Pushed** `vitana/gateway:12b05422d` (+ retagged `:latest`) — built from
   branch commit `12b05422d` = `main@06242d2` + the AWS CORS allowlist fix.
2. **Task def `vitana-gateway:6`** — image pinned to the sha tag,
   `GIT_COMMIT_SHA` stamped (build-info now reports the commit).
3. **Task def `vitana-gateway:7`** — mirrored GCP staging's non-secret env
   from `STAGE-DEPLOY.yml` `ENV_VARS`, which fixed the last route-mount FAIL:
   the intents routers are gated on `FEATURE_INTENT_ENGINE_A=true` (VTID-01973),
   which GCP staging sets and the AWS task def lacked. Also added:
   `ENVIRONMENT=staging`, `VTID_ALLOCATOR_ENABLED=true`, `COMMIT_SHA`,
   `BUILD_INFO_MARKER`, `FEATURE_LATENCY_TELEMETRY_ENV=staging-only`,
   `FEATURE_ORB_FAST_START_ENV=staging-only`,
   `FEATURE_ORB_SAFE_FAST_GREETING_ENV=staging-only`,
   `ORB_CONTEXT_READY_GATE_TIMEOUT_MS=300`, `NAV_GUIDED_JOURNEY=true`,
   `NAV_CONTINUATION_BIND=true`.
   **NOT mirrored (secrets, unavailable to this session):**
   `GATEWAY_SERVICE_TOKEN`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` — bind these
   via the AWS secrets path before authenticated smoke testing; features
   depending on them (service-token auth, fact-embedding backfill, DeepSeek
   extraction) will silently no-op until then.

## Verdict: 1 FAIL / 1 WARN (from 9 FAILs / 4 WARNs at the first run)

**Gateway-side parity is COMPLETE**: all 174 route prefixes mount with
identical status codes, CORS answers for the AWS frontend origin, env
identity + Supabase + headers + WebSocket + latency all PASS. Frontend
serves the SPA at its hostname root with working deep-route fallback.

| Status | Item | Path to close |
|--------|------|---------------|
| ❌ FAIL | Frontend bundle bakes `https://gateway.vitanaland.com` (the GCP gateway) | Rebuild `vitana-v1` with `VITE_GATEWAY_URL="https://preview-aws-gateway.vitanaland.com/api/v1"`, push to `vitana/community-app`, roll the ECS service. Not possible from this sandbox (npm registry blocked; no build toolchain in the runtime image) |
| ⚠️ WARN | Deployed commit differs (gcp=`06242d2` vs aws=`12b0542`) | Expected: AWS runs main + the CORS fix from this PR. Clears once this PR merges and both environments run the same main commit |

## Live-change ledger (cumulative — all must reach IaC)

| Change | Where it lives now |
|--------|--------------------|
| ECS↔ALB attachments (gateway :8080, community-app :8080, 60s grace) | live only |
| Gateway TG health check `/health` → `/alive` | live only |
| ALB host rule P30 `preview-aws.vitanaland.com` → community TG | live only |
| Task def `vitana-gateway:7` (image pin + env block above) | live only |
| CORS allowlist for AWS staging hostnames | this branch (merge to `main`) |
| ECR `vitana/gateway:latest` now = main+CORS fix (was 2026-07-14 build) | ECR |
| Task def `vitana-gateway:8` — `SUPABASE_JWT_SECRET` bound as a plain env var (2026-07-17). Verified: e2e-test login via Supabase REST → `GET /api/v1/journey/state` on `preview-aws-gateway.vitanaland.com` returns 200 with real state, so authenticated JWT verification works on AWS. **Hygiene note:** plain task-def env is readable by anyone with `ecs:DescribeTaskDefinition` — move to AWS Secrets Manager (`secrets` block + execution-role read grant) when the remaining secrets (`GATEWAY_SERVICE_TOKEN`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, Gemini key) are wired | live only |

## Next steps to full parity + sign-off

1. `vitana-v1` rebuild with the AWS gateway URL (clears the last FAIL).
2. Bind `GATEWAY_SERVICE_TOKEN` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`
   secrets on the AWS task def.
3. Merge this PR so `main` carries the CORS allowlist (clears the WARN on
   the next aligned deploy).
4. Mirror the live-change ledger into Terraform.
5. Run the authenticated smoke layer + G1–G6 sign-off gates from
   `docs/AWS-STAGING-VALIDATION.md` (login → gateway reads → ORB voice →
   write path → i18n → Command Hub).
