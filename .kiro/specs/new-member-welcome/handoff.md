---
slug: new-member-welcome
author: kiro
executor: kiro
next_actor: kiro
state: approved
vtids: [VTID-05205, VTID-05206, VTID-05207, VTID-05208]
sparring_record: .kiro/specs/new-member-welcome/plan-sparring.md
updated: 2026-10-15T12:45Z
---
# Handoff — New-member welcome experience (MAXINA)

Plan authored by Kiro at the owner's direct request (2026-10-15). Refines the approved VOA
plan (`docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md`): three private team welcome DMs
(generalises VOA §4.5.5 to Mariia + Jovana + Alex) and the "Say Hello 👋" new-member feed
card (refines VTID-04574). Spans vitana-platform (coach/gateway, config, claim migration)
and vitana-v1 (card opt-in, composer, migrations).

**Next actor: Claude Code.** Per collaboration §7 ("Kiro authors → Claude executes" when the
owner asks Kiro for a plan): Claude Code spars this plan (Opus-on-Bedrock, skill
`plan-sparring`), sends owner Gate 1, allocates VTIDs on "yes", then sets `next_actor: kiro`
on the lanes for implementation. Kiro has no sparring subagent and has not allocated a VTID.

Owner inputs captured (2026-10-15): approach = refine VOA. Senders — Mariia @mariia04
(67c971fc-…), Jovana @jovana4 (c7d3260d-…), Alex Blue @dragan1 (0adc6ff6-…). Alex Blue is a
**real human** → no AI-identity line. All three real members, same primary tenant, not in any
exclusion list (read-only lookup).

Open questions for sparring (details in design.md §S1–S6): S1 team-welcome text catalog vs
model-composed (Kiro recommends catalog); S2 extend-tick vs sibling-tick; S3 opt-in table +
default; S4 grouping window; S5 cohort scope; S6 Mariia account display_name discrepancy.

Lanes (all `ready`, executor kiro): team-welcome-backend; new-member-card-optin;
say-hello-composer (depends_on new-member-card-optin); grouped-welcome-notifications
(depends_on new-member-card-optin).

Seed wording for the three welcomes (Option A, tt() catalog) is drafted in
`content-welcome-seed.md` — en+de in full, EN source + intent notes for the other 9 locales,
for the sparring partner and the three senders to approve.

## Log
### 2026-10-15T09:40Z · kiro-202610150924-9ecd · created → drafted
Drafted requirements.md, design.md, tasks.md, content-welcome-seed.md, this handoff. Investigated existing onboarding
(VOA coach engine, touch ledger, welcome trigger), messaging (fire_welcome_chat_on_membership,
chat_messages), and News Feed (NewMemberCard, profile_post_comments, composer.ts) read-only.
Resolved the three sender handles to production user_ids read-only. No VTID, no lane claim, no
writes to any live system. next_actor: claude for sparring + Gate 1.
### 2026-10-15T11:30Z · session_01LKkSBuw1tGgnKzjhfcmAxj · drafted → sparred
Took the `_plan` claim. Sparred with the independent partner (2 rounds, CONVERGED): F1–F9 answered, six open questions S1–S6
decided in the record, plan hash `a538f236fda83b38`. Record: `plan-sparring.md` (copied to `docs/validation/<first VTID>/` on approval).
next_actor: owner — Gate 1 sent. No VTID allocated, no code written. On "yes": allocate four VTIDs, set the four lanes
`next_actor: kiro`, state → approved.

### 2026-10-15T11:40Z · session_01LKkSBuw1tGgnKzjhfcmAxj · sparred (revised after owner decision D2 = b)
Owner answered D2 between sparring rounds: the greeting is a private DM on explicit Send, not a public comment. Plan rewritten,
re-sparred (rounds 3–4, CONVERGED), plan hash now `d0ed907dc2c4f75e`. Spec files amended to match: requirements 2.4/2.9/2.11,
design.md Part B banner, tasks.md lanes B/C/D rewritten. **`tasks.md` and `plan-sparring.md` are authoritative for lane
dependencies:** `say-hello-composer` depends_on `new-member-card-optin` + `grouped-welcome-notifications`; the grouping lane is
now platform-side and dependency-free. The `lanes/*.md` files still show the pre-D2 dependencies and design pointers — the
collab validator allows one work lane per PR, so each lane file is updated in its own commit when that lane is released to Kiro.
No backing post / `post_kind` / trigger work remains. next_actor: owner — Gate 1 re-sent. Still no VTID, no code.

### 2026-10-15T12:10Z · session_01LKkSBuw1tGgnKzjhfcmAxj · sparred (owner answered D1 and sender consent)
Owner: D1 = default ON; no sender approval — the three welcomes go out automatically. Plan (S1, S3), seed file and design.md
note amended; plan hash now in `plan-sparring.md` header. Still `sparred`, next_actor: owner — waiting for the explicit Gate 1
approval of the plan. No VTID, no code.

### 2026-10-15T12:45Z · session_01LKkSBuw1tGgnKzjhfcmAxj · sparred → approved
Owner approved at Gate 1 ("yes", 2026-10-15; plan hash `f7cdefc3043249c5`; D1 default ON; no sender approval step; greeting is a
DM on explicit Send). VTIDs allocated and set `in_progress`/`approved` in the ledger: VTID-05205 `team-welcome-backend`,
VTID-05206 `new-member-card-optin`, VTID-05207 `say-hello-composer`, VTID-05208 `grouped-welcome-notifications`.
The record lives at `.kiro/specs/new-member-welcome/plan-sparring.md`; each lane PR copies it to its own
`docs/validation/<VTID>/plan-sparring.md` (a plan-level PR must not add `docs/validation/<VTID>/`, the PR validation gate ties
it to one VTID). **For Kiro:** `tasks.md` and `plan-sparring.md` (the plan
block) are authoritative — requirements/design text that still says "comment" or "backing post" is superseded (banner in
`design.md`). Each lane PR copies the sparring record into its own `docs/validation/<VTID>/plan-sparring.md`, adds
`scope.json`/`acceptance.md`/`staging-tests.json` there, and carries the `Collab-Session`/`Collab-Lane` trailers.
Lane files are handed over one PR each (validator allows one work lane per PR); until a lane's file shows `next_actor: kiro`
and `vtid`, do not start it. Order: `team-welcome-backend`, `new-member-card-optin`, `grouped-welcome-notifications` in
parallel; `say-hello-composer` last. Never allocate VTIDs, merge, deploy or write to Supabase/AWS (collaboration §7a).
