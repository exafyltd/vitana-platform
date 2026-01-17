# VTID-01185: Autopilot Recommendation Engine

## Overview

The Autopilot Recommendation Engine is an AI-powered service that analyzes the Vitana codebase, OASIS events, system health, and roadmap to generate actionable development recommendations. These recommendations populate the Autopilot popup in Command Hub (VTID-01180).

## Problem Statement

Currently, Autopilot recommendations are static seed data. For Autopilot to be truly useful, it needs to:
1. Understand the current state of the codebase
2. Identify gaps, technical debt, and improvement opportunities
3. Generate context-aware recommendations
4. Prioritize based on impact and effort
5. Avoid duplicate or stale recommendations

## Goals

1. **Dynamic Analysis** - Automatically scan codebase and system for improvement opportunities
2. **Context-Aware** - Generate recommendations relevant to Vitana Dev's architecture and patterns
3. **Prioritized** - Score recommendations by impact, effort, and risk
4. **Deduplicated** - Avoid suggesting work that's already in progress or completed
5. **Actionable** - Each recommendation includes enough detail to create a VTID spec

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Autopilot Recommendation Engine                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Codebase    │  │   OASIS      │  │   System     │              │
│  │  Analyzer    │  │   Analyzer   │  │   Health     │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                       │
│         └────────────┬────┴────────────────┘                       │
│                      ▼                                              │
│         ┌────────────────────────┐                                 │
│         │   Recommendation       │                                 │
│         │   Generator (Claude)   │                                 │
│         └───────────┬────────────┘                                 │
│                     ▼                                              │
│         ┌────────────────────────┐                                 │
│         │   Deduplication &      │                                 │
│         │   Scoring Engine       │                                 │
│         └───────────┬────────────┘                                 │
│                     ▼                                              │
│         ┌────────────────────────┐                                 │
│         │ autopilot_recommendations │                              │
│         │        (Supabase)      │                                 │
│         └────────────────────────┘                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Analysis Sources

### 1. Codebase Analyzer

Scans the repository for:

| Signal | Detection Method | Example Recommendation |
|--------|------------------|----------------------|
| TODO/FIXME comments | Regex scan `// TODO:`, `// FIXME:` | "Address TODO in worker-connector.ts:145" |
| Missing tests | Compare src/ files to test coverage | "Add unit tests for autopilot-event-loop.ts" |
| Large files | Files > 1000 lines | "Refactor app.js (17k lines) into modules" |
| Outdated dependencies | `npm outdated` analysis | "Update express from 4.18 to 4.21" |
| Security vulnerabilities | `npm audit` results | "Fix high-severity vulnerability in lodash" |
| Dead code | Unused exports/functions | "Remove unused function processLegacyTask()" |
| Missing documentation | Public APIs without JSDoc | "Document worker-connector API endpoints" |
| Code duplication | Similar code blocks | "Extract common validation logic to shared util" |

### 2. OASIS Event Analyzer

Analyzes operational events for patterns:

| Signal | Detection Method | Example Recommendation |
|--------|------------------|----------------------|
| Frequent errors | Error event clustering | "Fix recurring auth.token.expired errors (150/day)" |
| Slow endpoints | Response time > 2s | "Optimize /api/v1/vtid/list (avg 3.2s)" |
| Failed deployments | deploy.failed events | "Investigate deploy failures on gateway service" |
| Underused features | Low event counts | "Consider deprecating unused /api/v1/legacy/*" |
| Error spikes | Anomaly detection | "Investigate 5x error increase since last deploy" |

### 3. System Health Monitor

Checks infrastructure and configuration:

| Signal | Detection Method | Example Recommendation |
|--------|------------------|----------------------|
| Missing indexes | Slow query analysis | "Add index on vtid_ledger.status column" |
| Large tables | Row count > 1M | "Implement data archival for oasis_events" |
| Missing RLS | Tables without policies | "Add RLS policy to new_table" |
| Env var gaps | Missing required vars | "Add REDIS_URL to production config" |
| Stale migrations | Unapplied migrations | "Apply pending migration 20260118..." |

### 4. Roadmap & Spec Analyzer

Ingests existing planning artifacts:

| Source | Analysis | Example Recommendation |
|--------|----------|----------------------|
| docs/specs/*.md | Unimplemented specs | "Implement VTID-01150 (pending 30 days)" |
| GitHub Issues | Open feature requests | "Address issue #423: Add export to CSV" |
| VTID Ledger | Stalled tasks | "Unblock VTID-01123 (stuck in Planner 7 days)" |

## Recommendation Schema

Each generated recommendation includes:

```typescript
interface GeneratedRecommendation {
  // Display
  title: string;           // "Add unit tests for autopilot-event-loop.ts"
  summary: string;         // Detailed description with context
  domain: string;          // 'dev' | 'admin' | 'health' | 'infra' | 'security'

  // Scoring
  impact_score: number;    // 1-10, based on affected users/systems
  effort_score: number;    // 1-10, estimated implementation effort
  risk_level: string;      // 'low' | 'medium' | 'high' | 'critical'

  // Source tracking
  source_type: string;     // 'codebase' | 'oasis' | 'health' | 'roadmap'
  source_ref: string;      // File path, event ID, or spec reference

  // Deduplication
  fingerprint: string;     // Hash for dedup (e.g., sha256 of title+source_ref)

  // Spec generation hints
  suggested_files: string[];      // Files likely to be modified
  suggested_endpoints: string[];  // APIs likely to be added/changed
  suggested_tests: string[];      // Test types needed
}
```

## API Endpoints

### POST /api/v1/autopilot/recommendations/generate

Triggers recommendation generation (admin only).

```typescript
// Request
{
  sources?: string[];  // ['codebase', 'oasis', 'health', 'roadmap'] - default all
  limit?: number;      // Max recommendations to generate (default 20)
  force?: boolean;     // Regenerate even if recently run
}

// Response
{
  ok: true,
  generated: 15,
  skipped_duplicates: 3,
  run_id: "rec-gen-2026-01-17-001",
  duration_ms: 45000
}
```

### GET /api/v1/autopilot/recommendations/sources

Returns available analysis sources and their status.

```typescript
{
  ok: true,
  sources: [
    { type: 'codebase', status: 'ready', last_scan: '2026-01-17T10:00:00Z', files_scanned: 1523 },
    { type: 'oasis', status: 'ready', last_scan: '2026-01-17T12:00:00Z', events_analyzed: 50000 },
    { type: 'health', status: 'ready', last_scan: '2026-01-17T11:00:00Z', checks_run: 45 },
    { type: 'roadmap', status: 'ready', last_scan: '2026-01-17T09:00:00Z', specs_found: 23 }
  ]
}
```

### GET /api/v1/autopilot/recommendations/history

Returns generation history.

```typescript
{
  ok: true,
  runs: [
    { run_id: "rec-gen-2026-01-17-001", timestamp: "...", generated: 15, duration_ms: 45000 },
    { run_id: "rec-gen-2026-01-16-001", timestamp: "...", generated: 8, duration_ms: 32000 }
  ]
}
```

## Scheduled Generation

The engine runs automatically:

| Schedule | Scope | Purpose |
|----------|-------|---------|
| Every 6 hours | OASIS events | Catch emerging issues quickly |
| Daily (2 AM UTC) | Full codebase scan | Comprehensive analysis |
| On PR merge to main | Changed files only | Immediate feedback |
| Manual trigger | Configurable | On-demand deep analysis |

## Implementation Plan

### Phase 1: Codebase Analyzer (MVP)
- [ ] TODO/FIXME scanner
- [ ] Large file detector
- [ ] Missing test coverage analyzer
- [ ] Recommendation generator with Claude
- [ ] Deduplication engine
- [ ] Manual trigger endpoint

### Phase 2: OASIS Integration
- [ ] Error pattern analyzer
- [ ] Performance bottleneck detector
- [ ] Event anomaly detection
- [ ] Real-time alerting for critical issues

### Phase 3: System Health
- [ ] Database health checks
- [ ] Migration status tracker
- [ ] Dependency audit integration
- [ ] Security vulnerability scanner

### Phase 4: Roadmap Integration
- [ ] Spec file parser
- [ ] GitHub Issues sync
- [ ] VTID Ledger stale task detection
- [ ] Priority scoring based on roadmap

## Database Schema Additions

```sql
-- Track generation runs
CREATE TABLE autopilot_recommendation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT UNIQUE NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'running', -- running, completed, failed
  sources TEXT[] DEFAULT '{}',
  recommendations_generated INTEGER DEFAULT 0,
  duplicates_skipped INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  duration_ms INTEGER
);

-- Add source tracking to recommendations
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE autopilot_recommendations ADD COLUMN IF NOT EXISTS run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_fingerprint
  ON autopilot_recommendations(fingerprint) WHERE fingerprint IS NOT NULL;
```

## Claude Prompt Template

```
You are the Vitana Autopilot Recommendation Engine. Analyze the following signals and generate actionable development recommendations.

## Context
- Platform: Vitana Dev (health/longevity SaaS platform)
- Stack: TypeScript, Express, Supabase, React (vanilla JS frontend)
- Architecture: Monorepo with gateway service, OASIS event system, VTID task tracking

## Analysis Input
{analysis_data}

## Requirements
1. Generate 5-10 recommendations based on the analysis
2. Each recommendation must be specific and actionable
3. Include file paths and code references where applicable
4. Score impact (1-10) based on user/system benefit
5. Score effort (1-10) based on implementation complexity
6. Assign risk level based on potential for breaking changes
7. Avoid recommendations for work already in progress (check VTID ledger)

## Output Format
Return JSON array of recommendations matching the GeneratedRecommendation schema.
```

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Recommendation relevance | >80% useful | User accept rate |
| Duplicate rate | <5% | Fingerprint collisions |
| Generation time | <60s | End-to-end latency |
| Coverage | 4 sources | All analyzers active |
| Freshness | <24h | Time since last scan |

## Security Considerations

1. **Admin-only generation** - Only admins can trigger generation
2. **Rate limiting** - Max 1 generation per hour per source
3. **Audit logging** - All generations logged to OASIS
4. **Sensitive data** - No secrets or PII in recommendations
5. **Code access** - Analyzer runs in sandboxed environment

## Dependencies

- VTID-01180: Autopilot Recommendations API (complete)
- VTID-01179: Autopilot Event Loop (complete)
- Claude API access for recommendation generation
- GitHub API for repository analysis

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Noisy recommendations | User fatigue | Strict dedup + quality scoring |
| Stale recommendations | Wasted effort | Auto-expire after 30 days |
| False positives | Trust erosion | Human review option + feedback loop |
| High API costs | Budget overrun | Caching + rate limiting |

## Open Questions

1. Should recommendations auto-expire or require manual dismissal?
2. How to handle recommendations that span multiple VTIDs?
3. Should users be able to request recommendations for specific areas?
4. Integration with external tools (Jira, Linear, etc.)?

---

**VTID:** 01185
**Status:** Specified
**Owner:** Autopilot Team
**Created:** 2026-01-17
**Target:** Phase 1 MVP within 2 sprints
