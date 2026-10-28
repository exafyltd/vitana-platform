# mobile-sim — device-level frontend testing

Real eyes and hands on the Vitana frontend, beyond viewport emulation: this
layer runs the app in an actual mobile browser and drives it through the
platform's accessibility tree, the same mechanism a screen reader uses.

Two independent drivers, because they have genuinely different host
requirements:

| | iOS (`mobile-sim/`) | Android (`mobile-sim/android/`) |
|---|---|---|
| Driven via | [`sim-use`](https://github.com/lycorp-jp/sim-use) (LY Corporation, Apache-2.0) — a Swift CLI | `adb` + `uiautomator` — the Android SDK, no third-party tool |
| Host requirement | **macOS 14+, always** — sim-use is a macOS-only Swift/Xcode binary, even when the platform it drives isn't iOS | **None** — `adb`/`uiautomator` are cross-platform; runs on Linux |
| CI runner | `macos-15` (paid, and — see caveat below — currently slow for this app) | `ubuntu-latest` with KVM (free-tier eligible, faster) |
| Status | Working end-to-end for install/boot/record; login+nav-walk currently blocked by very slow accessibility-tree calls on GH's hosted macOS runner (unconfirmed whether real Mac hardware has the same issue) | New — validate via `ANDROID-DEVICE-E2E.yml` |

Both complement the Playwright projects in `e2e/`, which emulate an
iPhone-14 *viewport* on Chromium and run anywhere (including Linux CI and
cloud containers) — that layer is faster and platform-agnostic but cannot
catch real touch-pipeline/rendering/keyboard issues the way a real device
can.

```
e2e/mobile-sim/
├── run.mjs                # iOS entry point (sim-use)
├── doctor.mjs              # iOS preflight
├── lib/
│   ├── simuse.mjs          # Node wrapper around the sim-use CLI
│   ├── device.mjs          # simctl (iOS) + adb (Android) device helpers
│   └── report.mjs          # shared artifact writer — screenshots, outlines, summary.json
├── flows/
│   ├── login.mjs           # iOS: UI-driven login through the real form
│   └── smoke.mjs           # iOS: open app → login → walk bottom nav → capture
└── android/
    ├── run.mjs             # Android entry point (adb + uiautomator)
    ├── doctor.mjs           # Android preflight
    ├── lib/uiautomator.mjs # adb/uiautomator driver — dump/tap/type/screenshot/record
    └── flows/
        ├── login.mjs        # Android: UI-driven login (+ Chrome first-run dismissal)
        └── smoke.mjs        # Android: open app → login → walk bottom nav → capture
```

## Android — no Mac required

```bash
cd e2e
npm run sim:doctor:android              # verify adb + a connected device/emulator
npm run test:device:android             # default device, staging /maxina, smoke flow
npm run test:device:android -- --flow observe
```

CI: dispatch `.github/workflows/ANDROID-DEVICE-E2E.yml` — boots a KVM-backed
emulator directly on `ubuntu-latest` (via
[`reactivecircus/android-emulator-runner`](https://github.com/ReactiveCircus/android-emulator-runner)),
opens the app in Chrome, drives it via `uiautomator dump` + `input tap/text`,
records with `adb shell screenrecord`, and uploads everything as artifacts.
No macOS runner, no sim-use, no Homebrew install step.

If you have a Mac with `sim-use android init` already set up, that path
still works too: `npm run test:device:android:sim-use`.

## iOS — requires a Mac

```bash
brew tap lycorp-jp/tap && brew install lycorp-jp/tap/sim-use

cd e2e
npm run sim:doctor         # verify the host is ready
npm run test:device        # iOS Simulator, staging /maxina, smoke flow
```

CI: dispatch `.github/workflows/MOBILE-DEVICE-E2E.yml` — boots an iOS
Simulator on a `macos-15` runner, installs sim-use via Homebrew, runs the
flow, uploads artifacts.

**Known issue (unresolved):** on GitHub's hosted `macos-15` runner, every
single `sim-use ui` call has been observed taking 80-170+ seconds against
this app (a heavy animated React SPA) — sim-use's own docs describe
~200-300ms after daemon warmup. Even with retries and long settle waits,
runs have not reliably reached the login form within a normal CI timeout.
This has **not** been tested against real Mac hardware — it may be specific
to GitHub's virtualized macOS tier. Until that's confirmed, treat the iOS
CI path as unreliable and prefer local `npm run test:device` on an actual
Mac when you need a real result.

## Shared options

`--url <url>` (default `$COMMUNITY_URL` or `https://preview.vitanaland.com`,
**+`/maxina`** — the bare domain root is the multi-tenant portal-selector
grid with no login form; `/maxina` is the actual community app + auth
screen), `--flow smoke|observe`, `--device <UDID|serial>`, `--out <dir>`.

Login credentials come from `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` (same
envs as the Playwright fixtures). Without a password the smoke flow runs
unauthenticated and covers public screens only.

Optional: set `SIM_USE_VERBOSE=1` to echo every driver command to stderr
(off by default; the name is shared across both drivers for consistency).

Artifacts land in `mobile-sim/artifacts/<platform>-<timestamp>/`:
numbered screenshots, per-step element/outline dumps, `summary.json`, and
`session.mp4` — a video of the run (browser opening, login being typed,
every tab tap) so anyone can watch it as a replay. Recording is
best-effort on both platforms and never fails the run; on Android a single
`screenrecord` invocation is capped at ~170s, so very long runs only
capture the opening portion.

## Agent usage

Claude Code sessions get two skills from this integration:

- `.claude/skills/sim-use/` — the vendored upstream skill: full command
  surface, selector styles, pitfalls, crash protocol (iOS only).
- `.claude/skills/vitana-mobile-testing/` — Vitana glue: which layer to use
  per host, DE-first labels, login/logout, environment URLs.

On hosts that can't run either device layer well (no adb device reachable,
no macOS), agents fall back to the Playwright mobile projects
(`npm run test:mobile`) — `doctor.mjs` / `android/doctor.mjs` say exactly
this when run on a host that isn't ready.

See `docs/MOBILE_DEVICE_TESTING.md` for the full architecture writeup.
