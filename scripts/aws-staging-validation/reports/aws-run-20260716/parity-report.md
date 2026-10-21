# AWS↔GCP staging parity report

- Reference: **gcp** (https://preview-gateway.vitanaland.com)
- Candidate: **aws** (https://vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com)
- Generated: 2026-07-16T15:33:27Z

| Status | Check | Detail |
|--------|-------|--------|
| ✅ PASS | gcp gateway reachable | /api/v1/admin/health → 200 |
| ❌ FAIL | aws gateway reachable | /api/v1/admin/health → HTTP 503 |
| ✅ PASS | gcp env identity | env=staging (VITANA_ENV wired correctly) |
| ❌ FAIL | aws env identity | env='<missing>' — expected 'staging'. VITANA_ENV not set on the service. |
| ❌ FAIL | Supabase alignment | aws reports no supabase_host — SUPABASE_URL missing/malformed |
| ⚠️ WARN | Deployed commit | aws reports no git_commit — GIT_COMMIT_SHA/COMMIT_SHA env var not stamped by the AWS deploy pipeline |
| ℹ️ INFO | Platform identity | aws cloud_run_service='null' (null is expected off Cloud Run — K_SERVICE/K_REVISION are GCP-injected; set equivalents on AWS if the Command Hub CLOCK view needs them) |
| ✅ PASS | Route mounts | no reference-mounted prefix is missing on aws (174 prefixes probed) |
| ⚠️ WARN | Route mounts (extra) | 103 prefixes mounted on aws only: /api/v1/actions, /api/v1/admin, /api/v1/admin/ai-assistants, /api/v1/admin/autopilot, /api/v1/admin/feedback, /api/v1/admin/i18n-ops, /api/v1/admin/intent-engine, /api/v1/admin/invitations, /api/v1/admin/marketplace, /api/v1/admin/moderation |
| ⚠️ WARN | Route response codes | 174 prefixes answer with different status codes: /api/v1/actions (404→503), /api/v1/admin (404→503), /api/v1/admin/ai-assistants (404→503), /api/v1/admin/autopilot (404→503), /api/v1/admin/feedback (404→503), /api/v1/admin/i18n-ops (404→503), /api/v1/admin/intent-engine (404→503), /api/v1/admin/invitations (404→503), /api/v1/admin/journey-checklist (401→503), /api/v1/admin/marketplace (404→503) (+164 more) |
| ❌ FAIL | CORS preflight | gcp sends Access-Control-Allow-Origin but aws does not — browser calls from the frontend will fail |
| ✅ PASS | Header: strict-transport-security | parity OK |
| ✅ PASS | Header: x-content-type-options | parity OK |
| ⚠️ WARN | WebSocket upgrade path | gcp→400 vs aws→503 — different but app-level; verify ORB voice manually |
| ✅ PASS | Latency (median health) | gcp=0.252s vs aws=0.491s |
| ✅ PASS | gcp frontend reachable | GET / → 200 |
| ✅ PASS | gcp SPA fallback | deep route /settings → 200 |
| ❌ FAIL | aws frontend reachable | GET / → HTTP 503 |
| ❌ FAIL | aws SPA fallback | deep route /settings → HTTP 503 — static host must rewrite unknown paths to index.html |
| ❌ FAIL | aws frontend→gateway wiring | bundle gateway URLs [] do not include the aws gateway (vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com) — the AWS frontend is silently calling another environment's API |
| ❌ FAIL | Frontend Supabase wiring | gcp=["https://inmkhvwdcuyhnxkgfvsb.supabase.co"] vs aws=[] — logins on one frontend will be anonymous to the gateway |

**RESULT: FAIL** — 8 failing check(s), 4 warning(s). The AWS staging environment is NOT yet equivalent.
