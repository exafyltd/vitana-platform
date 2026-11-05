# Sparring round 1 — in_progress

Session: `3e5bf45b-6434-4a84-99db-bc272402be2c` · plan hash `6fcdb1f32fcbe1b72da2225fd5fa5e26a38f5ba607c0f13fbda5aec87af66bd1`

## Summary

Verified the core premises of the plan against the pinned commit. The 22-row events-calendar partition, the lane_rules in parity-scope.json, and the core-closure.mjs class-B gate all check out. One minor arithmetic error in the kind breakdown (the plan says 14 screen but the ledger has 13 screen). I was unable to verify the App.tsx route line ranges, the ESLint i18n/no-raw-locale-call rule, vcal/time.ts, and liveRoom.ts due to the tool-call cap; these should be verified in round 2. No blocker or major issues found.

## Findings

### R1-F1 [minor]

The plan's Measured State says the 22 rows break down as '14 screen, 3 overlay, 6 exclusion route', but 14+3+6=23≠22. The actual ledger has 13 screen + 3 overlay + 6 route = 22. COMM.OVERVIEW is the 13th screen; there is no 14th. The total of 22 and the 12+4+6 lane partition are both correct, so this is only a cosmetic annotation error, but it could mislead an implementer doing a kind-based sanity check.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:485` — "key": "CALENDAR.OVERVIEW", ... "kind": "overlay"
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:808` — "key": "COMM.OVERVIEW", "web_path": "/comm/events-meetups?tab=hot", "kind": "screen"
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:1877` — "key": "REMINDERS.OVERVIEW", ... "kind": "screen", ... "lane": "events-calendar"

Suggestion: Correct the kind breakdown to '13 screen, 3 overlay, 6 exclusion route' (total 22).

### R1-F2 [minor]

The plan references core-closure.mjs line 150 for the class-B gate (`m.own !== 'A'`), but the actual check is at line 153. Minor line-reference error that could confuse a reviewer looking at the cited line.

- `exafyltd/vitana-v1:scripts/native/core-closure.mjs:150` — for (const rel of [...closure].sort()) {
      const m = modules[rel];
      if (!m) continue;
      if (m.own !== 'A') {

Suggestion: Update the line reference from :150 to :153.

### R1-F3 [minor]

COMM.OVERVIEW (line 808) and COMM.EVENTS_HOT (line 509) share the identical web_path '/comm/events-meetups?tab=hot'. The plan lists both as separate rows in the events-meetups lane without noting the duplicate path. While the ledger uses the `key` field for uniqueness (not web_path), this could cause confusion during parity verification — a single native screen would need to satisfy two distinct parity rows at the same URL.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:509` — "key": "COMM.EVENTS_HOT", "web_path": "/comm/events-meetups?tab=hot"
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:808` — "key": "COMM.OVERVIEW", "web_path": "/comm/events-meetups?tab=hot"

Suggestion: Add a note in the events-meetups lane acknowledging that COMM.OVERVIEW and COMM.EVENTS_HOT share the same web_path, and clarify how parity is assessed for two keys at one URL (e.g. the native screen flips both rows).

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
