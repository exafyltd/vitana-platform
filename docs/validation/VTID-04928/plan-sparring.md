# Plan sparring record — VTID-04928

- Change class: standard (frontend page + gateway push URL)
- Plan hash (sha256 of text between plan markers): 430c5dfc1a169a3e0d208af8a111ea5b356d8807d914d518843f80b68279d26e
- Partner: plan-sparring-partner, 2 passes
- Round 1: 2 major (F1 third push site in orb-tools/messaging-depth-tools.ts; F2 deep link outside the latest-100 window), 4 minor (F3 observer cleanup, F4 spec rationale, F5 i18n, F6 What's New). Verdict NOT CONVERGED.
- Round 2: F1–F6 closed (F1 site added; F2 accepted as stated limitation, follow-up for fetch-around); no new findings. Verdict **CONVERGED**.
- Owner approval: "Yes" in chat after the final plan and both rounds were shown.

# Plan: group chat — notification opens at the received message; open-at-latest works on the device

Change class: standard (frontend page + gateway route notification URL)
Scope:
- vitana-v1 `src/pages/messages/GroupChat.tsx`, its Vitest spec, `tests/e2e/staging/vtid-04921-group-chat-latest.staging.spec.ts`, `docs/validation/<VTID>/staging-tests.json`
- vitana-platform `services/gateway/src/routes/chat-groups.ts` (group push `url`), its jest test

<!-- plan:begin -->
## Owner report (2026-10-06, after VTID-04921 shipped to prod at 32c8cd9)
On the Android app (Appilix webview), opening "Alle Beisammen" — and tapping a group-message push — lands on the OLDEST message (top). Owner wants the push to land on the message received, and a normal open to land on the newest.

## Verified facts
- VTID-04921 (`GroupChat.tsx` L199-224) jumps with `main.scrollTop = main.scrollHeight` only. The previous code used `streamEndRef.scrollIntoView`, which scrolls whichever ancestor actually scrolls (main or the document).
- STAGING-VERIFY (headless Chromium 390x844) runs of 3e28249 and 32c8cd9: the VTID-04921 browser spec's body passed (scroll at bottom); the test failed only on staging-guard (39 aborted `rpc/get_message_reactions_text` POSTs). So the code works where `<main>` is the scroller and fails on the device.
- Hypothesis (not provable from this sandbox — no device, prod/staging unreachable): in the Appilix webview `<main>` is not the scroll container (e.g. `h-[100dvh]` not honoured → root grows → document scrolls; header/footer are `sticky`, so the screen looks identical). Then `main.scrollTop` is a no-op → always top. The old `scrollIntoView` path still moved the document, which is why notification opens used to work when React batched the two state updates.
- Group push URL is `/inbox/g/${groupId}` (`chat-groups.ts` L524 new-message fanout, L738 welcome refanout); `message_id` is already in the payload. The deep-link route `/inbox/g/:groupId/msg/:messageId` exists and GroupChat scrolls+highlights the target (`scrollIntoView`, smooth, center), but if the target is not in the loaded page it never scrolls at all (stays top).

## Change
### Frontend (vitana-v1, GroupChat.tsx)
1. Container-agnostic scrolling: the initial jump calls `streamEndRef.current.scrollIntoView({ block: "end" })` (instant) AND sets `main.scrollTop = main.scrollHeight`, so it works whether main or the document scrolls.
2. Stay pinned while late content lays out (images, avatars, signed URLs): a ResizeObserver on the message list re-applies the jump while `pinnedRef` is true. The first user gesture (`touchstart`, `wheel`, `keydown` on the page) clears the pin so the member can scroll up freely. New messages keep the existing "follow if count grew" smooth scroll.
3. Deep link `/msg/:messageId`: scroll to the target with `block: "center"` instantly (no smooth), pinned the same way to the target; highlight as today. If the messages have loaded and the target is not among them, fall back to the bottom (never stay at the top).
### Gateway (vitana-platform, chat-groups.ts)
4. Group-message push `url` becomes `/inbox/g/${groupId}/msg/${messageId}` (new-message fanout and welcome refanout). Old notifications keep working (old URL still opens at the newest message via 1–2).
### Tests
5. Vitest: initial jump uses scrollIntoView on the end sentinel (works when document scrolls); deep link scrolls to the target; deep link to a missing id falls back to the bottom; first user gesture unpins.
6. Staging spec (read-only): fix the guard failure WITHOUT widening the guard — the spec fulfils `rpc/get_message_reactions_text` locally with `[]` via `page.route` (the request never leaves the browser). Add a second case that forces document scrolling (inject CSS making the page root `height:auto`) and asserts the newest message is in the viewport — the device condition. Add a deep-link case `/inbox/g/<id>/msg/<latestId>` asserting that message is in view.
7. Gateway jest: the fanout payload url carries `/msg/<messageId>`.

## Release
Frontend and gateway go through their own staging → STAGING-VERIFY. No production deploy without a passed verification on the exact commit and the owner's yes, with the full commit range listed.
<!-- plan:end -->

## Planner responses (round 1)
- F1 ACCEPTED: missed. Scope and change 4 now include `services/gateway/src/services/orb-tools/messaging-depth-tools.ts:377` (ORB voice send) — url becomes `/inbox/g/${group.id}/msg/${messageId}`; the gateway jest test covers all three sites.
- F2 ACCEPTED as a stated limitation, owner to confirm. A push is sent the moment its message is the newest, so the target is outside the latest-100 window only if 100+ newer messages arrived before the tap. In that case the chat opens at the newest message (never the top). Loading messages around an older target ("fetch-around") is a follow-up VTID, not this fix.
- F3 ACCEPTED: the ResizeObserver is disconnected and the gesture listeners removed in the effect cleanup; the effect is keyed on groupId/messageId, so unmount, navigation and group switch all clean up and re-arm.
- F4 ACCEPTED: the spec comment states the RPC is a SELECT-only PostgREST read sent as POST, and that fulfilling it locally keeps the request off the network (the guard itself is not widened).
- F5 ACCEPTED: no new user-visible strings; i18n inventory unchanged.
- F6 ACCEPTED: bug fix, no What's New entry.
