# AWS↔GCP staging parity report

- Reference: **gcp** (https://preview-gateway.vitanaland.com)
- Candidate: **aws** (https://preview-aws-gateway.vitanaland.com)
- Generated: 2026-07-17T08:11:13Z

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
| ✅ PASS | Latency (median health) | gcp=0.214s vs aws=0.420s |
| ✅ PASS | gcp frontend reachable | GET / → 200 |
| ✅ PASS | gcp SPA fallback | deep route /settings → 200 |
| ✅ PASS | aws frontend reachable | GET / → 200 |
| ✅ PASS | aws SPA fallback | deep route /settings → 200 |
| ❌ FAIL | aws frontend→gateway wiring | bundle gateway URLs ["http://localhost:9999","http://www.apache.org","http://www.w3.org","https://...","https://api.dicebear.com","https://deine-website.com","https://developer.mozilla.org","https://fcmregistrations.googleapis.com","https://firebaseinstallations.googleapis.com","https://gateway-q74ibpv6ia-uc.a.run.app","https://gateway.vitanaland.com","https://github.com","https://images.unsplash.com","https://inmkhvwdcuyhnxkgfvsb.supabase.co","https://linkedin.com","https://maps.google.com","https://oasis-operator-86804897789.us-central1.run.app","https://radix-ui.com","https://reactjs.org","https://vitanaland.com"] do not include the aws gateway (preview-aws-gateway.vitanaland.com) — the AWS frontend is silently calling another environment's API |
| ✅ PASS | Frontend Supabase wiring | identical baked Supabase URLs: ["https://inmkhvwdcuyhnxkgfvsb.supabase.co"] |

**RESULT: FAIL** — 1 failing check(s), 1 warning(s). The AWS staging environment is NOT yet equivalent.
