---
name: vitana-mobile-testing
description: Test the Vitana frontend on a real iOS Simulator or Android device using sim-use — eyes (accessibility outline, screenshots) and hands (tap, swipe, type) on the actual rendered app. Use when asked to test buttons/features on a device, verify mobile UX beyond viewport emulation, or run the device-level smoke suite.
---

# Vitana mobile device testing (sim-use)

Vitana's frontend (`vitana-v1`, deployed as `community-app`) is a React SPA.
The device layer runs it in a real device browser and drives it through the
platform accessibility tree using the `sim-use` CLI. This tests what viewport
emulation cannot: real rendering, real touch pipeline, real keyboard, real
Safari/Chrome behavior.

**Companion skill:** `.claude/skills/sim-use/SKILL.md` (vendored upstream)
covers the full sim-use command surface, selector styles, pitfalls, and crash
protocol. Read it before driving a device manually.

## 0. Which layer am I on?

| Host | Capability | Use |
|---|---|---|
| macOS 14+ (local Mac, macOS CI runner) | Full device layer | This skill |
| Linux (cloud container, WSL) | No simulators possible | Playwright emulation: `cd e2e && npm run test:mobile` |

Check first: `cd e2e && npm run sim:doctor` — it verifies host, sim-use
install, simulators, and Android toolchain, and prints fixes.

## 1. Scripted flows (preferred starting point)

```bash
cd e2e
npm run sim:doctor                                     # preflight
npm run test:device                                    # iOS, staging, smoke flow
npm run test:device -- --url https://vitanaland.com    # against prod
npm run test:device -- --flow observe                  # eyes only, no taps
npm run test:device:android -- --device emulator-5554  # Android
```

The **smoke flow** opens the app in the device browser, logs in through the
real form (env `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`; defaults to the
shared e2e user `e2e-test@vitana.dev`), discovers the bottom navigation from
the live accessibility tree, taps every tab, verifies each screen changes,
and saves a screenshot + outline per step to `e2e/mobile-sim/artifacts/`,
plus `session.mp4` — a video of the whole run for human review.

In CI: dispatch `.github/workflows/MOBILE-DEVICE-E2E.yml` (macOS runner,
iOS Simulator; artifacts uploaded).

## 2. Interactive testing (agent loop)

For exploratory "test this button/feature" work, drive sim-use directly with
the observe → act → verify loop:

```bash
UDID=$(xcrun simctl list devices booted -j | python3 -c "import json,sys; print(json.load(sys.stdin)['devices'].__iter__().__next__() if False else [d['udid'] for l in json.load(sys.stdin)['devices'].values() for d in l][0])" 2>/dev/null || sim-use devices)
xcrun simctl openurl "$UDID" "https://preview.vitanaland.com"   # open the app
sim-use ui --device "$UDID"                                     # observe
sim-use tap --label "Anmelden" --device "$UDID"                 # act
sim-use ui --device "$UDID"                                     # verify
sim-use screenshot --output /tmp/state.png --device "$UDID"     # evidence
```

Vitana specifics to keep in mind:

- **German-default UI (du-form).** Labels are DE first: "Anmelden" not
  "Sign in", "Startseite" not "Home". Match with
  `--label-regex '(Anmelden|Sign in)'` when unsure.
- **It's a WebView tree.** sim-use walks web content fully, but ids are
  sparser than native apps — prefer `--label` / `--label-contains` selectors
  and re-run `ui` after every navigation (SPA route changes invalidate `@N`
  aliases).
- **Umlauts/emoji input:** use `sim-use paste 'Müller 🎉'`, not `type`
  (needs hardware keyboard connected; fall back to `paste --via-menu`).
- **Login:** the scripted flow (`flows/login.mjs`) drives the real form. For
  quick manual sessions the browser may still hold a previous session —
  navigate to `/logout` to reset.
- **Environments:** staging `https://preview.vitanaland.com` (default),
  prod `https://vitanaland.com`, per-PR previews
  `https://community-app-pr-<n>-*.run.app`. Test staging/PR previews unless
  explicitly asked to check prod.

## 3. Android

One-time per device: `sim-use android init --device <serial>` (installs the
accessibility bridge APK). Then all the same top-level verbs work; open the
app with `adb -s <serial> shell am start -a android.intent.action.VIEW -d <url>`.
Use `sim-use button back` for Android back. No GitHub-hosted CI path yet —
Android runs are local (Mac with emulator or USB device).

## 4. Reporting results

Follow the repo verification protocol (CLAUDE.md §Targeted Visual
Verification): report completion WITH the screenshots you inspected — read
each screenshot file, check layout/clipping/tap targets, and attach the
outline of the final state. A run that ends without looking at its own
screenshots is not a verification.
