# Summary: Database Schema

> Summary of the canonical DATABASE_SCHEMA.md document -- the single source of truth for all Vitana Platform table names, schemas, and API endpoints.

## Content

### Document: `raw/database/DATABASE_SCHEMA.md`

**Status**: Canonical Reference (last updated 2025-11-11, with additions through 2026-01-03)

This document is the **single source of truth** for table names in the Vitana Platform. All TypeScript code must reference exact table names from this file.

### Production Tables Documented

| Table | Domain | Purpose | Key Fields |
|-------|--------|---------|------------|
| `vtid_ledger` | Platform Core | VTID task tracking | `vtid TEXT PK`, `layer`, `module`, `status`, `metadata JSONB` |
| `oasis_events` | OASIS | System event log / audit trail | `id UUID PK`, `type`, `source`, `payload JSONB` |
| `personalization_audit` | Personalization | Cross-domain personalization decisions | `tenant_id`, `user_id`, `endpoint`, `snapshot JSONB` |
| `services_catalog` | Catalog | Services available to users | `tenant_id`, `service_type`, `topic_keys TEXT[]` |
| `products_catalog` | Catalog | Products available to users | `tenant_id`, `product_type`, `topic_keys TEXT[]` |
| `user_offers_memory` | Offers | User relationship to services/products | `tenant_id`, `user_id`, `target_type`, `state`, `trust_score` |
| `usage_outcomes` | Offers | User-stated outcomes | `tenant_id`, `user_id`, `outcome_type`, `perceived_impact` |
| `relationship_edges` | Graph | User relationships to entities | `tenant_id`, `user_id`, `relationship_type`, `strength` |
| `d44_predictive_signals` | D44 | Early intervention signals | `signal_type`, `confidence`, `user_impact`, `status` |
| `d44_signal_evidence` | D44 | Evidence for signals | `signal_id FK`, `evidence_type`, `weight` |
| `d44_intervention_history` | D44 | User actions on signals | `signal_id FK`, `action_type` |
| `contextual_opportunities` | D48 | Opportunity surfacing | `opportunity_type`, `confidence`, `why_now`, `priority_domain` |
| `risk_mitigations` | D49 | Health/lifestyle risk mitigation | `domain`, `confidence`, `suggested_adjustment`, `disclaimer` |

### Deprecated Tables

- `VtidLedger` (PascalCase) -- empty, do not use; use `vtid_ledger` instead.

### API Endpoints per Table

The document maps each table to its API endpoints (e.g., `vtid_ledger` is served by `POST /api/v1/vtid/create`, `GET /api/v1/vtid/:vtid`, etc.) and its consuming services (e.g., `services/gateway/src/routes/vtid.ts`).

### OASIS Events

Several tables emit OASIS events for observability (e.g., `d44.signal.detected`, `opportunity.surfaced`, `risk_mitigation.generated`).

### Visual Verification (VTID-01200)

The document also describes the `VisualVerificationResult` TypeScript data structure used for post-deploy visual testing, stored in `vtid_ledger.metadata.verification_result.visual_verification_result`.

### Hard Governance Patterns

Tables like `contextual_opportunities` and `risk_mitigations` have documented hard governance rules: user-benefit over monetization, no dark patterns, no medical claims, explainability mandatory, all outputs logged to OASIS.

## Related Pages

- [[database-schema]]
- [[supabase-platform]]
- [[additive-migration-pattern]]
- [[summary-platform-schema-inventory]]

## Sources

- `raw/database/DATABASE_SCHEMA.md`

## Last Updated

2026-04-12
