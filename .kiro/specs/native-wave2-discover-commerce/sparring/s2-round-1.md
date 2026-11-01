# Sparring round 1 — in_progress

Session: `a0d3b59a-8d7d-4695-9fd0-fc2e365c9fc2` · plan hash `317c86c5ff705d7dcf5ba73995f6bcc33daf454796fea9b06e5869fd6265d94b`

## Summary

The plan is thorough and well-structured. I verified its core premises against the pinned code and they hold up well. The parity ledger row counts (22 registry + 4 exclusion = 26, all `discover-commerce`, all `not_started`) match exactly. The 3-lane partition (12 + 5 + 9 = 26) is correct. The App.tsx routes at lines 1029–1117 match the plan's description. The `packages/core/manifest.json`, `closure.generated.json`, and `core-closure.mjs` script all exist. One minor inaccuracy in the `isIAPRestricted()` reference and one unverifiable premise about `assertNotProduction()`.

## Findings

### R1-F1 [minor]

The plan states `isIAPRestricted()` today = `Platform.OS === 'ios'` at `apps/mobile/src/shell/logic/drawer.ts:37-38` and says 'the shell already hides wallet on iOS'. Lines 37-38 actually contain a JSDoc comment and a type property (`iapRestricted: boolean`) in the `DrawerInput` type, not a function definition. The actual filtering is at line 68 (`.filter((item) => !(iapRestricted && item.id === 'wallet'))`). No `isIAPRestricted()` function was found in any searched file — only a comment describing the contract. The plan's lanes reference this function as if it exists and can be called per-screen; the executor needs to know the actual mechanism is a boolean prop passed into `composeDrawerRows`, not a standalone callable function.

- `exafyltd/vitana-v1:apps/mobile/src/shell/logic/drawer.ts:37` — /** isIAPRestricted(): today's Appilix iOS rule — Platform.OS === 'ios' (program decision 5 default). */
    iapRestricted: boolean;
...
    .filter((item) => !(iapRestricted && item.id === 'wallet'))

Suggestion: Correct the plan's reference: the iOS-IAP gate is a `iapRestricted: boolean` prop on `DrawerInput` (line 38), consumed at line 68, not a standalone `isIAPRestricted()` function at lines 37-38. The executor should be told the actual calling convention so the per-screen IAP flag approach can compose with the existing boolean-prop pattern correctly.

### R1-F2 [minor]

The plan states 'the native app has no production profile; `assertNotProduction()` refuses prod/staging hosts' but no function named `assertNotProduction` was found via code search in vitana-v1. The premise could not be verified at the pinned commit.

- `exafyltd/vitana-v1:apps/mobile/src/shell/logic/drawer.ts:1` — The entire drawer.ts file (115 lines) was read — no assertNotProduction reference. Code searches for 'assertNotProduction' and 'assertNotProduction refuse production staging' both returned no hits across vitana-v1.

Suggestion: The planner should cite the exact file and line where `assertNotProduction()` (or the equivalent production-guard) lives, so the executor knows the safety rail exists and doesn't accidentally bypass it. If it doesn't exist yet, this is a pre-existing gap worth flagging.

### R1-F3 [minor]

App.tsx line 1087 defines `<Route path="/cart" element={<Navigate to="/universal-cart" replace />} />` — a web redirect from `/cart` to `/universal-cart`. The plan ports `/universal-cart` natively (DISCOVER.CART row) but does not mention handling the `/cart` redirect path in the native app. If any deep link, push notification, or internal navigation targets `/cart`, it would hit the resolver's 'Unported' screen instead of redirecting to the native cart.

- `exafyltd/vitana-v1:src/App.tsx:1087` — <Route path="/cart" element={<Navigate to="/universal-cart" replace />} />
            {/* VTID-03236: Universal Cart route (gateway-backed) — the one cart. */}
            <Route path="/universal-cart" element={
              <AuthGuard>
                <UniversalCart />
              </AuthGuard>
            } />

Suggestion: The product-cart-checkout lane should either (a) add a native Expo Router redirect from `/cart` to `/universal-cart`, or (b) explicitly note in the lane doc that `/cart` is not a parity-ledger destination and confirm no deep link or backend push-notification targets that path.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
