# VTID-04042 — Agent executor: read_file / search_text stream files above the in-memory cap

**Defect (live, 2026-09-18, Run #6 / VTID-04039 / execution a5289ad8):** `read_file` refused
`services/gateway/src/frontend/command-hub/app.js` (2,625,600 bytes) with "file too large to
read" BEFORE considering `start_line`/`end_line`, and `search_text` silently skipped it. The
agent then spent all 60 turns writing a jest test that sliced the file into a scratch output and
reading that back, and the execution failed with "agent hit the 60-turn cap without calling finish".

**Fix:** files above `TEXT_FILE_MAX_BYTES` (2 MB) are streamed line by line (`streamLines`, readline
over a read stream, bounded to the requested window / the match list); only files above the new
`READ_FILE_HARD_MAX_BYTES` (64 MB) are refused outright. A NUL byte marks the file binary exactly
as the in-memory branch already did.

AC-1 — `read_file` on a > 2 MB text file returns the requested numbered window with the same trailer as a small file (`[N more line(s); file has M lines — read from start_line=…]` / `[end of file, M lines]`), and the default window when no range is given.
TEST: services/gateway/test/autopilot-agent-tools.test.ts

AC-2 — `search_text` streams a > 2 MB text file and reports hits with the real 1-based line number.
TEST: services/gateway/test/autopilot-agent-tools.test.ts

AC-3 — a > 2 MB file carrying a NUL byte is reported as `binary file` by `read_file` and skipped by `search_text`.
TEST: services/gateway/test/autopilot-agent-tools.test.ts

AC-4 — every pre-existing agent-tool behaviour (path jail, small-file windowing, edit/write/delete, run_check allowlist) is unchanged.
TEST: services/gateway/test/autopilot-agent-tools.test.ts

AC-5 — (live, post image rebuild) an open-ended request that needs a region of `app.js` is completed by the agent without a scratch slicer — Run #6 re-run, recorded under `docs/validation/VTID-04037/outputs/`.
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat/stream — recorded after the executor image is rebuilt from this merge
