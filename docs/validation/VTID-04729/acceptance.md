# VTID-04729 — Stop the privacy refusal before it is spoken (prompt)

Staging `2ae96e0`, 2026-09-28, test account, no spouse fact stored. Asked "wie heißt meine Frau", Nova's own first reply was a refusal every time the VTID-04704 backstop then had to correct:

- `live-61b6a597…`: "Ich kann mich nicht an persönliche Informationen wie den Namen deiner Frau erinnern, da dies gegen die Datenschutzbestimmungen verstoßen würde. Solche sensiblen Daten sind in deinem Profil gespeichert … Möchtest du, dass ich dich zu deinen Profileinstellungen bringe?"
- `live-70d3315a…`: "Tut mir leid, aber ich kann keine persönlichen Informationen über andere Personen preisgeben, auch nicht über Familienmitglieder."
- `live-9b368586…` (on `72e8e2f`): "… kann diese persönliche Information nicht preisgeben. Solche Daten können nur in deinem Profil bearbeitet werden. Möchtest du, dass ich dich zu deinen Profileinstellungen bringe?"

## Root cause

I read the session's own `nova_instruction_debug_dump`. The refusals repeat the wording of two prompt blocks written for something else:

1. **Identity guardrail** (`identity-guardrail-block.ts`). It said: "NEVER state the user's age, birthday … from a value other than what is shown above". It also held the *sanctioned refusal*: "tell them this kind of basic information can only be changed in their Profile / Settings, and offer to take them there". Nothing said these rules cover only the user's own fields, so "my wife's birthday / name" was answered with them.
2. **Social context hint** (`social-memory-prompts.ts`). It said "Respect privacy: never reveal message contents of other people". The rule is meant for other community members, but "other people" reads as anyone the user mentions, including a spouse.

Memory rule 6b already said "never cite privacy". It sat next to two NON-NEGOTIABLE-sounding blocks that pointed the other way.

## Change (prompt wording only)

- **Guardrail:** "the user's OWN age, birthday…" and "any of these fields of their own". It gets a new SCOPE line: partner, family and friends are not profile fields. They are never answered with the refusal or sent to the Profile. When nothing is stored, say you do not know it yet and ask.
- **Social hint:** "Respect other members' privacy: never reveal what other community members wrote in their messages… This is about other members only: what the user told you about their own partner, family and friends is theirs to hear back."
- **Rule 6b:** "not stored yet, ask for it, so you can remember it" is the whole answer. Never send them to their profile or settings for it.

AC-1: The identity guardrail covers only the user's own fields, and routes the user's people to memory. The guardrail for the user's own fields is unchanged.
TEST: services/gateway/test/services/vtid-04729-own-people-not-a-privacy-refusal.test.ts

AC-2: The social privacy hint protects other community members, not the user's own people.
TEST: services/gateway/test/services/vtid-04729-own-people-not-a-privacy-refusal.test.ts

AC-3: Rule 6b makes "not stored yet, ask" the whole answer. The VTID-04618/04645/04683 guarantees hold.
TEST: services/gateway/test/services/vtid-04729-own-people-not-a-privacy-refusal.test.ts

AC-4: Only the authenticated community `de` context hash moves in the payload-identity guard. It was regenerated on purpose.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

## Live check after merge

On staging, with no spouse fact stored, "wie heißt meine Frau" must answer first time with "I don't know it yet, tell me", with no privacy, profile or settings wording. The `recall_backstop` diag should no longer fire as `privacy_refusal` or `deflected` for these sessions. With the facts stored, the answers must still be "Anna" / "12. März".

## Ported fix: `main` red after the CLAUDE.md split (VTID-04253, `8490e09`)

The gateway Jest job failed on this PR with two failures. `main` itself carries both of them; no fix PR existed, so this PR fixes them:

- **`vtid-04019-no-token-prefixes-in-docs`** looked for §16 in `CLAUDE.md`. It moved to `.claude/rules/infrastructure.md`, so the test now reads it there. The token scan now also covers `.claude/rules/*.md`, the path-scoped rule files every session can load.
- **`vtid-04018-operator-bootstrap-pack`** exposed a real regression. The Operator Console's bootstrap pack read its "Recent change log" rows from `CLAUDE.md`, which no longer holds the CHANGE LOG table, so the section went empty in production. It now reads `docs/CHANGELOG.md`, and the test fixtures follow suit: one file read more per build.
