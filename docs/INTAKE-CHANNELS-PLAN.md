# Intake Channels Plan — Command Hub voice + support tickets (VTID-04306)

**Owner request (2026-09-22):** make the two remaining intake channels — the
Command Hub developer voice assistant and the customer-support / bug-report
channel — feed the same task pipeline the Operator Console and Dev Autopilot
already use, with as few separate pipelines as possible.

**This file is the resume point.** Any session continuing this work reads the
status table first, picks the first step that is not `done`, and updates the
table in the same PR that finishes a step. Every step has its own VTID
(allocated 2026-09-22, `in_progress` / `approved`).

## Target shape

```
 Operator Console (text + voice, one thread) ─┐
 Support tickets (form, Talk to Vitana, ORB) ─┼─► autopilot_recommendations (source_type + source_ref)
 Dev Autopilot scanners                        │      → VTID (vtid_ledger)
 Self-healing                                 ─┘      → agent executor → hold for approval → PR
                                                       → CI watcher → deploy → reconcile back to source
                                                         (operator thread / feedback ticket)
```

Rules that apply to every source: a real VTID, the kill switch, the approval
hold, one executor. A source only owns (a) its intake adapter and (b) its
report-back reconciler.

## Findings this plan is built on (2026-09-22, code + live DB)

### Channel 1 — Command Hub voice
- The Command Hub loads the same `orb-widget.js` as the community app; the
  gateway makes it the developer assistant only from `current_route` starting
  with `/command-hub` (`orb/live/surface.ts:26-57`,
  `live-session-controller.ts:1093-1096` forces `developer`).
- Voice declares legacy task tools (`dev_create_task`, `dev_allocate_vtid`,
  `dev_execute_vtid` in `services/orb-tools/vtid-lifecycle-tools.ts`) that call
  `/api/v1/vtid/create` and the worker orchestrator through `gatewayApiCall`
  with no auth header — not the Operator on-ramp.
- Those tools are appended last to a ~290-declaration catalog and are very
  likely dropped by the 48/64 KB tool-catalog budget
  (`vertex-tool-catalog-budget.ts`, priority list already ~58 KB). Inferred,
  not observed.
- `autopilot_run_task` / `autopilot_execute_task` (the gated on-ramp) are
  unreachable from voice; their exafy_admin gate (`operator-execute-authz.ts`)
  is set only by `routes/operator.ts`.
- Voice transcripts go to `memory_items`, Redis, and the user's community
  "Vitana" inbox DM (`chat_messages`) — never to `operator_threads`.
  Developer voice therefore lands in the community inbox.

### Channel 2 — support tickets
- Intake works: mobile Support, Talk to Vitana, ORB `report_to_specialist` /
  `submit_bug_report` → `feedback_tickets`; pg_cron `feedback-classifier` and
  `feedback-auto-triage` are active (every 5 min).
- Live: 134 tickets, newest **2026-07-11** (nothing in 10 weeks); 26 bug/ux
  tickets `triaged` and never dispatched; 10 ever reached Autopilot; **0 have
  a VTID**.
- `feedback-execution-bridge.ts` dispatchFeedbackTicket → recommendation +
  execution exists; only caller is the human-clicked
  `POST /admin/tenants/:tid/tickets/:id/activate`.
- Broken: Command Hub "Approve & Fix" only flips status to `in_progress`
  (then Activate refuses it — stuck forever); feedback lane is exempt from the
  kill switch; auto-triage writes placeholder `spec_md` that Activate will
  dispatch; `linked_vtid` never set; `ensureTenantAdmin` decodes the JWT
  without verifying the signature; users are never notified; the Diary
  recorders still write the dead-end `user_feedback_reports` table.

## Steps

| # | VTID | Step | Status |
|---|------|------|--------|
| 1 | VTID-04307 | Verify JWT signature on the ticket admin endpoints (`ensureTenantAdmin`) | pending |
| 2 | VTID-04308 | "Approve & Fix" dispatches; VTID per dispatched ticket (`linked_vtid`); feedback lane obeys the kill switch | pending |
| 3 | VTID-04309 | Command Hub voice turns recorded into the Operator Console thread; not copied into the community inbox | pending |
| 4 | VTID-04310 | Command Hub voice: one operator-delegation tool (same gate + hold as `autopilot_run_task`), surface-gated developer catalog, persona prompt update | pending |
| 5 | VTID-04311 | LLM spec drafting at triage for bug/ux; dispatch refuses placeholder specs | pending |
| 6 | VTID-04312 | Notify the reporter on resolved / needs-more-info (tt() catalog); resolution in `/mine` | pending |
| 7 | VTID-04313 | Diary recorders → `feedback_tickets`, retire `user_feedback_reports`; root-cause the intake silence since 2026-07-11 | pending |

### Step details

1. **Auth (VTID-04307).** Replace the base64 `sub` decode with a verified
   identity (the gateway's existing `requireAuth`/`optionalAuth` +
   exafy_admin / tenant-admin check). Tests: forged unsigned token → 401.
2. **Dispatch (VTID-04308).** Command Hub `approve` for a bug/ux ticket with a
   spec calls `dispatchFeedbackTicket` (support questions keep the answer
   path). Allocate a VTID at dispatch (reuse the VTID-04246 `ensureFindingVtid`
   pattern), write `feedback_tickets.linked_vtid`. Remove the feedback-lane
   kill-switch exemption. Unstick existing `in_progress` tickets with no
   finding (reset to their pre-approve status).
3. **Voice → thread (VTID-04309).** Command Hub passes the console's current
   thread id in the voice start payload (`operator_thread_id`); the gateway,
   for surface `command-hub` only, records each finalized user/assistant turn
   through `recordOperatorTurn` (message `meta.channel='voice'`) and skips the
   community `chat_messages` bridge. Console renders voice turns with a mic
   marker.
4. **Voice → task (VTID-04310).** Surface gate for `command-hub`: developer
   catalog (read tools + one `operator_delegate(request)`), no community
   tools. `operator_delegate` runs the same turn function as `POST
   /operator/chat` on the shared thread with the verified caller's
   exafy_admin marker, so `autopilot_run_task` / approval hold / execution
   follow all apply unchanged. Legacy `dev_*` vtid-lifecycle tools leave the
   voice catalog. Update `dev_orb` `voice_tools_section` as an intent (NEVER
   rule 41).
5. **Specs (VTID-04311).** Auto-triage marks placeholder specs
   (`classifier_meta.spec_placeholder=true`); a gateway tick drafts real specs
   through `callViaRouter('triage', …)` (Bedrock primary, never Google);
   `dispatchFeedbackTicket` refuses a placeholder spec.
6. **Report back (VTID-04312).** Reconciler emits a translated notification
   on resolved / needs_more_info; `/mine` returns `resolution_md` /
   `draft_answer_md` when sent.
7. **Consolidate (VTID-04313).** Frontend (`exafyltd/vitana-v1`) recorders
   post to `/api/v1/feedback/tickets`; the 5 legacy rows are copied over;
   the old table is left read-only. Investigate and fix the July silence.

## Constraints
- Staging only. Production changes only via PUBLISH or an owner-approved
  pinned dispatch (CLAUDE.md IF-THEN 26).
- Never write as the test user; never create community content to test.
- Supabase MCP SQL (reads, writes, migrations) is standing-approved by the
  platform owner — no per-call prompts.
