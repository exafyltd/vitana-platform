# Mobile Device Testing — sim-use integration

**Added: 2026-07-13 · Upstream: [lycorp-jp/sim-use](https://github.com/lycorp-jp/sim-use) (Apache-2.0)**

This document describes the device-level testing layer that gives agents and
engineers *eyes and hands* on the Vitana frontend running in a real iOS
Simulator or Android emulator/device — beyond the viewport emulation the
Playwright suites provide.

## The two testing layers

| | Layer 1 — Playwright emulation | Layer 2 — sim-use device layer |
|---|---|---|
| What it is | Chromium with iPhone-14 viewport/touch flags | Real Simulator/emulator browser, driven via platform accessibility APIs |
| Lives in | `e2e/` (projects `mobile-*`) | `e2e/mobile-sim/` |
| Runs on | Anywhere (Linux CI, cloud containers, Mac) | **macOS 14+ only** (sim-use is a Swift CLI; iOS Simulator needs Xcode) |
| Auth | Injected Supabase session (localStorage) | Real login form, real taps and keystrokes |
| Catches | Route errors, console errors, layout at mobile width | Real rendering, touch pipeline, soft keyboard, Safari quirks, tap-target reachability |
| Command | `cd e2e && npm run test:mobile` | `cd e2e && npm run test:device` |

Both layers test the same deployed URLs (staging
`preview.vitanaland.com` by default; prod `vitanaland.com`; per-PR
previews `community-app-pr-<n>`).

## What sim-use is

A cross-platform CLI (LY Corporation) built for AI-agent loops:

- `sim-use ui` — renders the current screen as a token-efficient
  accessibility outline (`@N` aliases per element), including WebView content
  — which is what makes it work for our SPA.
- `sim-use tap @9` / `--label 'Anmelden'` / `#id` — taps by alias, label, or
  accessibility id; plus `swipe`, `type`, `paste` (IME-safe Unicode),
  `gesture`, `button`, `screenshot`, `record-video`, `app-state` (crash
  detection).
- One command surface for **iOS Simulator** (via idb/HID) and **Android**
  (via an on-device accessibility-bridge APK over `adb forward`).

Install (macOS): `brew tap lycorp-jp/tap && brew install lycorp-jp/tap/sim-use`

## What was integrated

1. **`e2e/mobile-sim/`** — driver + flows (see its README):
   - `doctor.mjs` preflight, `run.mjs` entry point;
   - `flows/smoke.mjs` — open app in device browser → UI-driven login →
     discover bottom nav from the live accessibility tree (label-agnostic,
     i18n-safe) → tap every tab → verify each screen changes → screenshot +
     outline per step → `summary.json`;
   - npm scripts: `sim:doctor`, `test:device`, `test:device:ios`,
     `test:device:android`.
2. **`.github/workflows/MOBILE-DEVICE-E2E.yml`** — dispatch-only workflow on
   a `macos-15` runner: installs sim-use, boots an iPhone simulator, runs the
   smoke flow against a chosen URL, uploads screenshots/outlines. Needs the
   existing `TEST_USER_PASSWORD` repo secret for the authenticated part.
3. **Agent skills** (auto-loaded by Claude Code sessions in this repo):
   - `.claude/skills/sim-use/` — vendored upstream skill (SKILL.md,
     cheatsheet, pitfalls, crash protocol, preflight script) with its
     Apache-2.0 LICENSE and NOTICE;
   - `.claude/skills/vitana-mobile-testing/` — Vitana glue: layer selection
     per host, DE-first labels, auth, environment URLs.

## Host capability matrix

| Host | iOS Simulator | Android | What to run |
|---|---|---|---|
| Mac (dev machine) | ✅ | ✅ (emulator or USB device) | `npm run test:device[:android]` |
| GitHub `macos-15` runner | ✅ (MOBILE-DEVICE-E2E.yml) | ❌ (no reliable nested virt) | dispatch the workflow |
| Linux CI / Claude cloud container | ❌ (no macOS, no KVM) | ❌ | `npm run test:mobile` (Layer 1) |

`npm run sim:doctor` encodes this matrix — run it on any host and it tells
you what that host can do and how to fix or where to fall back.

## Android one-time setup

```bash
sim-use android init --device <serial>   # installs the bridge APK
adb -s <serial> shell am start -a android.intent.action.VIEW -d https://preview.vitanaland.com
sim-use ui --device <serial>
```

## Conventions

- Test **staging or PR previews** by default; prod only when explicitly
  asked (consistent with the staging-first cutover, CLAUDE.md §16).
- The smoke flow discovers nav from the accessibility tree instead of
  hardcoding labels — keep new flows label-agnostic or match both DE and EN
  variants (`--label-regex '(Anmelden|Sign in)'`).
- Artifacts are gitignored (`e2e/mobile-sim/artifacts/`); CI uploads them as
  workflow artifacts instead.
- Per the repo verification protocol: a device run isn't "done" until the
  screenshots have actually been read and inspected.
