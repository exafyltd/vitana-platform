# Sparring round 1 — in_progress

Session: `7bf15cbe-7042-4a54-9813-7f4efaac2935` · plan hash `6dfbd44028328ff7c986453caee0a0a169eb87bd478fd6509892668862f7f041`

## Summary

All vitana-platform "CLOSED" premises hold solidly at the pinned commit: S-A through S-M and WS10 a–d are confirmed in code. The single piece of open work (lane `s-j-route-inventory`) lives entirely in `exafyltd/vitana-v1`, which has **no pinned ref** in this review session — every vitana-v1 implementation premise (test-file line numbers, config.toml block location, script existence, vitest config include pattern, package.json test chain) is unverifiable. Two additional concerns: the planned inventory-script positive check is an import-presence pattern that cannot catch a function that imports the auth helper but fails to invoke it on every code path; and a VTID comment in billing-repository.ts attributes the S-K fix to VTID-05044 while the plan assigns VTID-05044 exclusively to S-G, creating a ledger ambiguity.

## Findings

### R1-F1 [major]

The primary target repo (`exafyltd/vitana-v1`) is not pinned in this review session, making every vitana-v1 implementation premise unverifiable. The plan cites exact line numbers and file paths in vitana-v1 that the implementer is instructed to act on: `supabase/config.toml:72-74` ([functions.linkedin-import] block), `src/lib/edge-functions-caller-identity.s4.test.ts` at four specific locations (:77-88, :90-92, :107-110, :272), `scripts/check-edge-data-client.mjs`, `scripts/check-realtime-helper.mjs`, `vitest.config.ts:19` (include glob), and `package.json` test chain. If the vitest `include` glob differs from `src/**/*.test.{ts,tsx}`, the plan's entire safety argument — 'this test is collected so a missed cleanup reddens CI' — collapses silently. If any of the four cited test-file line ranges are off, the implementer either updates wrong lines or misses a reference, leaving a dead `readFileSync` call or stale assertion that goes undetected because the test is never reached.

- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:15554` — router.get('/debug/context-bootstrap', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {

Suggestion: Re-submit this plan with `exafyltd/vitana-v1` also pinned so that: (a) the vitest `include` glob at `vitest.config.ts:19` is confirmed to be `src/**/*.test.{ts,tsx}`; (b) the four line ranges in `edge-functions-caller-identity.s4.test.ts` are confirmed; (c) `scripts/check-edge-data-client.mjs` and `scripts/check-realtime-helper.mjs` are confirmed to exist and appear in the `package.json` `"test"` chain; (d) `supabase/config.toml:72-74` is confirmed to contain `[functions.linkedin-import]`. Without pinned evidence, the implementation instructions cannot be confirmed as correct.

### R1-F2 [minor]

The inventory script `check-edge-function-auth.mjs` is described as checking whether a Supabase edge function 'imports `_shared/caller-auth.ts` / calls `requireUser`'. This is a static source-text pattern match. It does not verify that `requireUser` is invoked before the handler logic on every reachable code path. A function that imports `_shared/caller-auth.ts` but only calls `requireUser` inside a conditional branch, or after some unauthenticated logic, would pass the check despite being incompletely gated. Conversely, a correctly-gated function that uses a different auth utility would be flagged unless it is on the explicit public allowlist.

- `exafyltd/vitana-platform:services/gateway/src/connectors/runtime/webhook-signature.ts:1` — Every verifier fails closed: an unset or empty secret is a rejection, never a 'dev mode' pass.

Suggestion: Strengthen the check to verify the call site exists at or near the top of the default export (e.g., within the first N lines before any response-generating logic, or as the first `await` in the handler), not just that the import is present. Document in the allowlist comment what alternative auth pattern a non-`_shared/caller-auth.ts` function uses, so a future reader can audit it rather than trust the exemption name alone.

### R1-F3 [minor]

`billing-repository.ts:281` attributes the S-K fix (`fetchTenantSettingsFeatureFlags` `.maybeSingle()` removal) to `VTID-05044`, but the plan's `## Depends on` section assigns VTID-05044 exclusively to S-G (tenant invitations). `billing.ts:1308` also annotates the marketing-budget aggregation path as `VTID-05044`. If VTID-05044 covered both invitations and the billing fix, the plan should say so; if it did not, this is a VTID comment collision that misrepresents what was done under that VTID in the ledger.

- `exafyltd/vitana-platform:services/gateway/src/routes/billing-repository.ts:281` — /**
 * VTID-05044: every tenant's feature_flags. This used to be .maybeSingle(),
 * which errors as soon as a second tenant_settings row exists...
- `exafyltd/vitana-platform:services/gateway/src/routes/billing.ts:1308` — // 5. Marketing budget remaining (VTID-05044): the budget is per tenant,

Suggestion: In the `## Depends on` section, clarify whether VTID-05044 covered S-K (billing) as well as S-G (invitations). If it did, change the parenthetical to `VTID-05044 (S-G, S-K)`. If it did not, the billing code comments carry the wrong VTID and must be corrected to the actual VTID that shipped the billing fix — otherwise the ledger cannot be audited accurately.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
