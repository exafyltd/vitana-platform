# J - MAXINA concert tour engagement strategy (session_01KZLmJSBmtKaTEkWKwPoE2K)
- Created 2026-10-12T10:11, updated 10:18 (idle). Branch claude/nifty-wright-8tj9ml. No code written.
## Goal
Produce a MAXINA new-user engagement and Let's Dance Concert Tour activation strategy: new song release 30 Oct 2026, new clothing ready 3 Nov 2026, two clothing sets given away by Mariia Maksina; three areas (concert onboarding, song launch, clothing giveaway), combined journey, must-have/nice-to-have/future split, and reuse of existing features.
## Done
- Strategy written as a Claude doc: https://claude.ai/code/artifact/a8ee7faa-5609-4206-b21c-e993830f7f88 (central idea "MAXINA Tour Pass": QR at the concert, five stamps, stamps = entries for the two clothing sets).
- Inventory of reusable features (about 80% exists): Maxina Longevity Game / Event Game (/e/game/:slug QR landing, points, leaderboard, winner_reward_text), invite codes (/i/:code), VTNA coins (50 onboarding, 1000 per invited friend), groups, shorts, live rooms, push, sharing.
- No VTIDs, PRs, migrations or deploys.
## State now
- Nothing open: no PRs, no branches with work, no routines. Doc is private/shared via link only.
## Blocked on / needs owner
- Confirm KPI targets (proposals only). Supply: song title, tour dates/cities, clothing set contents and sizes, minimum age, shipping countries, legal check of giveaway terms (incl. German competition law).
## Next steps for Kiro
1. After owner confirms the doc, plan (with sparring) the must-have items; first one is signup source attribution (UTM / source tagging at signup; frontend never calls log-attempt, so signups are untagged today).
2. Then a Tour Pass on top of Event Game (EventGamePublicLanding, EventGameAdmin, bootstrap_maxina_event_game migration).
3. Any VTID allocation only after a sparred plan is approved. Prod publish: Claude Code / owner.
## Gotchas
- Dates and legal terms are placeholders/open decisions; do not invent them.
- Giveaway needs legal review before building.
