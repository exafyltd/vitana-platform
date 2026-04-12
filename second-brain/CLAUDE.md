# Vitana Second Brain — Rules & Instructions

## What This Is

A Karpathy-style second brain for the Vitana engineering ecosystem. Three layers:
- **`raw/`** — Immutable source documents (233 files from vitana-v1 and vitana-platform)
- **`wiki/`** — AI-maintained structured markdown knowledge base with cross-links
- **Outputs** — Answers, syntheses, and decisions generated from querying the wiki

## Absolute Rules

### Never violate these:
1. **NEVER edit, rename, move, or delete files in `raw/`** — it is the immutable source of truth
2. **ALL wiki writes go in `wiki/` only** — create, update, and delete pages exclusively in `wiki/`
3. **Every wiki page must cite its raw sources** — use `Source: raw/path/to/file.md` references so claims are traceable
4. **Use Obsidian-style `[[wiki links]]`** between related wiki pages for backlink navigation
5. **Update `wiki/index.md` and `wiki/log.md` after every ingest or major edit**

## Wiki Page Types

### `wiki/concepts/`
Ideas, frameworks, architectural patterns, design principles.
Example: `multi-tenancy.md`, `dual-jwt-auth.md`, `autopilot-recommendation-engine.md`

### `wiki/entities/`
People, tools, companies, APIs, services, Cloud Run services, Supabase projects.
Example: `supabase.md`, `cloud-run-gateway.md`, `command-hub.md`, `maxina-orb.md`

### `wiki/sources/`
One-page summaries of individual raw files or clusters of related raw files.
Example: `summary-autopilot-architecture.md`, `summary-database-schema.md`

### `wiki/comparisons/`
Side-by-side analyses, tradeoff matrices, "X vs Y" pages.
Example: `lovable-cdn-vs-cloud-run.md`, `supabase-auth-vs-platform-auth.md`

### `wiki/syntheses/`
Cross-cutting analyses that combine multiple wiki pages into a higher-level insight.
Example: `full-stack-deploy-flow.md`, `data-flow-user-to-recommendation.md`

### `wiki/decisions/`
Architecture Decision Records derived from raw sources and wiki analysis.
Example: `adr-repo-canonical-structure.md`, `adr-dual-supabase-strategy.md`

### `wiki/gaps/`
Known unknowns — areas where raw sources are thin or contradictory.
Example: `gap-e2e-test-coverage.md`, `gap-token-staking-implementation.md`

### Top-level wiki files:
- **`wiki/index.md`** — Master index of all wiki pages, grouped by type
- **`wiki/overview.md`** — Big-picture map of the Vitana system (updated after each ingest)
- **`wiki/log.md`** — Chronological log of all ingest and edit operations

## Page Template

Every wiki page should follow this structure:

```markdown
# Page Title

> One-line summary of what this page covers.

## Content

[Main body — structured prose, bullet points, tables as appropriate]

## Related Pages

- [[related-concept-1]]
- [[related-entity-1]]
- [[related-comparison-1]]

## Sources

- `raw/architecture/vitana-platform-CLAUDE.md`
- `raw/database/DATABASE_SCHEMA.md`

## Last Updated

YYYY-MM-DD
```

## Raw Source Organization

```
raw/
├── architecture/       # Root CLAUDE.md files, API inventory, Dev Hub
├── auth/               # Canonical identity, Lovable adapter, auth guardrails
├── agents/             # CrewAI, memory indexer, orchestrator READMEs
├── autonomy/           # Autonomous architecture, Cognee integration
├── autopilot/          # Autopilot architecture, capabilities, action catalog
│   └── autopilot-automations/  # 12 automation domain docs
├── command-hub/        # Wiring, reconnection, build docs
├── communication/      # SSE diagnostics, WebRTC, Gemini Live API
├── compliance/         # Apple review, virtual currency architecture
├── database/           # Schema, migration rules, platform inventory
├── deployment/         # GitHub Actions deploy, Cloud Run cleanup, recovery
├── design-system/      # UI patterns, emoji mapping, horizontal lists
├── governance/         # VTID system, branching, ADRs, CEO handover
├── guides/             # Community guide, AI business hub guidance
├── knowledge-base/     # Full product KB (77 user-facing articles)
├── live-rooms/         # iOS fixes, session fixes
├── mobile-pwa/         # PWA rules, screen inventory, wireframes, reorientation
├── phase-summaries/    # Phase 2/2B/2C execution summaries
├── reports/            # Technical reports
├── screen-registry/    # Navigation map, screen registry, role matrix
├── specs/              # VTID specs, self-healing, Stripe, live rooms
│   ├── governance/     # Spec templates, rules, validator
│   ├── verification/   # Lovable handoff, master code pack
│   └── vtids/          # VTID implementation docs
└── wallet/             # CTO wallet report
```

## Ingest Workflow

When running an ingest (processing new raw files into wiki pages):

1. **Scan** `raw/` for new or updated files since last ingest
2. **DO NOT modify** anything in `raw/`
3. For each source file, create or update:
   - A **source summary** in `wiki/sources/`
   - Relevant **concept pages** in `wiki/concepts/`
   - Relevant **entity pages** in `wiki/entities/`
   - **Comparison pages** in `wiki/comparisons/` where useful tradeoffs exist
4. Add `[[wiki links]]` between all related pages (bidirectional where possible)
5. Add `Source: raw/path/file.md` references to every page
6. Update `wiki/index.md` with any new pages
7. Update `wiki/overview.md` if the big picture changed
8. Append to `wiki/log.md` with date, files processed, pages created/updated

## Query Workflow

When answering questions from the wiki:

1. **Search `wiki/` first** — it is the distilled, cross-linked knowledge layer
2. **Pull from `raw/` only** when the wiki is missing evidence or needs updating
3. If the answer produces durable insight, **save it** as a synthesis or decision page
4. If the answer reveals a gap, **note it** in `wiki/gaps/`

## Health Check

Periodically audit the wiki for:
- Duplicate or overlapping pages (merge them)
- Broken or missing `[[wiki links]]`
- Pages lacking source references
- Outdated summaries that no longer match raw sources
- Concepts that are too broad (split) or too narrow (merge)
- Important gaps suggested by raw sources but not covered in wiki

## Domain Scope

This second brain covers the **Vitana engineering ecosystem**:
- **vitana-v1**: React/Vite SPA frontend (551+ screens, community app)
- **vitana-platform**: Express API gateway (95+ routes, 110+ services)
- **Supabase**: Dual-project auth and database
- **Cloud Run**: Deployment target for both services
- **Autopilot**: AI recommendation engine and automations
- **Live Rooms**: Real-time communication (WebRTC, Daily.co)
- **Wallet**: Credits, tokens, subscriptions, payments
- **Command Hub**: Operator/developer dashboard
- **Mobile PWA**: Mobile-first progressive web app
- **Knowledge Base**: User-facing product documentation (77 articles)
- **Governance**: VTID tracking, spec templates, deployment guardrails
