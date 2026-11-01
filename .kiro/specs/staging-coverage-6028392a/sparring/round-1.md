# Sparring round 1 — in_progress

Session: `ffd45970-2c82-401c-bbf0-5bbfcf81224d` · plan hash `afe12c5809b2d81e4ededd9514c4040050a0066a0b494310792add1769e09d15`

## Summary

The plan is well-constructed and governance-compliant. All key premises about the existing code verified against the pinned commit. The notification refactoring is correctly described, the staging-tests.json design avoids production writes, and the commit-coverage.json format matches what `parseCommitCoverage` expects. One minor line-citation inaccuracy found; no blockers or major issues.

## Findings

### R1-F1 [minor]

Plan cites `live.ts:1072` as the location of `notifyUserAsync(..., 'live_room_starting', notif.live_going_live.*)` for the subscriber fan-out, but line 1072 is the `console.log` statement. The `notifyUserAsync` call is at lines 1066-1070.

- `exafyltd/vitana-platform:services/gateway/src/routes/live.ts:1064` —             for (const uid of subscriberIds) {
              const lc = locales.get(uid);
              notifyUserAsync(uid, tenantId, 'live_room_starting', {
                title: tt('notif.live_going_live.title', lc),
                body: tt('notif.live_going_live.body', lc, { title: streamTitle }),
                data: { url: liveRoomViewUrl(roomId), room_id: roomId, entity_id: roomId },
              }, supaN);
            }
            console.log(`[Notifications] live go-live fan-out → ${subscriberIds.length} subscriber(s) for ${roomId}`);

Suggestion: Correct the citation to `live.ts:1066–1070` for `notifyUserAsync` (or `1066–1072` if you want to include the log line). Tiny but avoids confusion when someone follows the reference.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
