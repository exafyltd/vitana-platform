# Sparring round 1 — in_progress

Session: `e5a2cf45-d17c-470b-8c5c-956d51590414` · plan hash `842fad0167bcf1a7c230c8a905b13046cd009d796494168f588e3e9ee8efd3d6`

## Summary

Verified 5 premises against the pinned code (3 with read_file, 2 via list_dir dropped per store rules). One major architectural issue found: the plan's client-identity middleware mount point (global, after delegatedTokenGuard()) cannot access req.identity because authentication is per-route in this gateway, not global. The classification header echo will work, but the recording of per-member rows in client_identity_daily_seen will silently never fire because req.identity is always undefined at the global middleware layer. Three other premises confirmed as stated.

## Findings

### R1-F1 [major]

The plan says the client-identity middleware will be 'mounted once in src/index.ts after delegatedTokenGuard(), line 640' and 'For an authenticated request it records one row per (day, member, class) in client_identity_daily_seen.' However, authentication in the gateway is NOT global — there is no app.use() that sets req.identity. Instead, each route applies its own auth middleware (requireAuth, optionalAuth, requireTenant, etc.) from auth-supabase-jwt.ts within the route handler chain. A middleware mounted globally after line 640 will execute BEFORE any route-level auth, so req.identity will always be undefined when it runs. The classification (reading the X-Vitana-Client header) works fine globally, but the recording of (day, user_id, client_class) requires the authenticated identity, which is only available after per-route auth middleware. The plan must specify how the middleware obtains the identity — e.g., a response-lifecycle hook (res.on('finish', ...)) that defers recording until after route handlers have run, or mounting as per-route middleware after auth, or performing its own JWT verification. Without this, writes to client_identity_daily_seen will never occur and adoption measurement is broken.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:637` — const { delegatedTokenGuard } = require('./services/delegation-guard');
    app.use(delegatedTokenGuard());

    // Health check
    app.get('/health', (req, res) => {
- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:41` — export interface SupabaseIdentity {
    user_id: string;
    email: string | null;
    tenant_id: string | null;
    exafy_admin: boolean;
    role: string | null;
    aud: string | null;
    exp: number | null;
    iat: number | null;
    vitana_id?: string | null;
  }
- `exafyltd/vitana-platform:services/gateway/src/routes/health.ts:30` — function getBearerToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  }
- `exafyltd/vitana-platform:services/gateway/src/routes/me.ts:89` — function getBearerToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  }

Suggestion: The plan must specify the mechanism for deferring the recording until after per-route auth has populated req.identity. The standard Express pattern is for the global middleware to hook res.on('finish', ...) or res.on('close', ...) to fire a callback after the route handler chain (including route-level auth) has completed. At that point req.identity will be populated for authenticated routes. Alternatively, state that the middleware will perform a lightweight JWT decode (not full verification, which is done per-route) to extract user_id/tenant_id, or mount the recording as a per-route middleware after auth. Whichever approach is chosen, document it in the plan so the implementor gets it right.

### R1-F2 [minor]

The plan says 'the middleware echoes X-Vitana-Client-Class on the response' for the staging test, implying the classification header is set on the response by the global middleware. For a global middleware that runs before route handlers, setting response headers is straightforward (call res.setHeader before next()). However, the plan should clarify that the response header is set before calling next(), not in a response lifecycle hook, to ensure it's available regardless of how the route handler sends the response.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:637` — const { delegatedTokenGuard } = require('./services/delegation-guard');
    app.use(delegatedTokenGuard());

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // Alive endpoint for deployment validation
    app.get('/alive', (req, res) => {
      res.json({ status: 'ok', service: 'gateway', timestamp: new Date().toISOString() });
    });

Suggestion: Clarify that the middleware sets the X-Vitana-Client-Class response header synchronously (res.setHeader) before calling next(), ensuring it's present on all responses including error responses from downstream handlers.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
