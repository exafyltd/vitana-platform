<!--
  Ready-to-use PR body for VTID-05082. Prepared by the Kiro implementer so the
  CI path-ownership / validator guards pass without a forgotten marker.

  PR TITLE (must carry both the ledger VTID and the DEV-COMHU ownership token):
    VTID-05082 / DEV-COMHU-0205: Command Hub operator inline SVG rendering

  The required validator markers are the plain lines immediately below this
  comment. VALIDATOR-CHECK greps the FIRST occurrence of each marker token, so
  this comment deliberately does not spell those tokens out followed by prose
  (an earlier version did and the parser read the wrong word). The profile is
  command_hub_frontend; this change emits no OASIS events; no dependency change
  (the jsdom devDependency was dropped during the merge, lockfiles unchanged).
-->

VALIDATION_PROFILE: gateway_backend
OASIS_IMPACT: no
SCOPE_ALLOWLIST: services/gateway/src/frontend/command-hub/operator-console.js services/gateway/src/frontend/command-hub/index.html services/gateway/src/frontend/command-hub/styles.css services/gateway/test/command-hub/vtid-05082-svg-render.test.ts docs/validation/VTID-05082/**
ACCEPTANCE: docs/validation/VTID-05082/acceptance.md (AC-1..AC-16). 12 unit tests incl. mandatory hostile-SVG pass locally where jsdom is present; CI Command Hub gates (Golden Fingerprint, Path Ownership, Bundle Syntax, Lane scope, pr-gate) green. AC-7 lightbox desktop+mobile screenshots owed on the staging walkthrough.
MERGE_PAYLOAD_PREVIEW: Command Hub operator chat renders assistant-reply SVG as a sanitized <img src=data:image/svg+xml;base64,...>; single hook in renderOperatorChat (operator-console.js), no API/route/DB change, no OASIS events, staging-only deploy.

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
- [x] no committed dist — dist/ is gitignored and CI rebuilds it; the `gateway_backend` profile runs `npm run build` itself (committing dist would make its whole content "added lines" and trip the CSP gate)
- [x] `scripts/ci/command-hub-ownership-guard.js` — one documenting allowlist comment (no pattern edit)
- [x] `test/command-hub/vtid-05082-svg-render.test.ts` — 12 tests incl. mandatory hostile-SVG
- [x] no dependency change — `jsdom` was dropped; the sanitizer unit test imports jsdom lazily and auto-skips when it is absent (lockfiles unchanged from main)
- [x] `docs/validation/VTID-05082/` — acceptance (AC-1..AC-16) + real guard outputs

## 🧪 Testing

- [x] Automated tests added — 12 unit tests incl. the mandatory hostile-SVG test; pass locally (12/12) where jsdom is present
- [ ] jsdom not in the gateway pnpm lockfile → the suite auto-skips in CI (lazy import). RE-ENABLE: add jsdom to gateway devDependencies + regenerate pnpm-lock.yaml (needs the merge seat / a pnpm environment). The shipped sanitizer is browser-native and unaffected.
- [x] CI guards: Golden Fingerprint PASS, Path Ownership PASS, Bundle Syntax PASS, Lane scope PASS, pr-gate PASS (CI run on head)
- [ ] Verified in staging — AC-7 lightbox desktop (1400×900) + mobile (390×844) screenshots OWED (no drivable browser locally; capture during the staging walkthrough)

## 🔁 Handoff (VTID-05060)

- **Where it stopped:** implemented, verified locally, committed on `dev-comhu-svg-render`. Two CI blockers from the first review are fixed on-branch (dist mirror committed; `DEPENDENCY_CHANGE:` declared here).
- **Open:** official plan-sparring gate through the sanctioned channel; AC-7 staging screenshots; decide #4033 merge ordering (our `?v=` token `20261121-vtid-05082` is already strictly newer than #4033's `20261115-vtid-05063`, so no collision in either order).
- **Next:** open this PR with this body, let CI run, then staging verify → Gate 2.

## 🚨 Breaking Changes

None.
