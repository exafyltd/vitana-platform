# vitana-v1

> The frontend repository: a React/Vite SPA community app branded "MAXINA - Longevity Community" with 551+ screens.

## Content

### Identity

| Property | Value |
|----------|-------|
| Repository | `exafyltd/vitana-v1` |
| Role | Frontend community app |
| Brand | MAXINA - Longevity Community |
| Scale | 551+ screens |
| Cloud Run Service | `community-app` |
| Lovable CDN (legacy) | `vitana-lovable-vers1.lovable.app` |

### Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | React 18 + TypeScript |
| Build | Vite 5 (SWC plugin) |
| Styling | Tailwind CSS + shadcn/ui |
| State | Zustand + TanStack React Query v5 |
| Auth | Supabase Auth (dual JWT -- platform + community) |
| Routing | React Router v6 (lazy-loaded routes) |

### Project Structure

```
src/
  pages/          # Route page components (lazy-loaded)
  components/     # 85+ component directories
    ui/           # shadcn/ui primitives
  hooks/          # 60+ custom hooks
  contexts/       # React context providers
  lib/            # Utilities (supabase client, etc.)
  types/          # TypeScript type definitions
  App.tsx         # Main router (1200+ lines, all routes)
```

### Build Commands

```bash
npm run dev       # Dev server on port 8080
npm run build     # Production build -> dist/
npm run preview   # Preview production build
```

### Environment Variables

`.env` contains `VITE_*` vars baked at build time (public keys only):

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase connection URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase anon key |
| `VITE_GATEWAY_URL` | Backend API gateway URL |
| `VITE_OPERATOR_BASE_URL` | Operator API URL |
| `VITE_DEV_HUB_ENABLED` | Dev Hub feature flag |

### Key Patterns

- **Mobile-first:** `useIsMobile()` hook, MobileAppShell wrapper.
- **Role-based:** Community, Professional, Staff, Admin, Dev roles.
- **Multi-tenant:** TenantProvider for portal-specific branding.
- **Offline support:** OfflineProvider + LocalStorage query persistence.
- **Auth flow:** Supabase Auth -> role check -> route guard.

### Deployment

Deploys to two hosts on push to `main`:

1. **Cloud Run** `community-app` service via `.github/workflows/DEPLOY.yml` (nginx serving static Vite build).
2. **Lovable CDN** at `vitana-lovable-vers1.lovable.app` (legacy fallback, to be decommissioned).

Claude Code is the only development tool for this repo -- no more Lovable web editor.

### Supabase Project

Uses the "Lovable" Supabase project: `https://inmkhvwdcuyhnxkgfvsb.supabase.co`

## Related Pages

- [[vitana-platform]]
- [[multi-repo-architecture]]
- [[cloud-run-deployment]]
- [[dev-hub]]
- [[supabase]]
- [[summary-vitana-v1-claude]]
- [[lovable-cdn-vs-cloud-run]]

## Sources

- `raw/architecture/vitana-v1-CLAUDE.md`
- `raw/architecture/vitana-platform-CLAUDE.md`

## Last Updated

2026-04-12
