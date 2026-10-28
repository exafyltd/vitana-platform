# AWS↔GCP staging parity report

- Reference: **gcp** (https://preview-gateway.vitanaland.com)
- Candidate: **aws** (https://preview-aws-gateway.vitanaland.com)
- Generated: 2026-07-17T07:48:15Z

| Status | Check | Detail |
|--------|-------|--------|
| ✅ PASS | gcp gateway reachable | /api/v1/admin/health → 200 |
| ✅ PASS | aws gateway reachable | /api/v1/admin/health → 200 |
| ✅ PASS | gcp env identity | env=staging (VITANA_ENV wired correctly) |
| ✅ PASS | aws env identity | env=staging (VITANA_ENV wired correctly) |
| ✅ PASS | Supabase alignment | both gateways use inmkhvwdcuyhnxkgfvsb.supabase.co |
| ⚠️ WARN | Deployed commit | aws reports no git_commit — GIT_COMMIT_SHA/COMMIT_SHA env var not stamped by the AWS deploy pipeline |
| ℹ️ INFO | Platform identity | aws cloud_run_service='null' (null is expected off Cloud Run — K_SERVICE/K_REVISION are GCP-injected; set equivalents on AWS if the Command Hub CLOCK view needs them) |
| ❌ FAIL | Route mounts | 4 prefixes mounted on gcp but NOT on aws: /api/v1/discover, /api/v1/intent-board, /api/v1/intent-categories, /api/v1/intents |
| ⚠️ WARN | Route response codes | 4 prefixes answer with different status codes: /api/v1/discover (401→404), /api/v1/intent-board (401→404), /api/v1/intent-categories (401→404), /api/v1/intents (401→404) |
| ❌ FAIL | CORS preflight | gcp sends Access-Control-Allow-Origin but aws does not — browser calls from the frontend will fail |
| ✅ PASS | Header: strict-transport-security | parity OK |
| ✅ PASS | Header: x-content-type-options | parity OK |
| ✅ PASS | WebSocket upgrade path | both answer HTTP 400 to an Upgrade request |
| ✅ PASS | Latency (median health) | gcp=0.239s vs aws=0.427s |
| ✅ PASS | gcp frontend reachable | GET / → 200 |
| ✅ PASS | gcp SPA fallback | deep route /settings → 200 |
| ✅ PASS | aws frontend reachable | GET / → 200 |
| ✅ PASS | aws SPA fallback | deep route /settings → 200 |
| ❌ FAIL | aws frontend→gateway wiring | bundle gateway URLs ["http://localhost:9999","http://www.apache.org","http://www.w3.org","https://...","https://api.dicebear.com","https://deine-website.com","https://developer.mozilla.org","https://fcmregistrations.googleapis.com","https://firebaseinstallations.googleapis.com","https://gateway-q74ibpv6ia-uc.a.run.app","https://gateway.vitanaland.com","https://github.com","https://images.unsplash.com","https://inmkhvwdcuyhnxkgfvsb.supabase.co","https://linkedin.com","https://maps.google.com","https://oasis-operator-86804897789.us-central1.run.app","https://radix-ui.com","https://reactjs.org","https://vitanaland.com"] do not include the aws gateway (preview-aws-gateway.vitanaland.com) — the AWS frontend is silently calling another environment's API |
| ✅ PASS | Frontend Supabase wiring | identical baked Supabase URLs: ["https://inmkhvwdcuyhnxkgfvsb.supabase.co"] |

**RESULT: FAIL** — 3 failing check(s), 2 warning(s). The AWS staging environment is NOT yet equivalent.
