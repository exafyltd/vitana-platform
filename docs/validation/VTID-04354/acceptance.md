# VTID-04354 — Command Hub Orchestrator view v0 (Autopilot › Orchestrator)

Orchestrator v2, P7 v0 (docs/ORCHESTRATOR-REDESIGN-PLAN.md). A read-only
Autopilot sub-tab over the VTID-04319/04325 orchestrator routes. No new
route, no gateway change, no write.

## Acceptance criteria

AC-1: Autopilot gains an "Orchestrator" tab at `/command-hub/autopilot/orchestrator/`, dispatched to `renderAutopilotOrchestratorView()`.
TEST: services/gateway/test/command-hub/vtid-04354-orchestrator-view.test.ts

AC-2: The view calls only GET routes the orchestrator router serves (`runs/summary`, `runs`, `agents`, `policy`), and never sends a method other than GET.
TEST: services/gateway/test/command-hub/vtid-04354-orchestrator-view.test.ts

AC-3: Each section loads on its own; a 403/404/502 on one endpoint shows that section's error and leaves the others rendered.
TEST: services/gateway/test/command-hub/vtid-04354-orchestrator-view.test.ts

AC-4: Per-plane run counts, the unified run list (with error text), agent cards and the default role-grant matrix render from real-shaped payloads; commerce is shown as org-derived, never as a role tier; clicking a plane filters the run list.
TEST: services/gateway/test/command-hub/vtid-04354-orchestrator-view.test.ts

AC-5: CSP-safe (classes only, no innerHTML, no inline style); `?v=` bumped on app.js and styles.css; VTID allowlisted in the ownership guard; the VTID-04334 cache-bust pin relaxed to at-or-after.
TEST: services/gateway/test/command-hub/vtid-04354-orchestrator-view.test.ts
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts

AC-6: Visually verified at 1400×900 and 390×844 against a local harness fed by live rows read (read-only) from `agent_runs_unified` / `agents_registry`: no page errors, no horizontal page overflow, plane filter works (`outputs/*.png`, `outputs/shoot-result.json`). Two defects found this way and fixed before commit: plane-card content vertically centred (button default), and role names breaking mid-word in the grant table on a phone.
UI: docs/validation/VTID-04354/outputs/orchestrator-desktop.png, orchestrator-mobile.png, orchestrator-grants-mobile.png, orchestrator-filtered-plane-desktop.png

## Not verified

Staging. Staging still serves `e09eb26` (AWS account task-placement block since
2026-09-22 22:57 UTC), and `/api/v1/orchestrator/*` returns `404 text/html`
there, so on staging each section shows "route not deployed" until the gateway
deploys again. The first real exercise is opening the tab on staging once
#3605/#3617 are served.
