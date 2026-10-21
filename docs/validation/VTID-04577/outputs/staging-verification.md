# VTID-04577 / 04578 / 04579 — staging verification (build 8fa030b)

Staging served `8fa030b` on 8/8 build-info samples before any test ran.
Three authenticated `de` Nova sessions, run with the test account over SSE.
Read-only apart from sign-in. Script:
`LANG_CODE=de node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated --trials=3 --utterance-pcm=q_follows_de.raw`

| Check | live-39596249 | live-6d29f21a | live-a5ad1545 |
|---|---|---|---|
| brain_context_built packed | false | false | false |
| chars_after (old cap 12,000) | 14,142 | 14,142 | 15,217 / 15,668 |
| social_context | kept | kept | kept |
| instruction_budget trimmed / shortened | none | none | none |
| instruction bytes (of 65,536) | 39,012 | 39,015 | 40,094 / 40,519 |
| MEMORY LOOKUP count in dump | 1 | 1 | 1 |
| "MY JOURNEY — ZWEI ANSICHTEN" count | 1 | 1 | 1 |
| `Follows (1): Mariia Maksina` in prompt | yes | yes | yes |

Before (build a07a332, `baseline-spoken-trials.json`): social_context was
dropped in every session.

## The spoken question, "Wem folge ich eigentlich in der Community?"
- Trial 1 was wrong: "Du hast derzeit noch keine Follower". The model called
  `list_followers`.
- Trial 2 was right, then contradicted itself: "Du folgst aktuell Mariia
  Maksina", then the `list_followers` result.
- Trial 3 hit Nova's content filter on the greeting (the wake-brief override
  rung). No user turn was reached.

The context fix works: the fact is now in the prompt, and trial 2 answered
from it. The remaining error is tool choice. Nova calls `list_followers`, a
tool that is not in its declared catalog; only `list_following` is. This is
fixed in VTID-04585.

The trial-3 content-filter block is on a greeting rung this change does not
touch (`wake_brief_override`). With 3 post-deploy sessions, the sample is too
small to compare block rates.
