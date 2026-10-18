# Requirements — sparring-model-fallback

## R1 — Opus 4.6 stays the primary partner
The sparring partner's primary model remains `PLAN_SPARRING_MODEL` (default
`eu.anthropic.claude-opus-4-6-v1`) with `effort: 'high'` + adaptive thinking. This change does not alter
the primary or weaken VTID-04868 (rule 53): Opus 4.6 first, always.

## R2 — Explicit, logged fallback on retryable throttle only
When a partner invoke fails with a **retryable throttle** — specifically a Bedrock
`Too many tokens per day` error or an explicit rate-limit/throttling error — the partner pass retries the
same turn once on the fallback model `PLAN_SPARRING_FALLBACK_MODEL` (default
`eu.anthropic.claude-sonnet-4-6`). The fallback:
- fires ONLY for retryable throttle errors, never for other failures (auth, invalid request,
  content errors still end the pass as before);
- is at most one retry per turn;
- writes a `modelLog` entry AND a WARN log line naming the throttle reason and the fallback model, so the
  fallback is always visible — never silent.

## R3 — No silent / non-Bedrock fallback
The existing guard `r.provider !== 'bedrock'` stays. Sonnet 4.6 is a Bedrock model, so a legitimate
fallback still passes this guard; any non-Bedrock answer (Anthropic-direct, Google, DeepSeek) is still
refused. The router-level `NO_FALLBACK_STAGES` entry for `plan_sparring` is UNCHANGED — the throttle
fallback is implemented inside the partner pass explicitly, not via the generic router fallback.

## R4 — Request shape gated by model
`output_config.effort` / `thinking` are sent only to models that accept them. Opus 4.6 receives both.
Sonnet 4.6 receives only the fields it accepts, verified by a real invoke at implementation time (if it
rejects `output_config.effort`, that field is omitted for Sonnet). No model ever receives a field it
rejects (which previously produced `Extra inputs are not permitted` on Opus 4.5).

## R5 — Tests prove the behaviour
A regression test proves: (a) a non-throttle failure ends the pass with no retry; (b) a
`Too many tokens per day` failure retries once on the fallback and the round proceeds on success;
(c) the field-gating table sends `effort` to Opus 4.6 and withholds it from a model marked as not
accepting it; (d) a non-Bedrock fallback is still refused.

## R6 — Verified on staging, read-only
After deploy, a real re-push of a stuck plan spars; when Opus 4.6 throttles mid-round, the round completes
on Sonnet 4.6 (visible in modelLog) instead of escalating `model_unavailable`. No production writes.
