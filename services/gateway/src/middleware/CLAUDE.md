# src/middleware/ — Express Middleware (3 files)

## Middleware Chain

Applied in order in `src/index.ts`:

1. **CORS** → `cors.ts`
2. **Auth** → `auth-supabase-jwt.ts` (on protected routes)
3. **VTID** → `require-vtid.ts` (on governance-tracked routes)

## File Index

### `auth-supabase-jwt.ts` — Dual JWT Authentication

Validates JWTs from TWO Supabase projects:
- **Platform Supabase** — `SUPABASE_URL` / `SUPABASE_JWT_SECRET`
- **Lovable Supabase** — `LOVABLE_SUPABASE_URL` (project: `inmkhvwdcuyhnxkgfvsb`)

The middleware tries Platform first, then Lovable. If both fail, returns 401.

Sets `req.user` with the authenticated user's data.

### `cors.ts` — CORS Configuration

Configures allowed origins for cross-origin requests from:
- Community app (`vitana-v1`) — both Cloud Run and Lovable CDN URLs
- Command Hub (same-origin, served by gateway)
- Local development (`localhost:8080`)

### `require-vtid.ts` — VTID Validation

Validates that requests include a valid VTID reference for governance tracking.
Used on routes that modify tracked state.

## Patterns

- Middleware is mounted globally or per-route in `src/index.ts`
- Auth middleware sets `req.user` — all downstream routes can access it
- Add new middleware here and mount in `index.ts`
