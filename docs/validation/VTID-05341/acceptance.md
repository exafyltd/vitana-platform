# VTID-05341 acceptance (session-title-stable/platform-title, tasks.md T1-T3)

Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
Red-on-base output: `red-on-base.txt`. Full command log and pass/fail counts: `commands.log`.

AC-1 `.kiro/steering/vitana-session-title.md` exists with `inclusion: always`, states plan §3 rules 1-5 (title set
once from the owner's original request; never changed later; no state such as "Blocked:" in the title; changed only
on the owner's explicit request; every Kiro session on Vitana) and contains no `#[[file:]]` link.
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs

AC-2 The new test fails on `origin/main` (file missing, 37/38) and passes on the head (38/38); it is an appended case,
no existing test is changed or weakened; the steering guard stays OK.
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs && node scripts/ci/kiro-steering/guard.cjs .

AC-3 The file is byte-identical to the vitana-v1 copy (exafyltd/vitana-v1#1499, lane `v1-title`), so the Kiro Web
generator writes it once (`vitana-platform--vitana-session-title.md`, `--check` ok; `commands.log`).
TEST: node scripts/collab/kiro-web-steering.mjs --check

AC-4 Only the lane's `paths` change; deploys nothing (no staging deploy path, no STAGING-VERIFY, no Gate 2).
TEST: node scripts/collab/preflight.mjs (Lane scope PASS, `commands.log`)
