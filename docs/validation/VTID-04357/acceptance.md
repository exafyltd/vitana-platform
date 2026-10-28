# VTID-04357 — Calendar step 6: developer and admin work lenses

Step 6 of the Vitanaland calendar redesign (steps 1–5: VTID-04320/04321/
04322/04331/04338/04351/04356). The owner asked that admin and developer
entries be kept apart from other roles so they do not overload those views.

## Before (read live, 2026-09-23, read-only)

- The `developer` and `admin` lenses existed in `ROLE_TO_CONTEXTS` but had
  nothing in them: no code writes `dev_task`, `deployment`,
  `sprint_milestone` or `admin_task` entries.
- The work itself already lives in the platform's own tables. 14 days held
  217 `staging.deploy.completed` and 16 `prod.deploy.completed` events and
  1 Dev Autopilot execution held at `awaiting_approval`. There were 0 pending
  `erp_approvals` and 0 `feedback_tickets` in the last 30 days.

## Design

- **Computed live, never written.** A deploy or a ticket is not one person's
  appointment. Writing it to `calendar_events` would mean one row per staff
  member per event, all kept in sync forever. So the window read builds
  read-only items from the source tables on each request. The source table
  stays the only truth.
- **Exafy staff only.** This is platform-wide operations data. It is granted
  from the verified `exafy_admin` JWT claim. The `X-Vitana-Active-Role`
  header is client-asserted, so it only picks which lens a staff member is
  looking at. A tenant admin or developer role without the claim gets
  nothing.
- **Developer lens:**
  - gateway deploys (staging and production);
  - Dev Autopilot executions held for review.
- **Admin lens:**
  - open member-ticket SLA deadlines;
  - pending BackOffice (ERP) approvals.
- **Text rules.** Titles are identifiers only (commit, ticket number,
  capability). The label comes from `vcal.work.<kind>` in the app.
- **Read-only.** Items get the id `work:<kind>:<source_id>`, carry no
  reminders, and cannot be completed. `POST /events/:id/complete` refuses
  them.
- **Fail-open.** Each source fails open to nothing and logs. A cap of 200
  items per source keeps one noisy source from flooding a month view.

## Acceptance criteria

| AC | Criterion | Evidence |
|---|---|---|
| AC-1 | Nobody without the verified `exafy_admin` claim gets work items, whatever the role header says. | TEST: `services/gateway/test/vtid-04357-calendar-work-lenses.test.ts` ("who sees work items", "route wiring") |
| AC-2 | Staff get the lens their role picks (developer / admin, super_admin both), none in the community view. | TEST: same file |
| AC-3 | Each source maps to a read-only item: deploy kind + short commit, review placed when staged, ticket block ending on the SLA, closed tickets dropped, ERP approval by capability. | TEST: same file ("source rows become read-only items") |
| AC-4 | Only GET reads, only the sources of the requested lens; `calendar_events` is never touched. | TEST: same file ("listWorkItems") |
| AC-5 | A failing or throwing source is logged and skipped; the calendar still answers. | TEST: same file |
| AC-6 | Work items can never be completed through the calendar; they carry no reminders. | TEST: same file ("route wiring") |
| AC-7 | The app labels them, hides "Mark as done", and keeps them out of the progress ring. | `exafyltd/vitana-v1` `src/components/calendar/vcal/vcal.test.ts` ("work-lens items") |

## Not verified

- A staff session on staging reading `/events/window` with a work lens.
  That needs this PR merged and deployed, and an `exafy_admin` session. It
  is read-only.
