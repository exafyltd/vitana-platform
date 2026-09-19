# VTID-04100 — enable the greeting audio bridge in production

Follow-up to VTID-04096/04097/04098/04099/04100 (PR #3451, merged `01566ab`).
That PR shipped the bridge's cache and bounded its pre-connect await and
enabled it on STAGING ONLY, deliberately: turning it on reverses a recorded
product decision, and that is not a latency VTID's call to make.

The platform owner reviewed the trade on 2026-09-19 and accepted it. This
change pins the flag for production.

## What the trade is

The bridge phrase is synthesized by Polly; the live upstream is Nova Sonic.
The user therefore hears one voice say the short bridge line and a different
voice continue. That is why it was disabled on 2026-07-28.

What it buys, measured on staging 2026-09-19 (authenticated `de`, pooled
n=19, `scripts/orb/measure-orb-first-audio.mjs`):

| | min | p50 | p90 |
|---|---|---|---|
| First AUDIBLE speech (bridge) | 621 ms | 1,398 ms | 2,018 ms |
| First MODEL audio | 2,370 ms | 2,878 ms | 3,614 ms |

The catalog and directive budgets (VTID-04097/04096) move the TAIL — p90
7,502 → 3,614 ms. They do not move the floor. The bridge is the only
mechanism that puts a voice in front of the model's own time-to-first-token,
and it is the difference between ~2.9 s and ~1.4 s to a spoken word.

## Acceptance criteria

AC-1 Production pins the flag ON, via the deploy workflow rather than a
hand-edited task definition.
  TEST: services/gateway/test/orb/live/upstream/vtid-04100-prod-greeting-bridge-flag-pinned.test.ts
  ("upserts the flag as \"staging+prod\"")

AC-2 The pin is authoritative — the inherited value is stripped first, so an
absent or stale value on the live task def cannot survive the deploy. (The
live prod task def, rev 108, did not carry this var at all, and an absent var
resolves to off.)
  TEST: same file ("strips the inherited value first")

AC-3 The reversal of a recorded product decision is documented in place, with
the original date, the actual objection, and the rollback.
  TEST: same file ("records WHY a recorded product decision was reversed")

AC-4 The workflow records that this is only safe because VTID-04100 gave the
bridge a cache and bounded its await — an unbounded await on the pre-connect
path is what made VTID-03802 an outage.
  TEST: same file ("is only safe because VTID-04100 cached it and bounded its await")

AC-5 Staging keeps the flag enabled; production must never be ahead of
staging on this.
  TEST: same file ("staging keeps the flag on too")

## OASIS_PROOF

OASIS_PROOF: no new topic, no new event volume. The existing
`greeting_bridge_sent` diag already carries `cache: hit|miss` (added by
VTID-04100 in `01566ab`); enabling the flag in production simply means that
stage begins appearing for production sessions, where it currently never does.

Post-deploy confirmation (read-only):

    select metadata->>'env', metadata->>'cache', count(*)
    from oasis_events
    where topic='orb.live.diag' and metadata->>'stage'='greeting_bridge_sent'
      and created_at > now() - interval '1 hour'
    group by 1,2;

Before this change that query returns zero production rows, which is what
makes their appearance the proof.

## Not verified here

The voice seam itself is a subjective judgement and was made by the platform
owner, not measured. The latency figures above are STAGING; production has
never emitted `voice.latency.measured` at all, because
`FEATURE_LATENCY_TELEMETRY_ENV` was set to the unrecognised value
"production" and silently resolved to off (VTID-04098). The same deploy that
carries this flag also carries that repair, so the first production numbers
for any of this arrive together with it.
