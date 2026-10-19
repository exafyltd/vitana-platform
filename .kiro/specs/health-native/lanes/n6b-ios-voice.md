---
lane: n6b-ios-voice
state: executing
next_actor: kiro
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
updated: 2026-10-15T18:59Z
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
