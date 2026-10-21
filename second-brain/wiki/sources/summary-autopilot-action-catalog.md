# Summary: Autopilot Action Catalog

> Summary of the VITANA Autopilot Action Catalog (v1.1.0), the authoritative reference for all 169 Autopilot actions with detailed execution specifications, API mappings, screen references, risk classifications, and voice grammar.

## Content

### Document Purpose

This document (`AUTOPILOT_ACTION_CATALOG.md`) is the complete reference catalog of every Autopilot action. It provides the action overview table, detailed per-action definitions, module summaries, dependency mappings, risk classifications, and the Autopilot voice grammar.

### Catalog Structure

The catalog is organized into 9 sections:
1. Action Overview Table (all 169 actions)
2. Detailed Action Definitions (per-action specs)
3. Module Summaries
4. Dependency Mapping
5. Risk Classification Summary
6. Autopilot Voice Grammar
7. Appendix A: Action -> APIs Table
8. Appendix B: Action -> Screens Table
9. Appendix C: Orchestration Diagrams

### Action Count by Module

| Module | ID Prefix | Actions |
|--------|-----------|---------|
| Community | A*-COMM-* | 30 |
| Discover | A*-DISC-* | 23 |
| Health | A*-HLTH-* | 30 |
| Sharing | A*-SHAR-* | 22 |
| Wallet | A*-WALL-* | 20 |
| Business | A*-BIZ-* | 24 |
| AI | A*-AI-* | 17 |
| Memory | A*-MEM-* | 14 |
| Admin | A*-ADMN-* | 20 |
| Settings | A*-SETT-* | 15 |
| **Total** | | **169** |

### Action ID Format

Each action follows the pattern `A{level}-{MODULE}-{number}`:
- `A1-COMM-001` = Level 1 (Informational), Community module, action 001
- `A4-WALL-011` = Level 4 (High-Risk Transaction), Wallet module, action 011
- `A5-HLTH-028` = Level 5 (Multi-Step), Health module, action 028

### Per-Action Specification Fields

Each detailed action definition includes:
- **Name**, **Level**, **Module**, **Description**
- **Primary APIs Used**: Hooks, edge functions, RPC functions, external APIs
- **Screens Touched**: Screen IDs from the screen registry
- **Preconditions**: Required role, auth state, data prerequisites
- **Inputs/Outputs**: Parameter types and return shapes
- **Failure Modes**: Error scenarios
- **Tenant-Specific Behavior**: Which tenants support the action
- **Risk Level & Safety Rules**: Level-appropriate safeguards
- **Notes for AI Agents**: Guidance for when/how AI should invoke the action

### Risk Distribution

| Risk Level | Count | Description |
|------------|-------|-------------|
| Low | ~100 | A1 (read-only) and A2 (navigation) actions |
| Medium | ~30 | A3 (low-risk transactional) actions |
| High | ~30 | A4 (financial/PHI) actions |
| High (cumulative) | ~9 | A5 (multi-step workflow) actions |

### Key High-Risk Actions

Financial operations requiring Stripe integration:
- `A4-COMM-028`: Buy Event Ticket (Stripe checkout)
- `A4-DISC-021`: Checkout Cart (Stripe checkout session)
- `A4-DISC-022`: Request Refund
- `A4-WALL-011`: Transfer Credits
- `A4-WALL-012`: Exchange Currency
- `A4-WALL-015`: Top Up Balance
- `A4-WALL-016/017/018`: Subscription lifecycle

### Voice Grammar

The document includes a complete voice grammar specification for the VITANALAND Orb, mapping natural language patterns to specific actions (e.g., "Show my upcoming events" -> A1-COMM-001, "Buy this ticket" -> A4-COMM-028).

### Notable Observations

- Several Business module APIs are marked with "API placeholder" warnings, indicating the backend endpoints do not yet exist
- A5 orchestration actions are marked with "Orchestration placeholder" notes
- The catalog serves as a contract between the AI agent layer and the execution layer

## Related Pages

- [[autopilot-system]]
- [[autopilot]]
- [[recommendation-engine]]
- [[summary-autopilot-architecture]]
- [[summary-autopilot-capabilities]]

## Sources

- `raw/autopilot/AUTOPILOT_ACTION_CATALOG.md`

## Last Updated

2026-04-12
