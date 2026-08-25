# VTID-03733 — Turkish ORB captions ("subtitles under the orb")

Reported live: "Turkish still has English subtitles/captions under the orb
unlike other languages." Same defect shape as VTID-03578/03681/03719: a
per-language table that VTID-03730's ORB-voice sweep never touched, because
it lives entirely inside the Command Hub widget's own JS file
(`services/gateway/src/frontend/command-hub/orb-widget.js`), not in any of
the backend routing/TTS tables VTID-03730 covered.

There is no live transcript in this widget (deliberately removed — see the
widget's own `BOOTSTRAP-ORB-CAPTION-I18N` comment); the ".vtorb-status" text
shown under the orb is always one of a small, fixed set of status phrases
("Vitana speaking...", "Listening...", a "thinking" filler line, etc.), each
looked up from a `{en, de, es, sr, fr, pt, ru, pl, zh, ar}` dictionary via
`_resolveCaptionLocale()`. `tr` had no entry in any of the 4 dictionaries
that feed this lookup, so `_resolveCaptionLocale()` fell through to its `en`
default for every Turkish session — the same undeclared-gap shape as every
prior "language X speaks/shows English" incident here.

**Same file serves both apps** — `vitana-v1/index.html` loads this exact
gateway-hosted script directly (`%VITE_GATEWAY_BASE%/command-hub/orb-widget.js`),
so the fix in `orb-widget.js` alone fixes captions for both the real
community app and the Command Hub admin panel.

---

AC-1 — every one of the 4 caption-bearing dictionaries has a real Turkish
entry, not a silent fallback to English

- `_CAPTIONS` (13 keys), `_DISCONNECT_LABELS` (4), `_RECOVERY_LABELS` (4),
  `_THINKING_QUICK`/`_PRIMARY`/`_ALTERNATES` (6+7+8=21) — 42 phrase objects
  total, all now carrying a `tr:` field.

TEST: `services/gateway/test/frontend/orb-widget-caption-i18n.test.ts` —
"_CAPTIONS defines all 10 supported locales for every key" and
"_DISCONNECT_LABELS and _RECOVERY_LABELS define all 10 locales for every
reason" (both updated to the 11-locale set, including `tr`)
Output: outputs/targeted-tests.txt

AC-2 — the 21-entry "thinking" filler pool carries the full locale shape
for every entry, not just some

TEST: `orb-widget-caption-i18n.test.ts` — "_THINKING_QUICK/_PRIMARY/_ALTERNATES
entries all carry the full 10-key shape" (regex updated to require `tr:`)
TEST: `services/gateway/test/frontend/orb-widget-thinking-messages.test.ts`
— "every message pair has en/de plus all 8 other ... locales" (same regex
update, independent pin — this test existed before the caption-i18n suite
and asserts the identical invariant from a different angle, so both must
agree)
Output: outputs/targeted-tests.txt

AC-3 — `_CAPTION_LOCALES` (the resolver's admit-list) includes `tr`, so
`_resolveCaptionLocale()` actually reaches the new translations instead of
still falling through to `en`

TEST: `orb-widget-caption-i18n.test.ts` — "_CAPTION_LOCALES (the resolver
admit-list) includes tr, so _resolveCaptionLocale() actually reaches the tr
translations instead of falling through to en" — pins the admit-list array
literal directly (all 11 locale codes, `tr` included) and confirms
`_resolveCaptionLocale()` walks that exact array before its `'en'` fallback,
closing the gap the dictionary-shape tests (AC-1/AC-2) can't catch on their
own: a translation present in a dictionary but missing from this array would
still resolve to `en` at runtime.
Output: outputs/targeted-tests.txt

AC-4 — the fix is scoped to `orb-widget.js` only; the cache-bust `?v=`
parameter is bumped on BOTH apps that load it (gateway's own Command Hub
`index.html` and `vitana-v1`'s `index.html`, which loads the identical
gateway-hosted script), per CLAUDE.md IF-THEN rule 25

TEST: manual diff review, see `commands.log`
Output: (no test — HTML cache-bust bump, not testable code)

AC-5 — no regression to the full gateway suite or to type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt

---

## Deliberate scope note

`_CAPTION_LOCALES` and `GATEWAY_LOCALES` (`services/gateway/src/i18n/catalog.ts`)
are now DIFFERENT sets — `tr` is in the former, not the latter. This is
intentional, not a half-finished fix: `GatewayLocale` drives the
push/email/notification catalog (`tt()`, §13b), a separate, much larger
initiative (DB seeding, translation, native-speaker audit) that was
explicitly out of scope for VTID-03730's ORB-voice work and stays out of
scope here too. Documented inline in both `orb-widget.js` and the test file
so a future reader doesn't "fix" the caption dictionary back down to 10
locales to match `GATEWAY_LOCALES`.
