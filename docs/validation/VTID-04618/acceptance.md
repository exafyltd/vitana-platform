# VTID-04618 — Vitana answers with what the member told her about their own people

Production, 2026-09-26 (mobile app, German voice session): the member asked "erinnerst du dich an den Geburtstag meiner Frau?" and Vitana refused, citing privacy. The fact was stored (`memory_facts.fact_key = spouse_birthday`, 4. November 1999), so retrieval was not the problem.

The refusal came from the memory self-check that every memory context carries (`buildSelfCheckSection()` in `services/gateway/src/services/memory-orchestrator.ts`): "Still respect privacy: never name a THIRD person's private detail that isn't already visible to the user". The model read the member's wife as a third person and her birthday as her private detail.

The clause is replaced with rule 6b: everything the member told Vitana, including about their own partner, family and friends, belongs to the member. When they ask whether she remembers it, she answers, looking it up with her memory tool first if it is not in the context. She never refuses or cites privacy for something the member told her. The one privacy limit that stays: a private detail about another member that Vitana saw in community data and the member has not seen.

AC-1: The self-check tells the model that what the member told it is theirs, to look it up if needed, and never to refuse or cite privacy for it.
TEST: services/gateway/test/vtid-04618-memory-owned-by-user.test.ts

AC-2: The clause that produced the refusal is gone from both memory renderers.
TEST: services/gateway/test/vtid-04618-memory-owned-by-user.test.ts

AC-3: Other members' private data stays protected, and the no-invention rule stays.
TEST: services/gateway/test/vtid-04618-memory-owned-by-user.test.ts

AC-4: The only voice payload that changes is the authenticated member's memory context. The payload-identity snapshot was regenerated on purpose; tools, instruction and greeting hashes are unchanged.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

Not verified live: needs a spoken session on staging after merge ("erinnerst du dich an den Geburtstag meiner Frau?" on an account with a stored spouse birthday).
