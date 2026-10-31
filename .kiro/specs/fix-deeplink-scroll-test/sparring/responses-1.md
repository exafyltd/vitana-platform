# Responses to sparring round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified read-only against vitana-v1 origin/main 1349f6991 (git show origin/main:<path>) and recorded in plan.md Today item 4: outbox.ts:46 SENT_GRACE_MS = 2 min, :48 OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000, :89-90 prune(items, now) filters now - created_at < OUTBOX_MAX_AGE_MS, :99 loadOutbox(userId, now = Date.now()), :114/:138 sort by created_at. Fixed outbox dates 2026-10-21T10:00:0x at test :204, :205, :261 (outbox) and :249, :250 (realtime payloads, not pruned). Still red on main 1349f6991 (UNIT-TESTS run 40674402709). New evidence added as Today item 5: exafyltd/vitana-v1#1506 (open, VTID-05320 fix-forward) makes exactly this edit and its Vitest (jsdom) check is green on 3e324cec2, which empirically confirms the premise and the fix. The lane now matches #1506's edit shape and, if #1506 is merged first, closes as a verification of main instead of racing it (plan Lanes, tasks T0)."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "plan.md 'Parallel / shared files / hot files' now states: one changed code file (the test file) plus the standard lane evidence under docs/validation/<VTID>/ (red-on-base.txt, commands.log, staging-tests.json), which common-rules §11's 'at most 3 files' does not count. The lane paths are unchanged."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "plan.md Today item 4 lists every time threshold on outbox items: created_at is read only by prune (outbox.ts:90, 7 days) and for ordering (:114, :138, copied at :181-182); SENT_GRACE_MS applies to sent_at of status 'sent' items (useGlobalMessages.ts:1460-1465), not to these sending/failed fixtures; no minimum-age check exists. The offsets are now minutesAgo(2) / minutesAgo(1) (same as #1506): far inside 7 days, pending strictly 60 s older than failed, no other threshold touched. In the reload test the re-posted item becomes a serverRow dated 2026-10-21 (:101), still earlier than the failed item, so the asserted order is unchanged; #1506's green Vitest run confirms it."
  }
]
```
