# VTID-04884: voice diary entries become memory episodes

Production check, 2026-10-05 (read-only):
- Both diary entries since 2026-09-23 were voice entries from real members. Neither has a memory episode.
- Cause: `tool_save_diary_entry` wrote `diary_entries` directly and never wrote the episode that `saveDiaryEntry()` writes (VTID-04390).

Changed:
- `memory/diary.ts`:
  - `writeDiaryEpisode()` is the single episode write, and `saveDiaryEntry()` uses it.
  - New `updateDiaryEpisodeText()`: updates the episode for a diary row, or writes it if there is none.
- `tool_save_diary_entry`:
  - A new voice row writes its episode.
  - A coalesced fragment updates that row's episode.
  - Failures are non-fatal, and the spoken result is unchanged.
- A guard test fails if any file inserts into `diary_entries` without writing the episode.

## Acceptance

AC-1: a new voice diary entry writes one episode linked by `diary_entry_id`. The test fails on the old code.
TEST: services/gateway/test/services/memory/vtid-04884-voice-diary-episode.test.ts

AC-2: a coalesced fragment updates the same episode, or writes it if missing, and never writes a second one.
TEST: services/gateway/test/services/memory/vtid-04884-voice-diary-episode.test.ts

AC-3: every `diary_entries` writer writes the episode (guard).
TEST: services/gateway/test/services/memory/vtid-04884-voice-diary-episode.test.ts

AC-4: the existing save_diary_entry behaviour is unchanged.
TEST: services/gateway/test/save-diary-entry-shared.test.ts

Data repair: the two missed episodes from 2026-09-24 and 2026-09-26 are a separate, owner-approved step after deploy.
