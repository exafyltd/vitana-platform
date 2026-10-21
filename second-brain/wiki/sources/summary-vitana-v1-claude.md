# Summary: vitana-v1 CLAUDE.md

> Summary of the canonical CLAUDE.md file from the vitana-v1 frontend repository.

## Content

### What This File Is

The `vitana-v1-CLAUDE.md` is the top-level onboarding document placed in the root of the `exafyltd/vitana-v1` repository. It gives Claude Code (and developers) the essential context needed to work on the frontend community app.

### Key Facts

- **Product name:** MAXINA - Longevity Community.
- **Scale:** 551+ screens spanning community, health, AI, messaging, wallet, and admin features.
- **Stack:** React 18, Vite 5 (SWC), TypeScript, Tailwind CSS, shadcn/ui, Zustand, TanStack React Query v5, Supabase Auth, React Router v6.
- **Dev server:** port 8080.
- **Build output:** `dist/`.

### Deployment Model

Dual-deploy on push to `main`:
1. Cloud Run `community-app` service via `DEPLOY.yml`.
2. Lovable CDN at `vitana-lovable-vers1.lovable.app` (legacy fallback).

### Project Structure

- `src/pages/` -- lazy-loaded route pages.
- `src/components/` -- 85+ component directories (including `ui/` for shadcn).
- `src/hooks/` -- 60+ custom hooks.
- `src/contexts/` -- React context providers.
- `src/lib/` -- utilities (supabase client).
- `src/App.tsx` -- main router (1200+ lines).

### Environment Variables

All `VITE_*` vars baked at build time. Key ones: Supabase URL/key, gateway URL, operator URL, Dev Hub feature flag.

### Key Architectural Patterns

- Mobile-first (`useIsMobile()` hook).
- Role-based access (Community, Professional, Staff, Admin, Dev).
- Multi-tenant via TenantProvider.
- Offline support via OfflineProvider + LocalStorage.
- Auth: Supabase Auth -> role check -> route guard.

### Multi-Repo Context

The file explicitly states that both `vitana-v1` and `vitana-platform` must be available in every Claude Code session. The backend is in `exafyltd/vitana-platform` and the frontend calls it via `VITE_GATEWAY_URL`.

## Related Pages

- [[vitana-v1]]
- [[multi-repo-architecture]]
- [[summary-vitana-platform-claude]]

## Sources

- `raw/architecture/vitana-v1-CLAUDE.md`

## Last Updated

2026-04-12
