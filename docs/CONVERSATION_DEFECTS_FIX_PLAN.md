# Conversation logic defects — fix plan

**Source:** operator-reported ORB text-chat transcripts (preview.vitanaland.com,
2026-06-30), verified against gateway code. Companion to
`docs/CONVERSATION_FLOW_ROADMAP_V3.md` (the consolidate-first roadmap) — this doc
is the concrete defect list + fixes those steps must deliver.

**Cross-cutting root cause (all six defects):**
1. **No single brain** choosing a coherent, topic-continuous, **intent-first** move
   each turn — the model free-associates and staples canned offers.
2. **Missing READ capabilities** — no tool to view messages, followers/following,
   or recent conversations — so the assistant **deflects or hallucinates**.
3. **Capabilities mis-bound to the wrong system** — internal community messages get
   routed to Google/Gmail.
4. **Disambiguation ignores exact hits** — asks you to choose among 3 when one is a
   100% match.
5. **Offers ungrounded in capability** — it proposes actions it cannot execute
   (offer-then-fail).

Instance-fixable now: **#1, #2, #4, #5** (add the missing read tools; fix named
disambiguation; enforce internal-vs-external separation). **#3, #6** are the brain
problem — mitigations are instance, the real fix is `decideConversationFlow()`
(roadmap Steps 1–3). Every defect becomes a permanent replay-suite assertion.

---

## Defect 1 — hallucinated "archived messages"
- **Symptom:** user has 8 unread; Vitana offers *"Möchtest du dir die archivierten Nachrichten ansehen oder deine Matches?"*
- **Root cause (verified):** **no read/view-messages tool** — only `tool_send_chat_message` (send/reply). The unread count comes from the briefing (`messages_unread` signal), but there is no capability to open the unread thread → the model fabricates a category ("archived").
- **Fix:** `view_messages` tool over `chat_messages` (`receiver_id = user AND read_at IS NULL`), **speakable** (senders + snippets), navigates to inbox on app surfaces. HARD rule: only offer states that exist (**unread / all**); **never** "archived".
- **Test:** N unread → speakable list; offered options never contain "archiv/archived".

## Defect 2 — exact match still asks for the other two names
- **Symptom:** user names "Mariia Maksina", system finds her (100%), yet asks about 2 other names.
- **Root cause:** `tool_find_match` → `runFindMatch` (`services/intent-find-match.ts`) returns fuzzy candidates and disambiguates even on an exact name hit. The dominant-score gate (`INTENT_MATCH_AUTONAV_GAP = 0.15`) governs `view_intent_matches`, but a **named-person lookup must short-circuit disambiguation on an exact name match**.
- **Fix:** in `runFindMatch`/`find_match`, when the query is a specific name and a candidate matches exactly (case/space-insensitive) OR dominates by the gap → select it directly, no alternates. Disambiguate only on genuine ambiguity.
- **Test:** named query, 1 exact + 2 fuzzy → selects the exact one; text does not ask to choose among names.

## Defect 3 — context-blind next-step (unrelated plan stapled onto the thread)
- **Symptom:** *"16 neue Matches und 8 ungelesene Nachrichten. Ich schlage vor, wir erstellen einen Plan, um deinen Bewegungs-Score zu verbessern."* — and, in a later transcript, right after failing a "who follows me" question: *"Du hast 8 neue Nachrichten. Ich schlage vor, wir schreiben eine Antwort zusammen."* The next-step fires **after a deflection**, doubles down, and never answers the actual ask. "Fly to the moon" would be the same logic.
- **Root cause:** `suggested_next_step` is the **session-opening NBA** (`selectNextBestAction` over the static overview payload in `decide-opening.ts`: weakest pillar → `focus_pillar` → `create_index_improvement_plan`). It is chosen once at open, **not bound to the live topic**, and the rule *"ALWAYS finish with `suggested_next_step`"* staples it on every turn.
- **Fix:**
  - **Instance mitigation:** topic-lane guard — when the active topic is community/social, the next step stays in that lane; suppress the health-plan NBA unless the topic is health/idle. Make *"always end on suggested_next_step"* **conditional** — never bolt on an off-topic suggestion; if the coherent move is answering the user, do that.
  - **Real fix (brain, roadmap Step 1–2):** `decideConversationFlow()` selects the next step from the **full live context each turn** — topic-aware, not a static opening pick.
- **Test:** user engaged with matches/messages → next step is a messages/matches action, **never** `create_index_improvement_plan`; a plan is offered only when the topic is health/idle, and never right after a failed answer.

## Defect 4 — offers unread messages, then demands a Google account to show them
- **Symptom:** *"Du hast zehn ungelesene Nachrichten; ich schlage vor, wir sehen uns die an."* → user "Ja, zeig mir das mal." → *"Ich kann das noch nicht überprüfen, da du dein Google Konto noch nicht verbunden hast. Soll ich dich zu den verbundenen Apps bringen?"*
- **Two failures:** (a) **offer-then-fail** — proposed, accepted, undelivered; (b) **wrong-system binding** — internal community messages routed to a **Google/Gmail "connected apps"** dependency. Internal messages need no external account.
- **Root cause:** (a) still no internal view-messages tool (Defect 1) → the model mis-binds "messages" to the Google/email integration and invents a connection requirement; (b) the opener offers "let's look at your messages" grounded only on the **count**, not a real **capability**.
- **Fix:** (1) `view_messages` (Defect 1) — internal, no external account. (2) **HARD separation:** internal community messages/matches/notifications ≠ Google/Gmail/connected-apps; "show my messages/matches" must **never** route to Google. Google integration is only for explicit email/calendar/Google requests. (3) **Offer-integrity** (offer-binding, roadmap Step 2): the opener may only propose actions it can execute.
- **Test:** internal unread + "show them" → opened via `view_messages`; response **never** mentions Google/connected-apps; the messages offer is only made when fulfillable.

## Defect 5 — can't answer basic self-social-graph questions
- **Symptom:** *"gibt es in der Community Personen, die mir folgen?"* → *"Ob dir Personen folgen, kann ich dir nicht direkt sagen. Du kannst aber … suchen … Soll ich dich dorthin bringen?"* — then the user: *"…sagst mit wem ich zuletzt geschrieben habe."*
- **Root cause (verified):** no ORB tool for the user's **own** social graph. There are `search_community` / `find_community_member` / matches tools, but nothing for **followers / following / recent conversations / last contact**. The data exists (relationship graph `relationship_nodes`/`relationship_edges`; `chat_messages`) — the capability doesn't. So she deflects to a manual member-list search.
- **Fix:** add read tools: `list_followers` (who follows me), `list_following` (who I follow), `recent_conversations` / `last_contact` (who I last messaged). Query the relationship graph + `chat_messages` (latest per contact). **Speakable** ("Dir folgen 12 Personen — zuletzt X und Y" / "Zuletzt hast du mit X geschrieben"). Map these questions to these tools directly; **never** deflect to "search the member list".
- **Test:** "who follows me" → count + names via tool; "with whom did I last chat" → the last contact; never "kann ich dir nicht direkt sagen".

## Defect 6 — leads with a canned offer instead of understanding + answering
- **Symptom:** the user's own words: *"…erstmal erklärst du mir, ob du mich überhaupt verstehst."* Vitana keyword-matches "community/messages/matches" to a canned suggestion instead of parsing and answering the literal question. She never confirms or demonstrates comprehension.
- **Root cause:** the flow **leads with a pre-baked next-step** (opener/NBA + "always end on a suggestion") rather than first resolving **intent** and **answering the question asked**. Keyword-triggered offers outrank genuine Q&A.
- **Fix:**
  - **Real fix (brain, roadmap Step 1–2, intent contract):** the brain first resolves the user's intent and **answers the actual question**, THEN optionally offers a next step. "Answer what the user asked" outranks "inject a suggestion."
  - **Instance mitigation:** when the user asks a factual question (follows/last-contact/unread), route to the data tool and answer; suppress the reflexive suggestion.
- **Test:** a direct factual question is answered from a tool before any suggestion; the assistant does not open with an unrelated canned offer.

---

## Ordered execution
1. **[instance] Missing READ capabilities (one workstream):** `view_messages` (unread) + `recent_conversations`/`last_contact` + `list_followers`/`list_following`, all over existing data, all **speakable**. → kills Defects **1, 4(a), 5** and the "can't tell you" deflections.
2. **[instance] Internal-vs-external hard separation** (community messages/matches/social ≠ Google/Gmail). → kills Defect **4(b)**.
3. **[instance] Named-match exact short-circuit** in `runFindMatch`/`find_match`. → kills Defect **2**.
4. **[instance mitigation → brain] Intent-first + topic-bound next-step:** answer the actual question first; suppress off-topic/canned suggestions; select the next step against the live topic. → kills/mitigates Defects **3, 6**; full fix = `decideConversationFlow()` (roadmap Steps 1–3).
5. **[guardrail] Golden failing scenarios** from every transcript here (Mariia-Maksina disambiguation, the Google-account offer-then-fail, the followers deflection, the movement-plan pivot) with hard assertions — must pass before the brain work merges.

## Roadmap mapping
Defects 1/2/4/5 = surface/capability instance fixes (do now, each with a flow test).
Defects 3/6 = the reason for the consolidate-first single brain (v3 roadmap Steps 1–3).
All six become permanent replay-suite assertions (Step 3).
