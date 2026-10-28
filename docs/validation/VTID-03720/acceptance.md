# VTID-03720 — staging must PIN the cascade flag, not inherit it

Reported live, after every code fix in the chain had already merged:

> "I just checked on staging, and Polish and Portuguese still speak English
> with Polish accent and Portuguese accent... it's still the same old shit
> since hours."

Correct, and none of the merged code could have changed it.

## The code was never the blocker

Ran the real decision functions rather than reading the tables
(`outputs/cascade-eligibility.txt`):

| lang | Nova speaks it | cascade eligible | Transcribe | Polly voice |
|---|---|---|---|---|
| `pl` | no | **yes** | `pl-PL` | Ola (neural) |
| `pt` | no | **yes** | `pt-BR` | Camila (neural) |
| `ru` / `ar` / `zh` | no | yes | ✓ | ✓ |
| `sr` | no | **no** — `no_polly_voice` | – | none |

So the pipeline resolves Polish and Portuguese correctly. What it never got
was permission to run.

## Root cause: config that existed only in live AWS state

`ORB_CASCADED_VOICE_ENABLED` appeared in `AWS-STAGE-DEPLOY-GATEWAY.yml`
**only inside a comment**, asserting it was "already true here". That was an
observation of live AWS state, not something the file guaranteed — the var was
in **neither** the strip list **nor** the re-add list, so it was merely
*preserved* from whatever the previous task definition happened to carry.

`isCascadedVoiceEnabled()` requires the exact string `'true'`. Anything else —
unset, empty, inherited-stale — makes `tryCascadeRescue()` return null, control
falls to `nova_forced_vertex_unavailable`, and **Nova is forced to carry a
language it cannot speak**. It then answers in English, in a language-flavoured
voice: `pt` → `carolina` (a real Brazilian Portuguese voice), `pl` → `tina`
(the German fallback). That is the reported symptom exactly, accent included.

This is the VTID-03513 failure shape, which this very file warns about: state
that lives only in AWS, invisible to review, unverifiable, and silently
reversible by the next deploy.

---

AC-1 — The flag is pinned as the exact string the code compares against

TEST: `services/gateway/test/orb/live/upstream/staging-cascade-flag-pinned.test.ts` —
"upserts the flag as the exact string \"true\""
Output: `outputs/targeted-tests.txt`

`=== 'true'`, so `"TRUE"`/`"1"`/`"yes"` are all off. Pinning the literal is the
whole point.

AC-2 — An inherited stale value cannot survive

TEST: same file — "strips the inherited value first, so a stale one cannot survive"
CURL: n/a — verified by EXECUTING the filter, see AC-3
Output: `outputs/targeted-tests.txt`

Without the strip, the re-add appends a duplicate key beside the inherited one,
and which wins is not something to leave to chance.

AC-3 — The jq filter actually does it, run against a hostile fixture

TEST: `outputs/jq-fixture-run.txt` — the filter extracted from the workflow and
executed with `jq` against `environment: [{ORB_CASCADED_VOICE_ENABLED: "STALE"}]`.
Result: exactly one entry survives, `value: "true"`; `stale value survived? False`.
Output: `outputs/jq-fixture-run.txt`

A YAML-parse check proves the file loads; it does not prove the filter is
correct. This runs it.

AC-4 — The flag it is useless without still ships

TEST: same file — "keeps the flag it is useless without"
TEST: same file — "keeps Polly strict, so a TTS gap fails loudly instead of reaching for dead Google"
Output: `outputs/targeted-tests.txt`

`VERTEX_LIVE_UNAVAILABLE` gates the branch **above** the cascade: unset, the
selector returns `{provider:'vertex'}` and returns *before* `tryCascadeRescue`
is consulted, so the cascade flag does nothing. These must ship together or
neither has any effect — the workflow's own VTID-03708 comment already
documents this, and it is now covered by a test rather than by prose.

AC-5 — No regression

TEST: `npx jest test/orb/` — 1741 passing, 6 pre-existing todo.
TEST: `npx tsc --noEmit` — clean.
Output: `outputs/orb-suite.txt`

---

## Verification summary

| Check | Result |
|---|---|
| Targeted suite | 4/4 |
| jq filter executed against stale fixture | strips + pins correctly |
| Cascade eligibility (real functions) | pl/pt/ru/ar/zh eligible; sr refused |
| Workflow YAML parses | OK, 1 job |
| `test/orb/` | 1741 passing |
| `tsc --noEmit` | clean |
| Live confirmation | **pending — needs a listen after this deploys to staging** |

## What this does and does not claim

**Does:** staging will now genuinely exercise Transcribe → Bedrock → Polly for
`pl pt ru ar zh`, and the flag's value is reviewable in git instead of living
only in AWS.

**Does not:** I could not read staging's live task definition — there is no
`aws` CLI in this session — so I cannot state what the inherited value was,
only that the repo never guaranteed it and that the observed behaviour matches
the off branch precisely. The proof is the next staging deploy: a Polish
session should answer in Polish, in Ola's voice.

**Also unproven from here:** the `transcribe:StartStreamTranscription` +
`polly:SynthesizeSpeech` grants on `vitana-ecs-task-role`. If those are
missing, the failure is per-turn and quiet rather than loud. If Polish comes
back silent or erroring rather than English, that is the thing to check.

**Not in scope:** `sr` stays English-voiced — Polly publishes no Serbian voice
in any engine, so the cascade correctly refuses it (`no_polly_voice`). That is
a product gap needing a third provider, not a config error.
