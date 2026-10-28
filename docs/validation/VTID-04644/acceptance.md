# VTID-04644 — open the screen when the member plainly asks and the model did not

VTID: VTID-04644
VALIDATION_PROFILE: gateway_backend

## Why

On production (VTID-04629) a member said "show me the screen where I can make a post". The voice
model answered with words ("it's in the news feed … I can't take you there") and opened nothing.
The registry knew the screen. The owner approved a gateway safeguard on 2026-09-26: when the member
clearly asks to open or see a screen and the model opened nothing, the gateway opens it.

## What changed

- `services/gateway/src/orb/live/session/explicit-open-backstop.ts` (new): at turn_complete, if the
  member's words are an explicit open request ("open", "show me", "take me to", "öffne", "zeig mir",
  "bring mich" and the equivalents in es/fr/pt/it/sr/pl/ru/tr/ar/zh), not negated, nothing was
  navigated during the turn and nothing is pending, and the registry resolver gives ONE clear match,
  the screen opens through `openScreen()` with every gate. Ambiguous or no match: nothing happens.
  Registry dispatcher only (NAV_V2_ENABLED), not on /admin-style role surfaces.
  `ORB_NAV_OPEN_BACKSTOP_ENABLED=false` turns it off.
- `upstream-message-handler.ts`: reads the per-turn navigation marker before `turn_count` advances
  and calls the backstop right after the VTID-04619 backstop (Vitana announced a page but did not
  navigate), only when that one did not take the turn — the two never both navigate.
- `orb-widget.js`: a directive marked `after_turn` runs as soon as the reply audio has drained. The
  held speak-then-navigate path waits for a turn_complete that, for this directive, already passed
  (measured: 15.5 s via the safety timer).

## Acceptance

AC-1: the production request, in English and German, opens the post composer (`HOME.CREATE_POST`, `/home?compose=1`) when the model did not.
  TEST: services/gateway/test/nav-redirect/explicit-open-backstop.test.ts
AC-2: across all 57 requests of the redirect suite the backstop never opens a wrong screen (35 open, 0 wrong); "where" questions and ambiguous requests open nothing.
  TEST: services/gateway/test/nav-redirect/explicit-open-backstop.test.ts
AC-3: nothing happens when the model navigated in the turn, a navigation is pending, the model navigates while the resolver runs, the flag is off, or the member is on a role surface.
  TEST: services/gateway/test/nav-redirect/explicit-open-backstop.test.ts
AC-4: negations in every covered language ("don't open it", "Öffne das bitte nicht", "Não abra …", "Non apri …", "不要打开设置", …), "is open" statements, and statements or questions about the action ("I tried to open my calendar", "Should I open it?", "Soll ich den Kalender öffnen?") are not open requests; wishes ("I'd like you to open …", "ich möchte …, öffne das") are.
  TEST: services/gateway/test/nav-redirect/explicit-open-backstop.test.ts
AC-4b: a screen the backstop opens is recorded against the turn that just ended, so the next turn is not treated as already navigated.
  TEST: services/gateway/test/nav-redirect/explicit-open-backstop.test.ts
AC-5: the real widget in Chromium opens the screen 1.1 s after an after_turn directive (was 15.5 s without it), and waits for audio still playing before it navigates.
  TEST: services/gateway/test/nav-redirect/explicit-open-backstop.test.ts (wiring) and outputs/widget-after-turn.json (browser run, local only)
AC-6: no existing navigation behaviour changes.
  TEST: services/gateway/test/nav-redirect services/gateway/test/navigation services/gateway/test/nav-golden

## Staging

`staging-tests.json`: the served widget carries the after_turn branch, plus the suites above. Read-only.

## Not verified

A live voice session on staging where the model fails to navigate: that depends on the model
failing, which cannot be forced. The server path is covered on the real registry and vectors; the
client path in a real browser.
