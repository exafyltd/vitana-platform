# VTID-04881 — LiveKit navigation sends intent, entity ids, the member's words and language

The LiveKit orb-agent (standby voice worker) calls the gateway's shared tools
through `POST /api/v1/orb/tool`. Its navigation wrappers sent less than the
tools need:

- `navigate` sent no `intent`. The gateway treats a missing intent as "where",
  so on this pipeline "open my wallet" only ever got an offer and never opened
  anything. It also sent no `is_mobile`, which would open desktop routes on
  phones once "open" works.
- `navigate_to_screen` sent only `target`. Every screen about one item (a
  conversation, a group, a profile, a match, the event/meetup/profile panels)
  failed with `missing_param`.
- Neither sent the member's own words (`transcript_excerpt`, VTID-04629),
  which orb-live.ts injects server-side for Vertex and Nova.
- `/orb/tool` built the identity with no `lang`, so every shared tool answered
  LiveKit members in English.

## Change

- `tools.py`:
  - `navigate(question, intent)`: `intent` is required. It is normalised to
    open/where, and anything else is "where", the gateway's own default. The
    call forwards `is_mobile`, `is_anonymous` and the member's words.
  - `navigate_to_screen(screen_id, target, reason, keep_orb_open, …)`: forwards
    `NAVIGATE_TO_SCREEN_ENTITY_ARGS` (`recipient_id`, `chat_group_id`,
    `groupId`, `roomId`, `match_id`, `intent_id`, `vitana_id`, `id`,
    `event_id`, `meetup_id`, `user_id`) under the gateway's own names. A
    value is forwarded only when it is non-empty.
  - One `_track_route` helper for both wrappers. It uses `base_route`, and
    skips `already_there` and overlays.
  - Every `/orb/tool` call carries the member's `lang`. **No session id is
    ever sent** (plan sparring F9).
- `session.py`: the final user transcript is kept on the GatewayClient
  (`last_user_text`, capped at 500 characters when sent).
- `routes/orb-tool.ts`: `toolCallLang()` accepts a short locale, reduced to its
  base code, into the identity. A body `session_id` is never read; user,
  tenant and role still come from the JWT.
- `voice-pipeline-spec/spec.json`: `navigate_to_screen` is implemented on
  vertex and livekit.

## Acceptance criteria

AC-1: `navigate` sends `intent` ("open" only when the model said so) together
  with `is_mobile`, `is_anonymous` and the member's words. `intent` has no
  default.
TEST: pytest services/agents/orb-agent/tests/test_nav_tool_args.py (local; no CI job runs orb-agent pytest)

AC-2: `navigate_to_screen` forwards every entity id under the gateway's name,
  leaves out empty ones, and still accepts a legacy `target` alone. The
  forwarded set covers every `:param` and overlay param in the vitana-v1
  registry; this was mutation-checked by removing `event_id`, which the test
  catches.
TEST: pytest services/agents/orb-agent/tests/test_nav_tool_args.py

AC-3: both wrappers track the current page the same way (base_route; no move
  on already_there, an overlay, or an offer).
TEST: pytest services/agents/orb-agent/tests/test_nav_tool_args.py

AC-4: every tool call carries `lang` and never a session id. The route accepts
  only a valid locale, ignores a body session id, and keeps identity from the
  JWT.
TEST: npx jest test/routes/vtid-04881-orb-tool-lang.test.ts

AC-5: the customer support pipeline is unchanged (rule 42c).
TEST: npm run test:support

## Not in this change

- Deploying the orb-agent to production. It is a standby worker with a
  manual-dispatch-only deploy, so that stays a separate decision.
- LiveKit navigator OASIS events stay ungrouped by session.
- The orb-agent suite had 23 failures before this change, all from the local
  environment, which lacks livekit-agents. The set is identical before and
  after; this change adds 30 passing tests.
