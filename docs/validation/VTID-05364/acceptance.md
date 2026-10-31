# VTID-05364 acceptance (collab-handoff-check-fix/program-registry, tasks.md P1-P3)
Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
AC-1 Every spec of plan.md item 5 is listed by its programme: 13 `native-wave2-*` specs in `native-app`,
`desktop-spotlight-finish` in `desktop-redesign`, `i18n-propagate-stale-write` and `sparring-floor-retry` in
`standalone`. Each slug matches `/^[a-z0-9][a-z0-9-]*$/` and is listed exactly once.
TEST: node --test scripts/collab/program-registry.test.mjs
AC-2 Each programme's `repos` contains the repo prefix of every spec it lists (`desktop-redesign` gains
`vitana-platform`, R2-F1).
TEST: node --test scripts/collab/program-registry.test.mjs
AC-3 `validatePrograms` returns `[]`; the test is red on base (`red-on-base.txt`) and green on head.
TEST: node --test scripts/collab/*.test.mjs
AC-4 `validateRegistry` reports no programme error for #4373's touched spec with this head's registry.
TEST: commands.log ("P3")
