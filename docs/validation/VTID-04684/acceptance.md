# VTID-04684 — voice forget removes the stored fact

Found by the live memory suite (VTID-04600, B-FORG-01, staging build `477fe7c`).
The member said "Vergiss bitte, dass mein Hund Bello heißt". Vitana answered
"Ich habe den Namen deines Hundes aus meinem Gedächtnis gelöscht" — and called
no tool. Every tool call of the whole pass was `remember_fact` (18) or
`search_memory` (2). `user_pet_name=Bello` stayed current.

Two gaps stacked:
1. The voice model had no way to forget a FACT. `forget_memory` deletes one
   `memory_items` row by id; the Memory Garden delete is a screen.
2. The model often skips the tool and claims the result (the same shape
   VTID-04591 already handled for "merk dir").

Fix:
- `forget_fact(what)` (`services/memory/forget-fact.ts`): finds the fact the
  member means by the value they name ("Bello"), else by its key words
  ("mein Lieblingsessen" → `user_favorite_food`). Then it forgets every row of
  that key and records the do-not-re-learn marker (the Garden delete,
  VTID-04441). It also deletes the member's own transcript lines carrying the
  value and rebuilds the voice snapshot (VTID-04627). Profile and system keys are
  never forgotten by voice. More than one candidate returns `ambiguous` (ask);
  none returns `not_found` (say so, claim nothing).
- A gateway backstop, next to the remember backstop: a forget request
  (`detectForgetIntent`) the model answered without calling `forget_fact` or
  `forget_memory` is run by the gateway. The model is then told the real
  STATUS. "Vergiss nicht" / "don't forget" never trigger it. It runs on Nova
  only.
- `forget_fact` is in the catalog (last, so the Nova budget packs every other
  tool exactly as before) and dispatched. It is NOT in the Nova priority list:
  the budget is full, and ranking it there pushed `get_lab_results` off
  `/health` (caught by the VTID-04426 selection test). It is reachable through
  `find_tool`/`use_tool`, and the backstop runs the forget whether or not the
  model calls it. The MEMORY prompt line forbids claiming "forgotten" before a
  forget STATUS says so.
- Voice payload change, re-recorded on purpose: one MEMORY line, one more
  deferred tool, `forget_fact` in the unbudgeted catalog (295 → 296 tools). The
  Nova-declared tool sets (65,549 bytes) and the Serbian bridge set (49,198
  bytes) are byte-identical.

AC-1: A forget request naming the value forgets that key (marker recorded), removes the transcript lines carrying it, and rebuilds the snapshot.
TEST: services/gateway/test/services/memory/vtid-04684-forget-fact.test.ts

AC-2: "vergiss nicht", "don't forget" and ordinary statements are never treated as a forget request.
TEST: services/gateway/test/services/memory/vtid-04684-forget-fact.test.ts

AC-3: Nothing matching → not_found; two fitting keys → ambiguous; a failed forget is reported, never claimed.
TEST: services/gateway/test/services/memory/vtid-04684-forget-fact.test.ts

AC-4: The backstop runs when the model skipped the tool, tells the model the real STATUS, and stands down when forget_fact was called.
TEST: services/gateway/test/services/memory/vtid-04684-forget-fact.test.ts

AC-5: forget_fact is in the catalog and dispatched, stays out of the Nova priority list (no screen tool evicted), and the prompt forbids an unbacked "forgotten".
TEST: services/gateway/test/services/memory/vtid-04684-forget-fact.test.ts

AC-6 (live, staging): B-FORG-01 passes — the fact is gone and the next session does not say "Bello".
