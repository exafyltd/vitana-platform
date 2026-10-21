# VTID-04414 — Conversation rebuild WS-1.3: every voice path goes through one context builder

This is Plan v1 (Conversation Intelligence Rebuild), Phase 1, workstream WS-1.3.
It ships in PR #3614 as a companion to VTID-04339.

## What was wrong (read from the code, with 7 days of traffic read-only)

The standing context of an ORB voice session was put together in three places,
and each gave a different result.

| Path | Before | Traffic, 7 days |
|---|---|---|
| Session start, WS and SSE (`live-session-controller.ts`) | The brain when `vitana_brain_orb_enabled` is on (it is), the legacy pack otherwise. The Autopilot offer, the admin briefing and the Guided Journey block are then appended. | 473 `vtid.live.session.start` |
| SSE reconnect rebuild (`orb-live.ts` GET `/live/stream`, more than 60 s into a session that has turns) | **Always the legacy pack, with none of the three appended blocks.** | not measured: there is no event for it (added now) |
| Guided-topic tap (`live-session-controller.ts` fast path) | A fixed persona line plus the journey block, and nothing about the learner. | part of the above |
| LiveKit (`orb-livekit.ts`) | Always the legacy pack. | 0 sessions (every start is `sse` or `ws`) |

The reconnect defect has three effects:

- a brain session silently changed its context mid-conversation;
- the session lost the user's journey position (the "never restart at session 1" block);
- a guided-topic lesson was switched from its small lesson context to the full community pack partway through the lesson.

**Checked, and found already on the brain, so unchanged here:**

- **The text surfaces** (conversation, chat, groups, assistant) already call the brain when `vitana_brain_enabled` is on.
- **The admin, backoffice and commerce voice surfaces** deliberately inject no community context (VTID-03848/04326); that is kept.
- **The wake-brief override** removes only the brain's opener sections, by regex, and keeps the rest of the brain context. Moving that choice inside the brain is part of the one decision engine (WS-2.1), not a context-building change.

## Fix

**New `orb/live/session/session-context-builder.ts`:**

- **`resolveBrainRole`** is the one role rule: mobile is community, the Command Hub is developer, otherwise the identity's role.
- **`buildBaseSessionContext`** chooses the builder:
  - the brain when enabled;
  - otherwise the legacy pack;
  - the legacy pack on a brain failure, named in `brainError`.
- **`composeSessionContext`** appends the offer, the briefing and the journey block in the old order. The result is byte-identical to the old inline code; a test compares the two.
- **`buildLessonContext`** is the lesson surface:
  - the persona, the journey block, and the learner's verified facts from the stored core snapshot (VTID-04399);
  - only the `## Verified Facts` lines are used, at most 1 200 characters, cut at a line boundary;
  - the snapshot read waits at most 300 ms and runs in parallel with the journey read;
  - it fails open to the persona.
- **`rebuildSessionContext`** rebuilds with the builder, brain role and extras the session started with. A lesson rebuilds as a lesson. A session with no recorded builder keeps the old legacy rebuild.

**Session start** builds through the shared builder. It records `contextBuilder`, `contextBrainRole` and `contextExtras` on the session.

**The SSE reconnect rebuild** calls `rebuildSessionContext` and emits the `orb.live.diag` stage `context_rebuilt_on_reconnect`, with these fields:

- `builder`;
- `started_builder`;
- `chars`;
- `latency_ms`;
- `brain_error`;
- `turns`.

**LiveKit** builds through the shared builder. Brain text is fitted to the 12 KB bootstrap budget with the VTID-04393 packer. The response's `context_pack` meta names the builder and any brain error.

**The bootstrap packer** pins `=== LEARNER BACKGROUND` at priority 1.

**Kill switch:** `BRAIN_LESSON_CONTEXT=false` removes the learner facts from lessons.

## Behaviour changes to know about

- **The guided-topic persona line is now English for every language.** It was German for `de`. It is an instruction to the model, not speech, and the session's LANGUAGE directive decides the spoken language (CLAUDE.md §13b: system instructions are English).
- **A reconnect rebuild now costs a brain build** (cached, VTID-03504) instead of a legacy build, but only for sessions that started on the brain.

## Acceptance criteria

AC-1: One role rule and one builder choice (brain when enabled, legacy otherwise or on a brain failure, which is named) serve every voice path.
TEST: services/gateway/test/orb/live/session/vtid-04414-session-context-builder.test.ts

AC-2: The appended extras compose byte-identically to the pre-change inline code for community, admin and other roles, with and without base text and journey block.
TEST: services/gateway/test/orb/live/session/vtid-04414-session-context-builder.test.ts

AC-3: The lesson surface adds only the verified facts, bounded at a line boundary, never waits past its read bound, fails open, honours the kill switch, and is pinned by the packer.
TEST: services/gateway/test/orb/live/session/vtid-04414-session-context-builder.test.ts

AC-4: A reconnect rebuild uses the builder, role and extras the session started with; a lesson rebuilds as a lesson; a session with no recorded builder keeps the legacy rebuild.
TEST: services/gateway/test/orb/live/session/vtid-04414-session-context-builder.test.ts

AC-5: Session start, the guided-topic path, the SSE reconnect and LiveKit are wired to the shared builder (source contracts); the LiveKit parity contracts follow the new call.
TEST: services/gateway/test/orb/live/session/vtid-04414-session-context-builder.test.ts, services/gateway/test/orb/routes/livekit-context-parity.test.ts

AC-6: No regression in the ORB, route, conversation and script suites; tsc clean.
TEST: services/gateway/test/orb, services/gateway/test/routes, services/gateway/test/services/conversation, services/gateway/test/scripts

AC-7 (post-deploy, staging): an SSE reconnect more than 60 s into a signed-in session emits `orb.live.diag` stage `context_rebuilt_on_reconnect` with `builder = started_builder` (`brain` for community sessions); a guided-topic reconnect reports `lesson`.
CURL: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/alive

## Not verified live

- **Not deployed.** The reconnect rebuild has had no event until now, so how often it fires is unknown. `context_rebuilt_on_reconnect` is the first measurement.
- **LiveKit has no live traffic**, so its change is verified by tests only.
