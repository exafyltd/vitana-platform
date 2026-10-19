<!--
  Ready-to-use PR body for VTID-05082. Prepared by the Kiro implementer so the
  CI path-ownership / validator guards pass without a forgotten marker.

  PR TITLE (must carry both the ledger VTID and the DEV-COMHU ownership token):
    VTID-05082 / DEV-COMHU-0205: Command Hub operator inline SVG rendering

  The three validator markers below are REQUIRED in the PR body:
    - VALIDATION_PROFILE: selects the command_hub_frontend validator profile.
    - OASIS_IMPACT: no — this change emits no OASIS events.
    - DEPENDENCY_CHANGE: satisfies validator-path-guard.cjs exit-23 (a lockfile
      changed, so the body must declare why). Without this line the guard rejects.
-->

VALIDATION_PROFILE: command_hub_frontend
OASIS_IMPACT: no
DEPENDENCY_CHANGE: added jsdom (gateway devDependency) solely for the VTID-05082 SVG sanitizer unit test — the shipped Command Hub code uses the browser's native DOMParser/XMLSerializer and adds no runtime dependency.

## 🎯 VTID Reference

**VTID:** `VTID-05082` (ownership token `DEV-COMHU-0205`)
**Layer:** COMHU
**Priority:** P2

## 📋 Summary

Teaches the Command Hub operator chat transcript to render SVG that appears in
an assistant reply (a ```svg fence or a raw `<svg>…</svg>`) as an inline image,
instead of printing raw XML. The operator could always write SVG markup; it
could not show it rendered. This closes that gap.

SVG is treated as untrusted:
- `sanitizeSvgMarkup` parses with `DOMParser`, walks an element allowlist
  (drops `script`, `foreignObject`, `image`, anchors, animation, media),
  scrubs `on*` handlers, non-`#` `href`/`xlink:href`, foreign `url(...)` and
  dangerous `style`, and rejects DOCTYPE/ENTITY up front.
- The sanitized markup is shown only through
  `<img src="data:image/svg+xml;base64,…">` built with `createElement` — never
  inserted into the live DOM as markup. The `<img>` context is the second
  independent isolation layer.
- A ~200 KB payload cap and a mandatory hostile-SVG test guard the boundary.

Single hook (decision B): after VTID-05073 (#4121) moved `renderOperatorChat` into
`operator-console.js` and froze it, this PR no longer edits it. `app.js`'s
`_renderAppCore` makes one post-render call,
`window.OperatorSvgRender.enhanceOperatorChat(root, state.chatMessages)`, which
inserts previews after reply bubbles that line up 1:1 with the reply messages
(fail closed otherwise). User-authored messages are never scanned.
`operator-console.js`, `renderManualMarkdown` and `kiro-console.js` are untouched.

## ✅ Changes

- [x] `operator-svg-render.js` (new IIFE module, `modules.json` kind `module`) — SVG extract/sanitize/base64/preview/lightbox helpers + `enhanceOperatorChat` post-render hook
- [x] `app.js` — one post-render call in `_renderAppCore`
- [x] `styles.css` — `.chat-svg-*` preview/lightbox classes (no inline style)
- [x] `index.html` — `operator-svg-render.js` script tag (before `operator-console.js`/`app.js`); `?v=` bumped to `20261121-vtid-05082` on `app.js` + `styles.css`
- [x] `dist/frontend/command-hub/{app.js,styles.css,index.html,modules.json,operator-svg-render.js}` — built mirror committed (Build Gate)
- [x] `scripts/ci/command-hub-ownership-guard.js` — one documenting allowlist comment (no pattern edit)
- [x] `test/command-hub/vtid-05082-svg-render.test.ts` — 17 tests incl. mandatory hostile-SVG + the post-render hook
- [x] 6 tests that pin the `app.js`/`styles.css` `?v=` token updated to `20261121-vtid-05082` (same pattern every earlier bump used)
- [x] `specs/command-hub-symbol-index.json` regenerated
- [x] `package.json` / `package-lock.json` — test-only `jsdom` devDependency (declared above)
- [x] `docs/validation/VTID-05082/` — acceptance (AC-1..AC-16) + real guard outputs

## 🧪 Testing

- [x] Automated tests added (17/17 pass, incl. hostile-SVG); VTID-05073 extraction proof stays green with `operator-console.js` byte-identical to main
- [x] After merging `main`: 58/59 Command Hub + Operator suites green locally; the one red (`vtid-04465` operator pipeline, a Windows path-separator assertion `test\command-hub\…` vs `test/command-hub/…`) does not touch the Command Hub frontend. `npm run build` exit 0
- [x] CI guards re-run locally: ownership guard tests pass, golden fingerprint PASS, CSP gate exit 0, `node --check` exit 0
- [ ] Verified in staging — AC-7 lightbox desktop (1400×900) + mobile (390×844) screenshots OWED (no drivable browser locally; capture during the staging walkthrough)

## 🔁 Handoff (VTID-05060)

- **Where it stopped:** implemented, verified locally, committed on `dev-comhu-svg-render`. Two CI blockers from the first review are fixed on-branch (dist mirror committed; `DEPENDENCY_CHANGE:` declared here). `main` merged in (conflict with VTID-05073 resolved by decision B below), session `kiro-202610182052-5ce2`.
- **Open:** official plan-sparring gate through the sanctioned channel; AC-7 staging screenshots; decide #4033 merge ordering (our `?v=` token `20261121-vtid-05082` is already strictly newer than #4033's `20261115-vtid-05063`, so no collision in either order).
- **Next:** open this PR with this body, let CI run, then staging verify → Gate 2.

## 🧭 Decisions taken

- **Decision B (merging `main` after VTID-05073):** VTID-05073 froze every function it moved into `operator-console.js` (`renderOperatorChat` included) as AST-identical to its base fixture. Instead of editing a frozen function or loosening that guard, the SVG render hangs off code the guard doesn't cover: a new module `operator-svg-render.js` post-processes the rendered transcript, called once from `app.js`'s `_renderAppCore`. Owner-approved via the parent session, 2026-10-19. `operator-console.js` is byte-identical to `main`.
- Bubble↔message mapping fails closed: a `.chat-messages` container whose sent/reply bubbles don't match `state.chatMessages` 1:1 is left untouched (raw text, no preview).
- The lightbox close button sets `textContent` `×` instead of `innerHTML` `&times;` (same glyph, no markup).

## 🚨 Breaking Changes

None.
