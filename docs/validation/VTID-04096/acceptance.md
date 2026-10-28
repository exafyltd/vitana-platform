# VTID-04096 — ORB voice first-audio latency

Covers VTID-04096 (greeting directive budget), VTID-04097 (Nova tool-catalog
budget), VTID-04098 (feature-flag value hardening + prod pins), VTID-04100
(greeting-bridge cache + bounded await). Companion: VTID-04099 in
`exafyltd/vitana-v1` (widget load path), whose gateway-side half — bounding the
pre-session continuity round trip in `orb-widget.js` — lands here.

## The reported problem, and what the data says

Reported: pre-login intro takes 6-10s to speak, post-login worse, and the
Serbian/GCP path is much faster than AWS.

The provider premise is inverted. Production `oasis_events`, 30 days, p50 from
`vtid.live.session.start` to `orb.live.diag:model_start_speaking`:

| Cohort | Provider | Directive | Total | p90 | n |
|---|---|---|---|---|---|
| Pre-login SR | Vertex (GCP) | 101 chars | 8,503 ms | 10,605 | 24 |
| Pre-login DE | Nova (AWS) | 137 chars | 2,179 ms | 4,679 | 15 |
| Logged-in DE | Nova (AWS) | 17,838 chars | 7,670 ms | 10,450 | 49 |
| Logged-in EN | Nova (AWS) | 18,526 chars | 8,273 ms | 23,778 | 19 |
| Logged-in SR | Vertex (GCP) | 911 chars | 2,925 ms | 7,007 | 37 |

Pre-login Serbian on GCP is the SLOWEST production cohort. Payload size, not
the cloud, is the explanatory variable.

## Acceptance criteria

AC-1 The tool-catalog byte budget resolves per upstream provider instead of
being gated on `provider === 'vertex'`, and the cascade still gets no guard.
  TEST: services/gateway/test/orb/live/tools/vtid-04097-nova-tool-catalog-budget.test.ts
  ("gives Nova its own default budget", "returns no guard for the cascade and
  for an unresolved provider")

AC-2 The trim runs before the Nova branch reads `setup.tools`, and after the
provider is resolved — otherwise Nova silently receives the untrimmed array.
  TEST: services/gateway/test/orb/live/tools/vtid-04097-nova-tool-catalog-budget.test.ts
  ("runs the trim BEFORE the Nova branch reads setup.tools", "resolves the
  provider before the trim runs")

AC-3 The Nova budget keeps every priority tool present in the real
authenticated catalog. Measured: the priority set alone is 58.3 KB, so a 48 KB
budget drops eight of its own priority entries (log_water, log_sleep,
log_exercise, log_meditation, get_vitana_index, get_pillar_subscores,
resolve_recipient, explain_feature). 64 KB keeps all of them at 41/290
declarations and 65.5 KB.
  TEST: services/gateway/test/orb/live/tools/vtid-04097-nova-tool-catalog-budget.test.ts
  ("keeps every priority tool the untrimmed catalog actually had", "keeps
  navigation and end_conversation")

AC-4 Trimming the catalog measurably reduces time to first model audio on
Nova, most of all in the tail. Controlled A/B on staging, authenticated `de`,
10 trials per arm, only the ORB surface (and therefore the declared catalog)
changed: 290 decls/221.5 KB gave p50 3,033 ms / p90 7,502 ms; 134 decls/44.5 KB
gave p50 2,513 ms / p90 3,081 ms.
  TEST: outputs/ab-A-full-catalog-290tools.json, outputs/ab-B-admin-catalog-134tools.json
  (produced by scripts/orb/measure-orb-first-audio.mjs against staging)

AC-5 The greeting directive is bounded, and an over-budget new-day briefing
falls back to a compact variant that keeps the payload, the already-spoken
ledger and the name/length rules while dropping the static tuition.
  TEST: services/gateway/test/orb/live/instruction/vtid-04096-greeting-directive-budget.test.ts
  ("is an order of magnitude smaller than the full block", "keeps the payload",
  "drops the static tuition", "keeps already-spoken continuity")

AC-6 The compact directive keeps the wake-brief override marker, so the rung
is shrunk rather than silently demoted, and never hardcodes a spoken sentence
(Part 1 NEVER rule 41).
  TEST: services/gateway/test/orb/live/instruction/vtid-04096-greeting-directive-budget.test.ts
  ("keeps the override marker", "never hardcodes a sentence Vitana speaks")

AC-7 The real greeting decision emits the compact directive when over budget,
and reports it as queryable diag fields. Golden snapshots move 15,039 -> 1,096
and 16,606 -> 1,739 chars.
  TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  (re-recorded snapshots carry directive_reduced / directive_full_len /
  directive_budget_bytes and prompt_len 1,096 and 1,739)

AC-8 An unrecognised feature-flag value resolves to off AND says so loudly,
once per flag, and is distinguishable from a deliberate off.
  TEST: services/gateway/test/services/vtid-04098-feature-flag-invalid-value.test.ts
  ("rejects the real value found live in production", "logs an error naming the
  flag", "warns once per flag, not once per session")

AC-9 The greeting bridge is cached per (lang, rendered text), bounded in size,
expires by TTL, and never throws on a malformed store.
  TEST: services/gateway/test/services/tts/vtid-04100-greeting-bridge-cache.test.ts
  ("returns what was stored", "expires by TTL", "is bounded", "evicts the least
  recently used", "never throws on a malformed store")

AC-10 The bridge's pre-connect await is bounded, so a third-party TTS call can
no longer stall a session before `connectToLiveAPI` (the VTID-03802 shape).
  TEST: services/gateway/test/services/tts/vtid-04100-greeting-bridge-cache.test.ts
  ("bounds the pre-connect await", "keeps the bound well under the connect it
  precedes")

AC-11 Existing invariants are preserved, not deleted: the tool-catalog guard
still keys on provider and never on language, and the guided-topic bridge
ordering (greeting bridge, then guided-topic bridge, then connect) is unchanged.
  TEST: services/gateway/test/orb/live/tools/vertex-tool-catalog-budget.test.ts,
  services/gateway/test/orb/live/characterization/guided-topic-audio-bridge.characterization.test.ts

AC-12 Full gateway suite green with the change in place.
  TEST: outputs/full-suite.txt (995 suites, 16,614 tests, 0 failures)

## OASIS_PROOF

OASIS_PROOF: the diag stages and fields below are emitted by this commit; the
`tool_catalog_trimmed` stage does not exist before it, so its appearance in
`oasis_events` on staging is the proof that the guard is live.

VTID-04097 replaces the bridge-only `vertex_tool_catalog_trimmed` diag with a
provider-neutral `tool_catalog_trimmed` stage carrying `provider`, and keeps
emitting `vertex_tool_catalog_trimmed` for the bridge so VTID-04026's existing
queries continue to resolve. VTID-04096 adds `directive_reduced`,
`directive_full_len` and `directive_budget_bytes` to the existing
`greeting_sent` diag; VTID-04100 adds `cache: hit|miss` to
`greeting_bridge_sent`. No new topic, no new event volume per session.

Source of the emissions (this commit):
  services/gateway/src/routes/orb-live.ts — emitDiag(session, 'tool_catalog_trimmed', ...)
  services/gateway/src/routes/orb-live.ts — emitDiag(session, 'vertex_tool_catalog_trimmed', _budgetDiag)
  services/gateway/src/services/conversation/compute-greeting-decision.ts — diag.directive_reduced

Post-deploy confirmation on staging (read-only):
  select metadata->>'stage', metadata->>'provider', metadata->>'declarations_after'
  from oasis_events
  where topic='orb.live.diag' and metadata->>'stage'='tool_catalog_trimmed'
    and created_at > now() - interval '1 hour';

Pre-change baseline for the same query returns zero rows for
`tool_catalog_trimmed` (the stage does not exist before this commit), which is
what makes its appearance the proof.

## Not verified here, stated plainly

- The production effect. Production emits no `voice.latency.measured` at all
  (VTID-04098: the flag was set to the unrecognised value "production" and
  resolved to off), so every measurement above is staging or is derived from
  coarser `orb.live.diag` timestamps. Pinning the flag is part of this change;
  the production numbers come after it deploys.
- VTID-04096's causal claim is supported by a strong production correlation
  (n=48 large-directive vs n=44 small) but NOT by a controlled experiment: one
  staging session with a 17,264-char directive answered in 1,158 ms. The change
  is bounded and reversible (`ORB_GREETING_DIRECTIVE_BYTE_BUDGET=0`) precisely
  so its effect is measured rather than assumed.
- The greeting bridge is enabled on staging only. It was disabled on
  2026-07-28 on product grounds (the bridge voice is not the upstream voice)
  and that objection still stands with Polly. Whether to accept it in
  production is a human decision, not this VTID's.
