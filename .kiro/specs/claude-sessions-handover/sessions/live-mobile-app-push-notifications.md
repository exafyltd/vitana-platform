# Live Mobile App push notifications (session_01PuWUuLKsQft9PRyyxpjsJQ)
- Created 2026-10-05, last updated 2026-10-13T06:55 (idle). Branch ccr-dc73d9b5-dm126v (both repos). Repos: vitana-v1 + vitana-platform.
## Goal
Make push notifications reach members of the live mobile (Appilix) app; add visibility on push reach and an email backup. (Goal inferred from title and final reports; the first user request was not read.)
## Done
- VTID-05028: app phone registration + "Turn on notifications" card (exafyltd/vitana-v1#1308); live in prod since 2026-10-10 (checked bytes on vitanaland.com).
- VTID-05027: active-member push reach on push-dispatch health (exafyltd/vitana-platform#3989); live. Prod reports active_reach_7d active 11 / eligible 10 / reached 10 (ratio 1) on 10-13.
- VTID-05029: email backstop digest (exafyltd/vitana-platform#3992); live but inert (off).
- All three marked completed in vtid_ledger (on 10-13 they were already closed by another session; this one only confirmed).
- Prod gateway 98ebdab (2026-10-12) shipped everything the owner approved, incl. VTID-05030 code and VTID-04917.
## State now
- No open PRs named. Session idle, no routine running (the one-shot verify routine trig_011KfJWQTHZ7dx65MaRDMFKZ already fired 10-10).
- Prod gateway 98ebdab; staging 3d4ab4d54 at the time of last check (10-13).
## Blocked on / needs owner
- Owner: create a new Firebase project (browser push and Android in the planned native app need it).
- Owner: add the Resend key to AWS Secrets Manager; then set EMAIL_FALLBACK_ENABLED=true in a separate change.
- VTID-05030 DB migration (supabase/migrations/20261010140000_vtid_05030_user_connections_token_grants.sql) NOT applied: anon/authenticated roles still have direct access to user_connections. Belongs to VTID-05030's owner; code shipped without it.
## Next steps for Kiro
1. Follow-up change so reminder pushes create the notification records the email backup works from (not started; needs plan + sparring + VTID).
2. After owner supplies the Resend key: wire the email backup and flip the switch in its own PR (flip itself and any prod dispatch are Claude Code / owner steps).
3. Firebase wiring once the owner has the project (plan first).
4. Migration apply for VTID-05030: Claude Code / owner only (production write).
## Gotchas
- Staging moves fast: a pinned-commit promote can fail because staging changed; another session's deploy may already have shipped your commit, so re-check build-info before dispatching.
- A pinned prod deploy ships every ancestor commit; list the range for the owner (CLAUDE.md rule 26).
- Prod is read-only for checks; sessions here ran read-only curl/SQL only.
