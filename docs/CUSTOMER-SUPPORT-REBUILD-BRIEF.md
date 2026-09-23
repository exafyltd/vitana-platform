# Customer support rebuild — session brief (VTID-04317)

**For a fresh Claude Code session. Read this whole file before touching code.**
Written 2026-09-23 by the session that shipped the intake-channels work
(`docs/INTAKE-CHANNELS-PLAN.md`, VTID-04306..04315). Everything below marked
*measured* was read from the live database or the code on that date; anything
marked *hypothesis* is not yet proven and is yours to confirm first.

## 1. What the owner wants

One working customer-support loop, end to end:

1. A member talks to **Vitana** (ORB voice) and reports a problem or asks for
   help.
2. Vitana hands the member to her colleague **Devon** (tech-support persona,
   same voice session, different voice/prompt). Devon confirms the problem and
   a ticket is filed.
3. Bug and UX tickets flow into the self-healing pipeline (spec → Dev
   Autopilot execution → PR → deploy → verify) and the member is told when it
   is fixed.
4. The member has **one** Customer Support area where they can report by voice
   or text, see every ticket they filed, its status, and the answer.
5. The supervisor has admin screens that monitor all of it, and can connect
   the dots instantly: **the user's ticket number (FB-YYYY-MM-NNNNNN) appears
   next to the VTID, the finding, the execution and the PR everywhere.**

The hand-off "was working properly until it stopped". Find out why, fix it,
then make the whole loop solid.

## 2. What is already true (measured, 2026-09-23)

### 2.1 The hand-off stopped after 2026-06-27

`feedback_handoff_events` (one row per Vitana → specialist hand-off, each with
a ticket) per week:

| week of | hand-offs |
|---|---|
| 04-27 | 66 (devon, sage, mira) |
| 05-04 → 05-25 | 12, 11, 13, 9 |
| 06-01 → 06-15 | 6, 7, 6 |
| 06-22 | 1 |
| 07-06 | 1 (typed, not spoken — `structured_fields.source='orb-voice-typed-tool'`) |
| after | **0** |

`feedback_tickets.structured_fields.source`: `orb-voice-tool` tickets span
05-17 → **06-27** (45 tickets); `orb-livekit-tool` 05-16 → 05-17 (5). No
spoken hand-off has produced a ticket since 06-27. The decline from May to
June is gradual, then it stops — look for (a) something that made the model
call the tool less over time and (b) something around late June that stopped
it entirely.

OASIS telemetry older than ~2 weeks is purged (retention job), so tool-call
history from June/July is **not** in `oasis_events`. The clone is shallow
(root commit 2026-09-21) — use the GitHub API (`mcp__github__list_commits`
with `since`/`until`, `get_commit`) for history around 2026-06-20 → 07-15.

### 2.2 How the hand-off works in code (measured)

- `report_to_specialist` — declared `orb/live/tools/live-tool-catalog.ts:908`,
  handled `routes/orb-live.ts:4040` → `services/report-to-specialist-core.ts:127`.
  Rejects summaries under 12 words; asks the RPC
  `pick_specialist_for_text[_tenant]` whether to route; on `answer_inline`
  **nothing is filed and nothing is logged as a failure**. Otherwise inserts
  `feedback_tickets` + `feedback_handoff_events`, emits
  `feedback.ticket.created`, and queues a persona swap to the specialist.
- `switch_persona` — `live-tool-catalog.ts:851`, handled `orb-live.ts:3863`.
  Validates persona for the tenant, caps forward/return swaps, loads
  `agent_personas.system_prompt` + voice. Files nothing.
- The swap itself: tool sets `pendingPersonaSwap`; on turn complete the
  gateway closes the upstream with reason `persona_swap`
  (`upstream-message-handler.ts:2170-2181` Nova, `:409-422` legacy); the
  reconnect rebuilds setup with Devon's prompt (`orb-live.ts:7801`) and voice
  (`orb-live.ts:8509`, `resolveNovaSonicVoiceOrFallback`). Client WS/SSE stays
  open. The **cascade** (Transcribe→Bedrock→Polly/Fish, used for ru/pl/tr/zh/
  ar/es/fr and friends) has **no persona handling at all**.
- `submit_bug_report` / `submit_support_ticket`
  (`services/orb-tools/feedback-settings-tools.ts:749/776`, handlers
  `:271/:283`) file a ticket without a swap.
- Devon cannot file or enrich: `orb-live.ts:4060` refuses the tool with
  `STAY_IN_INTAKE`, and nothing writes Devon's conversation into the ticket's
  `intake_messages`. The ticket only ever holds Vitana's summary.
- The insert never sets `surface` or `tenant_id` → every voice ticket is
  `surface=community`, tenant unset.

### 2.3 Root-cause candidates (ranked — confirm before fixing)

1. **Contradictory prompt rule** (*measured: grep over
   `services/gateway/src` finds no handler returning any `STATUS:` value*):
   the VTID-03033 "handoff truthfulness" HARD RULE at
   `orb/live/instruction/live-system-instruction.ts:745` forbids announcing
   a hand-off unless the tool reply begins with `STATUS: handoff_created.`,
   and treats every other reply as "the handoff did NOT happen" — but no
   handler returns that text
   (`orb-live.ts:4252` returns `Ticket … created. Speak ONE short bridge…`;
   LiveKit path `services/orb-tools-shared.ts:505` likewise). So after a
   successful call the model is told the hand-off did not happen. Also:
   propose-then-wait-for-explicit-yes, a 15-word summary minimum, "RARE —
   less than 5%" in the tool description, and "you ARE the instruction
   manual". All of these push the model toward never calling the tool.
2. **Tool dilution** (*hypothesis*): commit `e319c82` (2026-07-06) added ~95
   tools (catalog → ~290 declarations), including `submit_*` tools that
   compete with `report_to_specialist`. Check timing against the 06-27 stop —
   it is *after*, so it cannot be the first cause, but it plausibly keeps it
   dead.
3. **Nova Sonic promotion** (*hypothesis — check first*): voice moved to Nova
   Sonic for 100% of sessions (VTID-03560; `NOVA_SONIC_GLOBAL_ENABLED`). Find
   the date. If it lands in late June, the persona-swap reconnect on Nova is
   the prime suspect: Nova closes, reconnect, Devon voice resolution, the
   swap cap, or the ~10% premature-close rate (CLAUDE.md §2e). Also the
   cascade has no persona handling — for cascade languages the hand-off can
   never work.
4. **Routing RPC veto** (*hypothesis*): `pick_specialist_for_text*` may be
   returning `answer_inline` for everything (gate A) — silent, no ticket.
   Test it directly with realistic transcripts via SQL.
5. **Catalog budget** (*measured, not the cause of the stop*): since 09-19
   (VTID-04097) authenticated Nova sessions keep 41 of 290 tools under 64 KB.
   `switch_persona`/`report_to_specialist` survive (priority list
   `orb/live/tools/vertex-tool-catalog-budget.ts:129-130`); `submit_bug_report`
   and `submit_support_ticket` are **dropped**.

**First task: prove the cause with a reproduction, not a theory.** On
STAGING only, drive a real voice session (the repo's
`scripts/orb/measure-orb-first-audio.mjs` / `verify-vertex-serbian-bridge.mjs`
show how to drive SSE sessions with a PCM utterance) where the member
clearly reports a bug, in German and English, and record: was
`report_to_specialist` called, what did the RPC decide, did the swap happen,
did Devon speak with his voice. Do **not** file tickets as a real member on
production (CLAUDE.md Part 1 rules 31/43–45 — use the staging gateway; note
staging and prod share one Supabase project, so any ticket you create is a
real row: mark it clearly as a test and clean it up, or better, run the
RPC/tool path in a jest integration test against mocks).

### 2.4 Pipeline state (measured)

- Tickets stuck: **43 in `triaged` since May** (15 bug, 11 ux_issue, 13
  support_question, 4 other). `auto_triage_pending_feedback_tickets()` only
  moves **p3** bugs to `spec_ready` and support questions with
  `pick_confidence >= 0.5`; everything else waits for a human who never came.
- No ticket has ever had `linked_vtid` set (VTID-04308 added it on
  2026-09-22). Only 4 tickets were ever resolved through an execution.
- Shipped 2026-09-22 (#3595/#3596/#3597, not yet live on staging because of
  the AWS account block — check `docs/INTAKE-CHANNELS-PLAN.md` for current
  status): Approve & Fix dispatches bug/ux tickets and allocates a VTID per
  ticket (`ensureTicketVtid`, title `Feedback <FB-…>: <headline>`); a spec
  drafter replaces placeholder specs via the `triage` stage (Bedrock);
  dispatch refuses placeholder specs; the reporter gets a translated
  notification when resolved; `/mine` returns the answer/resolution.
- VTID-04315: two legacy bug reports queued as FB-2026-02-000140 and
  FB-2026-03-000139 (`spec_ready`), waiting on staging.

### 2.5 Member screens (vitana-v1, measured)

- `/comm/talk-to-vitana` (`src/pages/community/TalkToVitana.tsx`) is the only
  real ticket list: `GET /api/v1/feedback/tickets/mine`, 30 s poll, shows
  ticket number, status pill, answer when resolved, confirm/reopen. No VTID,
  no report text. Hard-coded English in `KIND_OPTIONS`, `STATUS_PILL`,
  `timeAgo`, button labels (i18n rule violation). `activeId="overview"` means
  its own tab never highlights.
- `/support` → mobile `src/pages/MobileSupport.tsx` (Contact/FAQs/Community;
  Contact posts `surface:'support'` but shows **no ticket number and no
  list**); desktop `src/pages/settings/Support.tsx` is **fake** — hard-coded
  mock tickets, a form with no submit (`NewTicketPopup.tsx:28-32` only logs).
- Diary list `src/components/feedback/FeedbackReportList.tsx` reads
  Supabase directly, legacy + bug/ux tickets only, shows VTID but no ticket
  number or answer, different status names.
- `MobileSupport.tsx:32`, `FeedbackRecorder.tsx:22`,
  `UnifiedCaptureCard.tsx:28` fall back to the **dead GCP Cloud Run gateway**
  URL when `VITE_GATEWAY_BASE` is unset — fix to the canonical gateway config.
- No persona/hand-off UI in the frontend; the ORB widget
  (`services/gateway/src/frontend/command-hub/orb-widget.js`, served by the gateway)
  owns that.
- No notification-type entry or per-ticket deep link for
  `feedback_ticket_resolved` (backend sends `url:'/comm/talk-to-vitana'`).

### 2.6 Supervisor screens (measured)

- Command Hub → Feedback (`app.js:7993-7999`; inbox `:51557`, drawer
  `:51613-51706`; routes `routes/feedback-admin.ts`, `feedback-actions.ts`):
  shows ticket number, kind, priority, status, resolver, surface — **never**
  `linked_vtid`, `linked_finding_id`, execution or PR. No duplicate/rollback/
  reclassify buttons although routes exist.
- vitana-v1 `/admin/feedback/:tab` (`src/pages/admin/feedback/Feedback.tsx`,
  `TicketActionDrawer.tsx`): per-tenant list + drawer with a
  `PipelineProgress` (finding/execution prefixes, stage, PR link, rollback).
  Also **no `linked_vtid`**.
- Autopilot screens (Live view `app.js:49021-49029`, findings, executions):
  the only back-link to a ticket is the `[FB-…]` prefix in the finding title.
  `source_ref: feedback_ticket:<id>` and `spec_snapshot.feedback` are never
  rendered; origin reads "dev_autopilot", never "user report".
- PR titles/bodies: `stampVtidOnTitle` (`dev-autopilot-pr-contract.ts:104,315`)
  guarantees the VTID only; the ticket number is not guaranteed.
- `feedback-completion-reconciler.ts:190` emits `feedback.ticket.resolved`
  under the fixed `VTID-02669` instead of the ticket's own VTID; the failure
  branch emits no OASIS event.
- The admin list selects (`feedback-admin-repository.ts:28,66`) do not select
  `linked_*` columns.

## 3. The target

### 3.1 One ID chain the supervisor can read at a glance

`FB-YYYY-MM-NNNNNN` (member-facing ticket number) is the anchor. It must be
visible next to its `VTID-…` everywhere either appears:

| Surface | Must show |
|---|---|
| VTID ledger row | title `Feedback FB-…: <headline>` (done), `metadata.ticket_number` (done) |
| Autopilot finding/recommendation | title prefix `[FB-…]` (done) **plus** an "From user report FB-…" badge from `source_ref`/`spec_snapshot.feedback` |
| Autopilot Live / execution rows | the same badge, the ticket's VTID, link to the ticket drawer |
| PR title and body | `(VTID-…)` **and** `FB-…` — extend the PR contract, test it |
| OASIS events for the ticket | `vtid` = the ticket's own VTID, `payload.ticket_number`; add an event for the failure branch |
| Command Hub + vitana-v1 ticket drawer | ticket number, linked VTID, finding, execution, stage, PR, deploy/verify state — as clickable chips |
| Member ticket list | ticket number and a plain-language status timeline (received → being fixed → fixed, with the answer); the VTID is optional, supervisor-facing |

### 3.2 Voice flow

- Vitana recognizes a support/bug intent, proposes the hand-off in her own
  words (NEVER-rule 41 — no hardcoded spoken sentences), and hands off.
- Devon takes over with his own voice on **every** provider the member can be
  on (Nova, cascade, Serbian Vertex bridge) — or, where a provider genuinely
  cannot swap, Vitana files the ticket herself and says so; no silent dead
  ends.
- Devon can append to the ticket (a narrow `append_to_ticket` tool writing
  `intake_messages`/`structured_fields`, owner-scoped) and closes the
  conversation telling the member their ticket number.
- The ticket carries `surface`, `tenant_id`, language, screen, app version,
  and the session id for OASIS correlation.

### 3.3 Pipeline

- Bugs/UX issues never wait on a human to write the spec: the spec drafter
  drafts for every priority, not just p3 (auto-triage writes the placeholder,
  the gateway drafter replaces it — see VTID-04311).
- Dispatch stays behind the kill switch and the existing approval hold; the
  supervisor decides "Approve & Fix" (or an owner-set auto-approve policy for
  low-risk tickets — owner decision, do not enable it on your own).
- Support questions get a drafted answer for supervisor review.
- The stuck May–July tickets were closed as outdated (see §3.5).

### 3.4 Member Customer Support area

- One section, one list, one status vocabulary, fully translated (DE source,
  du-form, all locales, RTL-safe).
- Report by voice (opens the ORB in support mode) or text; after submit show
  the ticket number and deep-link to it.
- Replace the fake desktop Support page with the real one; merge
  `FeedbackReportList` and TalkToVitana onto one component/data source;
  retire direct reads of `user_feedback_reports`.
- Notification `feedback_ticket_resolved` deep-links to the specific ticket.

## 3.5 Owner decisions (2026-09-23) — these override §3 where they differ

1. **Auto-start every bug fix.** When a bug/UX ticket has a real
   (non-placeholder) spec, dispatch it to Dev Autopilot automatically — no
   "Approve & Fix" click. Build it behind a flag (on by default on staging,
   off-switch documented), keep it behind the kill switch, and keep the
   PR-approval hold (`OPERATOR_PR_APPROVAL_REQUIRED` / `require_approval`) as
   the safety net before anything merges. Support questions still get a
   drafted answer for review, not auto-sent.
2. **Devon in every language.** Build persona hand-off for the cascade path
   (Transcribe → Bedrock → Polly/Fish — ru, pl, tr, zh, ar and the other
   cascade languages) and the Serbian Vertex bridge, so the member always
   hears Devon take over. Until that ships for a given path, Vitana files the
   ticket herself there and says the ticket number — never a silent dead end.
3. **The 42 stale May–July tickets are closed** as `wont_fix` (VTID-04329),
   no member notification. Do not re-triage them; the queue starts clean.
4. The AWS account block is being handled by the owner's side.

## 4. Work order (one VTID and one PR per slice, CLAUDE.md §4.1)

1. **Reproduce and root-cause the hand-off** (staging + tests). Write the
   finding into this file before fixing.
2. **Fix the hand-off**: prompt rules (remove the dead `STATUS:` contract or
   make handlers return it — pick one and test it), tool description, Nova
   swap path, cascade fallback, Devon `append_to_ticket`, `surface`/
   `tenant_id` on insert, add `submit_*` or drop them from the prompt so the
   budget and the prompt agree.
3. **ID chain**: PR contract carries FB-…; OASIS events use the ticket VTID;
   failure branch event; admin selects return `linked_*`.
4. **Supervisor screens**: Command Hub drawer + Autopilot rows (CSP: no
   inline JS/CSS, bump `?v=`, ownership guard allowlist, symbol index);
   vitana-v1 admin drawer shows `linked_vtid`.
5. **Member screens** (vitana-v1): unified Customer Support area, i18n,
   dead-gateway fallback, deep link.
6. **Pipeline**: drafter for all priorities; auto-dispatch of bug/UX
   tickets once the spec is real (§3.5 decision 1).
7. **Devon on the cascade and the Serbian bridge** (§3.5 decision 2), with
   the Vitana-files-it-herself fallback shipped first.

## 5. Rules that bite here

- Staging-first. Merging to `main` deploys staging only; production only via
  PUBLISH or an owner-approved pinned dispatch (CLAUDE.md IF-THEN 26).
- Never test against production; never write as the test user; test
  accounts must not become visible to real members (Part 1 rules 31, 43–45).
  Staging and prod share **one** Supabase project.
- Claude via Bedrock only; never Google except the Serbian bridge.
- Never hardcode spoken sentences (rule 41); push/notification text goes
  through `tt()` with DE + all locales (`ar` stays honestly incomplete).
- Every UI change: screenshot desktop 1400×900 and mobile 390×844 and
  inspect before reporting done.
- VALIDATOR-CHECK needs: VTID in PR title, `VTID:` line, profile markers,
  `docs/validation/<VTID>/acceptance.md` with AC → `TEST:` lines.
- Supabase MCP SQL is standing-approved by the owner (reads, writes,
  migrations) — do not ask per call.
- Check `docs/INTAKE-CHANNELS-PLAN.md` first: the AWS account block
  (2026-09-22 ~22:26 UTC) may still stop staging deploys. If staging is
  still on `e09eb26`, code can merge but nothing can be verified live —
  say so plainly rather than claiming it works.

## 6. Where things live

| Thing | Path |
|---|---|
| Voice hand-off tool | `services/gateway/src/services/report-to-specialist-core.ts`, `routes/orb-live.ts:3863,4040,4252` |
| Hand-off prompt rules | `services/gateway/src/orb/live/instruction/live-system-instruction.ts:742-748` |
| Tool catalog + budget | `orb/live/tools/live-tool-catalog.ts`, `orb/live/tools/vertex-tool-catalog-budget.ts` |
| Persona swap on Nova | `orb/live/session/upstream-message-handler.ts:2170-2181` |
| Personas | table `agent_personas`, `services/ai-personality-service.ts` |
| Routing RPC | `pick_specialist_for_text`, `pick_specialist_for_text_tenant` (SQL) |
| Ticket intake / member API | `routes/feedback.ts` (`POST /api/v1/feedback/tickets`, `GET /mine`) |
| Classifier / auto-triage | pg_cron `feedback-classifier`, `feedback-auto-triage` |
| Spec drafter | `services/feedback-spec-drafter.ts` |
| Dispatch bridge | `services/feedback-execution-bridge.ts` |
| Completion + reporter notify | `services/feedback-completion-reconciler.ts`, `services/feedback-reporter-notify.ts` |
| Supervisor (Command Hub) | `frontend/command-hub/app.js` Feedback module, `routes/feedback-admin.ts`, `feedback-actions.ts` |
| Supervisor (vitana-v1) | `src/pages/admin/feedback/Feedback.tsx`, `TicketActionDrawer.tsx`, `routes/tenant-specialists.ts` |
| Member (vitana-v1) | `src/pages/community/TalkToVitana.tsx`, `src/pages/MobileSupport.tsx`, `src/pages/settings/Support.tsx`, `src/components/feedback/*`, `src/lib/feedback-ticket.ts` |
