# VTID-04694 — new facts stored under the English key

Live voice suite on staging, 2026-09-28 (pass 3, B-SELF-01): "Merk dir, mein
Lieblingsessen ist Lasagne" was saved as `lieblingsessen = lasagne`. Recall
worked, but the Garden's own facts use English keys (`user_favorite_food`), so
the member's memory holds keys in two languages.

VTID-04639 already reuses a stored fact's key when one exists (synonym table).
Only a NEW fact kept the model's language. Now a new fact's key words that the
synonym table knows are replaced by their English word; other words are kept,
and synonym entries that are already English are never rewritten.

## Acceptance

AC-1: `lieblingsessen` → `favorite_food`, `mutter_name` → `mother_name`, `zahnarzttermin` → `dentist_appointment`; English keys unchanged.
TEST: services/gateway/test/services/memory/vtid-04694-english-fact-key.test.ts

AC-2: a new German-named fact is written under the English key.
TEST: services/gateway/test/services/memory/vtid-04694-english-fact-key.test.ts

AC-3: a fact that already exists keeps its stored key (conflict path unchanged).
TEST: services/gateway/test/services/memory/vtid-04694-english-fact-key.test.ts

AC-4: live B-SELF-01 passes on staging (scripts/memory-verification/run-live.mjs).
TEST: scripts/memory-verification/run-live.mjs
