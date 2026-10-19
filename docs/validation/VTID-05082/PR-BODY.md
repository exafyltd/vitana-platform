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

Single hook: only `renderOperatorChat`'s reply path (`!isSent`) changed;
`renderManualMarkdown` and `kiro-console.js` are untouched.

> NOTE (merge with main): VTID-05073 extracted `renderOperatorChat` and the
> operator-chat helpers out of `app.js` into `operator-console.js` after this
> branch was cut. The SVG helper block and the reply-path hook now live in
> `services/gateway/src/frontend/command-hub/operator-console.js` (not `app.js`),
> which is where `renderOperatorChat` resides on current `main`. `app.js` is
> unchanged from `main`. Any "app.js" reference in the acceptance notes below
> refers to this now-relocated operator-chat renderer. The 12 unit tests slice
> and exercise the block from `operator-console.js` and pass.

## ✅ Changes

- [x] `operator-console.js` — SVG extract/sanitize/base64/preview/lightbox helpers + reply-path call in `renderOperatorChat`
- [x] `styles.css` — `.chat-svg-*` preview/lightbox classes (no inline style)
- [x] `index.html` — `?v=` bumped to `20261121-vtid-05082` on operator-console.js + app.js
- [x] `dist/frontend/command-hub/{operator-console.js,app.js,styles.css,index.html}` — built mirror committed (Build Gate)
- [x] `scripts/ci/command-hub-ownership-guard.js` — one documenting allowlist comment (no pattern edit)
- [x] `test/command-hub/vtid-05082-svg-render.test.ts` — 12 tests incl. mandatory hostile-SVG
- [x] `package.json` / `package-lock.json` — test-only `jsdom` devDependency (declared above)
- [x] `docs/validation/VTID-05082/` — acceptance (AC-1..AC-16) + real guard outputs

## 🧪 Testing

- [x] Automated tests added (12/12 pass, incl. hostile-SVG)
- [x] CI guards re-run locally: ownership 12/12, golden fingerprint PASS, CSP gate exit 0, `node --check` exit 0
- [ ] Verified in staging — AC-7 lightbox desktop (1400×900) + mobile (390×844) screenshots OWED (no drivable browser locally; capture during the staging walkthrough)

## 🔁 Handoff (VTID-05060)

- **Where it stopped:** implemented, verified locally, committed on `dev-comhu-svg-render`. Two CI blockers from the first review are fixed on-branch (dist mirror committed; `DEPENDENCY_CHANGE:` declared here).
- **Open:** official plan-sparring gate through the sanctioned channel; AC-7 staging screenshots; decide #4033 merge ordering (our `?v=` token `20261121-vtid-05082` is already strictly newer than #4033's `20261115-vtid-05063`, so no collision in either order).
- **Next:** open this PR with this body, let CI run, then staging verify → Gate 2.

## 🚨 Breaking Changes

None.
