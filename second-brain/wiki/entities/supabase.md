# Supabase

> Dual Supabase project setup for the Vitana platform: authentication, database, keys, and how the two projects interrelate.

## Content

### Dual Supabase Architecture

The Vitana platform uses two separate Supabase projects:

| Project | Identifier | Used By | Purpose |
|---------|-----------|---------|---------|
| **Lovable Supabase** | `inmkhvwdcuyhnxkgfvsb` | vitana-v1 (community app) | End-user auth, community data, edge functions |
| **Platform Supabase** | (secrets in GCP) | vitana-platform (gateway) | Backend services, VTID ledger, OASIS events |

### Lovable Supabase (Community)

- **URL:** `https://inmkhvwdcuyhnxkgfvsb.supabase.co`
- **Used by:** vitana-v1 frontend, Dev Hub auth, E2E tests.
- **Auth methods:** Email magic link, Google OAuth.
- **Frontend vars:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (baked at build time).
- **Edge Functions:** 56 Supabase Edge Functions (AI, payments, commerce, admin, etc.).
- **RPC Functions:** 32 database RPC functions.

### Platform Supabase (Backend)

- **Credentials:** stored in GCP Secret Manager as `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`.
- **Used by:** gateway service for VTID ledger, OASIS events, governance.
- **Access:** via `service_role` key (full access, bypasses RLS).

### Dual JWT Authentication

The gateway auth middleware (`services/gateway/src/middleware/auth-supabase-jwt.ts`) validates JWTs from both Supabase projects:

1. Checks the Platform Supabase JWT secret first.
2. Falls back to the Lovable Supabase JWT secret.
3. This allows both operator/admin users (Platform) and community users (Lovable) to authenticate against the same gateway API.

### Key Database Tables (Platform)

| Table | Purpose |
|-------|---------|
| `vtid_ledger` | Central VTID task tracking |
| `oasis_events` | System-wide event log |
| `personalization_audit` | Cross-domain personalization |
| `services_catalog` | Service catalog |
| `d44_predictive_signals` | Proactive intervention signals |

**Note:** `VtidLedger` (PascalCase) is deprecated and empty -- always use `vtid_ledger`.

### Row-Level Security (RLS)

- All tables enforce tenant isolation via RLS policies.
- `service_role` has full access for backend services.
- Authenticated users can read all VTIDs (transparency) but only update their own tenant's records.
- VTIDs cannot be deleted (immutable audit trail).

### E2E Testing Auth

- Test user: `e2e-test@vitana.dev` with `exafy_admin: true`.
- Auth via Supabase REST API: `POST /auth/v1/token`.
- Service role key and anon key are stored in workflow files and test fixtures.

### Dev Hub Auth Flow

The Dev Hub uses Lovable Supabase auth:
- Email magic link or Google OAuth at `/dev/login`.
- Dedicated `DevAuthGuard` prevents redirect to admin routes.
- Respects `?next=<path>` for post-login redirect.

## Related Pages

- [[vitana-v1]]
- [[vitana-platform]]
- [[api-gateway-pattern]]
- [[dev-hub]]
- [[vtid-governance]]

## Sources

- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/architecture/vitana-v1-CLAUDE.md`
- `raw/architecture/vitana-platform-claude-extended.md`
- `raw/architecture/DEV_HUB_PHASE1_AUTH_FIX.md`
- `raw/governance/VTID_SYSTEM.md`

## Last Updated

2026-04-12
