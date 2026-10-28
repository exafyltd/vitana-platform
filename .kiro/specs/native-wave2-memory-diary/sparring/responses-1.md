# Planner responses — session 1, round 1

Session: `789653a6-dff1-4e28-960c-6e34ad0506a7` · answering `round-1.md`.

All three findings accepted and fixed in `plan.md`, each verified against vitana-v1 `main`.

## What changed in `plan.md`

- **R1-F1 (parity target, major).** Confirmed the 4 memory pages have **no `useIsMobile()` branch and no
  `MobileAppShell`** (`Memory.tsx:11`, `memory/Timeline.tsx:14`, `memory/Recall.tsx:3`, `memory/Permissions.tsx:9` all
  render `AppLayout` + `SubNavigation`). Only the diary source `MobileDailyDiary.tsx` is phone-shaped (it uses
  `MobileAppShell`). Rewrote decision 6 to split the parity target by sub-cluster: **diary** mirrors its mobile-web
  source 1:1; the **four memory** screens take option (a) — **body-ported** through the native N3 shell
  (`MobileAppShell` substitutes for the responsive web `AppLayout`), the reference being functional body parity, not
  a 390×844 web pixel copy. Updated the Goal and the G1 deferred-tests line so the reviewer compares the four memory
  screens against the native N3 baseline, not a web capture.
- **R1-F2 (ledger, minor).** Verified directly against the committed ledger: 435 rows total, exactly 7 `memory-diary`
  rows with the keys/paths the plan lists, and **0** rows for `/memory/diary` — so it is not an orphan (it is a
  redirect route, not a tracked destination). Strengthened the measured-state note to record this.
- **R1-F3 (active-role header, minor).** Verified `communityFetch` sends `X-Vitana-Active-Role: community`
  (`community-gateway.ts:13-15`) and the generic native `gatewayGet`/`gatewayJson` (`gateway.ts:6`) does not. Added an
  explicit requirement to decision 2 that the native class-B memory/diary data layer send that header (via a small
  community-gateway wrapper, not by changing the shared helper) on every call, and added a fake-gateway unit test to
  the test plan asserting the header is present.

## Dispositions

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed against vitana-v1 main: Memory.tsx, memory/Timeline.tsx, memory/Recall.tsx and memory/Permissions.tsx have no useIsMobile() branch and do not use MobileAppShell — they render the responsive desktop AppLayout + SubNavigation on phones. There is no distinct mobile-web source to mirror for these four, so the generic 'mirror the useIsMobile() <=1024px branch' target was wrong for them. Fixed decision 6: the diary screen mirrors its genuinely phone-shaped web source (MobileDailyDiary.tsx via MobileAppShell) 1:1; the four memory screens are body-ported (option a) — content/controls/states re-authored through the native N3 shell, which substitutes for the responsive web AppLayout — with the parity reference being functional body parity, not a web pixel copy. The G1 screenshot task for the memory lane compares against the native N3 baseline, not a 390x844 web capture (which would show desktop AppLayout nav the native shell deliberately omits); recorded in the Goal, decision 6 and the deferred-tests line.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified directly in apps/mobile/parity/ledger.json (version 2): 435 rows total; exactly 7 rows carry lane memory-diary with keys/paths MEMORY.OVERVIEW /memory, MEMORY.TIMELINE /memory/timeline, MEMORY.RECALL /memory/recall, MEMORY.PERMISSIONS /memory/permissions, MEMORY.DAILY_DIARY /daily-diary, MEMORY.DIARY /daily-diary?tab=health, MEMORY.DIARY_BUGS /daily-diary?tab=bugs. There is NO /memory/diary ledger row (0 rows), so it cannot be an orphan — /memory/diary is a redirect route (to /daily-diary on mobile per App.tsx:720-727, to the desktop Diary hub on desktop) that the ledger does not track as a memory-diary destination. Strengthened the measured-state note with these confirmed facts; the '0 orphan' claim holds.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: web communityFetch (src/lib/community-gateway.ts:13-15) sends Authorization: Bearer <token> AND X-Vitana-Active-Role: community on every call; the generic native gatewayGet/gatewayJson (apps/mobile/src/auth/gateway.ts:6) does not add the role header. Added an explicit requirement to decision 2 that the native class-B memory/diary data layer send X-Vitana-Active-Role: community (and any other community-gateway headers) on every memory/diary gateway call, implemented as a small community-gateway wrapper in the native data layer (not by mutating the shared gatewayGet, which other lanes rely on), and added a fake-gateway unit test to the test plan asserting the header is present on each memory/diary call so wrong-active-role tenant scoping is caught in CI.",
    "deferred_to": ""
  }
]
```

## Next

Committing `plan.md` + this file and pushing to start round 2.
