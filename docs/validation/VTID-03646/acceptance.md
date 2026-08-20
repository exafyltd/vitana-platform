# VTID-03646 — Acceptance

**The proactive ORB conversation flow was gone because the rich new-day briefing
could not fire on any production session, and the one opener every session did
reach was instructed to dead-end.**

Reported live: Vitana opens voice with *"ich zeige dir die neuesten Nachrichten"*
and then drops into listening mode — no content, no proposed next step, no
confirmation.

## The three defects

1. **`shouldAttemptNewdayOverview()` required a first name production never has.**
   The name comes from the greeting-facts prefetch, gated on
   `isFeatureLive('ORB_SAFE_FAST_GREETING')`, which is `staging-only`. Measured on
   prod: **every** `newday_briefing_eval` on 2026-08-15 reported
   `outcome:guard_rejected` with `has_first_name:false`. One conjunct rejected
   100% of briefings. The name was never load-bearing for the CONTENT —
   `buildNewDayOverviewBlock` has always had an explicit unknown-name branch.

2. **The rung was also kill-switched off** (VTID-03628) on a theory VTID-03629's
   own writeup disproved. Prod agrees: zero `newday_overview` events have ever
   been recorded, and content-filter blocks continued for days after it went
   dark. VTID-03647 later traced those blocks to the guided-topic narration
   instruction — a different code path.

3. **`override_v2` was instructed to dead-end.** Its trigger said *"ONE short
   utterance only… NO QUESTION AFTER."* That is the reported behaviour verbatim.
   The model was obeying; the directive was the bug.

---

AC-1 — The briefing guard no longer requires a first name, so a production
session (where the prefetch never runs) can reach the rung at all. Every other
guard — already-briefed-today, onboarding, first-time, user/supabase — is
unchanged and independently pinned, so widening this one cannot widen those.
TEST: services/gateway/test/services/conversation/conversation-flow-regression.test.ts
  ("the guard passes with a null first name", "the rung still rejects when …")

AC-2 — The briefing's spoken content is correct without a name: it must carry the
"do not invent one" instruction rather than a null/undefined leaking into the
directive. The unsafe `(ctx.firstName as string).trim()` cast — only safe because
the old guard rejected null — is gone with it.
TEST: services/gateway/test/services/conversation/conversation-flow-regression.test.ts
  ("addresses the user without a name rather than inventing one")

AC-3 — `override_v2` delivers the three-beat contract (SUBSTANCE → NEXT STEP →
CONFIRMATION) and no longer carries the dead-end directive. Asserted by absence
as well as presence: the removed "ONE short utterance / no question after / say
exactly" wording must not reappear by any route.
TEST: services/gateway/test/services/conversation/conversation-flow-regression.test.ts
  ("override_v2 delivers, proposes, and asks")

AC-4 — The contract is language-neutral. VTID-03644 shipped the retired
per-language table missing pt/pl; one English INTENT cannot drift per locale, so
all ten locales get the same three beats and the same pinned lead.
TEST: services/gateway/test/services/conversation/conversation-flow-regression.test.ts
  ("the intent is language-neutral — no per-language sentence table survives")

AC-5 — A guided-topic (My Journey) candidate does NOT get the three-beat
contract. Proposing a next step and asking for confirmation before anything has
been taught is the skip-ahead VTID-03686 forbade. It keeps the plain
short-utterance opener VTID-03674 fell back to, and none of the "translate it
faithfully / fluent <language>" phrasing that tripped Nova's content filter.
TEST: services/gateway/test/services/conversation/conversation-flow-regression.test.ts
  ("a guided-topic lesson does NOT get the three-beat contract")

AC-6 — A silent reconnect still outranks the briefing and stays silent. A
briefing is the loudest possible thing to say into a reconnect.
TEST: services/gateway/test/services/conversation/conversation-flow-regression.test.ts
  ("a silent reconnect still outranks it and stays silent")

AC-7 — The kill switch survives the default flip: `ORB_NEWDAY_OVERVIEW_RUNG_ENABLED`
still disables the rung, and `day_close` stays default-OFF (it is the rung
actually observed firing and being blocked, and is not implicated in this report).
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("disabling makes BOTH ladders fall through", "re-enabling restores the rung")

---

## OASIS_PROOF

This changes what `orb.live.diag` emits, so the deploy is verifiable from
telemetry alone — and, until now, `newday_overview` has NEVER appeared there:

```sql
-- before this change: 0 rows, all time
select metadata->>'wake_opener' as opener, count(*)
from oasis_events
where topic = 'orb.live.diag'
  and metadata->>'wake_opener' = 'newday_overview'
  and created_at > now() - interval '7 days'
group by 1;

-- and the guard that rejected every briefing:
select metadata->>'outcome', metadata->>'has_first_name', count(*)
from oasis_events
where topic = 'orb.live.diag' and metadata->>'stage' = 'newday_briefing_eval'
  and created_at > now() - interval '2 days'
group by 1,2;
--   before: outcome=guard_rejected, has_first_name=false, 100% of rows
```

Post-deploy the second query must start reporting outcomes other than
`guard_rejected`, and the first must start returning rows. If it does not, the
briefing is still not firing and this fix did not land.

## Verification scope — read-only

Local tests, `tsc --noEmit`, and read-only production SELECTs against
`oasis_events`. No production write, no ORB session started, no deploy, per the
standing rule in CLAUDE.md.

## Known VALIDATOR-CHECK limitation

This PR also changes `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` (the
EMPTY-preserving dispatch input that makes the kill switch reachable without a
PR — the VTID-03513 lesson) and `CLAUDE.md` (the changelog row this repo requires).
Neither path is in either VALIDATION_PROFILE's allowlist, so this check reports
exit 22 regardless of the evidence above. Splitting the workflow binding into a
separate PR would put the kill switch and its lever in different commits, which
is the failure mode the input exists to prevent. Flagged for a human decision
rather than worked around — same posture VTID-03683's own pack took on exit 20.
