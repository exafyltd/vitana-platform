# Sparring round 1 — in_progress

Session: `b736a881-deb5-4378-93cc-7428b6706fc7` · plan hash `0e4be517e22094295b69cbb9a5f397c1517c7700349162925d3de6c1281b15d1`

## Summary

The plan is sound. All three premises hold against the pinned code. The root cause diagnosis is correct: the three outbox fixtures with hardcoded `2026-10-21` dates are pruned by `OUTBOX_MAX_AGE_MS` (7 days) once the wall clock passes 2026-10-28T10:00Z. The fix (making those three `created_at` values relative to `Date.now()`) is minimal and targets exactly the right lines. No source files change, change class "light" is appropriate, and the remaining fixed dates in the file (server rows, delivery-state patches) are not subject to pruning. One minor observation below.

## Findings

### R1-F1 [minor]

The `serverRow` helper (line 101) also uses a hardcoded date (`new Date(Date.UTC(2026, 9, 21, 10, 0, seq))`) for every mock server response. While this is not subject to outbox pruning, if any future time-sensitive logic is applied to server rows (e.g. age-based UI hints), this will become a second time bomb of the same kind. Consider making it relative too while you are in this file.

- `exafyltd/vitana-v1:src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx:100` — seq += 1;
  return { id: `srv-${seq}`, tenant_id: 't', sender_id: ME, receiver_id: PEER, content, created_at: new Date(Date.UTC(2026, 9, 21, 10, 0, seq)).toISOString(), read_at: null, delivered_at: null, client_message_id: cid, ...over };

Suggestion: Replace the hardcoded UTC date in `serverRow` with a relative one (e.g. `new Date(Date.now() - 5 * 60_000 + seq * 1000)`) to future-proof the file. This is low-risk since it is the same kind of change you are already making for the outbox fixtures.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
