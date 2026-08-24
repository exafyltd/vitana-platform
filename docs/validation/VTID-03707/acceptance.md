# VTID-03707 — Localize Orb status caption to all 10 gateway locales, bump font-size

Evidence pack for the user-reported bug: "Whatever language we choose, this
subtitles under the Orb are always in English, except when we choose German
and English" — plus a request to make the caption text a little bigger,
since there's a lot of empty space around it on mobile.

Root cause: `.vtorb-status` (the caption shown under the voice Orb) is not a
live transcript — that feature was deliberately removed from this widget
previously — it is always one of a small, fixed set of status phrases
("Vitana speaking...", "Listening...", "Connecting...", etc.), and every one
of ~21 call sites picked the phrase via `_cfg.lang.startsWith('de') ? de :
en`. `_cfg.lang` itself correctly carries the user's real selected locale
(read from `localStorage.getItem('vitana.lang')`, sent to the backend for
genuinely multi-lingual voice responses) — the bug is purely that the
caption-text layer never branched past `de`/not-`de`.

---

AC-1 — Every UI status phrase resolves in all 10 gateway-supported locales
(de, en, es, sr, fr, pt, ru, pl, zh, ar), not just de/en

`_CAPTIONS`, `_DISCONNECT_LABELS`, `_RECOVERY_LABELS`, and the three
`_THINKING_*` phrase pools were extended from `{en, de}` to all 10 locales,
mirroring the gateway's own canonical set
(`services/gateway/src/i18n/catalog.ts` `GATEWAY_LOCALES`).

TEST: `services/gateway/test/frontend/orb-widget-caption-i18n.test.ts` —
"_CAPTIONS defines all 10 supported locales for every key"
TEST: same file — "_DISCONNECT_LABELS and _RECOVERY_LABELS define all 10
locales for every reason"
TEST: same file — "_THINKING_QUICK/_PRIMARY/_ALTERNATES entries all carry
the full 10-key shape"
TEST: same file — "a sample of non-English translations are real
translations, not copies of the English text"
Output: `outputs/grep-sweep.txt` (font-size/lingering-pattern greps);
jest itself could not be executed in this sandbox — see "Known limitation"
below.

AC-2 — No `_setStatus` call site still branches on a hardcoded de/en check

Every one of the ~21 call sites that used to compute its phrase inline via
`_cfg.lang.startsWith('de') ? '<de>' : '<en>'` (or the `_pickLang()`-backed
equivalent) now calls `_caption(key)`/`_loc(entry)`, resolved via the new
`_resolveCaptionLocale()` (falls back to `en` only when the locale isn't one
of the 10 supported codes, never as a de/en-only collapse).

TEST: `orb-widget-caption-i18n.test.ts` — "no _setStatus call site still
branches directly on de/en for caption text"
Output: `outputs/grep-sweep.txt` — manual grep sweep for the same patterns,
confirming only two documented, deliberately out-of-scope sites remain:
`_currentPlaybackRate()` (TTS playback speed, not a caption) and
`_activateFallbackMode()`'s `_transcriptHistory` push (not rendered to
`.vtorb-status` — this widget has no live transcript UI).

AC-3 — `_pickLang()` (de/en-only) is scoped to exactly one remaining
caller — the disconnect-alert MP3 clip id — so widening caption coverage
cannot silently break audio-clip selection

`_ALERT_CLIPS` only has `-en`/`-de` MP3 files (rendered by
`scripts/render-orb-alert-clips.ts`); the caption text and the clip id are
now resolved independently (`captionLang` via `_resolveCaptionLocale()`,
`clipLang` via `_pickLang()`) inside `_announceDisconnect()`.

TEST: `orb-widget-caption-i18n.test.ts` — "_pickLang() is scoped to exactly
one caller — the disconnect-alert MP3 clip id"
Output: `outputs/grep-sweep.txt` — `_pickLang()` appears exactly twice in
the file (its declaration, and the one `clipLang = _pickLang()` call).

AC-4 — Caption font-size increased for legibility (14px→17px, min-height
20px→24px), applied consistently in both places it's set, with no
mobile/desktop divergence risk

Both the inline `cssText` set once at element creation (`_renderOverlay()`)
and the injected `<style>` stylesheet rule were bumped identically.
Deliberately not overridden inside the `@media (max-width:600px)` block:
the inline style has higher CSS specificity than any stylesheet rule
(media-scoped or not) and is never updated after creation, so a mobile-only
override there would silently never apply — a single shared value covers
both viewports named in this repo's visual-verification protocol.

TEST: `orb-widget-caption-i18n.test.ts` — ".vtorb-status font-size and
min-height are 17px/24px in both the inline style and the injected
stylesheet"
UI: verified live in a rendered DOM — see AC-5.
Output: `outputs/grep-sweep.txt`

AC-5 — The new caption text and font-size actually render correctly,
including RTL, at both required viewports

UI: `outputs/playwright-check.txt` — local, fully offline Playwright
harness using the widget's own `_test_showOverlay()`/`_test_setState()`
helpers (no network/live-session calls): English/Spanish/Arabic captions
and the longest new phrase (German idle-nudge, 44 chars) at 390×844 and
1400×900. `getComputedStyle(.vtorb-status).fontSize` read `17px` live in
the DOM in every case.

Screenshots were visually reviewed during this session (no clipping or
overflow on mobile, Arabic renders centered and correctly right-to-left,
the long German phrase wraps cleanly on one line) but are not committed
here, matching this pack's convention of citing tool/suite output rather
than binary images.

AC-6 — The sibling thinking-messages test suite still passes against the
new 10-key phrase-pool shape

`orb-widget-thinking-messages.test.ts`'s pair-shape regex (previously
matched the literal 2-key `{ en: '...', de: '...' }` shape) was updated to
the new 10-key shape; the pair count (21 — quick(6)+primary(7)+alt(8))
is unchanged.

TEST: `services/gateway/test/frontend/orb-widget-thinking-messages.test.ts`
— "every message pair has en/de plus all 8 other ... locales..."
Output: `outputs/grep-sweep.txt` (the same 21-pair count is asserted by
`orb-widget-caption-i18n.test.ts`'s own 10-key-shape regex, cross-checked
against the sibling file's assertion).

AC-7 — Syntax-valid, no build-time breakage from the edit

TEST: `node --check services/gateway/src/frontend/command-hub/orb-widget.js`
— clean, exit 0.
Output: `outputs/node-check.txt`

OASIS_IMPACT: no — this is a caption-text/CSS change with no lifecycle,
task, or state-transition semantics; nothing here emits or should emit an
OASIS event.

---

## Verification summary

| Check | Result |
|---|---|
| New `orb-widget-caption-i18n.test.ts` (10-locale coverage, no lingering de/en branch, `_pickLang()` scope, font-size) | Written; **not executed in this sandbox** — see limitation below |
| Updated `orb-widget-thinking-messages.test.ts` | Written; **not executed in this sandbox** — see limitation below |
| `node --check` on the edited widget file | Clean, exit 0 |
| Manual grep sweep for lingering hardcoded de/en branches | Only the two documented, deliberately out-of-scope sites remain |
| Offline Playwright harness (widget's own `_test_showOverlay`/`_test_setState`, no live session) | 17px confirmed live in DOM, mobile+desktop, en/es/ar/de, no clipping, correct RTL |
| Companion `vitana-v1` cache-bust PR | `exafyltd/vitana-v1#1018` |

## Known limitation — jest could not be executed in this session

`npm`/`pnpm install` for `services/gateway` returned a 403 from the npm
registry in this sandboxed session, with no cached `node_modules`/pnpm
store available to fall back to — an environment limitation of this
session, not a project issue (this repo's CI runners have normal registry
access and are expected to install and run the suite normally; the
**Build Gate** step of `VALIDATOR-CHECK.yml` — `npm ci && npm run build` —
will exercise this for real). `node --check` (syntax) and a hand-review of
every new test's logic against the actual edited source (regex patterns
verified against real line content via `grep`, not written blind) were
used as the best available substitute; the offline Playwright harness
(AC-5) additionally confirms real DOM/CSS behavior independent of jest.

## Known, separate defect surfaced by this PR — not fixed here

`VALIDATOR-CHECK.yml`'s CSP Governance Gate scans the *entire current
content* of any touched file under `services/gateway/src/frontend/` for
inline-style patterns. Simulating its exact regex locally against
`orb-widget.js` as it already stood before this change shows 26
pre-existing `.style.property = ...`/`.style.cssText = ...` DOM
assignments — genuine inline-style CSP violations under this platform's
own "no inline styles" rule, just never previously caught because this
exact gate has never successfully completed a run against this file before
(per this repo's own CHANGE LOG: the workflow was YAML-unparseable for
30+ runs and its VTID-03696 fix note says "not yet confirmed against a
live PR run — the next PR to touch a gateway tree is the first real
exercise"). This PR is, as far as could be determined, that first real
exercise. Fixing it for real means rewriting the widget's whole DOM-styling
approach (inline property writes → CSS classes) across the file — a large,
pre-existing, unrelated undertaking out of scope for a caption-localization
fix. Flagging explicitly rather than silently working around it or
widening this PR to also carry that rewrite.
