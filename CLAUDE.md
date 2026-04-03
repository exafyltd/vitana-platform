# Vitana Platform - Claude Code Deployment Guide

## Architecture Overview

- **Backend (Gateway):** Cloud Run service `gateway` in `us-central1`, project `lovable-vitana-vers1`
  - Source: `services/gateway/`
  - URL: `https://gateway-q74ibpv6ia-uc.a.run.app`
  - Deploys via: `.github/workflows/EXEC-DEPLOY.yml` (governed, with VTID tracking)
  - Auto-deploys on push to `main` via `.github/workflows/AUTO-DEPLOY.yml`

- **Frontend (Community App):** Previously hosted on Lovable (`vitana-lovable-vers1.lovable.app`)
  - Source: `apps/web/` (migrated from Lovable editor)
  - Supabase project: `inmkhvwdcuyhnxkgfvsb` (Lovable Supabase)
  - Auth: Dual JWT — Platform + Lovable Supabase secrets
  - CORS: Configured in `services/gateway/src/middleware/cors.ts`

- **Platform Supabase:** Secrets in GCP Secret Manager (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`)
- **Lovable Supabase:** `https://inmkhvwdcuyhnxkgfvsb.supabase.co` (env: `LOVABLE_SUPABASE_URL`)

## Deployment Process

### Backend (Gateway)

1. Make changes in `services/gateway/`
2. Verify TypeScript compiles: `cd services/gateway && npx tsc`
3. Commit and push to feature branch
4. Create PR to `main`, merge (squash)
5. AUTO-DEPLOY triggers → dispatches EXEC-DEPLOY
6. EXEC-DEPLOY: VTID check → Governance → `gcloud run deploy gateway` → Health check → Smoke tests
7. If no VTID in commit, uses `BOOTSTRAP-AUTO-{sha}` fallback

### Frontend (Community App)

1. Source lives in `apps/web/` (React/Vite SPA)
2. Build: `cd apps/web && npm run build` (outputs to `dist/`)
3. Deploy: Add `web` service to EXEC-DEPLOY.yml, deploy to Cloud Run as `vitana-web`
4. Dockerfile: nginx serving the built SPA with `try_files` for SPA routing
5. Update `FRONTEND_URL` env var on gateway to point to new frontend URL
6. Update CORS in `services/gateway/src/middleware/cors.ts` with new frontend domain

### Environment Variables (Gateway)

Key env vars set during deploy (see EXEC-DEPLOY.yml):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` (GCP secrets)
- `SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY` (GCP secrets)
- `GOOGLE_GEMINI_API_KEY` (GCP secret)
- `LOVABLE_SUPABASE_URL`, `LOVABLE_SUPABASE_SERVICE_ROLE` (env vars)
- `GCP_PROJECT_ID=lovable-vitana-vers1`
- `ENVIRONMENT=dev-sandbox`

## Key Services & Files

- **Autopilot Recommendations:** `services/gateway/src/routes/autopilot-recommendations.ts`
  - Community user recs: auto-replenishes when all are activated
  - Scheduler: daily at 7 AM UTC for community users (`services/gateway/src/services/recommendation-engine/scheduler.ts`)
  - Analyzer: `services/gateway/src/services/recommendation-engine/analyzers/community-user-analyzer.ts` (28 templates, 8 languages, 6 onboarding stages)

- **Auth Middleware:** `services/gateway/src/middleware/auth-supabase-jwt.ts` (dual JWT: Platform + Lovable)
- **CORS:** `services/gateway/src/middleware/cors.ts`
- **Command Hub Frontend:** `services/gateway/src/frontend/command-hub/app.js`

## Git Workflow

- Feature branches: `claude/{feature}-{id}`
- PRs merge to `main` via squash
- AUTO-DEPLOY triggers on `main` push when `services/gateway/**` or `apps/web/**` changes
- EXEC-DEPLOY is the canonical governed deploy pipeline
- If push fails, retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s)

## Gateway URLs

- Primary: `https://gateway-q74ibpv6ia-uc.a.run.app`
- Alt: `https://gateway-86804897789.us-central1.run.app`
- Canonical (in code): `https://gateway-q74ibpv6ia-uc.a.run.app`

## Lovable Migration Status

Lovable frontend is being replaced. All future frontend development happens in `apps/web/` and deploys via Claude Code + EXEC-DEPLOY pipeline. No more Lovable editor.
