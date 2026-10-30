# Acceptance — VTID-05410 (say-hello-lane-reassign / lane `reassign`)

Change types: Tooling/docs.

Nothing deploys: lane-file front matter only, so staging-tests.json holds only the read-only `/alive` check.

AC-1: `say-hello-composer.md` is `seat: jtadic`, `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer` with `paths` equal to the real merge-base diff of both feature branches (platform + vitana-v1), reaching no governance path.
TEST: node scripts/collab/queue.mjs scope-check (outputs/scope-check.txt, 0 errors)

AC-2: `new-member-card-optin.md` and `grouped-welcome-notifications.md` change only `seat: exafyltd` -> `seat: jtadic`.
TEST: git diff --stat vs origin/main (outputs/diff-stat.txt, outputs/perm-lines.diff)

AC-3: `state`, `depends_on`, `vtid`, `claimed_by` and every log line of the three targets are byte-identical.
TEST: outputs/perm-lines.diff shows only seat/executor/reviewer_seat/paths lines

AC-4: The lane PR passes Collab handoff and Lane scope through the `lane_admin` path.
TEST: node scripts/collab/queue.mjs validate (outputs/validate.txt)

AC-5: The enforcement suite stays green.
TEST: node --test scripts/collab/queue.test.mjs (outputs/queue.test.txt)

AC-6: Preflight passes every CI governance check.
TEST: node scripts/collab/preflight.mjs (outputs/preflight.txt)
