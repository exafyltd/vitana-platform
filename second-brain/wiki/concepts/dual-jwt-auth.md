# Dual JWT Authentication

> How the Vitana Platform handles authentication across two separate Supabase projects (Platform Supabase and Lovable Supabase), including token validation and the middleware chain.

## Content

### The Two Supabase Projects

The Vitana ecosystem operates with two distinct Supabase instances:

- **Platform Supabase** -- The authoritative auth provider for the Vitana Platform. Secrets stored in GCP, accessed via service role. Issues the canonical JWTs that the Platform Gateway trusts.
- **Lovable Supabase** -- Project ID `inmkhvwdcuyhnxkgfvsb`. Used by the Lovable-built frontend (vitana-v1). Issues its own JWTs with different claim structures.

Because each Supabase project has its own JWT signing key, a token from one project cannot be natively validated by the other. This is the core problem that dual JWT authentication must solve.

### Token Validation Flow

All protected routes in the Platform Gateway follow this enforcement pattern:

1. Extract Bearer token from the `Authorization` header.
2. Create a user-scoped Supabase client with the token.
3. Resolve identity via the `me_context()` RPC function.
4. Reject the request with `401 UNAUTHENTICATED` if the token is missing or invalid, or `401 IDENTITY_INCOMPLETE` if `user_id` or `tenant_id` cannot be resolved.

The Gateway code path (located at `/services/gateway/src/routes/me.ts`) enforces that every authenticated request carries a valid JWT with both a `user_id` (from `auth.uid()` / JWT `sub` claim) and a `tenant_id` (from JWT `tenant` or `tenant_id` claim).

### JWT Claims Contract

**Standard Supabase claims (required):**

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | UUID | User ID (maps to `user_id`) |
| `aud` | String | Must be `authenticated` |
| `exp` | Timestamp | Token expiration |
| `iat` | Timestamp | Token issued at |

**Platform-specific custom claims:**

| Claim | Type | Description |
|-------|------|-------------|
| `tenant` or `tenant_id` | UUID | User's tenant |
| `role` or `active_role` | String | User's active role |
| `email` | String | User's email |

### Middleware Chain

The middleware chain for authenticated requests proceeds as follows:

1. **Bearer extraction** -- Token pulled from `Authorization: Bearer {token}` header.
2. **Supabase client creation** -- A user-scoped client is created with the token, which causes Supabase to validate the JWT signature and expiration.
3. **Identity resolution** -- `me_context()` RPC resolves `user_id`, `tenant_id`, and `active_role` from the JWT and database state.
4. **RLS enforcement** -- All subsequent database queries execute under Row Level Security policies that enforce `tenant_id = current_tenant_id() AND user_id = auth.uid()`.

### Bridging the Two Projects

During the parallel development phase, a **JWT Translation Layer** (Session Bridge) is designed to accept a Lovable JWT, validate it against the Lovable Supabase instance, then issue a Platform-compatible token. The bridge endpoint is `POST /api/v1/auth/bridge`. The long-term plan (Option A: Supabase Project Consolidation) is to migrate all auth to the Platform Supabase so that only one JWT issuer exists.

### Adapter Architecture Options

| Option | Description | Runtime Overhead |
|--------|-------------|-----------------|
| **A: Consolidation** (recommended) | Migrate Lovable users to Platform Supabase. Single JWT issuer. | None after migration |
| **B: JWT Translation** | Runtime adapter validates Lovable tokens and issues Platform tokens. | Per-request translation |
| **C: Hybrid** | Phase 1: translation layer during parallel dev. Phase 2: gradual migration. Phase 3: full consolidation. | Decreasing over time |

### Security Considerations

- Lovable tokens must be validated against the Lovable Supabase public key before any bridge operation.
- Platform tokens are only issued for verified Lovable users.
- Token expiration is strictly enforced.
- All Platform API calls must go through the Gateway; no direct Supabase access from the Lovable frontend.
- HTTPS only; replay attacks mitigated via nonce or `jti` claim validation.

## Related Pages

- [[canonical-identity]]
- [[supabase-platform]]
- [[supabase-lovable]]
- [[platform-supabase-vs-lovable-supabase]]
- [[additive-migration-pattern]]

## Sources

- `raw/auth/canonical-identity.md`
- `raw/auth/lovable-compatibility-adapter.md`
- `raw/auth/auth-merge-guardrails.md`

## Last Updated

2026-04-12
