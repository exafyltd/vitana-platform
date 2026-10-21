# VTID-04124 — acceptance

**Title:** ORB voice: root-cause the `nova_validation` content-filter block rate on logged-in Nova sessions
**Validation profile:** `gateway_backend`

## Why

Blocked greeting turns are a latency cost, not only a reliability one: each one
forces a retry before the user hears anything. Three earlier VTIDs (03785,
03786, 03787) tried and failed to explain the rate.

## What the measurement actually says

### Correction to the metric itself (AC-1)

Every earlier estimate counted `metadata.code = 'nova_validation'`. That code
bundles **two unrelated failures**:

| diagnostic | meaning |
|---|---|
| `…has been blocked by our content filters.` | the real guardrail block |
| `Timed out waiting for audio bytes or interactive content … less than 55 seconds.` | an idle-stream timeout, nothing to do with content |

Over 14 days the idle-timeout variant is the **more common** of the two on most
days (20 vs 5 on 2026-09-15; 10 vs 2 on 09-17), and their mix shifts over time —
so the "35.8% → 66.7%" figures reported earlier in this session were measuring a
moving blend of two different things. Counting only the real content-filter
diagnostic, and only production origin, the rate is **10.1% (31/307)**.

`origin` on `vtid.live.session.start` is the reliable prod/staging discriminator
(`https://vitanaland.com` vs `https://preview-aws.vitanaland.com`) — `env` is
hardcoded `'production'` on both, a red herring already documented in the change
log. Staging, running the same commit: **0.3% (1/330)**.

### Where the blocks concentrate (AC-2)

30 days, production origin, authenticated, joined to the real content-filter close:

| rung / band | sessions | blocked | rate |
|---|---:|---:|---:|
| `legacy_default`, prompt_len 550–700 | 14 | 11 | **78.6%** |
| `legacy_default`, every other length | 21 | **0** | **0.0%** |
| `override_v2` | 7 | 3 | 42.9% |
| `conv_resume` | 12 | 3 | 25.0% |
| `newday_overview` (~20 KB directive) | 137 | 13 | 9.5% |

All 11 legacy blocks fall inside one 100-char band; every other band is 0.

### Two theories this kills

- **Size is not the driver.** The longest directive in the system
  (`newday_overview`, up to 21,856 chars) has the *lowest* rate, while a
  ~660-char one blocks four times in five. Neither the instruction budget nor
  VTID-04096's reduced directive can be the cause.
- **It is not the user's data.** The contrast is *within one function*, and for
  the heaviest-hit user *within one account*: the same person's
  `newday_overview` sessions pass while their short-gap sessions do not.

### Reverse causality: tested, does not explain it (AC-3)

A block makes the user retry at once, and an immediate retry is exactly what
puts a session in the `reconnect`/`recent` bucket — so the arrow could have run
backwards. Splitting the same 14 sessions on whether the **same user** had a
content-filter block in the preceding 30 minutes:

| | sessions | blocked | rate |
|---|---:|---:|---:|
| preceded by a block | 7 | 7 | 100% |
| **not** preceded by a block | 7 | 4 | **57.1%** |

The template is block-prone on its own (57% against a 0% sibling baseline); the
retry loop then amplifies it to certainty. Both effects are real; only the
second is downstream of the first.

## Root cause

The 550–700 band uniquely contained a **pile-up of negative imperatives** —
`Do NOT greet. Do NOT say "Hello" or the user's name. … EXACTLY ONE … NEVER use
two-part sentences`, plus three more inside the shared INTENT. That is the same
template *kind* VTID-03797 already proved causal for guided-topic sessions
(blocked 93/93 until its prohibition stack was removed): Bedrock's guardrail
scores it as injection-like. The sibling branches in the same function
(`Open with "Good morning, [Name]." … follow the OPENING SHAPE MATRIX`), which
carry almost no prohibitions, are **0/21**.

## Fix

Every clause is preserved, restated positively — `propose the move yourself`
carries the old `never ask what they want`; `choosing fresh wording every time`
carries the anti-repeat rule; `straight to the substance` carries the
no-greeting/no-name rules.

| site | measured? |
|---|---|
| `SHORT_GAP_OPENER_INTENT` | yes — in the 78.6% band |
| `bucket=reconnect` / `recent` / `same_day` | yes — in the 78.6% band |
| legacy apology branch (`wasFailure`) | **no** — 147–203 chars, in a 0/21 band; fixed on shape-class + NEVER-rule 41 grounds |
| rung 6 `safe_fast_pending_context` | **no** — below the n≥5 threshold; shape-class only |
| `LEGACY_DEFAULT_OPENER_INTENT` (anonymous reconnect) | **no** — shape-class only |

The apology branch was additionally a `Record<lang, string>` of **finished
spoken sentences** (`Say exactly: "Sorry about that. How can I help?"`) — a
direct CLAUDE.md NEVER-rule 41 violation, and VTID-03797's exact trigger shape.
It is now one language-neutral intent, which *strengthens* VTID-03556's own fix
(a German user can no longer get an English apology, because no literal exists).

## Acceptance criteria

AC-1 — the block metric separates the real content filter from the unrelated 55-second idle-stream timeout that shares `code='nova_validation'`.
TEST: docs/validation/VTID-04124/outputs/block-rate-by-diagnostic.md §1 (14-day split); the test file header records the same split.

AC-2 — no rewritten greeting rung emits more than one negative imperative.
TEST: services/gateway/test/services/conversation/vtid-04124-greeting-prohibition-stack.test.ts — "stays at or below 1 negative imperative", 6 rungs.

AC-3 — no rewritten rung orders verbatim reproduction of a supplied sentence (VTID-03797's identified trigger shape).
TEST: services/gateway/test/services/conversation/vtid-04124-greeting-prohibition-stack.test.ts — "no rewritten rung orders VERBATIM reproduction of a supplied sentence".

AC-4 — the behavioural meaning survives the rewrite: the model still composes its own opener, still leads rather than asking, still varies wording.
TEST: services/gateway/test/services/conversation/vtid-04124-greeting-prohibition-stack.test.ts — "the behavioural meaning survived the rewrite".

AC-5 — the apology branch is language-neutral, with no English literal left to leak into a non-English session (VTID-03556's own regression, strengthened).
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts — "legacy apology branch is language-neutral — no per-language table left to drift".

AC-6 — the guard actually bites: restoring a prohibition stack on any rewritten rung fails the build.
TEST: services/gateway/test/services/conversation/vtid-04124-greeting-prohibition-stack.test.ts — mutation-verified, see commands.log.

## Not verified

**No live confirmation.** This session cannot place a real ORB voice call, and
CLAUDE.md forbids testing against production. The fix is verified structurally
and against the live measurement that identified it — not against a post-deploy
block rate. **n=14 on the hot band is small**: the honest claim is a strong
effect on a narrow, low-volume band, not a precise rate.

The signal to watch after this deploys: the `legacy_default` 550–700 band's
content-filter rate falling toward its 0/21 siblings' baseline.

**Strongest remaining lead, deliberately not touched:** `conv_resume` at 25.0%
(3/12) — a large structured block with its own rule list, like
`newday_overview` (9.5%). Rewriting those is a bigger, unmeasured change and
belongs to its own VTID.

OASIS_PROOF: VTID-04124 allocated via `POST /api/v1/vtid/allocate`
(`{"ok":true,"vtid":"VTID-04124","num":4124}`), registered in `vtid_ledger`
with `status='in_progress'`, `spec_status='approved'`.
