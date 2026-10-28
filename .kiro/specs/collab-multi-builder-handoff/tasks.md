# Tasks — collab-multi-builder-handoff

<!-- lane: sequential-builders -->
- [ ] T1 Tests first: the six cases and the two extra cases of plan "Tests" in `scripts/collab/queue.test.mjs`; record
      case 1 failing on `origin/main` in `docs/validation/<VTID>/outputs/`.
- [ ] T2 `scripts/collab/queue.mjs` `validateRange`: replace the single-session rule with plan rules 1–2 (a–e); one
      error message per failing rule; nothing else in the file changes behaviour.
- [ ] T3 Evidence pack `docs/validation/<VTID>/`: `plan-sparring.md`, `scope.json`, `acceptance.md` (`AC-` per plan
      rule and test case), `commands.log`, `outputs/`, `staging-tests.json` (one `existing` entry); PR declaration block.
Acceptance: all suites green; the six required cases pass as specified; protected-file review on the current head.
