# AWS staging validation suite

Black-box parity validation of the **new AWS staging environment** against
the existing **GCP staging environment** (`gateway-staging` /
`community-app-staging`, reachable via `preview-gateway.vitanaland.com` /
`preview.vitanaland.com`).

Everything here is auth-free and secret-free: environment identity, route
mounts, headers, CORS, WebSocket transport, latency, and frontend bundle
wiring. The companion document [docs/AWS-STAGING-VALIDATION.md](../../docs/AWS-STAGING-VALIDATION.md)
contains the full validation plan, including the authenticated and manual
checks these scripts cannot cover.

## Files

| File | Purpose |
|------|---------|
| `generate-route-manifest.mjs` | Regenerates `route-manifest.json` from `services/gateway/src/index.ts` |
| `route-manifest.json` | Generated list of all mounted gateway route prefixes (probe targets) |
| `capture-snapshot.sh` | Captures one environment's snapshot into a directory of JSON artifacts |
| `compare-snapshots.sh` | Diffs two snapshots → markdown PASS/FAIL/WARN report; exit 1 on any FAIL |

## Usage

```bash
# 1. (only when gateway routes changed) refresh the probe manifest
node scripts/aws-staging-validation/generate-route-manifest.mjs

# 2. Snapshot the GCP staging stack (the reference)
scripts/aws-staging-validation/capture-snapshot.sh \
  --label gcp \
  --gateway  https://preview-gateway.vitanaland.com \
  --frontend https://preview.vitanaland.com \
  --out /tmp/snap-gcp

# 3. Snapshot the AWS staging stack (the candidate)
scripts/aws-staging-validation/capture-snapshot.sh \
  --label aws \
  --gateway  https://<aws-staging-gateway-url> \
  --frontend https://<aws-staging-frontend-url> \
  --out /tmp/snap-aws

# 4. Compare → parity report (exit 1 if any FAIL)
scripts/aws-staging-validation/compare-snapshots.sh /tmp/snap-gcp /tmp/snap-aws report.md
```

Or run everything from GitHub Actions (recommended — runners have open
egress): manually dispatch **`AWS-STAGING-VALIDATION.yml`** with the AWS
URLs as inputs. The report lands in the run's step summary and the raw
snapshots are uploaded as artifacts.

## What the automated checks assert

1. **Reachability** — `/api/v1/admin/health` answers 200 JSON on both.
2. **Environment identity** — both report `env=staging` (`VITANA_ENV` wired).
3. **Supabase alignment** — both gateways point at the SAME Supabase host.
   (The staging gateway deliberately uses the prod Supabase project — see
   `BOOTSTRAP-ORB-STAGING-SUPABASE-ALIGN` in `STAGE-DEPLOY.yml`. If AWS
   points elsewhere, logins become anonymous to the gateway.)
4. **Deployed commit** — `git_commit` from `/api/v1/admin/build-info`
   matches (same code before comparing behavior).
5. **Route mounts** — every route prefix mounted on GCP answers JSON (not
   an Express `text/html` 404) on AWS. Uses the JSON-vs-HTML diagnostic
   from CLAUDE.md §15 across the full generated manifest (~174 prefixes).
6. **CORS + security headers** — preflight answered; HSTS/nosniff parity.
7. **WebSocket transport** — an `Upgrade: websocket` probe gets the same
   class of answer (an ALB/proxy that strips upgrades kills ORB voice).
8. **Latency** — median health-endpoint latency within 3x of GCP (GCP
   staging keeps `min-instances=1` because a cold ORB `session/start`
   breaks the widget's 8s timeout — AWS needs an equivalent warm floor).
9. **Frontend** — reachable, SPA deep-route fallback works, the bundle
   bakes in the CORRECT gateway URL for its own environment, and both
   frontends bake in the SAME Supabase project.

## Requirements

`bash`, `curl`, `jq` (and `node` ≥18 for the manifest generator).
