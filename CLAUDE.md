# Vitana Platform - Claude Code Deployment Guide

## Multi-Repo Setup

This project spans TWO repositories. Both must be available in every Claude Code session:

- **`exafyltd/vitana-platform`** — Backend, Gateway, Command Hub, CI/CD pipelines
- **`exafyltd/vitana-v1`** — Frontend community app (React/Vite SPA, formerly Lovable)

### Claude Code Web Task Configuration
When creating tasks in Claude Code Web (claude.ai/code), ALWAYS select BOTH repositories:
1. `exafyltd/vitana-platform`
2. `exafyltd/vitana-v1`

### Filesystem Layout
```
/home/user/vitana-platform/   ← Backend (this repo)
/home/user/vitana-v1/         ← Frontend (clone if not present)
```

If `/home/user/vitana-v1` doesn't exist, clone it:
```bash
cd /home/user && git clone https://github.com/exafyltd/vitana-v1.git
```

## Architecture Overview

- **Backend (Gateway):** Cloud Run service `gateway` in `us-central1`, project `lovable-vitana-vers1`
  - Source: `vitana-platform/services/gateway/`
  - URL: `https://gateway-q74ibpv6ia-uc.a.run.app`
  - Deploys via: `.github/workflows/EXEC-DEPLOY.yml` (governed, with VTID tracking)
  - Auto-deploys on push to `main` via `.github/workflows/AUTO-DEPLOY.yml`

- **Frontend (Community App):** React/Vite SPA in `exafyltd/vitana-v1`
  - Repo: `exafyltd/vitana-v1` (filesystem: `/home/user/vitana-v1/`)
  - Hosted: `vitana-lovable-vers1.lovable.app` (auto-deploys on push to `main`)
  - Supabase project: `inmkhvwdcuyhnxkgfvsb`
  - Auth: Dual JWT — Platform + Lovable Supabase secrets
  - CORS: Configured in `vitana-platform/services/gateway/src/middleware/cors.ts`

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

### Frontend (Community App — vitana-v1)

1. Source: `/home/user/vitana-v1/` (or clone from `exafyltd/vitana-v1`)
2. Make changes, commit, push to `main`
3. Auto-deploys to `vitana-lovable-vers1.lovable.app` on push to `main`
4. For feature work: create branch, PR, merge to `main`

### Full-Stack Changes (both repos)

When a change spans backend + frontend:
1. Make backend changes in `vitana-platform/services/gateway/`
2. Make frontend changes in `vitana-v1/src/`
3. Deploy backend first (merge to `vitana-platform` main)
4. Deploy frontend second (merge to `vitana-v1` main)
5. Verify both are live before testing

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

## Frontend Repo: vitana-v1

- **Repo:** `exafyltd/vitana-v1` (must be added to Claude Code Web task scope)
- **Stack:** React, Vite, TypeScript, Tailwind, Supabase Auth
- **Hosting:** Auto-deploys on push to `main` (Lovable CDN at `*.lovable.app`)
- **Supabase:** `https://inmkhvwdcuyhnxkgfvsb.supabase.co`
- **All frontend changes happen in this repo** — no more Lovable web editor
- **Claude Code is the ONLY deployment tool** for both backend and frontend
