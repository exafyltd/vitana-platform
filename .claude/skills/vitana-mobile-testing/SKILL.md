---
name: vitana-mobile-testing
description: Test the Vitana frontend on a real iOS Simulator or Android device — eyes (accessibility outline, screenshots) and hands (tap, swipe, type) on the actual rendered app. Use when asked to test buttons/features on a device, verify mobile UX beyond viewport emulation, or run the device-level smoke suite.
---

# Vitana mobile device testing

Vitana's frontend (`vitana-v1`, deployed as `community-app`) is a React SPA.
The device layer runs it in a real device browser and drives it through the
platform accessibility tree — the same mechanism a screen reader uses. This
tests what viewport emulation cannot: real rendering, real touch pipeline,
real keyboard, real Safari/Chrome behavior.

**Two independent drivers — check which one your host can run:**

| Platform | Driver | Host requirement |
|---|---|---|
| iOS | [`sim-use`](https://github.com/lycorp-jp/sim-use) CLI | **macOS 14+, always** — sim-use is a macOS-only Swift/Xcode binary, even when driving Android. There is no way around this. |
| Android | `adb` + `uiautomator` (Android SDK, no third-party tool) | **None** — works on Linux, including this session's cloud container, given a reachable device/emulator. |

**Companion skill:** `.claude/skills/sim-use/SKILL.md` (vendored upstream)
covers the full sim-use command surface for the **iOS** path only — Android
here does not use sim-use at all.

## 0. Which layer am I on?

| Host | iOS | Android | Use |
|---|---|---|---|
| macOS 14+ (local Mac, macOS CI runner) | ✅ sim-use | ✅ (adb, or sim-use if `sim-use android init` was run) | Either |
| Linux (cloud container, WSL, `ubuntu-latest` CI) | ❌ | ✅ **if a device/emulator is reachable** | `mobile-sim/android/` |
| Linux with no adb device reachable | ❌ | ❌ | Playwright emulation: `cd e2e && npm run test:mobile` |

Check first:
```bash
cd e2e
npm run sim:doctor            # iOS — host, sim-use, simulators
npm run sim:doctor:android    # Android — adb, connected devices/emulators
```

## 1. Android — works from this session (no Mac needed)

```bash
cd e2e
npm run sim:doctor:android
npm run test:device:android                            # staging /maxina, smoke flow
npm run test:device:android -- --flow observe           # eyes only, no taps
npm run test:device:android -- --device emulator-5554
```

Requires a reachable device/emulator (`adb devices` non-empty). This cloud
container has no KVM, so it cannot boot an emulator itself — either a
USB/network-attached real device, or (the normal path) dispatch
`.github/workflows/ANDROID-DEVICE-E2E.yml`, which boots a KVM-backed
emulator directly on a standard `ubuntu-latest` runner (no macOS runner
cost) and runs the full flow there.

Chrome's first-run screen (ToS/"no thanks" prompts) is dismissed
automatically on a fresh AVD before anything else happens.

## 2. iOS — needs a Mac, and CI is currently unreliable

```bash
cd e2e
npm run sim:doctor
npm run test:device                                    # iOS, staging /maxina, smoke flow
npm run test:device -- --url https://vitanaland.com/maxina    # against prod
npm run test:device -- --flow observe                  # eyes only, no taps
```

In CI: dispatch `.github/workflows/MOBILE-DEVICE-E2E.yml` (`macos-15`
runner). **Known issue:** on GitHub's hosted macOS runner, `sim-use ui`
calls have been observed taking 80-170+ seconds against this app —
sim-use's own docs describe ~200-300ms after daemon warmup. Runs have not
reliably reached the login form even with retries and long settle waits.
This has not been tested on real Mac hardware, so treat it as an open
question, not a confirmed sim-use limitation — but don't expect CI iOS
runs to be fast or reliable until it's investigated further. Prefer local
`npm run test:device` on an actual Mac when you need a trustworthy result.

## 3. Both flows do the same thing

Open the app in the device browser → log in through the real form (env
`TEST_USER_EMAIL` / `TEST_USER_PASSWORD`; defaults to the shared e2e user
`e2e-test@vitana.dev`) → discover the bottom navigation from the live
accessibility tree → tap every tab, verify each screen changes → save a
screenshot + element/outline dump per step to `e2e/mobile-sim/artifacts/`,
plus `session.mp4` (video of the whole run; on Android capped at ~170s per
`screenrecord` invocation).

## 4. Interactive testing (agent loop, iOS/sim-use only)

For exploratory "test this button/feature" work on iOS, drive sim-use
directly with the observe → act → verify loop:

```bash
UDID=$(sim-use devices | awk '/Booted/{print $4}' | head -1)
xcrun simctl openurl "$UDID" "https://preview.vitanaland.com/maxina"  # NOT the bare root
sim-use ui --device "$UDID"                                     # observe
sim-use tap --label "Anmelden" --device "$UDID"                 # act
sim-use ui --device "$UDID"                                     # verify
sim-use screenshot --output /tmp/state.png --device "$UDID"     # evidence
```

For Android, the equivalent loop is plain adb — no CLI to install:

```bash
adb -s <serial> shell am start -a android.intent.action.VIEW -d "https://preview.vitanaland.com/maxina" -p com.android.chrome
adb -s <serial> shell uiautomator dump /sdcard/window_dump.xml && adb -s <serial> shell cat /sdcard/window_dump.xml   # observe
adb -s <serial> shell input tap <x> <y>                          # act (tap by center coords from the dump)
adb -s <serial> exec-out screencap -p > /tmp/state.png            # evidence
```

Vitana specifics to keep in mind:

- **German-default UI (du-form).** Labels are DE first: "Anmelden" not
  "Sign in", "Startseite" not "Home". Match both when scripting.
- **It's a WebView/Chrome tree.** Both drivers walk the browser's exposed
  accessibility content, but ids are sparser than native apps — prefer
  label-based matching and re-observe after every navigation.
- **Umlauts/emoji input on iOS:** use `sim-use paste 'Müller 🎉'`, not
  `type` (needs hardware keyboard connected; fall back to `paste
  --via-menu`). On Android, `adb shell input text` is ASCII-only — no
  direct Unicode equivalent without a custom IME.
- **Login:** the scripted flows (`flows/login.mjs` on both platforms)
  drive the real form. For quick manual sessions the browser may still
  hold a previous session — navigate to `/logout` to reset.
- **The bare domain root is NOT the app.** `/` renders the multi-tenant
  portal-selector grid (Maxina / AlKalma / Earthlinks / Exafy Admin cards)
  — no login form, no bottom nav. That's by design, not a bug — a flow
  that finds nothing to tap there hasn't failed. The community app (551+
  screens, real login form) lives at **`/maxina`** — both `run.mjs`
  entrypoints default there already.
- **Environments:** staging `https://preview.vitanaland.com/maxina`
  (default), prod `https://vitanaland.com/maxina`, per-PR previews
  `https://community-app-pr-<n>-*.run.app/maxina`. Test staging/PR
  previews unless explicitly asked to check prod.

## 5. Reporting results

Follow the repo verification protocol (CLAUDE.md §Targeted Visual
Verification): report completion WITH the screenshots you inspected — read
each screenshot file, check layout/clipping/tap targets, and attach the
outline/element dump of the final state. A run that ends without looking
at its own screenshots is not a verification.
