# J - MAXINA Intro screen French layout (session_01TJTt4VbpfsQ7ojhoavSsVw)
- Created 2026-09-08, updated 2026-10-10; idle. Branch claude/maxina-intro-french-layout-ack6wg (vitana-v1 and vitana-platform; only v1 used).

## Goal
Fix MAXINA intro screen on Samsung S25 with French selected: Login/Register CTA buttons clipped at the bottom of the viewport (S22 fine).

## Done
- exafyltd/vitana-v1#1057 opened 2026-09-08: `IntroExperience.tsx` content column `min-h-screen` -> `min-h-dvh` (+ comment updates; 19 add / 2 del, 1 file). CI was green (Vitest, i18n, preview-deploy). Not merged, nothing deployed.

## State now
- #1057 is CLOSED, NOT merged (closed 2026-10-10 10:46 UTC, by unknown actor). Head f860a12. No review comments ever (only preview bot and a Codex "usage limit reached" comment).
- Session's hourly check-in routines ended (auto-unsubscribed on close). Nothing uncommitted known. Fix is NOT on main (unknown whether main got it another way).

## Blocked on / needs owner
- Decision: reopen #1057, open a fresh PR with the same fix, investigate why it was closed, or drop it.
- Real-device verification (S25 + French) was never done: session had no device and no npm access.

## Next steps for Kiro
1. Check whether main already contains an equivalent fix for `IntroExperience.tsx` (grep min-h-dvh); if yes, close the topic.
2. If not and owner wants it: new `plan(` PR / VTID (plan sparring applies; a new VTID needs a sparred plan, the 2026-09 PR predates that rule), apply the 1-line min-h-dvh change, run vitest + i18n + design checks, verify in Playwright at 390x844 with French locale.
3. Merge and prod publish are Claude Code / Project Manager only.

## Gotchas/lessons
- PR sat 31+ h with no human review; check-in loop only polled, never escalated. Closure reason unknown.
- Fix is a hypothesis (viewport unit mismatch), never confirmed on an S25.
