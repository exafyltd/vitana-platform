# Memory Verification Suite (VTID-04600)

The question this suite answers: **does Vitana's memory actually work?** Specifically:
- does what a member tells her get stored correctly;
- does it come back correctly, including in a later conversation;
- is it handled correctly when it conflicts with what is stored, or belongs in the profile;
- is it never stored when it should not be;
- is what she *says* about it true.

## Why two layers

A year of "memory works" claims failed because nothing tested the whole path from what a member says to what Vitana says back. Unit tests passed while members heard "I can't save that". So the suite has two layers, and both must pass.

| | Layer A — Conformance | Layer B — Live voice |
|---|---|---|
| What runs | The real gateway memory code: `remember_fact` rules, the gateway backstop, the inline extractor's write guards, Identity Lock, forgotten-facts gate, recall broker, Garden | The real deployed product on **staging**: Nova voice, real speech (Polly-generated), real database |
| What is faked | Only the database (in memory) and the LLM's extracted facts (given per scenario) | Nothing but the member's voice |
| When | Every PR that touches the gateway (Jest, ~seconds) | After every memory-related deploy to staging, and on demand (~40–60 min) |
| Proves | The rules are right | The product does it, out loud, across sessions |
| Can it be fooled by a model that skips tools? | No — it tests the code | No — it checks the database and the spoken words, not the model's intent |

Layer A catches logic regressions before merge. Layer B is the only proof members get the behaviour, so a memory change is **done only when Layer B passes on staging.**

## How a scenario is written

Both layers read scenarios as data (JSON). Adding a case adds no code.

```jsonc
{
  "id": "B-CONFLICT-02",
  "category": "conflict",
  "title": "Sibling birthday changed in a later session: ask, then replace",
  "sessions": [
    { "lang": "de", "turns": [ { "say": "Merk dir: Mein Bruder Paul hat am fünften Mai Geburtstag." } ] },
    { "lang": "de", "turns": [
      { "say": "Mein Bruder Paul hat übrigens am siebten Mai Geburtstag.",
        "reply_must": ["5", "7"], "reply_must_ask": true, "reply_must_not": ["gespeichert", "aktualisiert"] },
      { "say": "Der siebte Mai ist richtig.", "reply_must": ["7"] }
    ] }
  ],
  "expect_db": { "facts": [ { "key_like": "paul%birthday", "value_date": "--05-07", "current": true } ],
                 "facts_absent": [ { "key_like": "paul%birthday", "value_date": "--05-05", "current": true } ] }
}
```

Each live turn is checked three ways:
1. **Database.** Which facts exist, current or superseded, with which value. Dates are compared by meaning, so "5. Mai" and "May 5" count as the same date.
2. **Tool / backstop status.** The `remember_fact` or `remember_backstop` outcome recorded in OASIS for the turn.
3. **Spoken reply.** Keyword rules per scenario: must mention, must ask, must not claim.
   - An optional LLM judge (Claude on Bedrock) rates the reply against the scenario's intent.
   - The keyword rules are what gate; the judge only adds a note.

## Safety

- **Staging only.** The live runner refuses to start unless the gateway reports `env=staging`.
- **Test user only** (`a27552a3-…`).
- Every scenario records a start time. Afterwards it deletes only the rows the test user wrote since then (facts, items, transcript turns, summaries, threads, promises) and restores any facts it superseded. Its own verification query then confirms zero leftovers.
- No community content is ever produced. No other account is touched.

## Case catalog

**64 conformance cases (A) + 32 live voice scenarios (B).** Categories run from the obvious to the ways memory has actually failed here.

### 1. Capture — facts about the member (A: 6, B: 3)
| ID | Input (DE unless noted) | Expected |
|---|---|---|
| A-SELF-01 / B-SELF-01 | "Merk dir, mein Lieblingsessen ist Lasagne." | saved; recalled in a new session |
| A-SELF-02 | "Ich arbeite als Physiotherapeutin." (no "merk dir") | saved by background extraction |
| A-SELF-03 / B-SELF-02 | "Remember that I'm allergic to penicillin." (EN) | saved in health scope; recalled in DE session |
| A-SELF-04 | "Mein Ziel ist, 10 kg abzunehmen." | saved as goal |
| A-SELF-05 | "Ich trinke jeden Morgen grünen Tee." | saved as routine |
| A-SELF-06 / B-SELF-03 | "Mein Hund heißt Bello." | saved; "Wie heißt mein Hund?" answered next session |

### 2. Capture — people in the member's life (A: 6, B: 4)
| ID | Input | Expected |
|---|---|---|
| A-OTHER-01 / B-OTHER-01 | "Merk dir, meine Frau Anna hat am 4. November Geburtstag." | saved about spouse, entity=disclosed |
| A-OTHER-02 / B-OTHER-02 | "Mein Bruder Paul hat am fünften Mai Geburtstag." | saved |
| A-OTHER-03 | "Meine Tochter Lea ist 7." | saved |
| A-OTHER-04 / B-OTHER-03 | "Mein Kollege Marko mag keinen Kaffee." | saved |
| A-OTHER-05 | two people in one sentence | two facts, no mix-up |
| A-OTHER-06 / B-OTHER-04 | about someone else: "Meine Mutter heißt Vesna" | never treated as the member's own name |

### 3. Profile-owned facts (A: 8, B: 4)
| ID | Situation | Expected |
|---|---|---|
| A-PROF-01 / B-PROF-01 | "Merk dir meinen Geburtstag: 9.9.1969", profile empty | profile_owned, nothing saved; tells to enter in profile, offers to open it |
| A-PROF-02 | same, profile has same date | "already know it" |
| A-PROF-03 | same, profile has different date | names profile value, says change it in profile |
| A-PROF-04 / B-PROF-02 | "Mein Name ist …" | profile_owned |
| A-PROF-05 | email / phone / address | profile_owned |
| A-PROF-06 | "Merk dir den Geburtstag meiner Frau" | NOT profile-owned (about someone else) |
| A-PROF-07 | background extraction of own birthday | Identity Lock refuses, nothing written |
| A-PROF-08 / B-PROF-03,04 | "Wann habe ich Geburtstag?" / "Wie heiße ich?" | answered from profile, never invented |

### 4. Already known / duplicates (A: 6, B: 2)
| ID | Situation | Expected |
|---|---|---|
| A-DUP-01 / B-DUP-01 | same fact said twice, two sessions | already_known; one current row |
| A-DUP-02 | "5. Mai" vs "May 5" vs "05.05." | same value |
| A-DUP-03 | stored "paul_birthday", said "Bruder Paul Geburtstag" | found under the stored key |
| A-DUP-04 | "Lasagne" vs "lasagne" | same |
| A-DUP-05 | background extractor re-mentions same value | no conflict, confidence up |
| A-DUP-06 / B-DUP-02 | repeated in one session | no second row, no "saved" twice |

### 5. Conflicts (A: 10, B: 6)
| ID | Situation | Expected |
|---|---|---|
| A-CONF-01 / B-CONF-01 | different value, same session | conflict; names both; nothing written |
| A-CONF-02 / B-CONF-02 | different value, later session | conflict (cross-session) |
| A-CONF-03 / B-CONF-03 | member confirms new value | replaced; old superseded |
| A-CONF-04 / B-CONF-04 | member confirms old value | old kept, nothing written |
| A-CONF-05 | member answers unclearly | nothing written |
| A-CONF-06 | confirm_replace without a prior question | still conflict (must ask first) |
| A-CONF-07 | confirmation 40 min later | not honoured |
| A-CONF-08 / B-CONF-05 | correction phrasing "nein, eigentlich am 7." | conflict → ask |
| A-CONF-09 | background extractor sees a different stated value | conflict kept for review, not overwritten |
| A-CONF-10 / B-CONF-06 | spouse birthday 1997 → 1999 (owner's own case) | ask which is right |

### 6. Recall (A: 8, B: 5)
| ID | Situation | Expected |
|---|---|---|
| A-REC-01 / B-REC-01 | ask in a new session | correct value |
| A-REC-02 / B-REC-02 | saved in DE, asked in EN | correct value |
| A-REC-03 | after a replace | new value only, old never |
| A-REC-04 / B-REC-03 | paraphrased question ("Wann feiert Paul?") | correct |
| A-REC-05 / B-REC-04 | nothing stored | says so honestly, never invents |
| A-REC-06 | another user's fact | never recalled |
| A-REC-07 | work-role memory | stays in work role |
| A-REC-08 / B-REC-05 | many facts (20) stored | the asked one is found |

### 7. Forgetting (A: 5, B: 2)
| ID | Situation | Expected |
|---|---|---|
| A-FORG-01 / B-FORG-01 | "Vergiss, dass mein Hund Bello heißt." | forgotten; not recalled |
| A-FORG-02 | Garden delete | gone from recall and Garden |
| A-FORG-03 | forgotten fact re-inferred in background | not re-learned |
| A-FORG-04 | forgotten fact stated again explicitly | saved again |
| A-FORG-05 / B-FORG-02 | "Was weißt du über meinen Hund?" after forget | nothing |

### 8. Must NOT be stored (A: 7, B: 3)

In layer A these cases check the pipeline around the extractor (no gateway note, no write, Identity Lock), given what the extractor returns. Whether the LLM correctly extracts *nothing* from a hypothetical, a joke or a question is a judgement only layer B can test.
| ID | Input | Expected |
|---|---|---|
| A-NOISE-01 / B-NOISE-01 | "Wenn ich einen Hund hätte, würde er Max heißen." | nothing stored |
| A-NOISE-02 | a question: "Hat Paul am 5. Mai Geburtstag?" | nothing stored |
| A-NOISE-03 / B-NOISE-02 | "Mein Nachbar glaubt, der Mond ist aus Käse." | not the member's fact |
| A-NOISE-04 | joke / sarcasm | nothing stored |
| A-NOISE-05 | "merk dir" with nothing to remember | asks what to remember |
| A-NOISE-06 | Vitana's own words | never stored as a member fact |
| A-NOISE-07 / B-NOISE-03 | "Ich heiße heute mal Batman" | profile untouched |

### 9. Time and plans (A: 4, B: 2)
| ID | Input | Expected |
|---|---|---|
| A-TIME-01 / B-TIME-01 | "Nächsten Dienstag habe ich einen Zahnarzttermin." | stored with a real date |
| A-TIME-02 | "Ich war gestern beim Arzt." | past, not a future plan |
| A-TIME-03 / B-TIME-02 | "Wann ist mein Zahnarzttermin?" next session | correct date |
| A-TIME-04 | birthday without a year | stored as day-month, never 1900 |

### 10. Honesty of speech (A: 4, B: 1 check applied to every live turn)
| ID | Rule |
|---|---|
| A-HON-01 | never "saved" unless status is saved |
| A-HON-02 | failed write → says it could not save |
| A-HON-03 | backstop note is never recorded as member speech |
| A-HON-04 | backstop stands down when the tool was called |
| B-HON-ALL | on every live turn: no "kann ich nicht speichern" for non-profile facts, no "notiert/gespeichert" for profile facts, no "saved" before the member confirmed a conflict |

## Layer A — first run (2026-09-26)

64 cases, all run. **59 pass as specified. 5 fail and are real gaps**, recorded in the fixture with `gap` so they run as `it.failing`: CI stays green while a gap is open and turns red the day it is fixed, so the marker must then be removed.

| Case | Gap |
|---|---|
| A-PROF-08 | Recall reads the member's birthday from `app_users.profile`, which is empty for every member on the live database (0 of 14 checked 2026-09-26). The profile screen writes `profiles.date_of_birth`. So "When is my birthday?" has no answer in the recall pack. |
| A-DUP-02 | A day-month date with no year ("05.05.") is not recognised as a date, so it counts as a different value from "May 5". |
| A-DUP-03 | The background extractor matches the exact key only. Said as "brother Paul's birthday" while stored as `paul_birthday`, it writes a second row for the same thing. |
| A-CONF-09 | Same root cause: a *different* value under a related key is written, not kept for review. |
| A-FORG-01 | Voice "forget" (`forget_memory`) deletes the conversation note (`memory_items`) but not the stored fact (`memory_facts`). The fact is still recalled afterwards. |

**The suite was checked against deliberate breakage.** Five changes were made to the memory code one at a time, and each turned the suite red:
- honouring `confirm_replace` without asking first;
- the backstop ignoring a tool call;
- the forgotten gate always open;
- the extractor conflict guard removed;
- profile routing removed.

After each check the code was restored.

**What layer A fakes, and why that is safe:**
- The database is emulated per table.
- `write_fact` and the role filter of `memory_semantic_search` are copied from the live definitions, which were read 2026-09-26.
- `memory_broker_enabled` is seeded as `true`, matching the live value.

## Pass bar
- **Layer A: 100%.** Any failure fails the PR.
- **Layer B:**
  - Database and tool assertions must pass 100%.
  - Spoken-reply rules must pass **≥ 90% per category**, and 100% for the honesty category.
  - Each scenario runs twice. A scenario passes only if both runs pass, so a lucky single run cannot hide Nova's non-determinism.
- The report names every failed scenario with its session id, the transcript, the DB rows, and the tool / backstop statuses.

## Files
- `services/gateway/test/fixtures/memory-verification/conformance.json` — layer A scenarios
- `services/gateway/test/memory-verification-conformance.test.ts` — layer A runner (Jest, in CI)
- `scripts/memory-verification/scenarios.live.json` — layer B scenarios
- `scripts/memory-verification/run-live.mjs` — layer B runner. It synthesizes each utterance with Polly (cached), runs the voice sessions on staging, checks the results, cleans up, and writes `report.md` + `report.json`.
- `npm run test:memory` (in `services/gateway`) runs layer A; `node scripts/memory-verification/run-live.mjs` runs layer B.
