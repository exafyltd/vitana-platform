# Plan — chat push burst shows the last message and the count (vitana-platform)

Change class: standard (gateway service + one worker path; no migration in round 1 unless the sparring round proves it needed).

<!-- plan:begin -->
## Owner report (2026-11-11)
"When there are multiple messages in a row from the same sender, we now receive everything in one notification, which is
correct, but we only see the first message sent in the notification, which is not correct. We should see the last
message sent and the total number of consecutive messages sent in the notification."

## Current behaviour (verified on main 05364284a1)
- services/gateway/src/services/chat-push-coalescer.ts: one push per conversation per CHAT_PUSH_COALESCE_WINDOW_MS (L36, 5 min)
  while the earlier pushed notification is unread. decideChatPushes() (L82) reads unread rows; coalesceChatPushes() (L141).
- The FIRST message of a burst is pushed immediately with its own body (payload unchanged when unreadCount == 1, L176-182).
- Later messages in the window return opts.suppressPush = 'coalesced' (L173-175): no push, row recorded as coalesced.
- The "N new messages · preview" body (L176-181) only applies when a push is sent while earlier unread rows exist and none was
  pushed recently. In a burst it is never sent, so the one visible card shows the FIRST message.
- Callers: routes/chat.ts:250, routes/chat-groups.ts:659, services/orb-tools/messaging-depth-tools.ts:375,
  services/orb-tools-shared.ts:2745.
- Appilix has no tag/collapse/update parameter (notification-service.ts:51-54 documents the gap), so a second push cannot
  replace the first card.
- Chat pushes are sent directly from notifyUser (notification-service.ts:932). They do NOT go through the push-dispatch
  endpoint (scheduled-notifications.ts:1252, EventBridge every ~1 minute).
- The i18n key notif.chat_burst.body already exists in all locales (catalog.ts:266); only the meaning of {preview} changes.

## Goal
One push per burst that shows the LAST message's preview and the total count of unread messages in that burst, e.g.
"3 new messages · <last text>". A single message still shows its own text.

## Design v2 (answers round 1)
D1 Durable hold without a schema migration (answers F1, Q1, Q3):
- notifyUser, when the coalescer says HOLD, writes the row with push_outcome 'pending_burst' and
  data.burst_due_at = now + CHAT_PUSH_BURST_HOLD_MS. It does not call dispatchPush. push_sent_at stays NULL.
- A new in-process sweep (setInterval, 5 s, modeled on lifecycle-notification-worker.ts:157) runs in each gateway task.
  It claims due rows with an atomic UPDATE (push_outcome 'pending_burst' -> 'sending', returning the row) so two tasks
  cannot send the same burst twice, then sends ONE push per conversation per recipient.
  Stuck claims (answers F10): the sweep also reclaims rows in 'sending' whose data.claimed_at is older than 60 s and sets them
  back to 'pending_burst' before the claim, so a crash between claim and dispatch cannot strand a burst.
- Durability: the state lives in user_notifications, so a restart or a rolling deploy leaves the rows in place; the next
  sweep on any task sends them (answers Q3). No migration: burst_due_at lives in the existing data jsonb.
- Push-dispatch (every ~1 minute) is not used (answers F4).

D2 Body at send time (answers F1/F6): count = unread rows for that recipient and conversation in the burst (capped at
CHAT_PUSH_MAX_COUNT), preview = the newest unread message text. Reuse notif.chat_burst.body; no new i18n key.

D3 Read during hold (answers F8): at claim time the sweep re-reads the recipient's unread rows for the conversation. If none
remain unread, the burst is dropped and every held row is marked suppressed_read. A Jest case covers it.

D4 Interaction with push-dispatch (answers F5, F9): fetchPendingPushNotifications (scheduled-notifications-repository.ts:221)
and the inline query in ops-health-checks.ts:348-355 add the NULL-safe filter
.or('push_outcome.is.null,push_outcome.neq.pending_burst'), so held rows are skipped and normal rows (push_outcome NULL) are
kept. A plain neq or NOT predicate is forbidden here: it drops NULL rows. A Jest case covers a NULL-outcome row.

D5 Latency trade-off (answers F3, Q2): every chat message is held for CHAT_PUSH_BURST_HOLD_MS (proposed 20 s). This is an
OWNER DECISION for Gate 1, with two options:
  Option A (recommended for the owner's stated goal): hold every message, one notification per burst, last text + count.
  Option B: push message 1 immediately; hold only messages 2+ (near-instant single DMs). Appilix users may see two cards on a
  rapid burst, the second showing the latest text.
Owner picks A or B; the hold length is also the owner's choice.

D5b Payload hygiene (answers F11): the sweep strips data.burst_due_at and data.claimed_at before dispatch
(const { burst_due_at, claimed_at, ...cleanData } = row.data).
D6 Mentions push at once (kind 'mention'), unchanged.
D7 Fails open: any read or write error pushes immediately as today. Off switch CHAT_PUSH_COALESCING_ENABLED=false unchanged.

## Files in scope (round 2)
- services/gateway/src/services/chat-push-coalescer.ts (decision, hold decision, burst body)
- services/gateway/src/services/notification-service.ts (notifyUser hold branch; PushOutcome union gains 'pending_burst',
  'suppressed_read' if not already present)
- NEW services/gateway/src/services/chat-burst-sweep.ts (the sweep and its claim query), started where
  lifecycle-notification-worker starts
- services/gateway/src/services/scheduled-notifications-repository.ts (fetchPendingPushNotifications filter)
- services/gateway/src/routes/ops-health-checks.ts (backlog count filter)
- callers: routes/chat.ts, routes/chat-groups.ts, services/orb-tools/messaging-depth-tools.ts, services/orb-tools-shared.ts
  (only the contract, if it changes)
- tests: test/vtid-05137-chat-push-coalescing.test.ts (contract CHANGES: first message no longer pushes immediately, F7),
  new test file for the sweep

## Test plan
- Jest: burst of 3 -> one push, count 3, last text; single message -> one push, count 1; mention pushes at once; read during
  hold -> no push; two tasks claim the same row -> one push; error -> push immediately; push-dispatch filter skips held rows.
- Gateway Jest CI job. No production writes; staging checks read-only.

## Change class
standard (gateway services and tests; no migration, no .github, no governance or LLM-routing file). The sweep adds a new
in-process loop, so the partner is asked to confirm this class.
<!-- plan:end -->

## Planner responses (round 1 -> round 2)
(see also round 2 below)
- F1 ACCEPTED: the "existing worker loop" premise was wrong. The mechanism is now an in-process sweep (D1), claim by atomic update.
- F2 ACCEPTED: notification-service.ts and PushOutcome are in scope (files in scope).
- F3 ACCEPTED as a decision for the owner: options A and B in D5. Option A recommended for the stated goal.
- F4 ACCEPTED: push-dispatch is not used; the sweep runs every 5 s (D1).
- F5 ACCEPTED: scheduled-notifications-repository and ops-health-checks in scope; filters in D4.
- F6 ACCEPTED: no new i18n key (D2).
- F7 ACCEPTED: the VTID-05137 test contract changes, not just additions.
- F8 ACCEPTED: read-during-hold in D3, with a Jest case.
- Q1 ACCEPTED: the in-process sweep is chosen (D1); the per-conversation timer is rejected to keep one loop.
- Q2 ANSWERED: owner decision in D5, presented at Gate 1.
- Q3 ANSWERED: rows are durable in user_notifications; a rolling deploy leaves them for the next sweep (D1).
- Verdict requested: converged or not, with each finding closed / acknowledged / disputed.

## Planner responses (round 2 -> round 3)
- F9 ACCEPTED (major): the filter is now NULL-safe, .or('push_outcome.is.null,push_outcome.neq.pending_burst') in D4, in both
  fetchPendingPushNotifications and the ops-health-checks inline query, with a Jest case for NULL-outcome rows.
- F10 ACCEPTED (minor): stuck 'sending' rows older than 60 s are reclaimed (D1).
- F11 ACCEPTED (minor): burst_due_at and claimed_at are stripped before dispatch (D5b).
- Round 1 closures stand; Q1-Q3 answered in round 1.
- Verdict requested: converged or not, with F9-F11 closed or disputed.

## Approval (Gate 1)
- Owner approval 2026-11-11: "yes, go with option A" (Option A: hold every chat message 20 s; one push per burst with the latest text and the count).
- Verdict: converged after three rounds (partner agent afb71652231179b67; round 1 one blocker and majors, round 2 one major, round 3 none).
- Plan hash (plan-v2 after round 3, the version recorded in the ledger): 347c8e7339a8b388.
