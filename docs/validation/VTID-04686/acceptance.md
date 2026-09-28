# VTID-04686 — one current row per key after every write

Found by the live memory suite (VTID-04600, B-CONF-04, staging build `477fe7c`).
Paul's birthday "May 5" was in the Memory Garden (`entity=self`). The member
confirmed the old value by voice, and the background extractor wrote "May 5th"
as `entity=disclosed`. Both stayed current: `write_fact` supersedes only rows
with the same `(key, entity)`. VTID-04638 fixed this only for a confirmed
replace in `remember_fact`. Every other writer still left two current values.

Fix: `rememberFact()` is the one write path every writer uses (tool, extractor,
Garden, automations). After a successful write it now retires every other
current row of the key (`superseded_by` = the new row), across entities. On
either transport (client or REST). Failure to retire is logged and never
undoes the write. `retireOthers: false` opts out.

AC-1: After a write, every other current row of the key is superseded by the new row, with no entity filter.
TEST: services/gateway/test/services/memory/vtid-04686-one-current-row-per-key.test.ts

AC-2: The REST transport does the same with one PATCH scoped to the key, excluding the new row.
TEST: services/gateway/test/services/memory/vtid-04686-one-current-row-per-key.test.ts

AC-3: A failed write retires nothing; a failed retire keeps the write; retireOthers:false opts out.
TEST: services/gateway/test/services/memory/vtid-04686-one-current-row-per-key.test.ts

AC-4 (live, staging): B-CONF-04 passes — one current paul_birthday row holding May 5.
