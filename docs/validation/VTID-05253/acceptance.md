# Acceptance — VTID-05253 (native-g1-wiring/_plan lane-status: sentinel + two lanes done)

Spec/docs-only coordinator update. No runtime code, migration, or deploy. Each AC maps to a verification.

AC-1: env-profiles lane (VTID-05249) is state: done with its merged vitana-v1 PR link.
TEST: grep -q "state: done" docs-check && gh pr view 1466 --repo exafyltd/vitana-v1 --json state  # => MERGED (50873056a)

AC-2: fixture-gateway lane (VTID-05250) is state: done with its merged vitana-v1 PR link.
TEST: gh pr view 1465 --repo exafyltd/vitana-v1 --json state  # => MERGED (db3e0766b)

AC-3: vitana-v1-verified sentinel (VTID-05253) is state: done with evidence recorded.
TEST: test -f docs/validation/VTID-05253/vitana-v1-spar-evidence.md && grep -q "state: done" .kiro/specs/native-g1-wiring/lanes/vitana-v1-verified.md

AC-4: the lane files exist on vitana-platform main (so dependents can resolve them).
TEST: git cat-file -e origin/main:.kiro/specs/native-g1-wiring/lanes/fixture-gateway.md  # => exit 0

AC-5: the lane front-matter transitions are valid per the collab validator.
TEST: node scripts/collab/queue.mjs validate  # => accepts ready/in-review -> done

AC-6: no runtime/code/migration change; OASIS impact none.
TEST: git diff --name-only origin/main...HEAD  # => only .kiro/specs/** and docs/validation/** paths

See commands.log and outputs/ for captured results.
