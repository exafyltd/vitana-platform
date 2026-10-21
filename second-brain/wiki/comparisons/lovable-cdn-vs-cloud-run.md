# Lovable CDN vs Cloud Run

> Comparison of the two deployment targets for the vitana-v1 community app: the legacy Lovable CDN and the new Cloud Run service.

## Content

### Context

The vitana-v1 community app currently deploys to both hosts simultaneously on push to `main`. This dual-deploy pattern is a transitional state while Cloud Run is verified as the production host.

### Comparison Matrix

| Dimension | Lovable CDN | Cloud Run (`community-app`) |
|-----------|-------------|---------------------------|
| **Status** | Legacy (fallback) | New (being verified) |
| **URL** | `vitana-lovable-vers1.lovable.app` | `community-app-*.run.app` |
| **Trigger** | Auto-deploy on push to `main` | `.github/workflows/DEPLOY.yml` on push to `main` |
| **Serving** | CDN-hosted static files | nginx serving static Vite build in container |
| **Preview branches** | `https://{branch}--vitana-v1.lovable.app` | Not yet (planned: `--no-traffic --tag` revisions) |
| **Infrastructure** | Lovable-managed (third-party) | GCP `lovable-vitana-vers1` (self-managed) |
| **Region** | Lovable CDN (unknown) | `us-central1` |
| **Cost control** | Included in Lovable plan | GCP billing |
| **Custom domains** | Lovable subdomain only | Configurable |
| **Development tool** | Lovable web editor (now abandoned) | Claude Code (exclusive) |
| **Governance** | None | VTID-tracked via deploy workflows |

### Why Cloud Run is the Target

1. **Unified infrastructure:** all services (gateway, community-app, OASIS) in the same GCP project.
2. **Governed deployment:** Cloud Run deploy goes through GitHub Actions workflows with VTID tracking.
3. **No third-party dependency:** eliminates reliance on Lovable platform.
4. **Development consistency:** Claude Code is the only dev tool; Lovable web editor is abandoned.
5. **Custom configuration:** nginx serving, environment variables, health checks.

### Why Lovable CDN is Still Active

1. **Fallback safety:** if Cloud Run `community-app` has issues, the Lovable CDN version is still live.
2. **Preview branches:** Lovable CDN still offers branch preview URLs (`{branch}--vitana-v1.lovable.app`) which Cloud Run does not yet support.
3. **Verification incomplete:** Cloud Run serving needs full E2E verification before cutover.

### Migration Plan

1. **Phase 1 (current):** Cloud Run deploys alongside Lovable CDN.
2. **Phase 2:** Add Cloud Run preview deploy workflows.
3. **Phase 3:** Expand Command Hub Publish modal for multi-service publish.
4. **Phase 4:** Backend API for preview status.
5. **Lovable cleanup:** Remove `lovable-tagger`, `.lovable/` directory, cut over DNS.

### What Gets Removed

When Lovable is decommissioned:
- `lovable-tagger` build plugin or integration.
- `.lovable/` directory in vitana-v1 repo.
- Lovable CDN auto-deploy configuration.
- References to `vitana-lovable-vers1.lovable.app` in CORS, docs, and env vars.

## Related Pages

- [[vitana-v1]]
- [[cloud-run]]
- [[cloud-run-deployment]]
- [[github-actions]]

## Sources

- `raw/architecture/vitana-v1-CLAUDE.md`
- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/deployment/cloud-run-cleanup-inventory.md`

## Last Updated

2026-04-12
