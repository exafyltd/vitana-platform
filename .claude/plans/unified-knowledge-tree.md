---
slug: unified-knowledge-tree
title: Unified Knowledge Tree — organize Vitana docs across Command Hub & Tenant KB
started: 2026-04-23
branch: feat/unified-knowledge-tree (vitana-platform) + feat/unified-knowledge-tree-v1 (vitana-v1)
---

# Unified Knowledge Tree

## Problem

Three overlapping surfaces today:
- **Command Hub Docs** (`/command-hub/docs/*`) — operator/developer system catalog (Screens, APIs, Schemas, Architecture, Workforce).
- **Tenant Knowledge → Documents** (`/admin/knowledge/documents`) — baseline + tenant RAG docs (`kb_documents`).
- **Tenant Knowledge → System KB** (`/admin/knowledge/system-kb`) — system-wide RAG (`knowledge_docs`), added in PR #852 as a parallel sibling tab.

Two separate Knowledge tabs (Documents + System KB) that look the same but hit different tables confuses admins. No operator-facing view of what the Assistant knows about itself.

## Two surfaces, clear scope

| Surface | URL | Audience | Content class | Source |
|---|---|---|---|---|
| Command Hub Docs | `/command-hub/docs/*` | Exafy staff, operators, devs | **System catalog** (what the platform *is*) | Live registries + `knowledge_docs` (read-only) |
| Tenant Knowledge | `/admin/knowledge/*` | Tenant admins (+ Exafy admins for system scope) | **Brain knowledge** (what the Assistant retrieves) | `knowledge_docs` + `kb_documents` |

Do not merge them. Catalog ≠ knowledge. Cross-link instead.

## Phases

### Phase 1 — Tenant KB: Documents tab becomes a unified tree (vitana-v1 + vitana-platform)

**Drop** the standalone `SystemKB.tsx` tab. Its view folds into Documents scope 1.

**Tree (three scopes, auto-grouped)**:
```
📖 Vitana Platform        (knowledge_docs, namespace=vitana_system) — exafy-admin editable
    └── auto-grouped by path hierarchy (kb/vitana-system/<area>/*)
📚 Baseline Library       (kb_documents WHERE tenant_id IS NULL) — exafy-admin editable, tenant can opt out
    └── auto-grouped by first topic tag
🏢 Your Tenant Docs       (kb_documents WHERE tenant_id = current) — tenant-admin editable
    └── auto-grouped by first topic tag
```

**New gateway endpoint**: `GET /api/v1/admin/tenants/:tenantId/kb/unified-tree`
Returns `{ system: TreeNode[], baseline: TreeNode[], tenant: TreeNode[] }`. Each `TreeNode` is `{ id, title, path, source: 'system'|'baseline'|'tenant', status, topics[], lastUpdated, opted_out? }`.

**UI**: tree (left) + viewer (right) + global search (scoped to this surface only — Q2 answer: "no", don't bleed into Command Hub registries).

**Baseline-edit safeguard (Q3 answer: yes)**: when exafy admin edits a baseline or system doc, show a confirm modal: "This document is shared across all tenants. Changes apply immediately everywhere."

**Files to touch**:
- *vitana-v1*: `src/pages/admin/knowledge/Documents.tsx` (rewrite), delete `SystemKB.tsx`, `src/config/admin-navigation.ts` (remove system-kb tab entry), `src/hooks/useAdminKnowledge.ts` (+ new `useUnifiedKbTree`)
- *vitana-platform*: `services/gateway/src/routes/tenant-admin/knowledge.ts` (new `/unified-tree` handler), possibly proxy to existing `admin-system-kb.ts` data

### Phase 2 — Command Hub: System Knowledge tab (Q1 answer: yes)

New sibling tab in Command Hub Docs, read-only mirror of `knowledge_docs` (`vitana_system` namespace). Reuses the same unified-tree endpoint filtered to the system scope.

**Files to touch**:
- `services/gateway/src/frontend/command-hub/app.js` — extend docs nav (`2786–2817`) and add `renderDocsSystemKnowledgeView` next to `renderDocsScreensView`

### Phase 3 — Cross-links

- Command Hub System Knowledge doc viewer → "Edit in tenant KB" link (exafy admins only) → `/admin/knowledge/documents?doc=<id>`.
- Tenant KB Vitana Platform scope doc viewer → "View in Command Hub" link for exafy admins.

### Phase 4 (parked) — Command Hub `/docs/screens/` network error

Screens tab shows "Error: Network response was not ok" in the screenshot. Separate follow-up ticket — endpoint diagnosis needed. Not in this PR.

## Open decisions (answered)

1. System Knowledge tab in Command Hub? **Yes.**
2. Global search crosses into Command Hub registries? **No.**
3. Baseline/system edits show "affects all tenants" warning? **Yes.**

## Rollout

- Commit to feature branches in both repos.
- Test locally (gateway build + vitana-v1 build + manual click-through).
- Open PRs in both repos.
- Merge vitana-platform first (endpoint must exist when UI ships).
- Merge vitana-v1.
- Verify on vitanaland.com (vitana-v1 → Cloud Run `community-app`) and on gateway Cloud Run URL.

## Out of scope

- No schema changes. Both tables exist.
- No ingestion changes. Same upload paths.
- No changes to Topics / Indexing / Search Test / Governance sibling tabs.
- No redesign of Command Hub Docs sub-tabs other than adding System Knowledge.
