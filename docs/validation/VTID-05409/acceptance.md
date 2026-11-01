# VTID-05409 (kiro-lane-admin/rules) — acceptance

Pure documentation/rule-text lane: no deployed surface. Each AC maps to a mechanical check (the steering guard, the
Collab-handoff validator, a grep over the changed files, or a byte-identical sha256 of the protected-gate sentence).
Evidence is captured under `docs/validation/VTID-05409/outputs/`; commands in `commands.log`.

AC-1 — `.claude/rules/collaboration.md` §3a and §7b state the protected-gate authority as "the owner's instruction
naming the plan plus a reviewer-agent accept on the current head (Claude Code is retired)"; neither offers "legacy
claude review" as an option.
  TEST: node scripts/ci/kiro-steering/guard.cjs
  TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD
  (grep confirmation: outputs/no-legacy-claude.txt shows zero "legacy claude"/"a Claude review" matches)

AC-2 — `.claude/rules/collaboration.md` §7a adds one sentence describing the authorized lane-administration path: an
`executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer` lane with `lane_admin: true` from a trusted source may
reassign a TARGET lane's `seat` and narrow its `paths`, preserving seat ownership, scope and independent review, never
widening the admin lane's own `paths`. The wording matches the merged enforcement (scripts/collab/queue.mjs refusal
strings + validateLane marker).
  TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD
  (grep confirmation: outputs/lane-admin-sentence.txt shows the §7a sentence present)

AC-3 — the platform `CLAUDE.md` and `vitana-v1/CLAUDE.md` protected-gate sentences are byte-identical (normalized of
soft-wrap), Claude-free wording.
  TEST: npm run i18n:inventory
  (byte-identical proof: outputs/claude-md-sha256.txt — both normalize to the same sha256)

AC-4 — `.kiro/pipeline/common-rules.md` rule 4 and `.kiro/steering/vitana-owner-autonomy.md` stop #3 carry the same
Claude-free protected-gate wording; no "legacy claude" option remains.
  TEST: node scripts/ci/kiro-steering/guard.cjs
  (grep confirmation: outputs/no-legacy-claude.txt)

AC-5 — the steering guard is green and `queue.mjs validate` is green; `.kiro/steering/vitana-collaboration.md` stays a
`#[[file:]]` link (no body edit).
  TEST: node scripts/ci/kiro-steering/guard.cjs
  TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD
  (outputs/kiro-steering-guard.txt, outputs/queue-validate.txt)
