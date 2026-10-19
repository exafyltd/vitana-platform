# VTID-05215 — PM Agent P2: programme registry content
Plan: `.kiro/specs/pm-agent/plan-sparring.md` (v2 §5; owner Gate 1 "yes" 2026-10-15), copied here as
`plan-sparring.md`. Tasks: `.kiro/specs/pm-agent/tasks.md` section `p2-registry`. Docs only — no code, no route, no
migration, no deploy.
VALIDATION_PROFILE: gateway_backend
## Acceptance criteria
AC-1: `docs/programs/<id>/program.md` exists for the 8 programmes (multi-tenant, native-app, commerce-portal, calendar, proactive-assistant, desktop-redesign, timeline-rebuild, aurora-cutover) and for `health-hub`, which has an owner doc. Front matter: id, title, status, priority, repos, specs, docs, exit_criteria, next_review.
  TEST: `node scripts/collab/queue.mjs validate --base origin/main --head <head>` (runs `validatePrograms` over every program.md: id = folder, title, status active|paused|done, priority 1-5, specs `<repo>:<slug>`) — scripts/collab/queue.test.mjs covers the validator
AC-2: Every current spec (`.kiro/specs/*` on main in vitana-platform and vitana-v1) is listed by exactly one programme.
  TEST: `validatePrograms` rejects a spec listed twice; a cross-check of `git ls-tree origin/main .kiro/specs/` in both repos against the union of `specs:` (see verification record)
AC-3: Links only — no plan text is copied or rewritten; every `docs:` entry resolves on main of its repo.
  TEST: review of the diff; `git cat-file -e origin/main:<path>` for each linked doc
AC-4: `queue --program <id>` shows that programme's lanes.
  TEST: `node scripts/collab/queue.mjs --repo <platform> --repo <v1> --program <id>` after merge (the queue reads programmes from origin/main)
## Decisions taken
- Specs that fit none of the 8 named programmes (`pm-agent`, `claude-sessions-handover`, `vitana-v1:chat-ux`,
  `vitana-v1:vitana-chat-markdown`) are listed by a tenth programme, `standalone`, so that every spec belongs to exactly
  one programme; the owner can move them.
- `health-native` covers both Health Hub and the native app; a spec belongs to one programme, so it is listed by
  `health-hub` (its umbrella VTID-05020 comes first) and `native-app` links to it in its body.
- `new-member-welcome` (refines the onboarding assistant plan) and `profile-vitana-cards` (Vitana cards) are listed by
  `proactive-assistant`.
- Every programme gets `status: active`, `priority: 3` (neutral middle) and `next_review: 2026-10-22`; the owner sets
  real priorities.
- `docs:` entries are written `<repo>:<path>` because programmes link docs in both repos.
