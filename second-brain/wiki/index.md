# Wiki Index

> Master index of all 95 pages in the Vitana Second Brain wiki, grouped by type and domain.

Last rebuilt: 2026-04-12

---

## Concepts (36 pages)

### Architecture & Infrastructure
- [[multi-repo-architecture]] — Dual-repo system (vitana-v1 + vitana-platform)
- [[api-gateway-pattern]] — Express gateway structure, routes, middleware
- [[cloud-run-deployment]] — GCP Cloud Run deployment model, dual-deploy pattern
- [[vtid-governance]] — VTID tracking system, numbering, branching
- [[spec-governance]] — Spec templates, rules, VTID validator
- [[self-healing-system]] — Automatic recovery pipeline, 6-stage diagnosis engine

### Auth & Data
- [[dual-jwt-auth]] — Dual JWT authentication across two Supabase projects
- [[canonical-identity]] — User identity resolution across projects
- [[additive-migration-pattern]] — Safe database migration rules (additive-only)

### Frontend & UX
- [[mobile-pwa-architecture]] — "14 Surfaces Not 500 Screens" philosophy, ORB states
- [[design-system]] — UI patterns, horizontal lists, emoji mapping, community header
- [[screen-registry]] — 551+ screens, D1 compliance standard
- [[role-based-access]] — Five roles and their screen access matrix
- [[multi-tenancy]] — Tenant-specific screens, branding, TenantProvider
- [[dev-hub]] — Developer command center feature
- [[apple-compliance]] — Apple App Review compliance (3.1.5 response)

### AI & Automation
- [[autopilot-system]] — Autopilot architecture: engine, scheduler, analyzer pipeline
- [[autopilot-automations]] — 12 automation domains, 108 total automations
- [[recommendation-engine]] — Community analyzer, 28 templates, 8 languages, daily scheduling
- [[autonomous-execution]] — Agent architecture, guardrails, execution review
- [[cognee-integration]] — Cognee vector DB for memory and knowledge graph
- [[agent-architecture]] — CrewAI, memory indexer, orchestrator, KB integration

### Communication & Real-Time
- [[sse-event-streaming]] — SSE architecture, /api/v1/events/stream, connection flapping
- [[webrtc-integration]] — WebRTC for video/audio in Live Rooms and Messenger
- [[gemini-live-api]] — Google Gemini Live API for real-time AI interaction
- [[live-rooms]] — Live Rooms system, sessions, iOS fixes, Daily.co
- [[command-hub-architecture]] — Operator dashboard, SSE wiring, vanilla JS

### Product Features
- [[wallet-system]] — Credits, tokens, transactions, subscriptions
- [[stripe-connect]] — Stripe Connect payment integration (90/10 split)
- [[longevity-philosophy]] — MAXINA longevity-first philosophy, five pillars
- [[vitana-index]] — Vitana Index 0-999 scoring system, zones, data sources
- [[memory-garden]] — Memory Garden: 13 categories, diary, privacy, AI learning
- [[health-tracking]] — Health dashboard, nutrition, sleep, biomarkers, wearables
- [[matchmaking-system]] — Intelligent matchmaking, daily matches, 7 types
- [[discover-marketplace]] — AI picks, supplements, doctors, deals, ordering
- [[financial-longevity]] — Credits, cash, VTN tokens, longevity economy

---

## Entities (24 pages)

### Repositories & Infrastructure
- [[vitana-v1]] — Frontend repo: React/Vite SPA, 551+ screens
- [[vitana-platform]] — Backend repo: Express gateway, 95+ routes, 110+ services
- [[cloud-run]] — Cloud Run services: gateway, community-app, oasis
- [[github-actions]] — CI/CD workflows: AUTO-DEPLOY, EXEC-DEPLOY, 12+ workflows
- [[supabase]] — Dual Supabase project setup overview
- [[supabase-platform]] — Platform Supabase: GCP secrets, 135+ tables
- [[supabase-lovable]] — Lovable Supabase: community auth, 271 tables
- [[database-schema]] — Full schema: tables by domain, RLS, tenants

### Products & Features
- [[autopilot]] — Autopilot system: user/operator controls, safety model
- [[command-hub]] — Command Hub: operator dashboard, publish workflow, layout rules
- [[maxina]] — MAXINA brand, AI personality, longevity community
- [[maxina-orb]] — ORB: AI assistant, 3 modes, voice/text, 8 visual layers
- [[home-dashboard]] — Home Dashboard: daily priorities, 4 tabs
- [[business-hub]] — Business Hub: services, marketplace, 4 earning paths
- [[mobile-surfaces]] — 15 primary surfaces + 7 overlays + 4 public routes
- [[memory-garden]] (entity) — Memory Garden product feature
- [[vitana-index-entity]] — Vitana Index product feature/scoring

### External Services
- [[google-gemini]] — Google Gemini API: Gemini 2.0 Flash, ORB voice
- [[daily-co]] — Daily.co video service for live rooms
- [[stripe]] — Stripe: Connect Express, Payment Intents, webhooks
- [[cognee]] ��� Cognee vector DB: entity extraction, Cloud Run

### AI Agents
- [[crewai]] — CrewAI agent framework: crew templates, role-model mappings
- [[memory-indexer]] — Memory indexer: Qdrant integration, KB skills
- [[vitana-orchestrator]] — Orchestrator: verification stage gates, domain validators

---

## Sources (31 pages)

### Architecture & Governance
- [[summary-vitana-v1-claude]] — vitana-v1 CLAUDE.md onboarding summary
- [[summary-vitana-platform-claude]] — vitana-platform CLAUDE.md + COP + CEO handover
- [[summary-api-inventory]] — 210+ APIs: 56 edge functions, 120+ hooks, 32 RPCs
- [[summary-vtid-system]] — VTID numbering, branching, COP, enforcement

### Auth & Database
- [[summary-canonical-identity]] — Canonical identity contract + auth adapters
- [[summary-database-schema]] — Canonical database schema reference
- [[summary-migration-rules]] — Additive migration rules
- [[summary-platform-schema-inventory]] — 135+ table inventory (14 domains)

### Autopilot & AI
- [[summary-autopilot-architecture]] — Autopilot architecture document
- [[summary-autopilot-capabilities]] — Autopilot capabilities model (A1-A5)
- [[summary-autopilot-action-catalog]] — Full action catalog (169 actions, 9 modules)
- [[summary-autonomous-architecture]] — Autonomous architecture v1 + review
- [[summary-cognee-integration]] — Cognee integration design
- [[summary-agent-services]] — CrewAI, memory indexer, orchestrator, KB READMEs

### Communication & Real-Time
- [[summary-sse-diagnostic]] — SSE flapping diagnostic (5 root causes)
- [[summary-webrtc-integration]] — WebRTC integration guide
- [[summary-wallet-cto-report]] — Wallet CTO report
- [[summary-command-hub-wiring]] — Command Hub wiring + reconnection + build
- [[summary-live-room-fixes]] — iOS crash fixes + session management fixes
- [[summary-daily-co-integration]] — Daily.co live rooms integration spec

### Frontend & UX
- [[summary-mobile-pwa-rules]] — 13 mandatory mobile PWA rules
- [[summary-screen-registry]] — Screen registry + D1 compliance gaps
- [[summary-role-screen-matrix]] — Role hierarchy and screen counts
- [[summary-navigation-map]] — Entry points, role flows, cross-role overlays
- [[summary-apple-compliance]] — Apple 3.1.5 response + virtual currency brief
- [[summary-community-guide]] — Community features guide (9 sections)

### Product & Knowledge Base
- [[summary-knowledge-base-overview]] — 77-article knowledge base structure
- [[summary-maxina-manifesto]] — Maxina longevity manifesto

### Specs & Infrastructure
- [[summary-self-healing-spec]] — Self-healing system spec + test plan
- [[summary-stripe-connect]] — Stripe Connect frontend + backend specs
- [[summary-phase2-progress]] — Phase 2/2B/2C execution summaries

---

## Comparisons (2 pages)

- [[lovable-cdn-vs-cloud-run]] — Deployment migration: CDN vs Cloud Run
- [[platform-supabase-vs-lovable-supabase]] — Dual Supabase projects compared

---

## Syntheses (1 page)

- [[phase-2-evolution]] — Phase 2 → 2B → 2C: observation → governance → runtime

---

## Decisions (1 page)

- [[adr-repo-canonical-structure]] — ADR-001: dual-repo canonical structure

---

## Gaps (0 pages)

_No gaps documented yet. Run a health check to identify areas needing more coverage._
