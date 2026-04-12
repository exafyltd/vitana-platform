# API Gateway Pattern

> The Express gateway architecture in vitana-platform: route structure, middleware chain, service proxying, and coding conventions.

## Content

### Overview

The Vitana platform uses a single Express.js gateway service as the central API layer. It is deployed to Cloud Run as the `gateway` service and serves both backend API routes and the Command Hub frontend from the same Docker image.

### Gateway Source Structure

```
services/gateway/
  src/
    index.ts             # Entry point (port 8080)
    types.ts             # TypeScript types
    routes/              # API route handlers
    services/            # Business logic services
    middleware/           # Middleware chain
    frontend/
      command-hub/       # Command Hub vanilla JS frontend
        app.js           # Main frontend code
        styles.css       # Design system (CSS classes + :root tokens)
  Dockerfile
  package.json
  tsconfig.json
```

### Route Namespace

All API routes live under `/api/v1/`. Key route groups include:

| Route Group | Purpose |
|-------------|---------|
| `/api/v1/worker/orchestrator/*` | Worker orchestrator (register, claim, heartbeat, complete) |
| `/api/v1/worker/subagent/*` | Subagent lifecycle (start, complete) |
| `/api/v1/governance/*` | Governance evaluation and status |
| `/api/v1/vtid/*` | VTID CRUD (create, read, update, list, health) |
| `/api/v1/events/*` | OASIS event ingestion and querying |
| `/api/v1/operator/*` | Operator actions (deploy, publish) |
| `/api/v1/creators/*` | Creator/Stripe Connect endpoints |
| `/api/v1/oasis/*` | OASIS proxy (vtid-ledger, etc.) |
| `/autopilot-recommendations` | Autopilot recommendation engine |
| `/command-hub` | Command Hub frontend (served by gateway) |
| `/alive` | Health check endpoint |

### Middleware Chain

| Middleware | File | Purpose |
|-----------|------|---------|
| CORS | `middleware/cors.ts` | Configured for community-app, Lovable CDN, and gateway origins |
| Auth (Dual JWT) | `middleware/auth-supabase-jwt.ts` | Validates JWTs from both Platform and Lovable Supabase projects |

### API Response Convention

All API responses follow the standard shape:

```typescript
{ ok: boolean, error?: string, data?: T }
```

JSON response fields use `snake_case`.

### Coding Conventions

- **Strict TypeScript** with Zod for request validation.
- **Express Router pattern** for route grouping.
- **All routes under `/api/v1/`** for versioning.
- **Verify TypeScript compiles** before committing: `cd services/gateway && npx tsc`.

### Command Hub Frontend Rules

The Command Hub frontend at `services/gateway/src/frontend/command-hub/` has strict layout rules:

- **All layout styles must live in `styles.css`** as class definitions referencing `:root` design tokens.
- **In `app.js`, use `element.className`** -- never `element.style.cssText` for layout properties.
- **Allowed inline:** only dynamic positioning (gridColumn, display toggles, computed transforms).
- **Forbidden inline:** padding, margin, gap, font-size, color, background, border, width, height.
- **Flexbox truncation:** `.x-row { display:flex }` with `.x-message { flex:1; overflow:hidden }` must have `min-width:0` on both.

### Key Services

| Service | File | Purpose |
|---------|------|---------|
| Autopilot Recommendations | `routes/autopilot-recommendations.ts` | Community user recommendations (auto-replenish, daily scheduler) |
| Recommendation Engine | `services/recommendation-engine/scheduler.ts` | Daily 7 AM UTC scheduler |
| Community Analyzer | `services/recommendation-engine/analyzers/community-user-analyzer.ts` | 28 templates, 8 languages, 6 onboarding stages |
| GChat Notifier | `services/gchat-notifier.ts` | Google Chat notifications |

### Gateway URLs

| Type | URL |
|------|-----|
| Canonical | `https://gateway-q74ibpv6ia-uc.a.run.app` |
| Alt | `https://gateway-86804897789.us-central1.run.app` |

## Related Pages

- [[vitana-platform]]
- [[cloud-run]]
- [[multi-repo-architecture]]
- [[summary-api-inventory]]
- [[vtid-governance]]

## Sources

- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/architecture/vitana-platform-claude-extended.md`
- `raw/architecture/API_INVENTORY.md`

## Last Updated

2026-04-12
