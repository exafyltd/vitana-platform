# VTID-03797 — per-language guided-topic coverage, measured live

Answering the explicit requirement that all 254 My Journey topics work in
**every one of the 11 languages**, rather than assuming the greeting fix
covers them.

Everything below is measured, not inferred. Raw evidence:
`outputs/live-language-routing.txt` (health endpoint) and
`outputs/live-probe-languages-before-fix.json` (real sessions).

## 1. The block is Nova-specific, not guided-topic-general

A live probe on staging against the **pre-fix** code, extended past the
de/en cases the earlier probe covered:

| language | route | guided topic (pre-fix) | audio chunks | errors |
|---|---|---|---|---|
| fr | Nova (speech-to-speech) | **BLOCKED** | 2 | 2 |
| es | Nova | **BLOCKED** | 2 | 2 |
| ru | cascade (Transcribe→Bedrock→Polly) | **WORKS** | 10 | 0 |
| pl | cascade | **WORKS** | 9 | 0 |

Together with the earlier de/en/T100/T200 results (all BLOCKED on Nova),
this is a clean split along the **upstream**, not along topic or language.

Guided topics have been working on the cascade languages the whole time.
That independently corroborates the "worked on Vertex, broke on Nova"
report: the guardrail rejecting the turn-1 directive lives on the Nova
speech-to-speech path. The cascade's text step (`callViaRouter('operator')`
→ Bedrock) does not reject the same directive.

**Why the fix still reaches every language:** the greeting decision is
upstream-agnostic. Every client implements the same `UpstreamClient`
interface (`types.ts:359`) and the directive arrives via `sendTextTurn` on
all of them. `buildGuidedTopicOpenTrigger()` interpolates no topic title
and no per-language text, so there is no table to keep in sync and no
locale that can be missed.

## 2. Live routing per language

`GET /api/v1/orb/nova-sonic/health` (public, secret-free, read-only),
measured 2026-08-29:

| | staging | production |
|---|---|---|
| `ORB_CASCADED_VOICE_ENABLED` | `true` | **`false`** |
| `VERTEX_LIVE_UNAVAILABLE` | `true` | `true` |
| **`effective`** | **`true`** | **`false`** |

Per-language verdict (computed from the same predicates routing uses, so
identical on both hosts — only `effective` differs):

| languages | verdict |
|---|---|
| en, de, fr, es | `no:nova_supports_natively` — Nova speech-to-speech |
| ar, pl, pt, ru, tr, zh | `cascade:<code>` — eligible |
| sr | `no:no_polly_voice` |

### The production gap

Nova speaks only `en de fr es`. With the cascade `effective:false` in
production, the other six languages are **forced onto Nova anyway** — the
deliberate VTID-03649 tradeoff of degraded speech over a connection to a
dead Vertex endpoint. That is the documented 4-5x audio shortfall in
`cascaded-config.ts`.

So, before this fix: guided topics worked in **six** languages on staging
and **zero** in production. Closing that is a production config change
(`ORB_CASCADED_VOICE_ENABLED` on `AWS-PROD-DEPLOY-GATEWAY.yml`), whose own
input description requires Transcribe + Polly IAM to be confirmed first.
**Not done here** — a prod dispatch is a deliberate, separately-approved
action, not a side effect of this work.

## 3. Serbian is a product gap, not a bug

`sr` reports `no_polly_voice`. Polly has no Serbian voice in any engine —
verified against the live API 2026-08-20 (106 voices, 42 language codes,
nothing matching `sr`/`hr`/`bs`/`sh`). The cascade fails closed rather than
serving Serbian in a wrong-language voice. Closing this needs a third TTS
provider; no change in this VTID addresses it.

So **10 of 11** languages are routable; Serbian is the one that is not.

## 4. Content is not the blocker

`supported_locales` × `journey_checklist_translations`, read live:

- All 11 locales are `status='ga'`.
- 254 rows each for en, es, fr, ar, pl, pt, ru, sr, zh.
- `de` = 4 rows, which is **correct** — German is the source language
  authored in the base table, and those 4 are legitimate explicit
  overrides (VTID-03679 established exactly this, after the same number
  was misread as a coverage failure).
- **`tr` = 252 rows, two short.** A real, small gap — flagged, not fixed
  here, and it needs its own VTID rather than being folded in silently.

## 5. What this does not establish

The post-fix re-run on Nova's four languages had not completed when this
was written. The pre-fix baseline is 0/93 guided sessions on Nova. If they
now speak, the verbatim directive was the cause; if they still block, the
greeting is eliminated and the GUIDE-MODE block is next. That result will
be recorded as measured, either way.
