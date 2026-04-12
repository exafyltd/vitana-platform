# Vitana System Overview

> Big-picture map of the Vitana engineering ecosystem, synthesized from 233 raw source documents into 95 wiki pages.

Last updated: 2026-04-12

---

## What Vitana Is

Vitana (branded **MAXINA - Longevity Community**) is a longevity-focused social platform combining health tracking, AI-powered recommendations, community features, live rooms, a wallet/payments system, and a marketplace. It serves community users, healthcare professionals, staff, and administrators across multiple tenants.

The platform is built as a [[multi-repo-architecture]] spanning two repositories and deploys to Google Cloud Run.

---

## System Architecture

```
                    ┌─────────────────────────────────────┐
                    │          Community Users             │
                    │    (Mobile PWA / Desktop Browser)    │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │         vitana-v1 (Frontend)         │
                    │   React 18 + Vite + TypeScript       │
                    │   551+ screens, 14 mobile surfaces   │
                    │   Cloud Run: community-app            │
                    └──────────────┬──────────────────────┘
                                   │ HTTPS
                    ┌──────────────▼──────────────────────┐
                    │      vitana-platform (Backend)       │
                    │   Express API Gateway (95+ routes)   │
                    │   + Command Hub (vanilla JS)         │
                    │   Cloud Run: gateway                  │
                    └───┬──────────┬──────────┬───────────┘
                        │          │          │
              ┌─────────▼──┐  ┌───▼────┐  ┌──▼──────────┐
              │  Supabase   │  │ Stripe │  │   Google     │
              │  (Dual)     │  │Connect │  │   Gemini     │
              │  Auth + DB  │  │Payments│  │   Live API   │
              └─────────────┘  └────────┘  └─────────────┘
```

### Frontend: [[vitana-v1]]
- **Stack:** React 18, Vite 5, TypeScript, Tailwind CSS, shadcn/ui
- **State:** Zustand + TanStack React Query v5
- **Routing:** React Router v6 (lazy-loaded)
- **Key patterns:** [[mobile-pwa-architecture]], [[role-based-access]], [[multi-tenancy]]
- **551+ screens** tracked in the [[screen-registry]]

### Backend: [[vitana-platform]]
- **Stack:** Express + TypeScript
- **95+ routes** through the [[api-gateway-pattern]]
- **110+ services** including [[autopilot-system]], [[wallet-system]], [[live-rooms]]
- **Command Hub:** [[command-hub]] operator dashboard (vanilla JS)

### Infrastructure
- **Deployment:** [[cloud-run-deployment]] with [[github-actions]] CI/CD
- **Auth:** [[dual-jwt-auth]] across [[supabase-platform]] and [[supabase-lovable]]
- **Database:** [[database-schema]] with [[additive-migration-pattern]]
- **Governance:** [[vtid-governance]] tracking all changes

---

## Core Product Domains

### AI & Automation
The [[autopilot-system]] is the intelligence layer. It uses a [[recommendation-engine]] (28 templates, 8 languages, daily scheduling) to suggest actions to users. The [[autopilot-automations]] cover 12 domains with 108 total automations. The system runs on [[autonomous-execution]] principles with CrewAI agents ([[crewai]]), a [[memory-indexer]], and [[cognee-integration]] for knowledge graphs.

**Key entities:** [[autopilot]], [[maxina-orb]], [[google-gemini]]

### Health & Longevity
The platform's [[longevity-philosophy]] (five health pillars) drives the [[health-tracking]] system (nutrition, hydration, exercise, sleep, mental wellness, biomarkers). The [[vitana-index]] scores users 0-999 across four zones. The [[memory-garden]] stores personal context (13 categories) that feeds back into AI recommendations.

**Key entities:** [[vitana-index-entity]], [[memory-garden]] (entity), [[home-dashboard]]

### Social & Community
[[matchmaking-system]] creates daily matches across 7 types (person, group, event, service, product, location, live room). [[live-rooms]] enable real-time video/audio via [[daily-co]] and [[webrtc-integration]]. Communication happens through [[sse-event-streaming]] and the [[gemini-live-api]].

### Commerce & Wallet
The [[wallet-system]] manages credits, cash, and VTN tokens. [[stripe-connect]] handles payments (90/10 split for creators). The [[discover-marketplace]] offers AI-curated supplements, doctors, and services. [[financial-longevity]] ties wellness engagement to economic rewards.

**Key entities:** [[stripe]], [[business-hub]]

### Operator Tools
The [[command-hub]] is the operator/developer dashboard. It shows live system status, manages deployments through the Publish workflow, and provides chat-based AI assistance. Built as vanilla JS served alongside the gateway.

---

## Governance & Process

All changes are tracked via [[vtid-governance]] (VTID task IDs). Specs follow [[spec-governance]] rules. The [[adr-repo-canonical-structure]] decision established the dual-repo pattern. Deployment flows through [[github-actions]] (AUTO-DEPLOY → EXEC-DEPLOY) with health checks and smoke tests.

The system is migrating from Lovable CDN to Cloud Run ([[lovable-cdn-vs-cloud-run]]) and consolidating dual Supabase projects ([[platform-supabase-vs-lovable-supabase]]).

---

## Evolution

The platform evolved through three phases ([[phase-2-evolution]]):
- **Phase 2A:** Observation layer — OASIS event system, telemetry
- **Phase 2B:** Governance layer — VTID enforcement, naming conventions, doc gates
- **Phase 2C:** Runtime fabric — Self-healing, autonomous execution, agent orchestration

---

## Key Numbers

| Metric | Count |
|--------|-------|
| Frontend screens | 551+ |
| Backend routes | 95+ |
| Backend services | 110+ |
| Supabase edge functions | 56 |
| Database tables (Platform) | 135+ |
| Database tables (Lovable) | 271 |
| Autopilot automations | 108 |
| Knowledge base articles | 77 |
| User roles | 5 |
| Tenants | 5 |
| Mobile surfaces | 14+7 overlays |
| Wiki pages | 95 |
| Raw source documents | 233 |

---

## How to Use This Wiki

1. **Start here** for the big picture
2. **Browse [[index]]** for the full page list by category
3. **Read concept pages** for deep understanding of any system
4. **Check entity pages** for what specific tools/services do
5. **Read source summaries** for quick overviews of raw documents
6. **Check comparisons** for tradeoff decisions
7. **Query across pages** using `[[wiki links]]` to navigate relationships
