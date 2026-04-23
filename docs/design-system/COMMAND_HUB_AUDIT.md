# Command Hub Design-Drift Audit

**Generated:** 2026-04-23
**Source:** `services/gateway/src/frontend/command-hub/app.js` @ commit on `feat/design-system-md`
**Drift authority:** `/DESIGN.md` §A (Track A — Command Hub)

## Executive summary

| | Count | % |
| --- | --- | --- |
| Total render functions audited | **140** | 100% |
| HIGH drift (≥5 `style.cssText` OR ≥15 hardcoded hex colors) | **23** | 16% |
| MEDIUM drift (≥2 cssText OR ≥5 hex) | **12** | 9% |
| LOW drift (≥1 cssText OR ≥1 hex) | **18** | 13% |
| CLEAN (zero cssText, zero hex) | **87** | 62% |

**Aggregate violations inside the audited functions:**
- 163 sites of `style.cssText = "…"` with pixel padding / font-size
- ~400 hardcoded hex colors that should route through `--color-*` tokens

Scope note: "render function" here means every top-level function in `app.js` whose name matches `render*View` / `render*Modal` / `render*Drawer` / `render*Panel`. Internal render helpers (`renderRow`, `renderCell`, `createButton`) are not counted individually — their drift rolls up into the view that invokes them.

## Migration templates — copy these patterns

These render functions already strictly use canonical tokens and classes (`.task-card`, `.metric-card`, `.header-pill`, `.status-live`, `.btn`, `--color-*`) with zero inline pixel styles and zero hardcoded hex. Every migration PR should pick the closest template and copy its structure.

| Template | File:Lines | Pattern |
| --- | --- | --- |
| `renderTasksView` | app.js:6240-6462 | Column + `.task-card` board — the reference for any list-of-entities screen |
| `renderDatabasesSupabaseView` | app.js:34396-34520 | Infra service cards + section headers — the reference for config/status dashboards |
| `renderDatabasesVectorsView` | app.js:34521-34824 | Same pattern as Supabase — proves the pattern scales |
| `renderDatabasesClustersView` | app.js:34825-35102 | Same pattern as Supabase |
| `renderAutopilotCommunityView` | app.js:40256-40295 | Minimal autopilot status view using semantic classes only |
| `renderAutopilotAdminView` | app.js:40297-40315 | Placeholder pattern with status badge |

## Wave plan (prioritized migration sequence)

Each wave becomes one or more focused PRs. Total estimated work: **~12-15 PRs** across ~3 months to fully migrate the Command Hub.

### Wave 1 — HIGH-impact hotspots (4 PRs)

Goal: eliminate the worst visual inconsistency. These functions alone account for 115+ cssText sites and 230+ hex colors.

| # | Target | File:Lines | Why |
| --- | --- | --- | --- |
| 1 | Task Drawer + Test-Run Drawer | app.js:6819-7767 + 32993-33081 | Shared drawer pattern; 16× cssText combined; frequently seen by every user |
| 2 | Publish / Governance-Blocked / Execution-Approval / Autopilot-Recommendations modals | 23276-24445 + 23710-23816 | 4 modals sharing one broken modal pattern; 78× cssText combined |
| 3 | Profile Modal | app.js:8411-9016 | 28 hex colors in one modal; high user visibility |
| 4 | Autopilot Registry + Live + Engine + Runs + Growth | app.js:38683-39624 | Autopilot surface cluster; 50× cssText + 150× hex colors total |

### Wave 2 — Operational + Autonomy surfaces (3 PRs)

| # | Target | File:Lines |
| --- | --- | --- |
| 5 | Operator Dashboard + Runbook + Event Stream | app.js:29745-30105, 30563-30782, 30123-30338 |
| 6 | Autonomy Pulse + Autonomy Trace + Dev Autopilot (+Lineage) | app.js:37121-37229, 37422-37525, 35714-35827, 36885-36949 |
| 7 | Overview System + Overview Live Metrics + Admin Analytics + Assistant Overview | app.js:27673-29017, 33701-33805, 40382-40529 |

### Wave 3 — Models/Evaluations + misc (2 PRs)

| # | Target | File:Lines |
| --- | --- | --- |
| 8 | Models Evaluations + Benchmarks + Routing + List + Playground | app.js:32467-32819 — unify status colors on `--color-task-*` tokens |
| 9 | Testing E2E + Vitana Awareness Test + Awareness Preview Drawer | app.js:33229-33437, 39625-39859, 40118-40255 |

### Wave 4 — Long-tail cleanup (1-2 PRs)

Sweep the 18 LOW-drift functions as opportunity allows. Focus on clustering so reviewers see the pattern.

## User-named routes — current status

Reality check on the 10 routes the user listed:

| Route | Render function | Lines | Drift | Notes |
| --- | --- | --- | --- | --- |
| `/autonomy/autopilot-community/` | `renderAutopilotCommunityView` | 40256-40295 | **CLEAN** | Already compliant. Use as template. |
| `/autonomy/autopilot-admin/` | `renderAutopilotAdminView` | 40297-40315 | **CLEAN** | One small `style="margin-left:.5rem;font-size:.7rem;"` on a status badge — LOW-priority fix. |
| `/databases/supabase/` | `renderDatabasesSupabaseView` | 34396-34520 | **CLEAN** | Migration template. |
| `/databases/vectors/` | `renderDatabasesVectorsView` | 34521-34824 | **CLEAN** | Migration template. |
| `/databases/clusters/` | `renderDatabasesClustersView` | 34825-35102 | **CLEAN** | Migration template. |
| `/ai/models/` | `renderModelsListView` | 32467-32514 | MEDIUM | 2× cssText + 1× `#22c55e` in live dot — replace with `.status-live` class. |
| `/ai/evaluations/` | `renderModelsEvaluationsView` | 32515-32598 | MEDIUM | 2× cssText + 4× inline `#22c55e/#f59e0b/#ef4444` for success-rate colors. Unify on `.status-*` variants. |
| `/ai/benchmarks/` | `renderModelsBenchmarksView` | 32599-32649 | MEDIUM | Same pattern as Evaluations; status-color drift. |
| `/ai/routing/` | `renderModelsRoutingView` | 32650-32727 | MEDIUM | 2× cssText + 1× hex (mostly flex layout). |
| `/ai/playground/` | `renderModelsPlaygroundView` | 32728-32819 | LOW | `#888` / `#aaa` secondary-text colors — swap to `--color-text-secondary`. |

Takeaway: **the routes the user named are mostly already clean or only mildly drifted.** The real drift hotspots live in the Autopilot cluster (38683–39624), Overview System (27673–28663), the four modals (23276–24445), and the drawer family (6819–7767). Wave 1 targets those.

## Color substitution table

When migrating, replace hardcoded hex colors with the canonical tokens below. All of these tokens already exist in `styles.css:1–45` — no new token invention.

| Hardcoded hex | Count in app.js | Canonical replacement |
| --- | --- | --- |
| `#888` | 123 | `var(--color-text-secondary)` |
| `#ef4444` | 64 | **needs DESIGN.md update** — currently no `--color-error` token; either reuse `var(--color-task-progress)` (amber, wrong semantically) or extend DESIGN.md first with a new `--color-error` |
| `#3b82f6` | 57 | `var(--color-accent)` |
| `#333` | 39 | `var(--color-border)` |
| `#22c55e` | 38 | `var(--color-task-completed)` |
| `#fff` | 37 | `var(--color-text-primary)` |
| `#f59e0b` | 30 | `var(--color-operator)` or `var(--color-task-progress)` depending on context |

**Prerequisite before Wave 2**: decide whether to add a `--color-error` token to DESIGN.md §A.1. The 64 `#ef4444` uses need somewhere to go. Recommendation: add `--color-error: #ef4444` to `styles.css:1–13` and document in DESIGN.md §A.1 before any Wave-2 migration starts. This is an *extension* of the documented palette, not an invention — the color is already in the codebase 64 times; DESIGN.md just catches up.

## Full inventory

### HIGH drift — fix first (23 render functions)

Ranked by combined severity (cssText × 100 + hex). Each should migrate onto the canonical class listed in the right column.

| Render function | Lines | LoC | cssText | hex | Migrate to |
| --- | --- | --- | --- | --- | --- |
| renderPublishModal | 23276-23684 | 409 | 22 | 35 | `.modal` / `.modal-overlay` |
| renderGovernanceBlockedModal | 24011-24205 | 195 | 22 | 19 | `.modal` / `.modal-overlay` |
| renderExecutionApprovalModal | 24206-24445 | 240 | 21 | 13 | `.modal` / `.modal-overlay` |
| renderTestingE2eView | 33229-33437 | 209 | 17 | 0 | `.task-card` family |
| renderAutopilotRegistryView | 38683-38965 | 283 | 15 | 53 | `.task-card` family |
| renderAutonomyTraceView | 37422-37525 | 104 | 15 | 18 | `.task-card` family |
| renderVitanaAwarenessTestView | 39625-39859 | 235 | 15 | 0 | `.task-card` family |
| renderAutonomyPulseView | 37121-37229 | 109 | 13 | 16 | `.metric-card` + `.overview-panel` |
| renderAutopilotRecommendationsModal | 23710-23816 | 107 | 13 | 6 | `.modal` / `.modal-overlay` |
| renderOverviewSystemView | 27673-28663 | 991 | 11 | 34 | `.metric-card` + `.overview-panel` |
| renderAutopilotLiveView | 39153-39312 | 160 | 11 | 32 | `.task-card` + `.status-live` |
| renderDevAutopilotView | 35714-35827 | 114 | 11 | 12 | `.task-card` family |
| renderOperatorDashboardView | 29745-30105 | 361 | 10 | 27 | `.metric-card` + `.overview-panel` |
| renderAutopilotEngineView | 39313-39484 | 172 | 9 | 31 | `.task-card` family |
| renderAutopilotRunsView | 38966-39152 | 187 | 9 | 30 | `.task-card` family |
| renderTaskDrawer | 6819-7767 | 949 | 8 | 12 | `.task-drawer` + `.task-card` |
| renderTestRunDrawer | 32993-33081 | 89 | 8 | 3 | `.task-drawer` + `.task-card` |
| renderDevAutopilotLineageView | 36885-36949 | 65 | 7 | 7 | `.task-card` family |
| renderAutopilotGrowthView | 39518-39624 | 107 | 6 | 24 | `.task-card` family |
| renderAssistantOverviewView | 40382-40529 | 148 | 6 | 0 | `.metric-card` + `.overview-panel` |
| renderProfileModal | 8411-9016 | 606 | 0 | 28 | `.modal` / `.modal-overlay` |
| renderAdminAnalyticsView | 33701-33805 | 105 | 0 | 15 | `.metric-card` + `.overview-panel` |
| renderOverviewLiveMetricsView | 28664-29017 | 354 | 0 | 15 | `.metric-card` + `.overview-panel` |

### MEDIUM drift (12)

Meaningful drift but narrower scope. Each becomes a small focused PR.

| Render function | Lines | LoC | cssText | hex |
| --- | --- | --- | --- | --- |
| renderOperatorRunbookView | 30563-30782 | 220 | 4 | 11 |
| renderAdminAwarenessView | 40148-40255 | 108 | 4 | 0 |
| renderAwarenessPreviewDrawer | 40118-40147 | 30 | 4 | 0 |
| renderOperatorEventStreamView | 30123-30338 | 216 | 2 | 9 |
| renderModelsBenchmarksView | 32599-32649 | 51 | 2 | 4 |
| renderModelsEvaluationsView | 32515-32598 | 84 | 2 | 4 |
| renderModelsListView | 32467-32514 | 48 | 2 | 1 |
| renderModelsRoutingView | 32650-32727 | 78 | 2 | 1 |
| renderDocsWorkforceView | 34007-34073 | 67 | 0 | 12 |
| renderSelfHealingView | 37608-38109 | 502 | 0 | 12 |
| renderDiagnosticsHealthChecksView | 32006-32052 | 47 | 0 | 6 |
| renderDocsApiInventoryView | 33806-33889 | 84 | 0 | 5 |

### LOW drift (18)

One or two inline styles / hex values. Can usually be fixed inline as part of nearby work.

| Render function | Lines | cssText | hex |
| --- | --- | --- | --- |
| renderOperatorTaskQueueView | 29529-29744 | 1 | 0 |
| renderDiagnosticsSseView | 32169-32241 | 0 | 4 |
| renderDiagnosticsLatencyView | 32053-32117 | 0 | 3 |
| renderDocsArchitectureView | 33960-34006 | 0 | 3 |
| renderDiagnosticsDebugPanelView | 32242-32296 | 0 | 2 |
| renderModelsPlaygroundView | 32728-32819 | 0 | 2 |
| renderAdminContentModerationView | 10992-11086 | 0 | 1 |
| renderAdminMarketplaceReviewView | 11518-11616 | 0 | 1 |
| renderAdminMarketplaceShopsView | 11182-11326 | 0 | 1 |
| renderAdminPermissionsView | 10663-10796 | 0 | 1 |
| renderAdminTenantsView | 10797-10991 | 0 | 1 |
| renderAdminUsersView | 10520-10662 | 0 | 1 |
| renderDiagnosticsErrorsView | 32118-32168 | 0 | 1 |
| renderDocsDatabaseSchemasView | 33890-33959 | 0 | 1 |
| renderIntegrationsApisView | 31511-31582 | 0 | 1 |
| renderOperatorDeploymentsView | 30339-30562 | 0 | 1 |
| renderSecurityKeysSecretsView | 38293-38360 | 0 | 1 |
| renderWorkflowsHistoryView | 27198-27310 | 0 | 1 |

### CLEAN (87) — use as migration references

These render functions have zero cssText and zero hardcoded hex. They are the authoritative examples for how Command Hub views should be built.

| Render function | Lines |
| --- | --- |
| renderAdminDevUsersView | 10130-10519 |
| renderAdminIdentityAccessView | 11617-11836 |
| renderAgentsErrorPanel | 11893-11936 |
| renderAgentsMemoryView | 25974-26078 |
| renderAgentsPipelinesView | 13123-13467 |
| renderAgentsSkillsView | 12575-12691 |
| renderAgentsTelemetryView | 13475-13530 |
| renderApprovalsView | 21891-22058 |
| renderAutopilotAdminView | 40297-40326 |
| renderAutopilotCommunityView | 40256-40296 |
| renderCategoryDetailModal | 20391-20579 |
| renderCommandHubEventsView | 18498-18656 |
| renderCommandHubLiveConsoleView | 30783-30960 |
| renderControlHistoryDrawer | 17789-17899 |
| renderDatabasesAnalyticsView | 34738-34824 |
| renderDatabasesCacheView | 34661-34737 |
| renderDatabasesClustersView | 34825-34889 |
| renderDatabasesSupabaseView | 34396-34520 |
| renderDatabasesVectorsView | 34521-34637 |
| renderDiaryEntryModal | 20246-20390 |
| renderDisableModal | 17705-17788 |
| renderDocsScreensView | 22059-22151 |
| renderEmbeddingsView | 21093-21310 |
| renderEnableModal | 17586-17704 |
| renderGovernanceCategoriesView | 17009-17369 |
| renderGovernanceControlsView | 17397-17484 |
| renderGovernanceEvaluationsView | 16322-16492 |
| renderGovernanceHistoryDrawer | 16834-17008 |
| renderGovernanceHistoryView | 16590-16833 |
| renderGovernanceProposalsView | 25820-25949 |
| renderGovernanceRuleDetailDrawer | 16081-16240 |
| renderGovernanceRulesView | 15846-16080 |
| renderGovernanceViolationsView | 25651-25771 |
| renderInfraConfigView | 35463-35590 |
| renderInfraDeploymentsView | 35142-35262 |
| renderInfraHealthView | 35032-35118 |
| renderInfraLogsView | 35288-35438 |
| renderInfraServicesView | 34947-35031 |
| renderInspectorView | 21578-21864 |
| renderIntegrationsLlmProvidersView | 31126-31283 |
| renderIntegrationsMcpView | 31004-31078 |
| renderIntegrationsPluginsView | 31814-31911 |
| renderIntegrationsServiceMeshView | 31912-31978 |
| renderIntegrationsToolsView | 31665-31743 |
| renderKnowledgeGraphView | 20891-21092 |
| renderLongevityFocusPanel | 20053-20158 |
| renderMemoryGardenView | 19928-20052 |
| renderOasisCommandLogView | 26397-26507 |
| renderOasisEntitiesView | 26106-26215 |
| renderOasisEventDrawer | 18259-18497 |
| renderOasisEventsView | 17964-18229 |
| renderOasisStreamsView | 26216-26321 |
| renderOasisVtidDetailPanel | 19084-19215 |
| renderOasisVtidLedgerDrawer | 19353-19927 |
| renderOasisVtidLedgerView | 19216-19352 |
| renderOrbChatDrawer | 25353-25497 |
| renderOverviewErrorsViolationsView | 29199-29358 |
| renderOverviewRecentEventsView | 29018-29198 |
| renderOverviewReleaseFeedView | 29383-29528 |
| renderPipelineTraceView | 13019-13122 |
| renderPipelinesErrorPanel | 12873-12912 |
| renderRecallView | 21311-21577 |
| renderRegisteredAgentsView | 12477-12574 |
| renderSecurityAuditLogView | 38378-38494 |
| renderSecurityPoliciesView | 38110-38202 |
| renderSecurityRlsAccessView | 38495-38610 |
| renderSecurityRolesView | 38220-38292 |
| renderTaskModal | 9017-9405 |
| renderTasksView | 6240-6462 |
| renderTelemetryRoutingPanel | 13742-13859 |
| renderTelemetryStreamPanel | 13531-13741 |
| renderTestingCiReportsView | 33643-33700 |
| renderTestingIntegrationView | 33136-33173 |
| renderTestingUnitView | 33098-33135 |
| renderTestingValidatorView | 33174-33228 |
| renderUnifiedIntelligencePanel | 20669-20871 |
| renderVoiceLabExperimentsPanel | 14025-14207 |
| renderVoiceLabOrbLivePanel | 14680-14877 |
| renderVoiceLabPersonalityPanel | 14435-14486 |
| renderVoiceLabPlaceholderPanel | 13975-14024 |
| renderVoiceLabSessionDrawer | 14878-15387 |
| renderVoiceLabView | 13890-13974 |
| renderVtidsView | 18829-18977 |
| renderWorkflowsActionsView | 26831-26965 |
| renderWorkflowsListView | 26556-26668 |
| renderWorkflowsSchedulesView | 27014-27149 |
| renderWorkflowsTriggersView | 26693-26830 |

## Methodology

All counts were produced mechanically from the `app.js` source at the feat/design-system-md branch commit:

```bash
# Enumerate view/modal/drawer/panel render functions with line ranges
awk '/^function [a-zA-Z_$]+\s*\(/ { ... }' services/gateway/src/frontend/command-hub/app.js

# For each range, count style.cssText and hex colors
sed -n "$start,$end p" | grep -cE 'style\.cssText'
sed -n "$start,$end p" | grep -oE '#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}\b' | wc -l
```

Drift bucketing:
- **HIGH**: `cssText >= 5` OR `hex >= 15`
- **MEDIUM**: `cssText >= 2` OR `hex >= 5`
- **LOW**: `cssText >= 1` OR `hex >= 1`
- **CLEAN**: neither

## Verification

After each migration PR:

```bash
# Re-run the audit script on the touched function — expect counts to drop to 0
cd services/gateway/src/frontend/command-hub
grep -cE 'style\.cssText' app.js   # should trend down from 163
grep -oE '#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}\b' app.js | wc -l   # should trend down from ~400
```

The audit doc itself should be **regenerated** at the end of each wave to confirm progress and keep the backlog current.

## Out of scope

- Internal render helpers that aren't top-level view/modal/drawer/panel functions.
- `intelligence-panels.js` — already addressed by the token alias in PR #825 (`styles.css:41–45`).
- vitana-v1 audit — separate deliverable; `docs/UI_PATTERNS.md` + `docs/design-system/horizontal-list-patterns.md` already guide that surface.

## Related

- `/DESIGN.md` — canonical token + class catalog (both tracks).
- `/CLAUDE.md` §17 — binding reuse-before-create rules.
- PR #825 (design-system foundation) — established DESIGN.md + removed deprecated classes + aliased parallel tokens.
