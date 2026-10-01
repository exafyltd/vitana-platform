# VTID-04334 — Supervisor sees the member ticket next to its VTID and fix run

VTID: VTID-04334
VALIDATION_PROFILE: gateway_backend

Brief: `docs/CUSTOMER-SUPPORT-REBUILD-BRIEF.md` §2.6 (measured gap) and §3.1
(one ID chain the supervisor can read at a glance). Work-order step 4
(Command Hub half). Frontend only: `app.js`, `styles.css`, `index.html`
(`?v=` bump), the ownership-guard allowlist and the regenerated symbol
index. No backend route was added or changed.

## Acceptance criteria

AC-1 ** — Pipeline block in the Feedback ticket drawer.** The drawer shows a
"Pipeline" block with chips for the ticket number (FB-…), linked VTID,
finding (8-char id), latest execution (8-char id + status + failure stage),
PR and deploy/verify state. Execution chip links to the row on Autopilot
Live; PR chip opens GitHub; ticket/VTID chips copy the id.
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts ("has a chip for ticket, VTID, finding, execution, PR and deploy/verify, each defensive")
TEST: docs/validation/VTID-04334/outputs/harness-report.json (`chips`, `execChipHref`) + feedback-drawer-pipeline-{desktop,mobile}.png

AC-2 ** — Defensive rendering.** Every field is optional: the ticket's
`linked_vtid` / `linked_finding_id` / `linked_pr_url` and the latest
execution (`latest_execution` or `execution`, top level or on the ticket)
may be absent — the chip then shows "—" (dashed), never a guess.
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts ("feedbackDeployVerifyState", "each defensive")
TEST: docs/validation/VTID-04334/outputs/harness-report.json (`oldShapeChips`) + feedback-drawer-pipeline-absent-fields-{desktop,mobile}.png

AC-3 ** — Mark duplicate / Reclassify / Rollback wired to existing routes.**
Verified the routes exist before wiring: `POST /api/v1/admin/feedback/tickets/:id/mark-duplicate`
(feedback-actions.ts, body `{duplicate_of: uuid}`), `PUT /api/v1/admin/tenants/:tenantId/tickets/:id/reclassify`
and `POST /api/v1/admin/tenants/:tenantId/tickets/:id/rollback` (tenant-specialists.ts).
Each button is offered only when the route would accept it (reclassify: not
dispatched, not terminal; rollback: resolved + auto_resolved + not rolled
back + has a PR). Mark duplicate accepts an FB number and resolves it to the
UUID the route requires.
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts ("wires Mark duplicate / Reclassify / Rollback to the routes that already exist", "only offers each action when its route would accept it")
TEST: docs/validation/VTID-04334/outputs/harness-report.json (`posted` — mark-duplicate by FB number posted the original's UUID; `resolvedButtons` contains "Rollback fix")

AC-4 ** — Member-report badge on Autopilot rows.** Autopilot Live recent
executions, Live dev-autopilot execution cards, the supervisor open-findings
panel and Dev Autopilot finding cards show "Member report FB-… [· VTID-…]"
when the row came from a ticket — from the API's `feedback_ticket` object
(VTID-04333), else `source_ref: feedback_ticket:<id>`, else
`spec_snapshot.feedback`, else the `[FB-…]` title prefix. The Live origin
text reads "member report" instead of "auto-approved (dev_autopilot)".
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts ("feedbackTicketRefFrom", "Autopilot rows carry the member-report badge")
TEST: docs/validation/VTID-04334/outputs/harness-report.json (`badges`, `originLines`, `supervisorFindingBadge`) + autopilot-live-*.png, autopilot-finding-row-*.png

AC-5 ** — Badge opens the ticket.** Clicking the badge opens the Feedback
drawer for that ticket in place; a badge that only knows the FB number
resolves it through `GET /api/v1/admin/feedback/tickets?limit=200` first.
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts ("the badge opens the ticket drawer, resolving a bare FB number first")
TEST: docs/validation/VTID-04334/outputs/harness-report.json (`drawerTitle`, `oldShapeTitle`)

AC-6 ** — Inbox VTID column** next to the ticket number (`linked_vtid`, "—"
when absent).
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts ("adds a VTID header after the ticket column and a linked_vtid cell per row")
TEST: docs/validation/VTID-04334/outputs/harness-report.json (`inboxHeaders`, `inboxVtids`) + feedback-inbox-{desktop,mobile}.png

AC-7 ** — CSP and cache-bust.** New code uses classes only (no `.style`, no
`style=`, no `innerHTML`); styles live in `styles.css`; `?v=` bumped on
`app.js` and `styles.css`; CSP gate clean on added lines; symbol index in
sync; ownership guard allowlists VTID-04334.
TEST: services/gateway/test/command-hub/vtid-04334-feedback-pipeline-links.test.ts ("CSP + cache-bust")
TEST: node scripts/ci/validator-path-guard.cjs --csp-added-lines → "No CSP pattern hits in added lines."
TEST: node services/gateway/scripts/generate-command-hub-symbol-index.mjs --check → in sync

AC-8 ** — No regression** in the Command Hub suites and every suite that
reads app.js / styles.css / index.html / the symbol index / the ownership
guard: 71 suites, 926 tests passed (`outputs/jest-summary.txt`).
TEST: services/gateway/test/command-hub/ (71 suites) → outputs/jest-summary.txt

## Visual verification

Local harness only — `outputs/harness-server.js` serves the Command Hub
statics from this working tree with stubbed APIs and fake ticket / execution
data; `outputs/harness-shoot.js` drives Chromium at 1400×900 and 390×844.
Nothing live was called. 0 page errors, no horizontal page overflow in any
shot (`harness-report.json`).

## Found while doing it (fixed here)

- The Feedback drawer panel was transparent: it (and the inbox) read
  `--color-surface-primary` / `--color-surface-secondary` /
  `--color-border-subtle`, which no stylesheet defines. Defined in the
  Feedback scope only (`#feedback-ticket-drawer`, `.fb-inbox`), never on
  `:root`.
- The inbox table wrapped FB numbers one segment per line; the ticket cell
  and status pill no longer wrap and the table scrolls inside the view.

## Not done / open

- The Feedback module has **no navigation entry** in the Command Hub
  (`NAVIGATION_CONFIG` has no `feedback` section; `navigation-config.js`,
  which lists it, is not loaded by `index.html`), so the inbox is not
  reachable from the sidebar or a URL — pre-existing, not changed here
  (sidebar/navigation change needs its own decision). The drawer is now
  reachable from every Autopilot row that came from a ticket.
- Reclassify and Rollback are tenant-scoped routes. The drawer uses
  `ticket.tenant_id` when the API provides it, otherwise the supervisor's own
  `meContext.tenant_id`; the route answers 404 `NOT_FOUND_OR_NOT_IN_TENANT`
  (shown as a toast) if the reporter is not a member of that tenant.
- The execution/deploy chips depend on VTID-04333 adding the latest
  execution to `GET /api/v1/admin/feedback/tickets/:id`; until then they show
  "—" (the `linked_*` columns already come through, `select('*')`). The
  inbox VTID column likewise shows "—" until the list select returns
  `linked_vtid`.
- Not verified against staging: nothing deployed from this session.
