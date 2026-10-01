# VTID-04645 — Vitana never answers with another person's fact

Staging, 2026-09-26, after VTID-04618 merged (`de21940`): the test account asked "erinnerst du dich an den Geburtstag meiner Frau?" (session `live-2e9fd81d-9d3e-47b1-905f-fab3cc897071`). The privacy refusal was gone, but Vitana answered "Du hast erwähnt, dass der Geburtstag deiner Frau am 7. Mai ist". That date belongs to the account's brother Paul (a session summary written by another test suite). The stored `spouse_birthday` is "12. März". She did not call `search_memory`.

Rule 6b of the memory self-check (`buildSelfCheckSection()` in `services/gateway/src/services/memory-orchestrator.ts`) now also says:
- match the person exactly — a date, name or detail stored for one person is never the answer for another;
- if the memory in the context has no such fact for exactly that person, call `search_memory` before answering;
- if it is not found there either, say so and ask for it.

AC-1: The self-check tells the model to match the person exactly and never lend one person's fact to another.
TEST: services/gateway/test/vtid-04618-memory-owned-by-user.test.ts

AC-2: With no fact for exactly that person in the context, the model looks it up with search_memory, and if it is not found says so and asks.
TEST: services/gateway/test/vtid-04618-memory-owned-by-user.test.ts

AC-3: VTID-04618's rule still holds: no refusal and no privacy citation for what the member told Vitana; other members' private data stays protected.
TEST: services/gateway/test/vtid-04618-memory-owned-by-user.test.ts

AC-4: Only the authenticated member's memory context changes; the payload-identity snapshot was regenerated on purpose.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

Live check after merge: the same spoken question on staging must answer "12. März", or look it up, never the brother's date.
