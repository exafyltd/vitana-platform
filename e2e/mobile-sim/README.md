# mobile-sim — device-level frontend testing via sim-use

Real eyes and hands on the Vitana frontend: this layer runs the app in an
**iOS Simulator or Android emulator/device browser** and drives it through
the platform accessibility tree using
[`sim-use`](https://github.com/lycorp-jp/sim-use) (LY Corporation,
Apache-2.0) — a CLI built for AI-agent loops that reads any screen as a
compact accessibility outline (`sim-use ui`) and acts on it
(`sim-use tap/type/swipe`).

It complements the Playwright projects in `e2e/` — those emulate an
iPhone-14 *viewport* on Chromium and run anywhere (including the Linux CI
and cloud containers); this layer exercises the **real** device rendering,
touch pipeline, and keyboard, and only runs on a **macOS 14+ host**.

```
e2e/mobile-sim/
├── run.mjs            # CLI entry — flows against a device
├── doctor.mjs         # preflight: host / sim-use / simulators / adb
├── lib/
│   ├── simuse.mjs     # Node wrapper around the sim-use CLI (--json envelopes)
│   ├── device.mjs     # simctl/adb: discovery, boot, open URL in device browser
│   └── report.mjs     # artifacts: screenshots, outlines, summary.json
└── flows/
    ├── login.mjs      # UI-driven login through the REAL form (taps + keys)
    └── smoke.mjs      # open app → login → walk bottom nav → verify + capture
```

## Quick start (on a Mac)

```bash
brew tap lycorp-jp/tap && brew install lycorp-jp/tap/sim-use

cd e2e
npm run sim:doctor        # verify the host is ready
npm run test:device       # iOS Simulator, staging URL, smoke flow
```

Options (after `--`): `--url <url>` (default `$COMMUNITY_URL` or
`https://preview.vitanaland.com`, **+`/maxina`** — the bare domain root is
the multi-tenant portal-selector grid with no login form; `/maxina` is the
actual community app + auth screen), `--flow smoke|observe`,
`--platform ios|android`, `--device <UDID|serial>`, `--out <dir>`.

Login credentials come from `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` (same
envs as the Playwright fixtures). Without a password the smoke flow runs
unauthenticated and covers public screens only.

Optional: set `SIM_USE_VERBOSE=1` to echo every sim-use CLI invocation to
stderr (off by default).

Artifacts land in `mobile-sim/artifacts/<platform>-<timestamp>/`:
numbered screenshots, per-step accessibility outlines (`*.outline.txt`),
`summary.json`, and `session.mp4` — a video recording of the entire run
(browser opening, login being typed, every tab tap), so anyone can watch
the test as a replay. Recording is best-effort and never fails the run.

## CI

Dispatch `.github/workflows/MOBILE-DEVICE-E2E.yml` — boots an iOS Simulator
on a `macos-15` runner, installs sim-use via Homebrew, runs the smoke flow,
and uploads all artifacts. Dispatch-only (macOS minutes + hits a deployed
environment).

## Android

```bash
sim-use android init --device <serial>     # one-time: installs bridge APK
cd e2e && npm run test:device:android
```

Runs locally against an emulator or USB device on a Mac. GitHub-hosted
macOS runners can't reliably host an Android emulator, so there is no
hosted CI path yet.

## Agent usage

Claude Code sessions get two skills from this integration:

- `.claude/skills/sim-use/` — the vendored upstream skill: full command
  surface, selector styles, pitfalls, crash protocol.
- `.claude/skills/vitana-mobile-testing/` — Vitana glue: which layer to use
  per host, DE-first labels, login/logout, environment URLs.

On hosts that can't run the device layer (Linux containers), agents fall
back to the Playwright mobile projects (`npm run test:mobile`) —
`doctor.mjs` says exactly this when run on a non-mac host.

See `docs/MOBILE_DEVICE_TESTING.md` for the full architecture writeup.
