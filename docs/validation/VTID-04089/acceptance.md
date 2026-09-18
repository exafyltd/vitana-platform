VTID: VTID-04089
VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1 — Every icon-only close control (`&times;`/unicode glyph) in the Command
Hub has an `aria-label` naming what it closes/removes, so a screen-reader
user hears what the button does instead of "button". TEST:
services/gateway/test/command-hub/t10-r2-aria-labels-and-input-labels.test.ts

AC-2 — Every standalone `<label>` element that does not already wrap its
control is wired to it via `for=`/`id=`, so a screen-reader user hears the
field's name when it receives focus. A label that WRAPS its input (implicit
association, WCAG-compliant) is correctly left untouched. TEST:
services/gateway/test/command-hub/t10-r2-aria-labels-and-input-labels.test.ts

AC-3 — No other behavior change: full Command Hub regression sweep unchanged
except for the two pre-existing brittle fixed-width source-slice tests that
had to be widened because the new `aria-label` content pushed later source
past their old window (the underlying assertion — a fullscreen toggle and
close button both exist inside `overlay-header-actions` — is unaffected).
TEST: services/gateway/test/command-hub/ full suite +
services/gateway/test/vtid-03906-08-operator-scroll-mic-fullscreen.test.ts

AC-4 — Cache-bust bumped on both `styles.css` and `app.js` tags together, to
the same version string.

AC-5 — `tsc --noEmit` and `npm run build` both clean.

## Route Mount Evidence

Not applicable — this VTID adds zero routes. It only edits
`services/gateway/src/frontend/command-hub/app.js` (attribute additions to
existing DOM-construction code) and `index.html` (cache-bust). No new
`router.<verb>(...)` registration is added anywhere in this diff.

Full acceptance mapping is the AC list above; see commands.log for the exact
commands run.
