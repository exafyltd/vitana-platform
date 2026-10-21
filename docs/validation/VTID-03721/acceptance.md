# VTID-03721 — make the cascade's runtime state observable

VTID-03720 found that `ORB_CASCADED_VOICE_ENABLED` was set nowhere in the repo
— asserted only in a workflow comment. The reason that survived for so long is
this one: **there was no way to ask.**

- No endpoint reported cascade state (searched: none exists).
- Session telemetry records **no upstream provider** at all — a `pl` session's
  full event trail shows `greeting_sent → model_start_speaking → turn_complete`
  with no field naming who served it.
- `nova_voice`, added for exactly this purpose, lands in **0 of 90** events
  (task #35 — wired to a dead emit site).

So "is the cascade on?" was a boolean that required AWS console access, and I
answered it wrong more than once by inferring from merged code instead.

## The field that matters is `effective`, not `enabled`

`VERTEX_LIVE_UNAVAILABLE` gates the branch **above** the cascade: unset, the
selector returns `{provider:'vertex'}` and returns *before* `tryCascadeRescue()`
is consulted. So `enabled: true` alone is true-but-useless — the exact
plausible-but-wrong shape this codebase keeps paying for. `effective` is
`enabled && vertexDead`.

---

AC-1 — `effective` reflects both gates, not one

TEST: `services/gateway/test/orb/live/upstream/cascade-health-payload.test.ts` —
"is true only when BOTH flags are set"
TEST: same file — "is false when the cascade flag is on but Vertex is not marked dead"
TEST: same file — "is false when the cascade flag is absent"
Output: `outputs/targeted-tests.txt`

The middle case is the silent one: cascade on, Vertex not marked dead, nothing
happens. It now reports `enabled: true, effective: false`.

AC-2 — The report cannot disagree with routing

TEST: same file — 6 cases of `"TRUE"/"True"/"1"/"yes"/"on"/""` → OFF
TEST: same file — "accepts the exact string with surrounding whitespace trimmed"
Output: `outputs/targeted-tests.txt`

`isCascadeEnabled()` compares `=== 'true'` after `.trim()`. The payload must
match exactly — a health endpoint that contradicts the code is worse than none.
(My first draft listed `' true '` as OFF; the suite caught the contradiction.)

AC-3 — Per-language verdicts come from the real routing functions

TEST: same file — "reports the languages the cascade rescues, with their Transcribe codes"
TEST: same file — "reports Serbian as refused, naming Polly as the real blocker"
TEST: same file — "reports Nova-native languages as refused for that reason"
Output: `outputs/targeted-tests.txt`

Derived from `evaluateCascadeEligibility`, not a second hardcoded list — the
divergence VTID-03681 found across seven tables. `sr` reports
`no:no_polly_voice`, naming the service actually responsible.

AC-4 — Public route leaks nothing

TEST: same file — "leaks no credentials"
Output: `outputs/targeted-tests.txt`

Asserted rather than assumed, because this route is public: a fixture carrying
`AWS_SECRET_ACCESS_KEY` and a role ARN must not appear in the JSON.

AC-5 — No regression

TEST: `npx jest test/orb/` — 1755 passing, 6 pre-existing todo.
TEST: `npx tsc --noEmit` — clean.
Output: `outputs/orb-suite.txt`, `outputs/tsc.txt`

---

## Verification summary

| Check | Result |
|---|---|
| Targeted suite | 16/16 |
| `test/orb/` | 1755 passing |
| `tsc --noEmit` | clean |
| Import cycle | none — `cascaded-config` already imports `nova-sonic-config`, not the reverse; verified before writing |
| Live confirmation | pending — the endpoint answers for itself once deployed |

## Why it rides on the Nova health route

Nova's health already answers "what serves a session". The cascade is the other
half of that answer for every language Nova cannot speak. A separate endpoint
would let the two drift, and drift between two tables describing one decision is
the recurring defect in this area.

## After deploy, this is answerable in one curl

    curl -s https://preview-aws-gateway.vitanaland.com/api/v1/orb/nova-sonic/health | jq .cascade

`effective: true` means Polish routes to Polly. `effective: false` names which
flag is missing. Either way it is a fact, not an inference — which is the whole
point of this VTID.
