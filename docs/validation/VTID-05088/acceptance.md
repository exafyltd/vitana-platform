# VTID-05088 — morning check row 21: tell "nobody spoke" apart from "memory is broken"

VTID: VTID-05088
VALIDATION_PROFILE: gateway_backend

## Problem
MORNING-SYSTEM-HEALTH-CHECK failed 2/22 on 2026-10-11 (run 38138854395): row 21
`no-memory-writes-24h`, and row 22 only because row 21 failed. The memory pipeline was
healthy — the last voice conversation (2026-10-08, 14 turns) wrote 15 items, prompts
carried memory 155/155, coverage 96%, AP-0910 ran on schedule. Nobody had a voice
conversation between 2026-10-08 17:17 and the check. Row 21 could not tell that apart
from a broken writer.

## Change
- Migration `20261012160000_vtid_05088_ci_memory_health_speech_input.sql`:
  `ci_memory_health()` gains `user_speech_turns_24h` (per session+turn, summed
  `input_transcription` fragments > 20 chars — the writer's own buffer gate, counted
  upstream of the writer) and `transcript_turns_24h`. Everything else unchanged.
- MORNING-SYSTEM-HEALTH-CHECK.yml row 21: `no-memory-writes-24h` only when speech > 0;
  new `speech-not-recorded` when speech > 0 and transcript turns = 0; a quiet day reads
  "no user speech in 24h (nothing to remember)". All other conditions unchanged.
- DATABASE_SCHEMA.md updated.

## Acceptance criteria
AC-1: the row-21 bash from the workflow, run against fixture RPC responses: quiet day
PASS; speech+writes PASS; speech without writes FAIL no-memory-writes-24h; speech not
reaching the writer FAIL speech-not-recorded; coverage, DLQ, prompt, AP-0910 and churn
conditions still FAIL on a quiet day. Reverting the writes line to unconditional makes
the quiet-day case fail (mutation check).
TEST: services/gateway/test/vtid-05088-memory-health-speech-input.test.ts

AC-2: migration keeps every key, adds exactly two, groups by (session_id, turn_count)
over summed fragments, stays SECURITY DEFINER / service_role only; on a local Postgres 16
a delta-split turn counts, "ja" turns and old/other-stage events do not, it applies
twice, anon cannot execute.
TEST: docs/validation/VTID-05088/outputs/local-postgres-harness.sql

AC-3 (after apply, read-only): the RPC returns both keys and a dispatched morning check
reports rows 21 and 22 PASS.
CURL: POST $SUPABASE_URL/rest/v1/rpc/ci_memory_health
