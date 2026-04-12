# Vitana Platform — Backend, Gateway, Command Hub

## What This Is

Backend platform for the Vitana/MAXINA longevity ecosystem. Node.js/Express API gateway with 95+ routes, 110+ services, OASIS event system, VTID governance, and multiple microservices. This is the **backend** repo. The frontend is `exafyltd/vitana-v1` at `/home/user/vitana-v1/`.

## Multi-Repo Setup

Both repos must be available in every session:
```
/home/user/vitana-platform/   <- Backend (this repo)
/home/user/vitana-v1/         <- Frontend (React/Vite SPA)
```

## Commands

### Gateway (main service)
```bash
cd services/gateway
npm run dev          # Dev server (tsx watch) → http://localhost:8080
npm run build        # TypeScript compile + copy frontend assets → dist/
npm run test         # Run tests
npm run lint         # ESLint
npx tsc              # TypeScript check (no emit)
```

### Database
```bash
npx prisma migrate dev        # Run pending migrations
npx prisma migrate deploy     # Deploy migrations (production)
npx prisma generate           # Regenerate Prisma client
npx prisma studio             # Visual DB browser
```

### Docker (local Postgres)
```bash
docker compose up -d                    # Start PostgreSQL 16
docker compose --profile tools up -d    # Start PostgreSQL + pgAdmin
```

### E2E Tests
```bash
cd e2e
npx playwright test --project=desktop-community
```

## Stack

- **Runtime:** Node.js 20 + TypeScript 5.3 (strict mode)
- **Framework:** Express 4.18
- **ORM:** Prisma 6.18 → PostgreSQL 16
- **Auth:** Supabase JWT (dual: Platform + Lovable)
- **AI:** Google Gemini, Vertex AI, OpenAI (embeddings), Perplexity (search)
- **State machines:** XState 5.26 (autopilot)
- **Payments:** Stripe 20.3
- **Video:** Daily.co SDK
- **Real-time:** WebSockets (ws), Server-Sent Events
- **Package manager:** pnpm 9.0

## Directory Map

```
vitana-platform/
├── services/
│   ├── gateway/                    # PRIMARY SERVICE — Express API + Command Hub frontend
│   │   ├── src/
│   │   │   ├── index.ts            # Express app setup, middleware, route mounting
│   │   │   ├── routes/             # 95+ API route files
│   │   │   ├── services/           # 110+ business logic services
│   │   │   ├── middleware/         # Auth, CORS, VTID validation (3 files)
│   │   │   ├── lib/                # Utilities — nav catalog, SPA routing, Supabase
│   │   │   ├── frontend/
│   │   │   │   ├── command-hub/    # Operator UI (vanilla JS — app.js + styles.css)
│   │   │   │   └── voice-lab/     # Voice testing interface
│   │   │   ├── types/             # TypeScript definitions
│   │   │   ├── utils/             # Helper functions
│   │   │   ├── constants/         # Static values
│   │   │   ├── governance/        # VTID validation rules
│   │   │   ├── kb/                # Knowledge base integration
│   │   │   └── validator-core/    # Validator service
│   │   ├── Dockerfile             # Multi-stage Node 20 Alpine build
│   │   ├── package.json           # Express, Supabase, Stripe, AI deps
│   │   └── tsconfig.json          # Strict mode, ES2022 target, CommonJS
│   ├── oasis-operator/            # OASIS event operator service
│   ├── oasis-projector/           # Event projection engine
│   ├── agents/                    # CrewAI agent framework (8 sub-services)
│   ├── mcp/                       # Model Context Protocol support
│   ├── mcp-gateway/               # MCP gateway service
│   ├── worker-runner/             # Task worker execution
│   ├── openclaw-bridge/           # Connector bridge
│   ├── deploy-watcher/            # Deployment monitoring
│   └── validators/                # Validation services
├── prisma/
│   ├── schema.prisma              # 3 models: OasisEvent, VtidLedger, ProjectionOffset
│   └── migrations/                # Prisma migrations
├── database/
│   ├── migrations/                # Raw SQL migrations (20+ files)
│   └── policies/                  # RLS policies
├── e2e/                           # Playwright E2E tests
│   ├── playwright.config.ts       # 16 projects (desktop/mobile per role)
│   ├── global-setup.ts            # Test user provisioning
│   ├── auth/                      # Auth flow tests
│   ├── command-hub/               # Command Hub tests
│   ├── community-desktop/         # Desktop community tests
│   ├── community-mobile/          # Mobile community tests
│   └── fixtures/                  # Test data & users
├── supabase/                      # Supabase edge functions & migrations
├── docs/                          # Architecture docs, governance, deployment
├── specs/                         # OASIS and gateway specifications (YAML + MD)
├── config/
│   ├── service-path-map.json      # Service → Cloud Run service mapping
│   └── cicd-concurrency.json      # CI/CD concurrency limits
├── scripts/                       # Deploy, CI, AI, backfill scripts
├── kb/                            # Knowledge base documents (JSON, 280KB)
├── cloudflare/                    # Cloudflare Workers (email intake, OG proxy)
├── crew_template/                 # CrewAI agent templates
├── .github/workflows/             # 11 CI/CD workflow files
│   ├── AUTO-DEPLOY.yml            # Triggers EXEC-DEPLOY on push to main
│   ├── EXEC-DEPLOY.yml            # Canonical governed deployment (32KB)
│   ├── E2E-TEST-RUN.yml           # Playwright E2E tests
│   ├── COMMAND-HUB-GUARDRAILS.yml # Layout rule enforcement
│   └── ...                        # Linting, naming, migration, persistence
├── docker-compose.yml             # Local PostgreSQL 16 + pgAdmin
├── package.json                   # Root package (pnpm, Prisma)
└── CLAUDE.md                      # This file
```

## Key Files — Read These First

| File | What it does | When to read it |
|------|-------------|-----------------|
| `services/gateway/src/index.ts` | Express app setup, all middleware + route mounting | Understanding request flow |
| `services/gateway/src/middleware/auth-supabase-jwt.ts` | Dual JWT validation (Platform + Lovable Supabase) | Auth issues |
| `services/gateway/src/middleware/cors.ts` | CORS configuration | CORS issues |
| `services/gateway/src/middleware/require-vtid.ts` | VTID validation middleware | VTID governance |
| `prisma/schema.prisma` | Database schema (OasisEvent, VtidLedger, ProjectionOffset) | DB changes |
| `config/service-path-map.json` | Service → Cloud Run mapping | Deployment |
| `services/gateway/src/frontend/command-hub/app.js` | Command Hub frontend (vanilla JS) | Command Hub changes |
| `services/gateway/src/frontend/command-hub/styles.css` | Command Hub styles | Command Hub styling |
| `services/gateway/src/lib/navigation-catalog.ts` | Navigation catalog (47KB) | Nav structure |
| `.github/workflows/EXEC-DEPLOY.yml` | Canonical deployment pipeline (32KB) | Deploy changes |
| `.github/workflows/AUTO-DEPLOY.yml` | Auto-deploy trigger on push to main | Deploy triggers |

## Three Deployable Components

| Component | Service | Source | Deploy trigger |
|-----------|---------|--------|---------------|
| Backend API + Command Hub | `gateway` on Cloud Run | `services/gateway/` | Push to `main` → AUTO-DEPLOY → EXEC-DEPLOY |
| Community App | `community-app` on Cloud Run | `vitana-v1/` (other repo) | Push to `main` → DEPLOY.yml |
| (Plus standalone services) | `oasis-operator`, `worker-runner`, etc. | `services/{name}/` | EXEC-DEPLOY with service param |

## Deployable Services

From `config/service-path-map.json`:
- **Deployable:** gateway, oasis-operator, oasis-projector, vitana-verification-engine, openclaw-bridge, worker-runner
- **Non-deployable** (support only): agents, mcp, mcp-gateway, deploy-watcher, oasis, validators

## Database Schema (Prisma)

Three models in `prisma/schema.prisma`:

1. **OasisEvent** → `oasis_events` table
   - System-wide event log
   - Fields: id, rid, service, event, tenant, status, notes, gitSha, metadata, vtid, topic, message, role, model, link, source, actor tracking fields
   - Indexed by: projected/createdAt, service, tenant, status, vtid

2. **VtidLedger** → `vtid_ledger` table
   - Central task tracking
   - Fields: id, vtid (unique), taskFamily, taskType, description, status, assignedTo, tenant, metadata, parentVtid, layer, module, title, summary
   - Indexed by: createdAt, taskFamily, status, tenant, vtid, lastEventAt, service

3. **ProjectionOffset** → `projection_offsets` table
   - Event projection tracking
   - Fields: projectorName (unique), lastEventId, lastEventTime, lastProcessedAt, eventsProcessed

## Environment Variables (Gateway)

Key env vars (set via GCP Secret Manager):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` — Platform Supabase
- `LOVABLE_SUPABASE_URL`, `LOVABLE_SUPABASE_SERVICE_ROLE` — Lovable Supabase (for community app auth)
- `SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY` — JWT validation
- `DATABASE_URL` — PostgreSQL connection
- `GOOGLE_GEMINI_API_KEY` — Gemini AI
- `OPENAI_API_KEY` — Embeddings
- `PERPLEXITY_API_KEY` — Web search
- `DAILY_API_KEY` — Video rooms
- `GCP_PROJECT_ID` — `lovable-vitana-vers1`
- `STRIPE_SECRET_KEY` — Payments

## Cross-Repo API Map

The frontend (`vitana-v1`) calls this backend at `VITE_GATEWAY_URL`. Key mappings:

| Frontend (vitana-v1) | Backend route | Backend service |
|---|---|---|
| `hooks/useChatApi.ts` | `routes/chat.ts` | `services/conversation-client.ts` |
| `hooks/use-autopilot.ts` | `routes/autopilot.ts` | `services/autopilot-controller.ts` |
| `hooks/useCommunityEvents.ts` | `routes/events.ts` | Supabase direct |
| `hooks/useLiveRoom.ts` | `routes/live.ts` | `services/room-session-manager.ts` |
| `hooks/useMessages.ts` | `routes/conversation.ts` | `services/conversation-client.ts` |
| `hooks/useWallet.ts` | `routes/financial-monetization.ts` | `services/d36-financial-monetization-engine.ts` |
| `hooks/useHealthPlans.ts` | `routes/health.ts` | `services/health-capacity-awareness-engine.ts` |
| `hooks/useTaskStream.ts` | `routes/tasks.ts` | `services/task-intake-service.ts` |
| `lib/commandHubApi.ts` | `routes/command-hub.ts` | `services/operator-service.ts` |

## VTID Governance

VTIDs (Vitana Task IDs) track all work across the platform:
- Format: `VTID-XXXXX` (e.g., `VTID-01228`)
- Every deploy requires a VTID (fallback: `BOOTSTRAP-AUTO-{sha}`)
- VTID lifecycle: created → in-progress → completed → terminalized
- Validation middleware: `services/gateway/src/middleware/require-vtid.ts`
- Ledger: `vtid_ledger` table (Prisma model)

## Git Workflow

- Feature branches: `claude/{feature}-{id}`
- PRs merge to `main` via squash
- AUTO-DEPLOY triggers on `main` push when `services/gateway/**` changes
- EXEC-DEPLOY is the canonical governed deploy pipeline
- VTID extracted from commit message for deploy tracking

## Architecture Rules — Do Not Violate

1. **VTID governance**: Every significant change needs a VTID. Commits should reference VTIDs.
2. **Dual JWT auth**: Both Platform and Lovable Supabase tokens must be validated. See `auth-supabase-jwt.ts`.
3. **Command Hub layout rules**: No inline styles in `app.js`. All styles in `styles.css` using CSS classes and design tokens. See section below.
4. **Deploy backend first**: For full-stack changes, deploy backend before frontend.
5. **Service isolation**: Each service in `services/` is independently deployable. Don't create cross-service imports.
6. **Event sourcing**: Use OASIS events for state changes that need audit trails. Don't mutate state without events.
7. **TypeScript strict mode**: The gateway uses `strict: true`. Don't add `@ts-ignore` or weaken type safety.

## Command Hub Layout Rules (DO NOT VIOLATE)

Layout, padding, font-size, color, border, and background styles MUST live in `styles.css` as class definitions using `:root` design tokens.

**In `app.js`, use:** `element.className = 'foo-class'`
**Never use:** `element.style.cssText = 'padding:...; font-size:...; background:...'`

**Allowed inline:** dynamic positioning (gridColumn), visibility toggles (display none/block), computed transforms
**Forbidden inline:** padding, margin, gap, font-size, color, background, border, width/height, display flex/grid

**Flexbox truncation:** `.x-row { display:flex }` with `.x-message { flex:1; overflow:hidden; text-overflow:ellipsis }` MUST have `min-width:0` on both row and message.

**Card sizing:** Cards with `justify-content:center` MUST declare `min-height`.

## Common Tasks

### Add a new API route
1. Create route file in `services/gateway/src/routes/`
2. Create service file in `services/gateway/src/services/` if business logic is complex
3. Mount route in `services/gateway/src/index.ts`
4. Add auth middleware: `authMiddleware` for protected routes
5. Validate input with Zod schemas

### Add a new service
1. Create service file in `services/gateway/src/services/`
2. Export functions, not classes (functional pattern)
3. Use Prisma client for DB access, Supabase client for Supabase operations
4. Add OASIS events for auditable operations

### Add a database migration
1. Modify `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name <description>`
3. For raw SQL: add file to `database/migrations/` with date prefix

### Deploy a change
1. Make changes in `services/gateway/src/`
2. Verify: `cd services/gateway && npx tsc`
3. Push to feature branch, create PR to `main`
4. Merge triggers AUTO-DEPLOY → EXEC-DEPLOY with VTID tracking

## Graphify Integration (Phase 2)

When Graphify is available, use it to answer:
- "What routes call this service?" — trace route → service → DB dependencies
- "What will break if I change this Prisma model?" — follow the type through services and routes
- "What frontend hooks hit this endpoint?" — cross-repo dependency chain

Keep CLAUDE.md for rules and architecture. Use Graphify for dynamic relationships.
