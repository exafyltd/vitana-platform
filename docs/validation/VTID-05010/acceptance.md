# VTID-05010 - Voice diary episode repair (data fix-up)

Owner Gate 1 "yes", 2026-10-09. Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: The fix-up inserts one memory_items episode for each of the two owner-approved diary rows, in writeDiaryEpisode()'s shape.
  TEST: services/gateway/test/vtid-05010-voice-diary-episode-repair.test.ts
AC-2: Idempotent (second run inserts 0) and guarded (aborts without writing if a row or its primary tenant is missing), proven on a throwaway Postgres.
  TEST: scripts/ci/test-vtid-05010-diary-repair.sh (see commands.log)
AC-3: After RUN-MIGRATION (read-only): each of the two diary ids has exactly 1 episode.
  TEST: select content_json->>'diary_entry_id', count(*) from memory_items where content_json->>'diary_entry_id' in ('a1a77e84-6db9-466d-8257-9376f0a6bc4f','6b40de35-72c3-42da-9bba-5d82c27cbe96') group by 1
