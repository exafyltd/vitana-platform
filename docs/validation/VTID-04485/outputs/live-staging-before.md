# VTID-04474 — live staging run, 2026-09-24 (gateway 62bd99f, task def vitana-gateway:563)

Harness: scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated, LANG_CODE=en,
test account a27552a3-0257-4305-8ed0-351a80fd3701, English utterances synthesized as 16 kHz PCM.

| # | Surface | Utterance | Tool called | Outcome |
|---|---|---|---|---|
| 1 | vitanaland (member) | "What is the status of my support tickets? Do I have any open ones?" | ask_support_specialist | agent_runs row `support`, status succeeded, 3.0 s, tools_used [list_my_tickets], findings "no open support tickets" (correct for this account). Voice ack returned at 1.51 s as `working`; the member heard "the support specialist is looking it up", NOT the answer → VTID-04485. |
| 2 | vitanaland (member) | "How do I change my notification settings?" | navigate → /settings/notifications | Correct: a navigation question, not a specialist one. |
| 3 | commerce (route /commerce) | support question | ask_commerce_specialist | Refused by policy in 0.3 s: `role ceiling for commerce is none` — the test account has no partner-organization membership. Correct refusal; Vitana said honestly it could not check. The support tool is not declared on commerce (surface isolation holds). |

Not tested: the commerce positive path (needs a partner organization for the test account — not approved), cancel_delegation.

Cleanup (owner instruction "after test, delete it from database"): every row the three sessions created for the
test account after 13:14 UTC was deleted in one transaction — agent_runs 1, memory_items 3, memory_transcript_turns 3,
user_session_summaries 3, user_open_threads 2, user_assistant_state 2, assistant_promises 1, memory_audit_log 4,
user_activity_log 35, product_analytics_events 8. Re-count afterwards: 0 in every user-keyed table; memory_items back to
the 36-row baseline. oasis_events kept (audit trail).
