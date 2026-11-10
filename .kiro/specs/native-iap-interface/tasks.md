# Tasks — native-iap-interface

One PR, branch `kiro/native-iap-interface/iap-interface`, title `VTID-xxxxx (native-iap-interface/iap-interface): …`,
trailers `Collab-Session` and `Collab-Lane`. The lane changes only its `paths`. The VTID is assigned by CI after
PLAN-SPAR converges; do not start before the lane's `vtid:` is set. Run `cd apps/mobile && npm ci && npm test &&
npm run typecheck`. No store build, no signing, no credential, no production host, no new dependency. New test files
only; no existing test is edited.

## Purchase interface, no-op default, flag OFF
<!-- lane: iap-interface -->
- [ ] I1 Add `apps/mobile/src/iap/provider.ts`: types `PurchaseProduct {id, title, price: {amountMinor, currency} | null}`,
  `PurchaseResult` (`purchased | cancelled | pending | unavailable | failed`), `RestoreResult`, `Entitlement {id}`;
  interface `PurchaseProvider` (`isAvailable`, `listProducts(ids)`, `purchase(productId)`, `restore()`,
  `getEntitlements()`); `NoopPurchaseProvider` (unavailable, empty); `getPurchaseProvider`; `setPurchaseProvider(p | null)`
  (null restores the no-op). Same shape as `apps/mobile/src/push/provider.ts:19-55`.
- [ ] I2 Add `apps/mobile/src/iap/flag.ts`: `IAP_FLAG_NAME = 'iap_enabled'`, `isIapEnabled()`,
  `setIapFlagResolver(fn | null)`; the default resolver returns `false`. Do not edit `config/remote-config.ts`.
- [ ] I3 Add `apps/mobile/src/iap/index.ts`: facade `isIapAvailable`, `listProducts`, `purchase`, `restore`,
  `getEntitlements` that use the installed provider only when the flag is ON, else the no-op; a provider error (sync or
  async) is caught and returned as `failed` (or an empty list), never thrown. Re-export the types and both setters.
- [ ] I4 Tests under `apps/mobile/tests/iap/` (new files): (a) no-op answers `unavailable`/empty and the flag is OFF by
  default; (b) flag OFF with an installed fake → fake never called; (c) flag ON → results pass through; (d) throwing and
  rejecting provider → `failed`, nothing thrown; (e) `setPurchaseProvider(null)` and `setIapFlagResolver(null)` reset;
  (f) no dependency name in `apps/mobile/package.json` matches `/iap|billing|storekit|revenuecat|purchases/i`; (g) no file under
  `apps/mobile/src` or `apps/mobile/app` outside `src/iap/` imports `iap`.
- [ ] I5 Evidence under `docs/validation/<VTID>/`: `scope.json`, `staging-tests.json` (no staging spec; reason recorded),
  `plan-sparring.md` (link to the sparring record), `commands.log`, and the red-on-base output of the new tests.

Acceptance:
- Change types: Tooling/docs (app code without UI or network)
- Outcome: none for members; behaviour is unchanged because nothing calls the module and the flag is OFF. The app gains a
  seam a later, owner-approved lane can install a vendor behind.
- States: flag OFF → no-op answers; provider throws or rejects → `failed`, no exception reaches the caller; provider
  removed with `null` → no-op again.
- Surfaces: n/a: no screen, no cart, no checkout, no drawer change; `isIAPRestricted()` and `iapRestricted` untouched.
- Locales: n/a: no user-visible text.
- Accessibility: n/a: no UI.
- Contract: TypeScript interface `PurchaseProvider` and flag name `iap_enabled`, with `file:line`; no network, no vendor
  type, no store product ID, key or receipt field; `package.json` gains no dependency.
- Staging proof: not verified on staging: no deployed build imports the module; the covering tests are I4 (a)–(g).
