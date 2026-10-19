# J - Chat UX PRs review and merge (session_018cpub1jCt46hQYBXtufFnN)
- Created 2026-10-15T09:26, updated 12:10, IDLE. Branch claude/magical-shannon-atmj3k
## Goal
Review and merge Kiro's four Chat UX lane PRs in exafyltd/vitana-v1 and get them to production. (Original request not read.)
## Done
- exafyltd/vitana-v1#1424 (VTID-05202 recent emojis), #1422 (05200 no unread-badge bump on open thread), #1423 (05201 instant deep-link jump): merged and deployed to production at 670c5e9; post-deploy check passed, rollback skipped. Ledger rows completed.
- exafyltd/vitana-v1#1426 (spec/sparring record/lanes for chat-ux, incl. fixes for 3 Codex findings) merged as dfb10fc. VTID-05200..05202 closed out.
## State now
- exafyltd/vitana-v1#1425 (VTID-05203 compact density, Kiro): still OPEN, draft (verified); VTID row in_progress. Lane compact-density is in-review, held for owner visual check.
- Preview: https://d2w0cqhh9jhjpj.cloudfront.net/pr-1425/. No routines noted. Production has the three merged changes.
## Blocked on / needs owner
1. Visual yes on #1425 (before/after screenshots desktop, mobile, RTL still owed by the session).
2. Lock-screen push: #1422 only fixed the badge; if the push was the issue it needs a separate vitana-platform lane. Which symptom?
3. Staging/pr-gate flakiness from public.ecr.aws rate limits: do you want a plan to mirror base images into your ECR (needs own plan and VTID)?
## Next steps for Kiro
1. Possibly tune #1425 density values per owner screenshots feedback (desktop panel may be too tight); keep it draft until owner approves.
2. If owner wants, plan lock-screen push lane in vitana-platform and base-image mirror lane.
3. Claude-Code-only: merge #1425 after owner yes, STAGING-VERIFY, Gate 2, production.
## Gotchas
- ecr.aws rate limit causes spurious pr-gate/staging failures; re-run once, do not loop.
- `blocked` is not a valid lane state; hold via log note. Merged lanes need log in-review -> verified -> done and refreshed `updated`.
- repowise/graphify updates were not run (sandbox lacks npm).
