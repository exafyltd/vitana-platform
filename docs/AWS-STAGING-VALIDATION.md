# AWS Staging Validation Plan

**Goal:** prove the new AWS staging environment is functionally equivalent to
the existing GCP staging environment (`gateway-staging` +
`community-app-staging`, i.e. `preview-gateway.vitanaland.com` +
`preview.vitanaland.com`) before any traffic, tooling, or deploy pipeline is
cut over to it.

The plan has three layers:

1. **Automated black-box parity** — `scripts/aws-staging-validation/`
   (runnable locally or via the `AWS-STAGING-VALIDATION.yml` workflow).
2. **Authenticated functional smoke** — real user session against the AWS
   stack.
3. **Manual infrastructure checklist** — the GCP-coupled machinery that a
   lift-and-shift silently breaks.

Treat the GCP stack as the **reference** and AWS as the **candidate**
throughout. Do not decommission or reconfigure the GCP staging stack until
every section below is green.

---

## 0. Prerequisites (access needed before validation can run)

| # | Item | Why |
|---|------|-----|
| 1 | **AWS staging gateway base URL** | Every automated check targets it |
| 2 | **AWS staging frontend base URL** | Frontend parity checks |
| 3 | **AWS console/CLI read access** (or an operator who has it) — ECS/EKS/App Runner service definitions, task env vars, ALB/CloudFront config, Secrets Manager entries | Env-var + secret parity (§4) cannot be proven black-box |
| 4 | **The AWS deploy pipeline definition** (how code reaches AWS staging on push to `main`) | §5 — staging is worthless if it drifts from `main` |
| 5 | **DNS plan** (will `preview*.vitanaland.com` move to AWS, or new hostnames?) | Cloudflare preview-router worker rewrites Host headers to `*.run.app`; pointing it at AWS unchanged will break (§6) |

## 1. Automated black-box parity (scripted)

Run `AWS-STAGING-VALIDATION.yml` (workflow_dispatch, AWS URLs as inputs) or
the scripts directly — see `scripts/aws-staging-validation/README.md`.

Checks, with the contract each enforces:

| Check | Contract |
|-------|----------|
| Health reachability | `/api/v1/admin/health` → 200 JSON on both stacks |
| Env identity | Both report `env=staging` — `VITANA_ENV=staging` must be set on the AWS service; the entire feature-flag system (`FEATURE_*_ENV=staging-only`) keys off it |
| Supabase alignment | `supabase_host` identical on both gateways. Staging deliberately uses the **prod** Supabase project (`inmkhvwdcuyhnxkgfvsb`) — see `BOOTSTRAP-ORB-STAGING-SUPABASE-ALIGN` in `STAGE-DEPLOY.yml`. A different host on AWS = auth tokens unverifiable = every authed feature silently dead |
| Deployed commit | `build-info.git_commit` matches — same code before judging behavior. AWS pipeline must stamp `GIT_COMMIT_SHA`/`COMMIT_SHA` |
| Route mounts | All ~174 route prefixes from `route-manifest.json` answer JSON (not Express `text/html` 404) on AWS — proves the full API surface is mounted (CLAUDE.md §15 diagnostic) |
| CORS | Preflight from the frontend origin answered with `Access-Control-Allow-Origin` |
| Security headers | HSTS / `X-Content-Type-Options` parity |
| WebSocket transport | `Upgrade: websocket` probe answered identically — an ALB that strips upgrades kills ORB voice (Gemini Live rides a WS) |
| Latency | Median health latency within 3× of GCP. GCP staging pins `min-instances=1` because a **cold** ORB `session/start` takes ~9.4s and blows the widget's 8s `AbortSignal.timeout`. AWS needs an equivalent warm floor (no scale-to-zero) |
| Frontend | 200 on `/`, SPA deep-route fallback to `index.html`, bundle bakes the **AWS** gateway URL (not GCP's), bundle bakes the **same** Supabase project as GCP's frontend |

## 2. Authenticated functional smoke (manual or Playwright)

Use the e2e test user (`e2e-test@vitana.dev`, UUID
`a27552a3-0257-4305-8ed0-351a80fd3701`) against the **AWS frontend**:

1. **Login** via Supabase auth → landing page renders with user data
   (proves frontend→Supabase→gateway JWT chain end-to-end).
2. **Gateway data read** — open My Journey / community feed; confirm the
   network tab shows calls to the **AWS** gateway returning 200 JSON.
3. **ORB voice session** — open the ORB, start a voice session, confirm a
   spoken greeting within ~8s. This exercises, in one shot: WebSocket
   transport, Gemini API key on AWS, warm instance floor, and the
   fast-greeting feature flags (`FEATURE_ORB_FAST_START_ENV=staging-only`
   etc.).
4. **Write path** — post a diary entry / send a chat message; verify it
   persists (round-trips through gateway → Supabase RLS).
5. **i18n** — UI renders German (du-form) for the default locale; no raw
   English strings on the AWS build.
6. **Command Hub** — `https://<aws-gateway>/command-hub/` loads (static
   assets served, CSP intact — no inline JS/CSS violations in console).

## 3. OASIS / observability parity

- [ ] Deploys to AWS staging emit `staging.deploy.completed` OASIS events
      and write `software_versions` rows (`environment='staging'`) — the
      Command Hub CLOCK history is blind to AWS otherwise.
- [ ] `cloud_run_service`/`cloud_run_revision` in `/admin/health` come from
      GCP-injected `K_SERVICE`/`K_REVISION` and will be `null` on AWS. The
      CLOCK revert flow keys on `cloud_run_revision` — see §5.
- [ ] AI-call logging (provider, model, latency) still lands wherever the
      team reads it (Always-rule #19); confirm log aggregation exists on
      AWS (CloudWatch vs Cloud Logging).

## 4. Configuration & secrets parity (needs AWS read access)

Compare the AWS service definition against the authoritative env-var list in
`.github/workflows/STAGE-DEPLOY.yml` (the `ENV_VARS` + `SECRETS` arrays are
the single source of truth; `--set-env-vars` REPLACES, so that list is
complete by construction):

- [ ] `VITANA_ENV=staging`, `ENVIRONMENT=staging`
- [ ] `VTID_ALLOCATOR_ENABLED=true`
- [ ] `GATEWAY_SERVICE_TOKEN` (service-token auth path — VTID-03214)
- [ ] Feature flags: `FEATURE_LATENCY_TELEMETRY_ENV=staging-only`,
      `FEATURE_INTENT_ENGINE_A=true` (Find-a-Partner 404s without it),
      `FEATURE_ORB_FAST_START_ENV=staging-only`,
      `FEATURE_ORB_SAFE_FAST_GREETING_ENV=staging-only`,
      `ORB_CONTEXT_READY_GATE_TIMEOUT_MS=300`,
      `NAV_GUIDED_JOURNEY=true`, `NAV_CONTINUATION_BIND=true`
- [ ] `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` (fact extraction / embeddings
      silently no-op without them — that exact bug already happened once)
- [ ] Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_ANON_KEY`,
      `SUPABASE_JWT_SECRET`, `GOOGLE_GEMINI_API_KEY` — must be the **prod**
      Supabase values (see §1 Supabase alignment)
- [ ] `GIT_COMMIT_SHA` / `COMMIT_SHA` / `BUILD_INFO_MARKER` stamped by the
      AWS deploy pipeline
- [ ] Port 8080, `/alive` as health/readiness probe path (Always-rules
      #15/#16 — an AWS target group probing `/healthz` will flap)
- [ ] Warm capacity floor equivalent to `min-instances=1`

## 5. GCP-coupled code paths — known AWS breakage candidates

These use GCP APIs directly and **cannot work unchanged on AWS**. Each needs
an explicit decision (port, stub, or keep-on-GCP):

| Code | What it does | AWS impact |
|------|--------------|------------|
| `services/gateway/src/services/cloud-run-admin.ts` | PUBLISH (staging→prod promote) + CLOCK revert via Cloud Run Admin API | Publish/revert buttons in Command Hub will fail against an AWS-hosted staging. If prod stays on GCP, publish-from-AWS-staging needs a new image-promotion path |
| Vertex AI auth (`vertex-live-client.ts`, `embedding-service.ts`, `llm-router.ts`, …) | Uses Application Default Credentials — on Cloud Run this is the metadata server | No metadata server on AWS. Needs a GCP service-account key in AWS Secrets Manager, or full migration of those calls to API-key auth (`GOOGLE_GEMINI_API_KEY` paths) |
| `K_SERVICE` / `K_REVISION` (`env.ts`) | Environment identity in health/build-info + CLOCK history | `null` on AWS; set equivalent env vars if anything downstream needs them |
| `STAGE-DEPLOY.yml` / `STAGE-DEPLOY-FRONTEND.yml` | The entire staging deploy pipeline is `gcloud run deploy` | AWS staging needs its own pipeline; until it exists, AWS staging drifts from `main` immediately |
| Cloudflare `preview-router` worker | Rewrites Host header to `*.run.app` before proxying | If `preview*.vitanaland.com` should point at AWS, the worker's `ROUTES` map + DNS CNAMEs must change; if new hostnames are used instead, CORS origins and the frontend build args change |
| `gcloud logging` runbooks | Log reading in CLAUDE.md / ops docs | CloudWatch equivalents needed for AWS-side debugging |

## 6. DNS / TLS / edge

- [ ] Decide the hostname strategy (reuse `preview*.vitanaland.com` vs new
      AWS hostnames) — see §0.5.
- [ ] Valid TLS cert on the AWS endpoints (no chain warnings).
- [ ] If Cloudflare stays in front: Host-header handling verified (the
      GCP setup needed a worker for this exact problem; ALBs are typically
      fine with arbitrary Host headers, so the worker may become
      unnecessary — verify, don't assume).
- [ ] HTTP→HTTPS redirect parity.

## 7. Sign-off gates

| Gate | Criteria |
|------|----------|
| G1 | Automated parity report: **0 FAIL** (`AWS-STAGING-VALIDATION.yml`) |
| G2 | Authenticated smoke (§2): all 6 steps pass, evidenced with screenshots |
| G3 | Config parity (§4): checklist complete, reviewed by an operator with AWS access |
| G4 | GCP-coupled decisions (§5): each row has an owner + decision recorded |
| G5 | Deploy pipeline: a `main` push (or manual dispatch) demonstrably updates AWS staging and stamps the commit SHA |
| G6 | OASIS events + `software_versions` rows flow from AWS deploys (§3) |

Only after G1–G6: schedule the cutover of `preview*.vitanaland.com` DNS (if
reusing hostnames) and update `docs/STAGING.md` to describe the AWS stack as
canonical.

---

*Created as part of the AWS staging migration validation prep. The
automated layer lives in `scripts/aws-staging-validation/`; the workflow is
`.github/workflows/AWS-STAGING-VALIDATION.yml`.*
