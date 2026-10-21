# AWS Staging Validation — Final Report (2026-07-17)

**Verdict: GO, with conditions.** The AWS staging environment is functionally
equivalent to GCP staging on every automated check and on the authenticated
smoke layer. Remaining conditions are durability items (IaC mirroring, missing
non-critical secrets), not functional gaps.

## Layer 1 — Automated black-box parity: ✅ 19 PASS / 0 FAIL

Final live-vs-live run (`../final-parity-20260717/parity-report.md`):
reachability, `env=staging` identity, Supabase alignment, 174/174 route
prefixes with identical status codes, CORS (AWS frontend origin), security
headers, WebSocket upgrade, latency within threshold, SPA fallback, frontend
bundle wired to the AWS gateway. Sole WARN (commit skew) cleared when PR
#2888 merged.

Journey from first run: 9 FAILs → 0 across five runs (PR #2888 has the full
history and root causes).

## Layer 2 — Authenticated smoke: ✅ API-level complete

| Check | Result |
|---|---|
| Supabase login (e2e test user `a27552a3…`) | ✅ token issued |
| AWS gateway verifies JWT (`/api/v1/journey/state`) | ✅ 200 with real journey state (was 401 until `SUPABASE_JWT_SECRET` bound — task-def revision 8) |
| ORB voice session start (`/api/v1/orb/live/session/start`) | ✅ 200, live session + conversation created — Gemini path works on AWS |
| In-browser rendering/attribution | ⚠️ not runnable from the validation sandbox (Chromium↔proxy limitation); bundle wiring verified statically + by the deploy workflow's post-verify. Optional close-out: run `authenticated-smoke.mjs` from a GitHub Actions runner or any workstation |

## Layer 3 — Conditions before this stack is trusted long-term

1. **Terraform mirroring (CRITICAL):** six out-of-band live changes are
   recorded in the ledger (PR #2888 reports + PR #2891): ECS↔ALB
   attachments, TG health check `/alive`, ALB host rule P30, DNS CNAMEs,
   task-def revisions 5–8 (env block, image pin, `SUPABASE_JWT_SECRET`).
   The migration team's next `terraform apply` reverts ALL of it unless
   mirrored first.
2. **Remaining secrets:** `GATEWAY_SERVICE_TOKEN`, `OPENAI_API_KEY`,
   `DEEPSEEK_API_KEY` still unbound on AWS — dependent features
   (service-token auth, embeddings backfill, fact extraction) silently
   no-op. Bind via AWS Secrets Manager + task-def `secrets` block; also
   migrate `SUPABASE_JWT_SECRET` from plain env var to that block
   (readable via `ecs:DescribeTaskDefinition` as-is).
3. **Gateway deploy pipeline for AWS:** the frontend has one
   (`AWS-STAGE-DEPLOY-FRONTEND.yml` in vitana-v1, proven by run #1); the
   gateway image was hand-built. Without a push-from-`main` pipeline the
   AWS gateway drifts immediately.
4. **Naming:** `vitana-alb-prod` / `vitana-tg-*-prod` vs `-staging`
   databases — migration team to confirm intent and align.
5. **OASIS observability:** AWS deploys emit no `staging.deploy.completed`
   events / `software_versions` rows; Command Hub CLOCK is blind to AWS.

## Access & tooling created during validation

- IAM user `claude-staging-validation` (ReadOnly + ECS/ELB/ECR — rotate or
  trim when validation ends), Cloudflare DNS token (roll after use).
- DNS: `preview-aws.vitanaland.com`, `preview-aws-gateway.vitanaland.com`
  → `vitana-alb-prod` (TLS via ACM `*.vitanaland.com`).
- Suite: `capture-snapshot.sh` / `compare-snapshots.sh` /
  `authenticated-smoke.mjs` + `AWS-STAGING-VALIDATION.yml` workflow
  (dispatchable re-test) + GCP baseline snapshot.

## Sign-off gates (docs/AWS-STAGING-VALIDATION.md §7)

| Gate | Status |
|---|---|
| G1 automated parity 0 FAIL | ✅ |
| G2 authenticated smoke | ✅ API-level (browser leg optional close-out) |
| G3 config/secrets parity | 🟡 3 secrets outstanding (§ Layer 3.2) |
| G4 GCP-coupled decisions | 🟡 publish/revert + Vertex ADC decisions still open |
| G5 deploy pipeline | 🟡 frontend ✅ / gateway ✗ |
| G6 OASIS events from AWS | ✗ |

**Do not decommission or repoint GCP staging until G3–G6 close.**
