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

There are THREE deployable components across two repos:

### 1. Backend + Command Hub (vitana-platform)
- **Cloud Run service:** `gateway` in `us-central1`, project `lovable-vitana-vers1`
- **Source:** `vitana-platform/services/gateway/`
- **Includes:** Backend API routes + Command Hub frontend (operator/developer UI)
- **URL:** `https://gateway-q74ibpv6ia-uc.a.run.app`
- **Command Hub frontend:** `services/gateway/src/frontend/command-hub/app.js` (vanilla JS, served by gateway)
- **Deploys via:** `.github/workflows/EXEC-DEPLOY.yml` (governed, with VTID tracking)
- **Auto-deploys** on push to `main` via `.github/workflows/AUTO-DEPLOY.yml`
- **One deploy = backend API + Command Hub frontend together** (same Docker image)

### 2. Community App (vitana-v1) 
- **Repo:** `exafyltd/vitana-v1` (filesystem: `/home/user/vitana-v1/`)
- **Stack:** React/Vite SPA with TypeScript, Tailwind, Supabase Auth
- **Hosted:** `vitana-lovable-vers1.lovable.app` (auto-deploys on push to `main`)
- **This is the end-user mobile/web app** (Events, Autopilot Actions popup, diary, matches, etc.)
- **Supabase project:** `inmkhvwdcuyhnxkgfvsb`
- **Auth:** Dual JWT — Platform + Lovable Supabase secrets
- **CORS:** Configured in `vitana-platform/services/gateway/src/middleware/cors.ts`

### Which frontend is which?
| Feature | Command Hub (`vitana-platform`) | Community App (`vitana-v1`) |
|---------|-------------------------------|---------------------------|
| Users | Operators, developers, admins | Community users (end users) |
| UI | "AUTOPILOT" pill, "OPERATOR" pill | "Autopilot Actions" popup, events, diary |
| Tech | Vanilla JS (`app.js`) | React/Vite/TypeScript |
| Deploy | With gateway (Cloud Run) | Push to `main` (Lovable CDN) |
| URL | `gateway-*.run.app/command-hub` | `vitana-lovable-vers1.lovable.app` |

- **Platform Supabase:** Secrets in GCP Secret Manager (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`)
- **Lovable Supabase:** `https://inmkhvwdcuyhnxkgfvsb.supabase.co` (env: `LOVABLE_SUPABASE_URL`)

## Deployment Process

### Backend API + Command Hub changes (vitana-platform)

1. Make changes in `services/gateway/src/` (API routes, middleware, services, OR Command Hub frontend)
2. Verify TypeScript compiles: `cd services/gateway && npx tsc`
3. Commit and push to feature branch
4. Create PR to `main`, merge (squash)
5. AUTO-DEPLOY triggers → dispatches EXEC-DEPLOY
6. EXEC-DEPLOY: VTID check → Governance → `gcloud run deploy gateway` → Health check → Smoke tests
7. If no VTID in commit, uses `BOOTSTRAP-AUTO-{sha}` fallback
8. **Both backend API and Command Hub frontend deploy together** (same image)

### Community App changes (vitana-v1)

1. Source: `/home/user/vitana-v1/` (or clone from `exafyltd/vitana-v1`)
2. Make changes in `src/` (React components, hooks, pages)
3. Commit and push to `main` (auto-deploys to `vitana-lovable-vers1.lovable.app`)
4. For feature work: create branch, PR, merge to `main`

### Full-Stack Changes (both repos)

When a change spans backend + community app:
1. Make backend changes in `vitana-platform/services/gateway/`
2. Make frontend changes in `vitana-v1/src/`
3. Deploy backend first (merge to `vitana-platform` main)
4. Deploy frontend second (merge to `vitana-v1` main)
5. Verify both are live before testing

### Command Hub + Community App (both frontends)

When a feature affects BOTH frontends (e.g., autopilot):
1. Backend/API changes + Command Hub in `vitana-platform` (one deploy)
2. Community App UI in `vitana-v1` (separate deploy)
3. Both call the same API endpoints — keep response format compatible

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

## Preview & Publish Pipeline

### Preview (feature branches)

Every feature branch gets automatic previews for both components:

| Component | Preview URL | How |
|-----------|------------|-----|
| **Community App** | `https://{branch}--vitana-v1.lovable.app` | Auto-generated by Lovable CDN on branch push |
| **Gateway + Command Hub** | Cloud Run `--no-traffic` revision | Deploy via `gcloud run deploy --no-traffic` on branch push |

### Publish (go live)

The Command Hub **Publish** button (`renderPublishModal()` in `app.js`) is the single control point:
- Shows preview URLs for both gateway and community app
- Selecting "Publish" merges the feature branch to `main` on both repos
- Gateway: AUTO-DEPLOY → EXEC-DEPLOY → Cloud Run routes traffic
- Community App: Push to `main` → Lovable CDN production deploy

### Workflow

```
1. Claude Code creates feature branch on both repos
2. Push changes → previews are live automatically
3. Test via preview URLs
4. Open Command Hub → click Publish → select branch → confirm
5. Both repos merge to main → both deploy to production
```

### Key Rule: NEVER push directly to main for untested changes
- Always use feature branches
- Always preview before publishing
- The Publish button is the single "go live" action
