# AWS↔GCP staging parity report

- Reference: **gcp** (https://preview-gateway.vitanaland.com)
- Candidate: **aws** (https://vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com)
- Generated: 2026-07-16T16:11:15Z

| Status | Check | Detail |
|--------|-------|--------|
| ✅ PASS | gcp gateway reachable | /api/v1/admin/health → 200 |
| ✅ PASS | aws gateway reachable | /api/v1/admin/health → 200 |
| ✅ PASS | gcp env identity | env=staging (VITANA_ENV wired correctly) |
| ❌ FAIL | aws env identity | env='production' — expected 'staging'. VITANA_ENV not set on the service. |
| ✅ PASS | Supabase alignment | both gateways use inmkhvwdcuyhnxkgfvsb.supabase.co |
| ⚠️ WARN | Deployed commit | aws reports no git_commit — GIT_COMMIT_SHA/COMMIT_SHA env var not stamped by the AWS deploy pipeline |
| ℹ️ INFO | Platform identity | aws cloud_run_service='null' (null is expected off Cloud Run — K_SERVICE/K_REVISION are GCP-injected; set equivalents on AWS if the Command Hub CLOCK view needs them) |
| ❌ FAIL | Route mounts | 4 prefixes mounted on gcp but NOT on aws: /api/v1/discover, /api/v1/intent-board, /api/v1/intent-categories, /api/v1/intents |
| ⚠️ WARN | Route response codes | 4 prefixes answer with different status codes: /api/v1/discover (401→404), /api/v1/intent-board (401→404), /api/v1/intent-categories (401→404), /api/v1/intents (401→404) |
| ❌ FAIL | CORS preflight | gcp sends Access-Control-Allow-Origin but aws does not — browser calls from the frontend will fail |
| ✅ PASS | Header: strict-transport-security | parity OK |
| ✅ PASS | Header: x-content-type-options | parity OK |
| ✅ PASS | WebSocket upgrade path | both answer HTTP 400 to an Upgrade request |
| ✅ PASS | Latency (median health) | gcp=0.257s vs aws=0.445s |
| ✅ PASS | gcp frontend reachable | GET / → 200 |
| ✅ PASS | gcp SPA fallback | deep route /settings → 200 |
| ✅ PASS | aws frontend reachable | GET / → 200 |
| ✅ PASS | aws SPA fallback | deep route /settings → 200 |
| ❌ FAIL | aws frontend→gateway wiring | bundle gateway URLs ["https://fonts.googleapis.com","https://fonts.gstatic.com","https://gateway.vitanaland.com","https://inmkhvwdcuyhnxkgfvsb.supabase.co"] do not include the aws gateway (vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com) — the AWS frontend is silently calling another environment's API |
| ✅ PASS | Frontend Supabase wiring | identical baked Supabase URLs: ["https://inmkhvwdcuyhnxkgfvsb.supabase.co"] |

**RESULT: FAIL** — 4 failing check(s), 2 warning(s). The AWS staging environment is NOT yet equivalent.
