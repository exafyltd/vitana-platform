# VTID-04707 — "what do you know about me" leads with what the member said

Pass 6 of the live voice suite on staging `fcf53eb` (2026-09-28, B-REC-06):
the member had told Vitana the dog is Bello and the favourite food is
Lasagne. Asked "Was weißt du eigentlich alles über mich?", Nova listed the
display name "E2E", the language, a life goal and matches, and neither of the
two things the member had said. The VTID-04692 recall backstop stayed silent
because the reply contained a stored value (the profile name "E2E").

For an about-me question the backstop now judges the reply against the facts
the member stated (`provenance_source` user_stated*, not system keys or
profile basics) and offers those first. `listCurrentFacts` reads
`provenance_source` for this.

## Acceptance

AC-1: member-stated facts exclude system keys and profile basics.
TEST: services/gateway/test/services/memory/vtid-04707-recall-member-stated-first.test.ts

AC-2: the live B-REC-06 reply triggers the backstop, and the note lists the member-stated facts first.
TEST: services/gateway/test/services/memory/vtid-04707-recall-member-stated-first.test.ts

AC-3: a reply that already names a member-stated fact triggers nothing.
TEST: services/gateway/test/services/memory/vtid-04707-recall-member-stated-first.test.ts

AC-4: live B-REC-06 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
