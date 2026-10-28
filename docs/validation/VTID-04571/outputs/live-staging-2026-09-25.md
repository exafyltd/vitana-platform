# VTID-04571 — staging evidence

## Before (member session live-03af48b7, staging build 1a80874, 2026-09-25, read-only from oasis_events)
| time (UTC) | stage | detail |
|---|---|---|
| 18:31:09.643 | turn_complete (turn 0) | greeting, 170 chars |
| 18:31:28.704 | tool_call | search_memory |
| 18:31:29.133 | tool.executed | query "Geburtstagsdatum Frau", 8 memories incl. spouse_name |
| 18:31:29.843 | duplicate_turn_detected | matched_prefix_chars 30, buffer_len 233 |
| 18:31:32.235 | turn_complete (turn 1) | output_preview starts with the turn-0 greeting, then "Ich erinnere mich an den Geburtstag deiner Frau, Maria Maksina. Ihr Ge…", output_suppressed true |
| 18:31:32.236 | duplicate_turn_suppressed_at_complete | dropped_chunks 158 |

`duplicate_turn_detected` per day on staging: 09-20 4, 09-21 0, 09-22 1, 09-23 0, 09-24 6, 09-25 14.

## After
Added once the fix is deployed to staging.
