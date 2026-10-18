---
lane: n6b-ios-voice
state: executing
next_actor: claude
vtid: VTID-05180
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: exafyltd
paths:
  - "apps/mobile/**"
  - "packages/core/**"
  - "packages/tokens/**"
  - "docs/validation/**"
claimed_by: kiro-exafy-202610181501-d321
branch: kiro/health-native/n6b-ios-voice
pr: https://github.com/exafyltd/vitana-platform/pull/4183
updated: 2026-10-18T15:03Z
---
# N6b — ORB iOS voice module: build + device verification on macOS (vitana-v1 #1392)

Tasks: `tasks.md` section "n6b-ios-voice".

The Swift sources (AVAudioEngine, AEC paths, playback rate) are already on main via #1401. What is missing is
proof on Apple hardware, which needs a Mac with Xcode (Kiro IDE seat on the owner's machine):
1. `npx expo prebuild -p ios` in `apps/mobile`, build in Xcode, run the XCTest targets under
   `apps/mobile/modules/vitana-voice/ios` (duplex-gate vectors).
2. On a real iPhone: the ORB dev bench (`/dev/orb-bench`) echo test must show zero gate openings; fake gateway only
   until G1 exists (no live ORB sessions against production).
3. Then either close #1392 as superseded by #1401 (note results in this lane) or push only the remaining fixes there.

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → executing
Handed over to Kiro with the health-native spec. next_actor: kiro.

### 2026-10-18T15:02Z · kiro-exafy-202610181501-d321 · executing (blocked, → next_actor: claude)
Picked up as the exafy seat's one build item this run (only `seat: exafy` lane with `next_actor: kiro`,
not blocked, unclaimed). Claimed OK (`collab-claim/health-native/n6b-ios-voice`).

**Blocked — this lane cannot be built in Kiro Web (Linux cloud).** All three tasks need Apple hardware that
is not available in this environment:
- `npx expo prebuild -p ios` + Xcode build + the `vitana-voice/ios` XCTest duplex-gate targets require macOS +
  Xcode. This sandbox is Linux x86_64 (`uname`: `…amzn2023.x86_64`); no `xcodebuild`, no `expo` on PATH.
- The `/dev/orb-bench` echo test "zero gate openings" step requires a real iPhone (and must use a fake gateway
  only — no live ORB on production, per the lane and CLAUDE.md).
- Closing #1392 / pushing remaining fixes depends on the device-verification results above, so it cannot be
  decided here either.

The lane itself says this is a "Kiro IDE seat on the owner's machine" job (Mac with Xcode). Nothing in the
lane's `paths` is doable Linux-only, so there is no partial code change to make. Leaving `state: executing`
and handing to `claude`/the owner's Mac-capable Kiro IDE seat to run the on-device verification.
No code changed; no VTID allocated; no live-system writes.
