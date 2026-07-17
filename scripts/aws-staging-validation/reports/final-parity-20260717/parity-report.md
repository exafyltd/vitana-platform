# AWS↔GCP staging parity report

- Reference: **gcp** (https://preview-gateway.vitanaland.com)
- Candidate: **aws** (https://preview-aws-gateway.vitanaland.com)
- Generated: 2026-07-17T08:24:39Z

| Status | Check | Detail |
|--------|-------|--------|
| ✅ PASS | gcp gateway reachable | /api/v1/admin/health → 200 |
| ✅ PASS | aws gateway reachable | /api/v1/admin/health → 200 |
| ✅ PASS | gcp env identity | env=staging (VITANA_ENV wired correctly) |
| ✅ PASS | aws env identity | env=staging (VITANA_ENV wired correctly) |
| ✅ PASS | Supabase alignment | both gateways use inmkhvwdcuyhnxkgfvsb.supabase.co |
| ⚠️ WARN | Deployed commit | gcp=06242d29327a vs aws=12b05422d4a2 — environments run different code; redeploy before comparing behavior |
| ℹ️ INFO | Platform identity | aws cloud_run_service='null' (null is expected off Cloud Run — K_SERVICE/K_REVISION are GCP-injected; set equivalents on AWS if the Command Hub CLOCK view needs them) |
| ✅ PASS | Route mounts | no reference-mounted prefix is missing on aws (174 prefixes probed) |
| ✅ PASS | Route response codes | identical status codes on all 174 probed prefixes |
| ✅ PASS | CORS preflight | aws answers preflight (access-control-allow-origin: https://preview-aws.vitanaland.com) |
| ✅ PASS | Header: strict-transport-security | parity OK |
| ✅ PASS | Header: x-content-type-options | parity OK |
| ✅ PASS | WebSocket upgrade path | both answer HTTP 400 to an Upgrade request |
| ✅ PASS | Latency (median health) | gcp=0.209s vs aws=0.433s |
| ✅ PASS | gcp frontend reachable | GET / → 200 |
| ✅ PASS | gcp SPA fallback | deep route /settings → 200 |
| ✅ PASS | aws frontend reachable | GET / → 200 |
| ✅ PASS | aws SPA fallback | deep route /settings → 200 |
| ✅ PASS | aws frontend→gateway wiring | bundle bakes in preview-aws-gateway.vitanaland.com |
| ✅ PASS | Frontend Supabase wiring | identical baked Supabase URLs: ["https://inmkhvwdcuyhnxkgfvsb.supabase.co"] |

**RESULT: PASS WITH WARNINGS** — 1 warning(s) need human review, then run the manual checklist in docs/AWS-STAGING-VALIDATION.md.
