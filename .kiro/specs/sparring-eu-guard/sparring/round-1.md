# Sparring round 1 — in_progress

Session: `f0274976-4fe8-42d2-b8e5-090a30eeb938` · plan hash `a017350cfa94f5e94bf02d88ae0bc5cbc4d0054310fa18dbbaa28c7d2824231a`

## Summary

The plan's premises all hold against the pinned code. The two core changes (C1: flip DeepSeek default to off; C2: remove us-east-1 fallback region) are well-scoped and correctly motivated. One minor gap: a second, independent `bedrockRegion()` function exists in `dev-memory-embedding.ts` that the plan does not mention; it has a different (EU) default but the same "silent fallback to a hardcoded region" pattern C2 is fixing in `bedrock.ts`.

## Findings

### R1-F1 [minor]

There is a second, independent `bedrockRegion()` function in `services/gateway/src/services/dev-memory-embedding.ts` (line 42-43) that follows the same pattern C2 is fixing in `bedrock.ts` — it silently falls back to a hardcoded region when env vars are missing. Its default happens to be `eu-central-1` (safe today), but the plan's C2 rationale ('a process without either variable silently uses a [wrong] region') applies equally: if someone copies this pattern or if the EU region ever changes, it would silently pick the wrong endpoint. The plan should either (a) apply the same 'no default, fail loudly' treatment to `dev-memory-embedding.ts` or (b) explicitly note why it is out of scope (e.g. 'already defaults to EU, acceptable risk').

- `exafyltd/vitana-platform:services/gateway/src/services/dev-memory-embedding.ts:42` — function bedrockRegion(): string {
  return process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1';
- `exafyltd/vitana-platform:services/gateway/src/providers/bedrock.ts:148` — function bedrockRegion(): string {
  return process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
}

Suggestion: Either include `dev-memory-embedding.ts` in C2 (same fail-loud guard) or add an explicit out-of-scope note explaining why its `eu-central-1` default is acceptable.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
