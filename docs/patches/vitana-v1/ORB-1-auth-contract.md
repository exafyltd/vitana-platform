# vitana-v1 companion patch — ORB Recovery 1: Auth contract (DEV-COMHU-0502)

**Target repo:** `exafyltd/vitana-v1` (NOT reachable from the autonomous sandbox)
**Companion to:** vitana-platform PR — reactive `setAuth` + `clearAuth()` in
`services/gateway/src/frontend/command-hub/orb-widget.js`, and the
`orb.session.identity.resolved` OASIS event in `live-session-controller.ts`.

## Why
The widget now treats `setAuth(token)` as **reactive**: a real token lifts the
anonymous lock at any time, and `setAuth('')`/`clearAuth()` wipes identity-bound
continuity. For this to fix the "I have no access / missing memory / first-time
greeting every reopen" cluster, the host shell must actually CALL `setAuth` on every
token-state change and `clearAuth` on logout/account-switch.

## 1. Cache-bust bump (required)
```diff
- orb-widget.js?v=20260529-VTID-03185-audio-queue-closure
+ orb-widget.js?v=20260531-DEV-COMHU-0502-auth-contract
```

## 2. `src/hooks/useOrbVoiceClient.ts` — call setAuth reactively
React to Supabase session changes (login, silent refresh, account switch) and push the
fresh access token into the widget. Example:

```ts
import { useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export function useOrbVoiceClient() {
  useEffect(() => {
    // Push the current token immediately…
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (window.VitanaOrb) {
        token ? window.VitanaOrb.setAuth(token) : window.VitanaOrb.clearAuth();
      }
    });
    // …and on every subsequent change.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!window.VitanaOrb) return;
      if (event === 'SIGNED_OUT' || !session?.access_token) {
        window.VitanaOrb.clearAuth();
      } else {
        window.VitanaOrb.setAuth(session.access_token); // login + TOKEN_REFRESHED
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);
}
```

## 3. `src/hooks/useLiveKitVoice.ts` — same reactive contract on the LiveKit path
The LiveKit voice client must use the same token state, so a refreshed token reaches
the LiveKit token-issuance request too. Mirror the `onAuthStateChange` wiring above
(call `setAuth`/`clearAuth`), or share a single auth-effect hook between both clients.

## 4. Shell logout / account switch — explicit clearAuth()
Wherever the shell signs the user out or switches accounts, call:
```ts
window.VitanaOrb?.clearAuth();
```
BEFORE the new identity's first ORB open, so the previous user's conversation /
greeting state cannot leak (preserves the VTID-AUTH-FIX anti-leak guarantee).

## Acceptance (post-deploy, community surface + LiveKit canary)
- Login as dragan3 → open ORB → `orb.session.identity.resolved` OASIS event shows
  `is_anonymous=false`, memory + cadence resolved.
- Logout → next ORB open shows `is_anonymous=true` (no silent authenticated drift) and
  no dragan3 continuity.
- Switch dragan1 → dragan3 in one session → no dragan1 conversation/identity leak.
- Verified on BOTH Vertex and the LiveKit canary.
