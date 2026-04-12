# services/gateway/ — Primary API Gateway

## What This Is

The main Express.js API server. Serves both the backend REST API (95+ routes) and the Command Hub frontend (vanilla JS). Deployed as a single Docker image to Cloud Run `gateway` service.

## Commands

```bash
npm run dev          # Dev server with hot reload (tsx watch)
npm run build        # tsc + copy frontend assets → dist/
npm run test         # Run tests
npm run lint         # ESLint
npx tsc              # Type check only
```

## Request Flow

```
Request → CORS (middleware/cors.ts)
        → Auth (middleware/auth-supabase-jwt.ts) — validates dual JWT
        → VTID (middleware/require-vtid.ts) — optional VTID validation
        → Route handler (routes/*.ts)
        → Service (services/*.ts) — business logic
        → Response
```

## Source Structure

```
src/
├── index.ts                  # Express app — middleware setup + ALL route mounting
├── routes/                   # 95+ API route files (see routes/CLAUDE.md)
├── services/                 # 110+ business logic services (see services/CLAUDE.md)
├── middleware/                # 3 middleware files (see middleware/CLAUDE.md)
├── lib/                      # Utility libraries
│   ├── navigation-catalog.ts # 47KB — comprehensive nav catalog
│   ├── nav-catalog-db.ts     # 19KB — DB-backed nav catalog
│   ├── spa-routes-fallback.ts # SPA routing fallback
│   ├── stage-mapping.ts      # User journey stage mapping
│   ├── supabase.ts           # Supabase client init
│   ├── supabase-user.ts      # User context from Supabase
│   ├── versioning.ts         # API versioning
│   └── vitana-bot.ts         # Bot user identity
├── frontend/
│   ├── command-hub/          # Operator UI (vanilla JS)
│   │   ├── app.js            # Main application logic
│   │   ├── styles.css        # ALL styles (design tokens at top)
│   │   └── index.html        # Entry point
│   └── voice-lab/            # Voice testing interface
├── types/                    # TypeScript definitions
├── utils/                    # Helper functions
├── constants/                # Static values
├── governance/               # VTID validation rules
├── kb/                       # Knowledge base integration
└── validator-core/           # Validator service
```

## Key Files

| File | Size | Purpose |
|------|------|---------|
| `src/index.ts` | — | Express app setup — READ THIS to understand middleware chain and route mounting |
| `src/routes/orb-live.ts` | 438KB | Massive — voice orb live streaming logic |
| `src/routes/worker-orchestrator.ts` | 416KB | Massive — worker task orchestration |
| `src/services/autopilot-controller.ts` | — | XState-based autopilot state machine |
| `src/services/autopilot-event-loop.ts` | — | Event-driven autopilot execution |
| `src/lib/navigation-catalog.ts` | 47KB | Complete navigation catalog |
| `src/frontend/command-hub/app.js` | — | Command Hub frontend — read layout rules in root CLAUDE.md |

## Build Output

`npm run build` produces:
- `dist/` — compiled TypeScript
- Frontend assets copied into dist for serving

## Docker

Multi-stage build:
1. Builder: Node 20 Alpine, `npm ci && npm run build`
2. Runtime: Node 20 Alpine, copies dist + node_modules
3. Health check: `GET /events/health`
4. Port: 8080
