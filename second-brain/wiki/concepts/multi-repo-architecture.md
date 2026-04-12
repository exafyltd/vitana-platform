# Multi-Repo Architecture

> How vitana-v1 (frontend) and vitana-platform (backend) work together as a dual-repo system with coordinated deployment.

## Content

### Overview

The Vitana engineering ecosystem is split across two GitHub repositories owned by `exafyltd`:

| Repo | Role | Stack | Cloud Run Service |
|------|------|-------|-------------------|
| `exafyltd/vitana-v1` | Frontend community app | React 18 + Vite 5 + TypeScript | `community-app` |
| `exafyltd/vitana-platform` | Backend gateway + Command Hub + CI/CD | Express + TypeScript | `gateway` |

### Filesystem Layout

When both repos are cloned (required for every Claude Code session):

```
/home/user/vitana-platform/   -- Backend (gateway, services, pipelines)
/home/user/vitana-v1/         -- Frontend (React SPA, community app)
```

### How They Connect

- **vitana-v1** calls the backend via the `VITE_GATEWAY_URL` environment variable, which points to the Cloud Run gateway service (`gateway-q74ibpv6ia-uc.a.run.app`).
- **vitana-platform** serves the backend API routes under `/api/v1/` and also hosts the Command Hub frontend (vanilla JS) at `/command-hub`.
- Both repos share the same Supabase project (`inmkhvwdcuyhnxkgfvsb`) for the community app, plus a separate Platform Supabase for backend services.

### Three Deployable Components

1. **Backend API + Command Hub** (vitana-platform) -- deployed as a single Docker image to the `gateway` Cloud Run service via `EXEC-DEPLOY.yml`.
2. **Community App** (vitana-v1) -- deployed to the `community-app` Cloud Run service via `DEPLOY.yml`, plus a legacy Lovable CDN fallback.
3. **OASIS services** (vitana-platform) -- `oasis-operator` and `oasis-projector` Cloud Run services deployed separately.

### Two Frontends

| Feature | Command Hub (vitana-platform) | Community App (vitana-v1) |
|---------|-------------------------------|---------------------------|
| Users | Operators, developers, admins | Community end-users |
| Tech | Vanilla JS (`app.js`) | React/Vite/TypeScript |
| Deploy | With gateway (same image) | Separate Cloud Run service + Lovable CDN |
| URL | `gateway-*.run.app/command-hub` | `community-app-*.run.app` |

### Full-Stack Change Coordination

When changes span both repos:
1. Deploy backend first (merge to `vitana-platform` main).
2. Deploy frontend second (merge to `vitana-v1` main).
3. Verify both are live before testing.
4. Keep API response formats compatible across both frontends.

### ADR and Canonical Structure

The dual-repo structure is documented in ADR-001 (Repository Canon V1). The long-term plan includes a Phase 2D monorepo consolidation, but the current structure is stable and enforced by CI.

## Related Pages

- [[vitana-v1]]
- [[vitana-platform]]
- [[cloud-run-deployment]]
- [[api-gateway-pattern]]
- [[adr-repo-canonical-structure]]
- [[github-actions]]

## Sources

- `raw/architecture/vitana-v1-CLAUDE.md`
- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/governance/ADR-001-REPO-CANON-V1.md`

## Last Updated

2026-04-12
