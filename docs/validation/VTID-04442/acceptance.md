# VTID-04442 — services/memory README

Plan §5.5: "`services/memory/` has one README with the table list, the write
callers and the read contract."

## Acceptance

AC-1: `services/gateway/src/services/memory/README.md` lists every memory table, the one write function per kind, the read API and role-scope rules, forgetting, flags and failure posture.
TEST: docs-only; checked by reading each module header and grepping the writers (commands.log). The existing memory suites stay green (services/gateway/test/services/memory/remember.test.ts, which pins that every former write_fact caller goes through rememberFact).
