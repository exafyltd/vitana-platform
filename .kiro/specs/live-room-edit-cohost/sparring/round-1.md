# Sparring round 1 — in_progress

Session: `576d1a34-afa1-4084-ab96-3ff5bc86aa5e` · plan hash `ad8e0d8e987f2fc32bcc3656af09948aac89e99d29a672ae37cac00978f44675`

## Summary

The plan's premises about existing code structure are largely accurate. However, I found a critical omission: the plan's interface 4 only specifies changing the `isHost` check in the `enter` and `/daily` routes, but misses the separate gateway-level host check in `room-session-manager.ts::transition()` at line 277. This gateway check will block co-hosts from open-lobby, start, and end operations — the exact powers the plan declares they should have.

## Findings

### R1-F1 [blocker]

The plan's interface 4 only changes `isHost` in the `enter` and `/daily` gateway routes, but `room-session-manager.ts::transition()` (line 277) has its own independent gateway-level host check (`event.userId !== room.host_user_id`) that fires BEFORE any SQL RPC is called. This method is used by: (1) `open-lobby` route (live.ts:2252), (2) `startForHost` → `transition()` (lines 613, 618) — called from the `enter` route when a host enters a scheduled/lobby room, and (3) the `/end` route via `transition({ type: 'END' })`. After the plan's changes, a co-host entering a scheduled/lobby room will pass the new `isHost` check in `enter` (line 1129), triggering `startForHost(roomId, identity.user_id, token)`, which calls `transition(roomId, { type: 'OPEN_LOBBY', userId: co-host-id }, token)`. At line 277, `co-host-id !== room.host_user_id` → returns NOT_HOST. The room never starts. The same applies to direct `/open-lobby` and `/end` calls by co-hosts. The Decisions say co-hosts can 'open the lobby and start the room' and 'end the session', but the gateway will reject all three.

- `exafyltd/vitana-platform:services/gateway/src/services/room-session-manager.ts:274` — // Host authorization check (Gateway-layer, NOT in XState machine)
// TIMEOUT and RESET events don't have userId — they're system-initiated
if ('userId' in event) {
  if (event.userId !== room.host_user_id) {
    return { ok: false, error: 'NOT_HOST', message: 'Only the room owner can perform this action' };
  }
}
- `exafyltd/vitana-platform:services/gateway/src/services/room-session-manager.ts:605` — async startForHost(roomId: string, userId: string, token: string): Promise<TransitionResult> {
  ...
  if (status === 'scheduled') {
    const lobby = await this.transition(roomId, { type: 'OPEN_LOBBY', userId }, token);
    if (!lobby.ok) return lobby;
    status = 'lobby';
  }
  if (status === 'lobby') {
    return this.transition(roomId, { type: 'START', userId }, token);
  }
- `exafyltd/vitana-platform:services/gateway/src/routes/live.ts:1128` — if (isHost && (room.status === 'scheduled' || room.status === 'lobby')) {
  const started = await sessionManager.startForHost(roomId, identity.user_id, token);
  if (!started.ok) {
    const code = started.error === 'NOT_HOST' ? 403 :
- `exafyltd/vitana-platform:services/gateway/src/routes/live.ts:2247` — const { user_id } = req.body;
if (!user_id) {
  return res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
}
const result = await sessionManager.transition(roomId, { type: 'OPEN_LOBBY', userId: user_id }, token);

Suggestion: Interface 4 must explicitly include the `transition()` method's host check (line 277). Replace `event.userId !== room.host_user_id` with a call to the new `isRoomHost` helper from `live-cohosts.ts`, the same way the plan changes `enter` and `/daily`. Also add `transition()` to the gateway Jest test plan (co-host calls OPEN_LOBBY, START, END successfully; non-host still fails).

### R1-F2 [major]

The `open-lobby`, `cancel`, `start`, and `end` routes take `user_id` from `req.body` (untrusted client input), not from the JWT identity. When the plan rewires the gateway host gates to accept co-hosts, the `transition()` check will compare the body-supplied `user_id` against the co-host list, while the downstream SQL RPCs use `auth.uid()` from the JWT. A caller could submit another user's id in the body. Today this is harmless (both checks compare to the single `host_user_id`), but after the change the gateway and SQL layers may disagree. More importantly, once R1-F1 is fixed and `transition()` uses `isRoomHost`, the gateway check should use the authenticated identity, not the body value, to be consistent with the `enter` route (which already uses `identity.user_id` from the JWT).

- `exafyltd/vitana-platform:services/gateway/src/routes/live.ts:2247` — const { user_id } = req.body;
if (!user_id) {
  return res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
}
const result = await sessionManager.transition(roomId, { type: 'OPEN_LOBBY', userId: user_id }, token);
- `exafyltd/vitana-platform:services/gateway/src/routes/live.ts:2285` — const { user_id } = req.body;
if (!user_id) {
  return res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
}
...
const result = await sessionManager.cancelSession(roomId, user_id, token, stripe);
- `exafyltd/vitana-platform:services/gateway/src/routes/live.ts:1096` — router.post('/rooms/:id/enter', requireAuth, async (req: Request, res: Response) => {
  ...
  const identity = (req as AuthenticatedRequest).identity!;
  ...
  const isHost = room.host_user_id === identity.user_id;

Suggestion: When fixing the `transition()` host gate (R1-F1), use the authenticated JWT identity (from `requireAuth` middleware or `verifyAndExtractIdentity`) as the authoritative user_id for the host check, not the body-supplied value. The `open-lobby`, `end`, and similar routes should be migrated to use `requireAuth` and `identity.user_id` like the `enter` route does. The `cancel` route should also use JWT identity, even though it stays creator-only.

### R1-F3 [minor]

The plan states `room-session-manager.ts:376` for `cancelSession`'s host check. The actual host check (`room.host_user_id !== userId`) is at line 378, not 376. Line 376 is `const room = stateResult.data.room;`. This is a minor line-number inaccuracy that does not affect correctness, but should be noted for implementation precision.

- `exafyltd/vitana-platform:services/gateway/src/services/room-session-manager.ts:374` — const room = stateResult.data.room;
const session = stateResult.data.session;

// Host check
if (room.host_user_id !== userId) {
  return { ok: false, error: 'NOT_HOST' };
}

Suggestion: Update the line reference to 378 in the implementation spec.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
