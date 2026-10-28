# Mobile Device Testing

**Layer 2 added: 2026-07-13 · Upstream: [lycorp-jp/sim-use](https://github.com/lycorp-jp/sim-use) (Apache-2.0)**
**Layer 3 added: 2026-07-16 · adb + uiautomator (Android SDK, no third-party tool)**

This document describes the device-level testing layers that give agents and
engineers *eyes and hands* on the Vitana frontend running in a real iOS
Simulator or Android emulator/device — beyond the viewport emulation the
Playwright suites provide.

## The three testing layers

| | Layer 1 — Playwright emulation | Layer 2 — iOS device (sim-use) | Layer 3 — Android device (adb) |
|---|---|---|---|
| What it is | Chromium with iPhone-14 viewport/touch flags | Real iOS Simulator, driven via Apple's Accessibility APIs | Real Android emulator/device, driven via `uiautomator` + `adb input` |
| Lives in | `e2e/` (projects `mobile-*`) | `e2e/mobile-sim/` | `e2e/mobile-sim/android/` |
| Runs on | Anywhere (Linux CI, cloud containers, Mac) | **macOS 14+ only** — sim-use is a Swift/Xcode binary, full stop, regardless of which platform it drives | **Anywhere** — `adb`/`uiautomator` are cross-platform, including Linux/`ubuntu-latest` CI, given a reachable device/emulator |
| Auth | Injected Supabase session (localStorage) | Real login form, real taps and keystrokes | Real login form, real taps and keystrokes |
| Catches | Route errors, console errors, layout at mobile width | Real rendering, touch pipeline, soft keyboard, Safari quirks | Real rendering, touch pipeline, soft keyboard, Chrome quirks |
| Command | `cd e2e && npm run test:mobile` | `cd e2e && npm run test:device` | `cd e2e && npm run test:device:android` |
| Status | Stable | Working for install/boot/record; login+nav-walk currently blocked on GH's hosted macOS runner — see caveat below | New — validate via CI dispatch |

All three test the same deployed URLs (staging `preview.vitanaland.com` by
default; prod `vitanaland.com`; per-PR previews `community-app-pr-<n>`) —
but the device layers open a browser at a real URL rather than injecting a
route via the test harness, so they must target an actual app screen.
`/maxina` (not the bare domain root, which is a portal-selector page — see
Conventions below) is both device flows' default.

## Layer 2: iOS via sim-use

A cross-platform CLI (LY Corporation) built for AI-agent loops. It's the
only reason iOS device testing is possible at all here — Apple doesn't
expose an equivalent of `adb`/`uiautomator` for the Simulator from outside
Xcode's own toolchain:

- `sim-use ui` — renders the current screen as a token-efficient
  accessibility outline (`@N` aliases per element), including WebView
  content — which is what makes it work for our SPA.
- `sim-use tap @9` / `--label 'Anmelden'` / `#id` — taps by alias, label, or
  accessibility id; plus `swipe`, `type`, `paste` (IME-safe Unicode),
  `gesture`, `button`, `screenshot`, `record-video`, `app-state` (crash
  detection).
- Also drives **Android** through the same command surface (via an
  on-device accessibility-bridge APK over `adb forward`) — but the CLI
  itself is still a macOS-only Swift binary either way, so this doesn't
  help a Mac-less host. Layer 3 exists precisely because of that gap.

Install (macOS only): `brew tap lycorp-jp/tap && brew install lycorp-jp/tap/sim-use`

**Known issue (unresolved, as of 2026-07-16):** on GitHub's hosted
`macos-15` Actions runner, every `sim-use ui` call has been observed taking
80-170+ seconds against this app (a heavy animated React SPA — framer-motion,
video preload) — sim-use's own docs describe ~200-300ms after daemon
warmup. Across 7 CI iterations (retry logic, longer settle waits, fixing an
unrelated recorder/daemon startup race), runs have not reliably reached the
login form within a reasonable CI timeout. **This has not been tested on
real Mac hardware** — it may be specific to GitHub's virtualized macOS
tier rather than sim-use itself. Until confirmed either way, prefer local
`npm run test:device` on an actual Mac over the CI path when you need a
trustworthy iOS result.

## Layer 3: Android via adb + uiautomator

No sim-use, no macOS, anywhere in the loop — built directly on parts of the
Android platform itself:

- `adb shell uiautomator dump` — serializes the on-screen accessibility
  tree to XML (Android's OS-level equivalent of what sim-use walks via AX
  APIs on iOS; for a page rendered in Chrome, this includes the WebView's
  exposed accessibility nodes).
- `adb shell input tap/text/keyevent` — synthesizes touch/keyboard events.
- `adb exec-out screencap` / `adb shell screenrecord` — screenshot/video,
  built into the OS image; no extra recorder process to coordinate with
  anything else (contrast with the daemon-startup race that had to be
  fixed on the sim-use/iOS side).

`e2e/mobile-sim/android/lib/uiautomator.mjs` implements the driver:
`dump()`/`visibleEntries()` (observe), `tapEntry()`/`tapLabel()`/`typeText()`
(act), `screenshot()`/`startRecording()` (evidence), `foregroundPackage()`
(crash/liveness check).

CI runs on a **standard `ubuntu-latest` runner** — no macOS runner cost —
using [`reactivecircus/android-emulator-runner`](https://github.com/ReactiveCircus/android-emulator-runner)
to boot a KVM-backed emulator directly on the Linux VM.

## What was integrated

1. **`e2e/mobile-sim/`** (iOS) and **`e2e/mobile-sim/android/`** (Android) —
   parallel driver + flow structures (see `e2e/mobile-sim/README.md`):
   `doctor.mjs` preflight, `run.mjs` entry point, `flows/login.mjs`
   (UI-driven, real form) + `flows/smoke.mjs` (open app → login → discover
   bottom nav from the live accessibility tree, label-agnostic/i18n-safe →
   tap every tab → verify each screen changes → screenshot + outline/dump
   per step → `summary.json` → `session.mp4`).
   npm scripts: `sim:doctor[:android]`, `test:device[:ios|:android]`.
2. **`.github/workflows/MOBILE-DEVICE-E2E.yml`** — dispatch-only, `macos-15`
   runner: installs sim-use, boots an iPhone simulator, runs the flow.
   Needs `TEST_USER_PASSWORD` (existing repo secret) for the authenticated
   part.
3. **`.github/workflows/ANDROID-DEVICE-E2E.yml`** — dispatch-only,
   `ubuntu-latest` runner: boots a KVM-backed emulator, runs the flow. Same
   `TEST_USER_PASSWORD` secret.
4. **Agent skills** (auto-loaded by Claude Code sessions in this repo):
   - `.claude/skills/sim-use/` — vendored upstream skill (iOS/sim-use
     command surface only) with its Apache-2.0 LICENSE and NOTICE;
   - `.claude/skills/vitana-mobile-testing/` — Vitana glue covering both
     drivers: layer selection per host, DE-first labels, auth, environment
     URLs.

## Host capability matrix

| Host | iOS | Android | What to run |
|---|---|---|---|
| Mac (dev machine) | ✅ sim-use | ✅ (adb, or `sim-use android init` if preferred) | `npm run test:device[:android]` |
| GitHub `macos-15` runner | ⚠️ boots/records fine, login/nav unreliable (see caveat) | n/a (use the cheaper ubuntu-latest path instead) | dispatch `MOBILE-DEVICE-E2E.yml` |
| GitHub `ubuntu-latest` runner | ❌ | ✅ (KVM-backed emulator) | dispatch `ANDROID-DEVICE-E2E.yml` |
| Linux CI / Claude cloud container | ❌ (no macOS) | ✅ **if** a device/emulator is reachable (this sandbox has no KVM, so it can't boot one itself) | `npm run test:device:android` against a reachable device, else Layer 1 |

`npm run sim:doctor` / `sim:doctor:android` encode this — run either on any
host and it tells you what that host can do and how to fix or where to
fall back.

## Conventions

- **Target `/maxina`, not the bare domain root.** `/` renders
  `src/pages/Index.tsx` — a multi-tenant portal-selector grid (Maxina /
  AlKalma / Earthlinks / Exafy Admin cards), not the community app. It has
  no login form and no bottom nav, so a flow pointed there will correctly
  find nothing to authenticate or tap — that's not a failure, it's the
  wrong entry URL. `/maxina` (`src/pages/portals/MaxinaPortal.tsx`) is the
  actual sign-in screen; both `run.mjs` entrypoints default there already.
- Test **staging or PR previews** by default; prod only when explicitly
  asked (consistent with the staging-first cutover, CLAUDE.md §16).
- The smoke flows discover nav from the accessibility tree instead of
  hardcoding labels — keep new flows label-agnostic or match both DE and EN
  variants.
- Artifacts are gitignored (`e2e/mobile-sim/artifacts/`); CI uploads them as
  workflow artifacts instead.
- Per the repo verification protocol: a device run isn't "done" until the
  screenshots have actually been read and inspected.
