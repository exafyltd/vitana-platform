---
slug: new-member-welcome
author: kiro
executor: kiro
next_actor: owner
state: sparred
sparring_record: .kiro/specs/new-member-welcome/plan-sparring.md
updated: 2026-10-15T11:30Z
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
