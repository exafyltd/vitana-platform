# VTID-03745 — remove the full-duplex mic-live glow ring from the ORB widget

User report (screenshot of the community app's ORB overlay, status text
"Vitana speaking..."): a green glow/ring around the mic button while Vitana
speaks "looks ugly and unnecessary" — asked for it to be removed.

## Root cause

`services/gateway/src/frontend/command-hub/orb-widget.js` is the shared ORB
voice widget script the gateway serves at `/command-hub/orb-widget.js`; the
community app (`exafyltd/vitana-v1`) loads it at runtime for the same voice
overlay shown in the screenshot (`useOrbVoiceWidget.ts` / `orbActivate.ts`
both reference it directly). VTID-03706 (full-duplex barge-in) added a
`.vtorb-btn-mic.vtorb-mic-live` CSS rule —
`box-shadow: 0 0 0 2px rgba(34,197,94,0.85), 0 0 12px rgba(34,197,94,0.45);`
— toggled on the mic button whenever full duplex is active and Vitana is
speaking (`_updateUI()`: `micBtn.classList.toggle('vtorb-mic-live', !muted
&& !!_s.fullDuplex && !!_s.audioPlaying)`). That box-shadow is exactly the
ring in the screenshot.

## Fix

Removed the `.vtorb-btn-mic.vtorb-mic-live` box-shadow CSS rule from the
widget's injected stylesheet (`_injectStyles()`). Left the class-toggle
logic in `_updateUI()` untouched — it is a legitimate full-duplex state
signal other code/tests can still read via `classList.contains(...)`, it
now just carries no visual style. Updated the two adjacent comments that
described/justified the ring so they don't go stale. Bumped the `?v=`
cache-busting query param on the `<script src="/command-hub/orb-widget.js">`
tag in `index.html`, per this repo's own CSS/JS deploy convention (CLAUDE.md
§16, "CSS/JS Cache-Busting").

No JS behavior, full-duplex logic, or barge-in mechanics changed — this is
a pure CSS removal.

---

AC-1 — the `.vtorb-btn-mic.vtorb-mic-live` box-shadow rule no longer exists
in the widget's injected stylesheet

TEST: `node --check` on the edited file (confirms the file still parses as
valid JS after the string-array edit — the CSS lives in a JS string array,
so a `grep`/manual read of the diff is the actual verification of intent;
`node --check` verifies the edit didn't corrupt the surrounding array).
Output: `outputs/node-check.txt`
CURL: `curl -s https://gateway.vitanaland.com/command-hub/orb-widget.js |
grep -c 'vtorb-mic-live {'` should read `0` once this ships — not run from
this session (no live/AWS access, and per CLAUDE.md this is read-only
against a public static asset, not a state-changing call; left as the
post-deploy spot-check for whoever verifies the merge).

AC-2 — the `.vtorb-mic-live` class is still toggled by full-duplex state in
`_updateUI()`, so no JS/test consumer of the class itself regresses

TEST: manual diff review — `micBtn.classList.toggle('vtorb-mic-live', ...)`
line is unchanged, byte-for-byte, in the diff.
Output: `outputs/diff.txt`

AC-3 — no existing test asserts the removed CSS values, so this change
cannot silently break `full-duplex-session-gate.widget-parity.test.ts` (the
suite that already covers `.vtorb-mic-live` class-toggle behavior) or any
other suite

TEST: `grep -rn "box-shadow\|rgba(34,197,94" services/gateway/test/` before
making the edit — zero matches, confirmed via the Grep tool during
investigation (no test file references the removed box-shadow values).
Output: none captured (a negative grep result — re-run:
`grep -rln "box-shadow" services/gateway/test/orb/` if independent
re-confirmation is wanted).

AC-4 — the edited file remains syntactically valid JavaScript

TEST: `node --check services/gateway/src/frontend/command-hub/orb-widget.js`
Output: `outputs/node-check.txt`

AC-5 — the diff introduces no new CSP-relevant pattern (inline `<script>`
without `src`, an inline `style=` attribute, `eval`, `new Function`,
`unsafe-inline`, or a CDN-style `.js`/`.css` URL) in the CSP-governed
surface (`services/gateway/src/frontend/`)

TEST: ran the same check `VALIDATOR-CHECK.yml`'s "CSP Governance Gate" step
runs — `git diff origin/main...HEAD -- 'services/gateway/src/frontend/'
'services/gateway/dist/frontend/'` piped into `node
scripts/ci/validator-path-guard.cjs --csp-added-lines <diff>` — locally,
before pushing.
Output: `outputs/csp-gate.txt`

AC-6 — the changed files (`index.html`, `orb-widget.js`, both under
`services/gateway/src/frontend/command-hub/`) satisfy the `gateway_backend`
VALIDATION_PROFILE's path-ownership allowlist (`services/gateway/src/`)

TEST: ran the same check `VALIDATOR-CHECK.yml`'s "Enforce Path Ownership
Guard" step runs — `node scripts/ci/validator-path-guard.cjs
<changed-files> gateway_backend <pr-body>` — locally, before pushing.
Output: `outputs/path-ownership-guard.txt`

AC-7 — no automated gateway test suite regression

TEST: could NOT be run from this session — `npm ci` fails with `403
Forbidden` fetching package tarballs from `registry.npmjs.org` (metadata
resolution via `npm ci --dry-run` succeeds; the actual tarball download is
blocked by this sandbox's egress policy). See "What could NOT be verified"
below.

---

## What could NOT be verified from this session, and why

**No automated test run (`npx tsc --noEmit`, `npx jest`, `npm run build`).**
`npm ci` fails immediately with `403 Forbidden` on the first package
tarball fetch (`registry.npmjs.org/zod/-/zod-3.25.76.tgz`) — this sandbox's
egress policy blocks the download, though dependency metadata resolution
(`npm ci --dry-run`) does succeed, confirming it is a package-fetch block
specifically, not a total network outage. Without `node_modules`, `tsc`
and `jest` cannot run at all in this session.

Reasoned rather than measured: the edited file (`orb-widget.js`) is a
static, un-typechecked frontend asset — the gateway's `tsconfig.json` has
`"include": ["src/**/*"]` but no `allowJs: true`, so `tsc` only compiles
`.ts` files under `src/`; `.js`/`.html` files are copied verbatim by
`npm run build`'s `copy-frontend` step and never touched by the type
checker. The edit is a pure string-array/CSS removal with no change to any
`.ts` file, so `tsc --noEmit` and `npm run build` are expected to be
unaffected — this is inference from reading `tsconfig.json` and
`package.json`'s `build`/`copy-frontend` scripts, not a confirmed run.

**No live/staging verification.** This session has no AWS or live gateway
access. Per this repo's own staging-first deploy model (CLAUDE.md §16),
merging to `main` auto-deploys to staging
(`preview-aws-gateway.vitanaland.com`) only; production needs a separate
PUBLISH-button promotion. Whoever merges this should do the AC-1 `CURL:`
spot-check above against staging (and prod, post-promotion) to confirm the
ring is actually gone from the served asset.

**No visual/browser screenshot.** This is a CSS-only removal of a rule that
already has no test coverage and a straightforward, auditable diff (one
CSS block deleted, two comments updated, one cache-bust bump) — the
change is small enough that a manual diff read plus the checks above stand
in for a screenshot, consistent with this repo's own "screenshot what you
changed" protocol being aimed at layout/interaction changes rather than a
pure rule deletion with no remaining visual surface to inspect (there is no
UI left to screenshot — the fix's entire effect is the ABSENCE of a ring).

**Net effect:** the removal itself is small, mechanical, and independently
verified by the checks above (syntax validity, CSP scan, path-ownership
scan, and a manual diff read confirming exactly one CSS rule was deleted
and nothing else). The parts that could not be verified from this session
(full test suite, live rendering) are disclosed explicitly rather than
asserted as done.
