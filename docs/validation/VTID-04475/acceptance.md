# VTID-04475 — Self-healing single writer (bridge)

AC-1: One self_healing_log row per incident — a failed stage on an execution whose finding came from the self-healing injector updates the injector's incident row (keyed by activated_vtid) instead of writing a new VTID-DA-<exec8> row.
TEST: services/gateway/test/vtid-04475-self-healing-single-writer.test.ts

AC-2: A self-heal child chain shares one row keyed by its root execution (VTID-DA-<root8>); parent walk is bounded (10) and cycle-safe.
TEST: services/gateway/test/vtid-04475-self-healing-single-writer.test.ts

AC-3: Updates merge, not replace: the original diagnosis is kept, original_failure_class recorded, stage_history appended (cap 20), attempt_number never decreases.
TEST: services/gateway/test/vtid-04475-self-healing-single-writer.test.ts

AC-4: The writer never throws; a lookup failure falls back to the old per-execution key.
TEST: services/gateway/test/vtid-04475-self-healing-single-writer.test.ts

AC-5: Operator pipeline regression suite (CLAUDE.md rule 42e) and existing bridge/self-healing suites stay green.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
