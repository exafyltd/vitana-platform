# Plan — native-iap-interface
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app `apps/mobile/`). Program:
`docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021). Spec: `handoff.md`, `tasks.md`, `lanes/iap-interface.md`
in this folder.

<!-- plan:begin -->
## Goal
Owner instruction, verbatim: "in-app purchase module: interface and feature flag only, no vendor chosen".

Add to the native app a vendor-neutral purchase seam: a `PurchaseProvider` interface (products, purchase, restore,
entitlement), a no-op default provider, a `setPurchaseProvider` installer and a feature flag that defaults OFF. The app
behaves exactly as today. Nothing in the app calls the module yet, so no screen changes. A later, owner-approved lane
can install a real provider behind the seam.

## Measured state
Pinned: vitana-v1 origin/main `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`, vitana-platform origin/main
`6dc6e1ba0c18252ec2f3fbf5651d245e200f9835` (2026-11-10T16:53Z).
- **No purchase code exists.** `git ls-tree` of `vitana-v1:apps/mobile` finds no `apps/mobile/src/iap/`; no file name
  matches StoreKit, Play Billing, RevenueCat or `react-native-iap`; `apps/mobile/package.json` and `app.config.ts` name
  none of them (searched at the pinned SHA). The app has no payment SDK.
- **The seam pattern to copy.** `vitana-v1:apps/mobile/src/push/provider.ts:19-31` defines the provider interface,
  `:35-44` the `Noop` default, `:46` the module-level `current`, `:48-50` `getPushProvider`, `:52-55` `setPushProvider`.
  `crash-port` (plan `native-wave3-release-r2`, decision 3) copies it for telemetry.
- **Today's iOS gate.** `vitana-v1:apps/mobile/src/shell/logic/drawer.ts:37-38` (`iapRestricted`) and
  `apps/mobile/src/screens/wallet-home/iap.ts:12-14` (`isIAPRestricted()` is `Platform.OS === 'ios'`) hide digital
  purchases on iOS. This plan does not read, change or replace them.
- **Remote config exists but is not touched.** `vitana-v1:apps/mobile/src/config/remote-config.ts:38` lists the known
  flags (`push_enabled`, `health_sync_enabled`, `orb_native_enabled`); unknown flags are ignored and a missing flag is
  false (`:12-17` doc block, `:69-71` `defaultFlags`). The file is shared native infra with its own tests.
- **The decision is the owner's.** `vitana-platform:.kiro/specs/native-wave3-release-r2/lanes/iap-decision-owner.md`
  records the payment classification per purchase type
  (frontmatter `next_actor: kiro`, depends on `prereq-exit`; the body says "OWNER GATE — no payment code is written" and
  "Next actor is the owner", `:19-26`; the decision is the owner's either way)
  (`vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:221`, §8 decision 4). The product-cart-checkout lane
  (vitana-v1 PR #1619, `docs/validation/VTID-05512/lane-brief.md:30`) keeps "iOS IAP gate exactly as today, flagged per
  surface".

- **Excerpts of the cited vitana-v1 code** (read at the pinned SHA with `git show`, inlined so a reviewer without
  vitana-v1 access can check the pattern):
  `push/provider.ts:46` `let current: PushProvider = NoopPushProvider;`, `:48-50` `export function getPushProvider():
  PushProvider { return current; }`, `:53-55` `export function setPushProvider(provider: PushProvider): void { current =
  provider; }`; `:35-44` the Noop object (`isAvailable: () => false`, `getToken: async () => null`, `requestPermission:
  async () => 'unavailable'`, ...). `remote-config.ts:38` `export const KNOWN_FLAGS = ['push_enabled',
  'health_sync_enabled', 'orb_native_enabled'] as const;`, `:69-71` `defaultFlags()` maps every known flag to `false`.
  `wallet-home/iap.ts:12-14` `export function isIAPRestricted(): boolean { return Platform.OS === 'ios'; }`.
  The crash-port lane of `native-wave3-release-r2` (`lanes/crash-port.md:25`) cites the same `push/provider.ts` pattern.

## Decisions
1. **One lane, one repo.** The change is a handful of new files in `apps/mobile/src/iap/` plus tests: a small task. Lane
   `iap-interface`.
2. **Interface only, same shape as `push/provider.ts`.** `PurchaseProvider` has `isAvailable()`, `listProducts(ids)`,
   `purchase(productId)`, `restore()` and `getEntitlements()`. Results are discriminated unions
   (`purchased | cancelled | pending | unavailable | failed`); a product is `{ id, title, price | null }`. The interface
   carries no vendor type, no store product ID, no receipt or key field. Product IDs are caller-supplied strings
   and nothing in the module defines one (they are owner-gated).
3. **The flag defaults OFF and lives inside the module.** `apps/mobile/src/iap/flag.ts` exports `IAP_FLAG_NAME =
   'iap_enabled'`, `isIapEnabled()` and `setIapFlagResolver(fn | null)`; the default resolver returns `false`. Reason:
   adding the flag to `KNOWN_FLAGS` in `config/remote-config.ts:38` edits a shared file and its existing tests (the
   owner rule for this run: no edits to existing tests), so the remote-config wiring is a later lane that calls
   `setIapFlagResolver`. The name `iap_enabled` is reserved so the gateway and the app agree later.
4. **The facade enforces the flag.** `apps/mobile/src/iap/index.ts` exposes `listProducts`, `purchase`, `restore`,
   `getEntitlements` and `isIapAvailable`. With the flag OFF they answer from the no-op provider (`unavailable`, empty
   lists) even when another provider is installed. With the flag ON they use the installed provider. A provider that
   throws is caught and turned into `failed`; nothing is thrown into the UI. Reason: a flag that only a caller checks
   can be forgotten; this one cannot.
5. **Nothing is wired.** No import of `src/iap` outside its tests. The wallet, cart and checkout screens, the drawer and
   `isIAPRestricted()` stay as they are, so behaviour is byte-for-byte today's. A test asserts that no file under
   `apps/mobile/src` or `apps/mobile/app` outside `src/iap/` imports it.

## Lane
| Lane | Repo | Executor / seat → reviewer | Scope | depends_on | next_actor |
|---|---|---|---|---|---|
| `iap-interface` | vitana-v1 | kiro / exafyltd → vitana-lane-reviewer | `apps/mobile/src/iap/**`, `apps/mobile/tests/iap/**`, `docs/validation/**` | — | kiro |

No shared file with any other lane: `remote-config.ts`, `package.json`, `app.config.ts`, screens and `push/` are untouched.

## Tests and verification
- New tests under `apps/mobile/tests/iap/` (none exist on base, so they fail there): default provider answers
  `unavailable`/empty and sends nothing; the flag defaults OFF; with the flag OFF an installed fake provider is never
  called; with the flag ON the fake provider's results pass through; a throwing provider yields `failed`;
  `setPurchaseProvider(null)` restores the no-op; `package.json` gains no dependency; no outside file imports the module.
- Commands: `cd apps/mobile && npm ci && npm test && npm run typecheck`.
- Staging proof: not verified on staging: the module is not imported by any screen or the shell, so no deployed build
  behaves differently; the covering tests are the lane's own.

## Out of scope / owner-gated (not built, not decided here)
- The vendor and SDK choice (StoreKit, Play Billing, RevenueCat or none).
- Product IDs, store setup (App Store Connect, Play Console), keys, receipts, server-side validation.
- The payment classification per purchase type (`iap-decision-owner`).
- Reading the flag from remote config (`KNOWN_FLAGS`, the gateway `app-config` response) and any screen, cart or checkout
  change. Each needs a later plan after the owner decision.

## Risks
- **A later wiring lane forgets the flag.** Mitigation: the facade enforces it (decision 4).
- **The interface fits one vendor badly.** Mitigation: it uses only generic concepts and is explicitly unfinalised until
  the owner picks a vendor; a later plan may extend it.
- **Name clash with `screens/wallet-*/iap.ts`.** Those files only gate by platform; the new module lives in `src/iap/`
  and shares no export.

## Unchanged
Production guards in `app.config.ts` and `env.ts`, the iOS IAP gate, all screens, remote config, dependencies, existing
tests and test keys, and every governance file.
<!-- plan:end -->
