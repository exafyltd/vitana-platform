# VTID-04619 — the gateway navigates when Vitana announces a page but never calls navigate

Production, 2026-09-26 ~09:17 UTC, session live-07f808a6 (de, Nova Sonic): Vitana offered to open the settings page for memory and privacy. The member said "okay, mach das" three times. Each time Vitana answered "Ich öffne jetzt die Seite mit …" and made no tool call (`orb.live.tool.executed`: none for navigate / navigate_to_screen). The repeated replies were muted as duplicate turns (VTID-03143), so the member saw Speaking → Listening with no sound, over and over, and was never taken anywhere.

The fix has the same shape as the VTID-04591 (remember) and VTID-04592 (end conversation) backstops. At turn_complete, if Vitana's reply stated in the first person that she is opening or taking the member to a page, and no navigate or navigate_to_screen call happened in the turn, and nothing is already navigating, the gateway runs the navigate tool itself (`intent: "open"`, question = her words + the member's). The navigate tool does the rest exactly as if the model had called it. Offers and questions ("soll ich …?", "ich kann dir … zeigen", "want me to …") do not count. `ORB_NAVIGATE_BACKSTOP_ENABLED=false` turns it off. Each run emits diag `navigate_backstop`.

AC-1: The production reply and other first-person promises (DE/EN) are recognised; offers, questions and descriptions are not.
TEST: services/gateway/test/orb/live/session/vtid-04619-navigate-backstop.test.ts

AC-2: When Vitana promised and made no call, the gateway calls navigate once with intent "open".
TEST: services/gateway/test/orb/live/session/vtid-04619-navigate-backstop.test.ts

AC-3: It does nothing when the model called navigate or navigate_to_screen this turn, when a navigation is pending or was dispatched in the turn that just ended, for an inactive or anonymous session, or when the kill switch is off. It never throws.
TEST: services/gateway/test/orb/live/session/vtid-04619-navigate-backstop.test.ts

AC-4: It fires through the real upstream message handler, and an ordinary answer does not navigate (mutation-checked: disabling the handler call fails the suite).
TEST: services/gateway/test/orb/live/session/vtid-04619-navigate-backstop.test.ts

AC-5: The end-conversation backstops are unchanged and green.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts

Not verified live: needs a spoken session on staging after merge in which Vitana announces opening a page.
