# Summary: Autopilot Architecture

> Summary of the Autopilot System Architecture document, which defines the scalable, AI-powered proactive action engine integrating across all Vitana features.

## Content

### Document Purpose

This document (`AUTOPILOT_ARCHITECTURE.md`) is the primary architecture specification for the Autopilot system. It covers the database schema, action registry, execution engine, AI suggestion engine, frontend integration, and development roadmap.

### Key Architectural Decisions

1. **Template-driven design** -- All actions derive from reusable `autopilot_action_templates` with parameterized titles, trigger conditions, and execution handlers. This allows scaling to hundreds of actions without per-action custom code.

2. **Supabase Edge Functions for execution** -- The execution engine (`autopilot-execute`) runs as a Deno edge function with a handler registry pattern. Each handler follows validate -> execute -> reward -> return.

3. **AI-powered suggestion generation** -- The `autopilot-suggest` edge function uses Gemini 2.5 Flash (via Lovable AI gateway) to personalize which templates apply to each user, with structured tool calling for type-safe output.

4. **Hourly cron for suggestions** -- A Postgres `cron.schedule` job triggers the suggestion engine every hour for active users.

5. **Real-time frontend** -- The `useAutopilot()` React hook subscribes to `postgres_changes` on the `autopilot_actions` table for live updates.

### Database Schema (5 tables)

- **`autopilot_action_templates`** -- Blueprints with template_code, category, title/reason templates, trigger conditions (JSONB), execution handler, required context
- **`autopilot_actions`** -- User instances with status lifecycle (pending/executing/completed/skipped/failed), execution data, scheduling, expiry, analytics
- **`autopilot_execution_logs`** -- Execution audit trail (status, error, duration, result data)
- **`autopilot_feedback`** -- User feedback loop (completed/skipped/dismissed/helpful/not_helpful)
- **`autopilot_trigger_logs`** -- Trigger debugging history

### Performance Indexes

Five targeted indexes covering: user+status (pending actions), template lookups, category filtering, scheduled actions, and expired action cleanup.

### Integration Points

The document defines handler stubs for Community (post, reply), Wallet (send vitana, suggest exchange), Calendar (schedule event), and Health (log supplement) integrations.

### Development Phases

- Phase 1: Foundation (database + execution engine + 10 templates)
- Phase 2: AI Integration (suggestion engine + context gathering + feedback)
- Phase 3: Scaling (template management UI + 50+ templates + analytics)
- Phase 4: Intelligence (behavioral learning + predictive timing + optimization)

### What This Document Does NOT Cover

- The 12 automation domains (covered in autopilot-automations/)
- The 169-action catalog (covered in AUTOPILOT_ACTION_CATALOG.md)
- Capability classification levels A1-A5 (covered in AUTOPILOT_CAPABILITIES.md)
- Autonomous agent architecture (covered in autonomy/ docs)

## Related Pages

- [[autopilot-system]]
- [[autopilot]]
- [[recommendation-engine]]
- [[summary-autopilot-capabilities]]
- [[summary-autopilot-action-catalog]]

## Sources

- `raw/autopilot/AUTOPILOT_ARCHITECTURE.md`

## Last Updated

2026-04-12
