# VTID-04918 — Vitana assistant parity for the calendar (create, move, cancel, share to the feed, invite)

Plan: `plan-sparring.md` (converged, 3 rounds, plan hash `e64911d9c6d0734acc94b829b02e0991ac172df64b28a7895bebc46b6f06ac38`), Phase 4.
Platform only: the gateway's shared tool registry, the text chat operator, the LiveKit agent's tool wrappers, the role registry and the calendar instruction-manual page. No migration, no app change.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. The tools run through the existing shared dispatcher `POST /api/v1/orb/tool` (`services/gateway/src/routes/orb-tool.ts`, `requireAuth`), the gateway live session's default tool arm (`routes/orb-live.ts`) and the text operator's `executeTool` (`services/gemini-operator.ts`).

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/orb/tool` (staging).

CURL_PROOF: staging probe — an unauthenticated `POST /api/v1/orb/tool` answers 401 (`staging-tests.json`). No authenticated call is made against any shared environment: these tools write calendar entries, feed posts and chat messages for real members.

OASIS_PROOF: `calendar.event.created`, `calendar.shared_to_feed` and `calendar.invite.sent` (vtid VTID-04918, `payload.via = 'assistant'`) after a confirmed write.

## Acceptance criteria

AC-1: One implementation for every assistant path: `create_calendar_event`, `share_calendar_entry_to_feed` and `invite_to_calendar_entry` are handlers in the shared ORB_TOOL_REGISTRY, reached by the gateway live session, the LiveKit agent (POST /api/v1/orb/tool) and text chat. The live session's own create_calendar_event arm delegates to the shared handler (no second implementation; ORB-TOOLS-LIFT-SCANNER parity gate).
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
  TEST: services/gateway/test/vtid-04356-calendar-source-producers.test.ts
AC-2: The shared guard holds in the handlers: nothing is created, posted or sent until `confirmed === true`, and never for a time that has passed (an event that has begun but not ended is still open). The preview returns what to read back; the wording is the model's (rule 41).
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
  TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
AC-3: The gateway live session additionally refuses every calendar write tool before the member has spoken (memberHasSpoken).
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
AC-4: Share to the feed reuses the Phase 2 service (`shareCalendarEntryToFeed`): only an upcoming community event or live room; its refusals (already shared, limit, duplicate, suspended) are named.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
AC-5: Invite reuses the Phase 3 card builder (`buildInviteFromEntry`): the server-built card goes into the direct chat with a person resolved by resolve_recipient (never the member themselves), under the voice send quota, with the same chat push as the app's send route; a refused entry sends nothing.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
AC-6: reschedule_event never moves an event into the past (every path); text chat moves an event only after confirmation.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
  TEST: services/gateway/test/orb-tools/calendar-management-tools.test.ts
AC-7: Text chat offers create, reschedule, cancel, share and invite, each through the shared dispatcher.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
AC-8: The LiveKit agent's create_calendar_event goes through the shared dispatcher (guarded) instead of the unguarded direct calendar POST; add_to_calendar and get_schedule mean the connected external calendar, as on the gateway; share and invite are available.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
AC-9: The community role lists the real calendar tools; the never-built get_calendar_today/week names are gone. Role separation stays green.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Decisions taken
- Text chat's tools live in `services/gemini-operator.ts` (that is the text-DM path: `processConversationTurn` → `processWithGemini`); `vitana-brain.ts`'s `buildBrainToolDefinitions`/`executeBrainTool`, named in the plan, have no callers.
- Assistant invites go to direct chats only (a person resolved by resolve_recipient). Group invites stay in the app's picker.
- reschedule_event keeps its one-step flow on voice; text chat asks for confirmation first. Both refuse a past time.
- `calendar.event.created` for a voice-created entry is now emitted by the shared handler (vtid VTID-04918, same payload fields incl. session_id, plus `via`) instead of inline in orb-live.ts (VTID-01155). The report-only voice-pipeline parity scan therefore lists it as missing_in_vertex; it is emitted on that path through the dispatcher.
- Only the community role's stale `get_calendar_today/week` entries (plan: `assistant-role-registry.ts:116-117`) were replaced; the patient role's and the staging synthetic list's are untouched.

## Follow-up (Codex review on #4015)
- share_calendar_entry_to_feed: a confirmed call must carry `is_public`; leaving it out answers `STATUS: needs_visibility` and posts nothing, so a post approved as private can never fall back to public.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
- The live session's memberHasSpoken gate also covers reschedule_event, cancel_event and complete_event, and add_to_calendar (connected Google calendar) in its own capability arm.
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
