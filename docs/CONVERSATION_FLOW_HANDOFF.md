# Conversation Flow — Handoff for the Command Hub "Conversation" section

**Audience:** the next session's agent, tasked with building a new **"Conversation"**
section in the Command Hub that visualises and configures the conversation-flow
engine described here.

**Status:** the engine below is built and live on the gateway (Vertex ORB path).
This doc is the contract the Command Hub UI should mirror — read it as the source
of truth for what the "Conversation" section must show and let an operator tune.

---

## 1. The mental model (what we built)

Every time a user opens Vitana, ONE decision is made from the **full context**,
rendered at the right depth, and it **always ends on a guided next step**. No more
ladder of disconnected greeting rungs.

```
            ┌──────────────────────── CONTEXT BUNDLE (assembled once) ───────────────────────┐
            │ recency (describeTimeSince) · identity+memory · where-we-left-off · journey ·   │
            │ what's-new (Index move, matches, messages, reminders, calendar) · entry screen  │
            └───────────────────────────────────┬────────────────────────────────────────────┘
                                                 ▼
                                   decideOpeningRegister()              ← recency FIRST
                                                 ▼
   first_time · daily_briefing · continue · quick_resume · same_day      ← the REGISTER
                                                 ▼
                                   selectNextBestAction()                ← the always-guiding step
                                                 ▼
                          one composed first-turn directive → the LLM speaks it
```

Two invariants the user insisted on:
1. **Recency is the primary gate** — a return after 1 minute must never be greeted
   "Guten Morgen". The register encodes this.
2. **Vitana always guides** — every register closes on a concrete, real next step
   (the Next-Best-Action), spanning the two north stars: **community engagement**
   and **health improvement**.

---

## 2. The registers (recency-first decision)

`decideOpeningRegister({ bucket, isFirstTime, briefingDue })` →

| Register | Trigger | Behaviour | Greeting? |
|---|---|---|---|
| `first_time` | never onboarded | onboarding welcome | ✅ |
| `daily_briefing` | `briefingDue` (first session of a real day; any gap length) | full rich briefing, once/day | ✅ time-of-day |
| `continue` | bucket `reconnect` (<2 min) | no greeting — pick the thread back up + NBA | ❌ |
| `quick_resume` | bucket `recent` (<15 min) | micro-ack, NO time-of-day, + NBA | ❌ |
| `same_day` | bucket `same_day`/`today` (hours, same day) | light re-entry + what's-new + NBA | ⚠️ light |

- **Recency buckets** come from `services/guide/temporal-bucket.ts` →
  `describeTimeSince` (8 buckets: reconnect/recent/same_day/today/yesterday/week/long/first).
- **`briefingDue`** = the durable once-per-day flag `user_journey.last_full_briefing_date`
  is stale for today (user tz). Multi-day gaps (yesterday/week/long) always have a
  stale flag → they resolve to `daily_briefing`.

---

## 3. The Next-Best-Action (NBA) engine — "always guiding"

`services/conversation/next-best-action.ts` — pure function over the rich
`OverviewPayload`. Ranks every **grounded** action (gated on real data; never
bluffs) by **band = value × timeliness**, then picks the top to lead the close.

| Band | Group | Actions (key) | Source signal |
|---|---|---|---|
| 100–92 | time-sensitive / waiting | `reminder_due`, `autopilot_step`, `reply_messages` | reminders_today, autopilot.today_checkpoint, messages_unread |
| 80 | continuity (journey thread) | `next_session` | guided_journey.next_session_title |
| 62–58 | health momentum | `diary_entry`, `focus_pillar` | diary_last_7d===0, vitana_index.weakest_pillar |
| 44 | community growth | `review_matches` | matches_unread |
| 30 | community growth (always-available, rotated) | `make_post`, `create_activity`, `connect_community` | — (rotation seed = day-of-year) |
| 26 | setup | `set_goal` | life_compass.state==='not_set' |

**North-star mapping:**
- **Community engagement:** reply_messages, review_matches, make_post, create_activity, connect_community
- **Health improvement:** autopilot_step, diary_entry, focus_pillar, next_session, set_goal

**Non-repetition (DONE):** the opener ADVANCES — it never repeats the same
suggestion two opens in a row. A durable per-user history `user_journey.recent_nbas`
(jsonb array of action keys, last ~8) is read in the greeting prefetch and passed
to `selectNextBestAction({ recentKeys, cooldown: 3 })`, which skips the last 3
suggestions and picks the next-best fresh action; the chosen key is appended after
speaking. The resume prompt is also told `already_offered_recently` so the model
explicitly moves the conversation forward. The day-of-year `rotationSeed` still
varies ties within the always-available community-growth pool.

---

## 3b. Screen awareness & action COMPLETION

Vitana knows the user's current screen (`session.current_route`, sent by the
client at session start, kept fresh on navigation) and uses it to **deepen toward
completing the action**, never to redirect the user to a screen they are already
on.

- `services/conversation/screen-surface.ts` — `surfaceForRoute(route)` maps a
  route to a `ConversationSurface` (matches / chat / community / diary / index /
  profile / journey / news / home / other); `screenCompletionFor(surface)` returns
  the **completion action** (band 115, above every redirect/discovery action) and
  the `redirect_key` to suppress while on that surface.
- In `buildResumeDirective`, when the user is on an actionable surface the next
  step becomes the completion action — e.g. on **/matches**: *pick one and start a
  joint activity / tell them who a match is / suggest an Index-boosting activity /
  refine criteria / enrich profile* — and the prompt is told `current_screen` +
  `complete_on_current_screen` with a HARD rule never to say "open X" while on X.

Completion mapping (the goal is to FINISH, not navigate):

| Surface | Completion next step |
|---|---|
| matches | pick a match & start a joint activity / who is this person / Index-boosting activity / refine criteria / enrich profile |
| chat | actually write & send the reply |
| community | draft & publish the post / create the activity |
| diary | make today's entry now (lifts the Index) |
| index | one concrete weakest-pillar action to raise it |
| profile | add one more profile detail → better matches |

**Telemetry:** `current_route` is now on the `conv_resume` greeting event.
**Command-Hub:** the "Conversation" section should show the per-surface completion
map and let an operator edit the completion offers (ideally policy-backed).

## 3c. Capability-gating — guidance that actually EXECUTES

The opener guides; the user accepts; it must **complete the action**, not stall on
"Das konnte ich leider nicht umsetzen". Every next-step action is now mapped to
the **real, registered ORB tool** that executes it (`CAPABILITY_BY_KEY` in
`next-best-action.ts`, verified against `ORB_TOOL_REGISTRY`):

| Action | Executes via |
|---|---|
| reply_messages / connect_community / complete_chat | `send_chat_message` |
| review_matches | `view_intent_matches` |
| complete_matches | `respond_to_match` |
| create_activity | `share_intent_post` |
| make_post / complete_post | `create_community_post` |
| diary_entry / complete_diary | `save_diary_entry` |
| focus_pillar / complete_index | `create_index_improvement_plan` |
| autopilot_step | `activate_recommendation` |
| next_session | `narrate_guided_session` |
| reminder_due, set_goal, complete_profile | _no one-shot tool → GUIDE the user_ |

The resume directive ships `suggested_next_step.execute_with_tool` and a HARD rule:
on acceptance, **call that tool**; if null, **guide step-by-step** and never promise
to do it. This stops over-promising and turns guidance into completion. (Most tools
already existed — the gap was wiring, not capability.) **Follow-up:** build a real
`update_profile_field` tool (verify `app_users`/`profiles` schema first) so
`complete_profile` graduates from guide-only to executable.

## 3d. Tool-execution observability — telemetry + self-check harness

Guidance can route perfectly and still end in "I couldn't do that" if the
underlying tool fails. Two pieces make that observable + fixable without a voice
session:

- **Tool-failure telemetry:** `executeLiveApiTool` (orb-live.ts) now emits an
  `orb.live.diag` stage `tool_failed` to `oasis_events` for both HARD failures
  (`success=false`) and SOFT ones (handler returned `ok:false`/a `reason`). Every
  "I can't" is now queryable: `select metadata->>'tool', metadata->>'detail' from
  oasis_events where topic='orb.live.diag' and metadata->>'stage'='tool_failed'`.
- **Self-check harness:** `POST /api/v1/admin/orb-tools/selfcheck { user_id }`
  (`routes/orb-tools-selfcheck.ts`, admin-gated) runs the capability tools via the
  SAME dispatcher the voice path uses, against the user's real data, and returns +
  emits (`orb.tools.selfcheck`) a per-tool pass/fail + exact error. Read tools run
  live; `create_index_improvement_plan` writes calendar events and is cleaned up.
- **Diagnosable writes:** `createCalendarEvent` now takes an `onError` sink, so the
  index-plan tool reports the real PostgREST reason when a calendar write fails
  (previously swallowed to Cloud Run logs).

The Command-Hub "Conversation" section should surface the `tool_failed` feed and a
button to run the self-check for a user.

## 4. Where everything lives (file map)

| File | Role |
|---|---|
| `services/gateway/src/services/conversation/next-best-action.ts` | NBA engine (ranking + select), pure over OverviewPayload |
| `services/gateway/src/services/conversation/decide-opening.ts` | register decision + resume-directive composition |
| `services/gateway/src/services/assistant-continuation/providers/new-day-overview-payload.ts` | `gatherOverviewPayload` — the context bundle (journey, index, life_compass, calendar, autopilot, matches, messages, reminders, diary, guided_journey, recall) |
| `services/gateway/src/services/assistant-continuation/providers/new-day-overview-prompt.ts` | `buildNewDayOverviewBlock` — the rich daily-briefing render |
| `services/gateway/src/services/guide/temporal-bucket.ts` | `describeTimeSince` — recency buckets + motivation signal |
| `services/gateway/src/routes/orb-live.ts` (`sendGreetingPromptToLiveAPI`) | integration: register routing for the Vertex SAFE-FAST path |
| `services/gateway/src/orb/live/session/live-session-controller.ts` | greeting-facts prefetch (name, lastSessionInfo, journey, briefing flag) |
| `docs/CONVERSATION_FLOW_ARCHITECTURE.md` | the broader "one brain, many mouths" architecture (memory §11, journey §10) |

---

## 5. Telemetry the Command Hub should READ

Greeting decisions are emitted to `oasis_events` (topic `orb.live.diag`, stage
`greeting_sent`) with these fields in `metadata`:

- `wake_opener`: `conv_resume` (new unified resume) | `safe_fast_newday_overview`
  (daily briefing) | `safe_fast_first_time_welcome` | `safe_fast_proactive`/`safe_fast_newday` (fallbacks)
- `register`: `continue` | `quick_resume` | `same_day` (on `conv_resume`)
- `bucket`: the recency bucket
- `nba` / `nba_domain`: the chosen next-best-action key + domain
- `briefing_date`: stamped on the daily briefing
- `overview_signals`: the per-signal inventory on the briefing

**Query example (recent openers):**
```sql
select created_at,
  coalesce(metadata->>'wake_opener', meta->>'wake_opener') as wake_opener,
  coalesce(metadata->>'register', meta->>'register')       as register,
  coalesce(metadata->>'bucket', meta->>'bucket')           as bucket,
  coalesce(metadata->>'nba', meta->>'nba')                 as nba
from oasis_events
where topic='orb.live.diag'
  and coalesce(metadata->>'stage', meta->>'stage')='greeting_sent'
order by created_at desc limit 50;
```

---

## 6. What the "Conversation" section should DO (build spec)

1. **Live decision feed** — stream recent opens with register + recency bucket +
   chosen NBA + which signals were present (from the telemetry above). Lets an
   operator see *why* Vitana said what it said.
2. **Register distribution** — counts of first_time / daily_briefing / continue /
   quick_resume / same_day over time; flag anomalies (e.g. too many bare fallbacks
   `safe_fast_newday` → something is mis-gating).
3. **NBA distribution** — which next steps Vitana is suggesting, split by domain
   (community vs health), to confirm the engagement/health balance the business wants.
4. **Action catalog editor** — view/tune the NBA bands and the community-growth
   rotation pool (see §3). Ideally back this with `decision_policy` keys (see the
   policy-resolver in `services/decision-contract/`) so changes need no redeploy.
5. **Register thresholds** — surface the recency thresholds (reconnect <2m, recent
   <15m, same_day <8h…) and the cooling/absent day boundary (already policy-driven:
   `SESSION_MOTIVATION_COOLING_TO_ABSENT_DAYS`). Make them viewable, ideally editable.
6. **Per-user simulator** — given a user_id, show the assembled context bundle, the
   register that would be chosen, and the NBA — a dry-run of `decideOpeningRegister`
   + `selectNextBestAction` without speaking. (Expose a gateway debug endpoint that
   calls the two pure functions over a freshly gathered payload.)

**Suggested gateway support to add for the UI:** a read-only debug route, e.g.
`GET /api/v1/admin/conversation/preview?user_id=…` returning
`{ bundle, register, nba, ranked_nbas }` by calling `gatherOverviewPayload` +
`decideOpeningRegister` + `rankNextBestActions`. (Not built yet — first task for
the Command-Hub session.)

---

## 7. Open follow-ups (carry into the build)

- [ ] Per-user NBA rotation history (§3) so suggestions don't repeat.
- [ ] Multi-day `welcome_back` warmth: today multi-day gaps fold into
  `daily_briefing`; consider passing `motivation_signal` into the briefing render
  so a 10-days-away open explicitly acknowledges the absence.
- [ ] Optimise the resume path: it gathers `gatherOverviewPayload` at greeting
  time (bounded 1800ms). Move it into the existing greeting-facts prefetch so the
  reopen is instant.
- [ ] Converge transports: LiveKit / the 3rd provider should call the SAME
  `decideOpeningRegister` + NBA (the "one brain, many mouths" goal in
  `CONVERSATION_FLOW_ARCHITECTURE.md`). Vertex is wired first.
- [ ] Standing-instruction guidance: keep the chosen NBA + memory in the system
  instruction for turns 2+, so Vitana keeps nudging the next step mid-conversation,
  not just at the open.
- [ ] Debug preview endpoint (§6) for the simulator.

---

## 8. Change log

| Date | Change |
|---|---|
| 2026-06-27 | Phase 1: unified opening decision (registers, recency-first) + Next-Best-Action engine wired into the Vertex SAFE-FAST path; durable once-per-day briefing flag; this handoff authored for the Command-Hub "Conversation" section. |
