# vitana-v1 companion patch — ORB Recovery 2+3: continuity + cadence (DEV-COMHU-0503)

**Target repo:** `exafyltd/vitana-v1` (NOT reachable from the autonomous sandbox)
**Companion to:** vitana-platform PR — `orb_session_state` migration,
`orb-session-state.ts` helper, `recordWakeTurn` (the missing `last_turn_at`
writer), continuity endpoints (`/api/v1/orb/session/continuity`), and widget
`_persistContinuity` / `reset()`.

## What ships automatically
The continuity logic lives in the gateway-served `orb-widget.js`, so the community
surface gets it once the gateway deploys. Two host-side items remain:

## 1. Cache-bust bump (required)
```diff
- orb-widget.js?v=20260529-VTID-03185-audio-queue-closure
+ orb-widget.js?v=20260531-DEV-COMHU-0503-continuity
```

## 2. Call `reset()` on logout / account switch (required for anti-leak)
The widget now exposes `VitanaOrb.reset()` (intentional forget: clears durable
continuity + in-memory identity-bound state, then closes). Wire it wherever the shell
signs out or switches accounts — ideally alongside the `clearAuth()` call added in the
ORB-1 patch:

```ts
// on SIGNED_OUT / account switch
window.VitanaOrb?.reset();   // clears continuity + closes
// (clearAuth from ORB-1 also clears the in-memory token)
```

`VitanaOrb.hide()` (the normal X-close) now PRESERVES 15-minute continuity on its own —
no host change needed for that path. Only the explicit forget needs `reset()`.

## LiveKit note
The LiveKit Python agent honoring the greeting decision (skip / brief_resume on quick
reopen) is tracked in `docs/patches/orb-agent/ORB-2-3-continuity-greeting.py`. The
gateway must pass the resolved `greeting_policy` into the LiveKit job metadata for the
agent to read.

## Acceptance (post-deploy, community surface)
- Close ORB, reopen within 60 s → greeting is `skip`/`brief_resume`, never first-time
  (verify via `orb.session.identity.resolved` + greeting telemetry).
- Reopen within 15 min → no repeated daily-journey summary.
- Logout → `reset()` called → next user has zero continuity leak (dragan1 ↔ dragan3).
- LiveKit agent honors `skip` / `brief_resume`.
