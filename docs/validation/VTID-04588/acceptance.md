# VTID-04588 — remember_fact: writes work from a voice session; ask before replacing

Found by the first live staging run of VTID-04581 (session `live-d6c34724-…`, 2026-09-25 20:28 UTC):
the birthday answer was right (`profile_owned`), but both writes for the brother returned
`STATUS: failed`. The tool passed the voice session id (`live-…`) as `write_fact`'s `p_thread_id`,
which is a uuid, so every write was refused. Unit tests mocked the write and missed it.
The same run showed the model inventing the year 1900 for "5. Mai" and sending
`confirm_replace=true` on a correction without asking.

## Acceptance criteria

AC-1: a voice session id is never sent as the uuid thread id; a uuid still is.
TEST: services/gateway/test/services/vtid-04581-remember-fact-tool.test.ts
AC-2: a placeholder year (1900/0001/0000) is stored as day and month only (`--MM-DD`), and matches "5. Mai".
TEST: services/gateway/test/services/vtid-04581-remember-fact-tool.test.ts
AC-3: `confirm_replace` is honoured only after this tool reported the conflict for the same member and key, within 30 minutes; otherwise the result is `conflict` and nothing is written.
TEST: services/gateway/test/services/vtid-04581-remember-fact-tool.test.ts
The real write error is now logged (`[VTID-04581] remember_fact <key> -> failed error=…`).

AC-5 (live, staging): a German voice session saves a sibling birthday, then asks which is right when told a different one, and writes nothing until confirmed. Recorded in `outputs/`.
UI: live German voice session on preview-aws-gateway.vitanaland.com as the test user, see outputs/live-staging.md
AC-6: a fact stored under another key for the same thing (extractor `paul_birthday`, model `bruder_paul_geburtstag`) is found: German/English words map to one set, and a match needs two shared words with one key's words inside the other's. Conflict and replace then use the stored key, so there is one fact per thing.
TEST: services/gateway/test/services/vtid-04581-remember-fact-tool.test.ts
