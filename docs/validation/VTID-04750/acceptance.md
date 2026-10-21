# VTID-04750 — an old note beat a stored fact

Production live-092945f7 (2026-09-29). The wife's birthday is stored as 4 November 1999; 1997 was replaced on 09-25. Vitana said 1997.

The replaced fact was filtered out everywhere. The older conversation excerpts in the memory block and in search_memory results carry no age, so the old value could win.

Fixes:
- The memory block now says these excerpts can be out of date, and that the structured fact is correct when they disagree.
- search_memory lists facts first and adds the same note.

## Acceptance

AC-1: the memory block labels excerpts as possibly out of date, with the fact as the winner.
TEST: services/gateway/test/services/memory/vtid-04750-facts-over-old-notes.test.ts
