# VTID-04954 — Plan sparring record

- Plan Sparring Gate: VTID-04868. Partner: `plan-sparring-partner` (independent, read-only), one agent across both rounds.
- Change class: light. Rounds: 2.
- Final plan hash: `5ed468e4e837da55e1d1cce68dadadb13d7464a660500291749fb7a92a070886`
- Verdict: **converged**.
- Owner approval: 2026-10-07 in session — "both approved, proceed" (Gate 1, Autonomy Contract VTID-04947).

## Final plan

<!-- plan:begin -->
## Problem (owner report, 2026-10-07, production)
On /command-hub/partner-review.html (VTID-04933):
1. The page cannot be scrolled with the keyboard or the wheel; the Decision section is only reachable by zooming out.
2. After Approve the confirmation banner is inserted at the top of the detail panel, out of view, so a successful
   action looks like nothing happened (the owner clicked Approve twice; the second call re-recorded the same approval).
3. When the Command Hub sign-in token has expired the page shows a bare "Could not load: UNAUTHENTICATED".

## Root causes (verified)
1. The page loads the shared `styles.css`, whose `body` rule sets `height: 100vh; overflow: hidden` (styles.css ~:53-61,
   built for the app shell). The standalone page inherits it.
2. `act()` in partner-review.js reloads the detail and prepends the banner to `#pr-detail`; nothing scrolls it into view
   and nothing prevents a second click while the first request is in flight.
3. partner-review.js reads `localStorage['vitana.command_hub.token']` (never written by anything) then
   `vitana.authToken`, which only the main Command Hub (app.js) refreshes; the page has no refresh and no 401 message.

Change class: **light** (3 frontend files + the ownership-guard allowlist entry; no routes, auth logic, migrations).

## Change
1. partner-review.html: `<body class="pr-page">`. partner-review.css: `body.pr-page { height: auto; min-height: 100vh;
   overflow: auto; }` — overrides the shared rule for this page only; styles.css untouched (app shell unaffected).
2. partner-review.js `act()`: before the request, disable every `button` inside the detail panel (Decision buttons and
   the per-offering Keep offline / Allow listing buttons); re-enable them on error (on success the panel is rebuilt).
   After the response, show the banner in a status area that is `position: sticky; top: 0` inside `.pr-container`
   (role="status", aria-live polite, z-index above content), so it never covers the header controls and stays visible
   while the page scrolls; it stays until the next action, and the detail panel is scrolled into view. Approve/keep-offline/allow-listing banners name
   what happened ("Approved — verification level 1. State: needs_action. Still open: …").
3. 401 handling, in the shared `call()` wrapper so it covers the initial `loadList()`, `loadDetail()` and every action:
   read `vitana.authToken` only (drop the never-written `vitana.command_hub.token`); no token at all → "Sign in to the
   Command Hub in this browser first" with a link; on any 401 show "Your Command Hub sign-in has
   expired. Open the Command Hub in this browser to sign in again, then press Refresh." with a link to /command-hub/.
   No token refresh logic is copied from app.js (rotation races between tabs, VTID-04259) — the page stays a reader of
   the hub's token.
4. Bump the `?v=` on the page's css/js links to `<date>-<this fix's VTID>`.
5. scripts/ci/command-hub-ownership-guard.js: add this fix's own VTID to the allowlist, following the existing VTID-04933 entry.

## Tests
- Jest (existing style of command-hub static tests): the page sets `class="pr-page"`, the css overrides overflow for
  body.pr-page, js has no innerHTML with data, no inline script/style, reads only `vitana.authToken`, handles 401 with
  the sign-in message, disables buttons during a request.
- Staging (read-only): page and versioned css/js served; css contains the override; js contains the 401 message.
- Visual: Playwright screenshot of the page shell on staging (unsigned → 401 message visible, page scrolls) at desktop
  and mobile widths; no sign-in, no writes.

## Out of scope
Any API or data change; token refresh; the B3/B4 checklist rules (separate plan); changing the shared styles.css (the
app shell relies on its body rule). Noted for a follow-up: jev.html and voice-budget.html share the scroll lock, and
jev.js/voice-budget.js read only the never-written `vitana.command_hub.token`, so they always call without a token.
<!-- plan:end -->

## Round 1 — partner (verbatim)

## Verified premises

- **"body rule sets height: 100vh; overflow: hidden (styles.css ~:53-61)"** --> TRUE -- `styles.css:53-61` has exactly `height: 100vh;` (line 59) and `overflow: hidden;` (line 60). The standalone page inherits these because `partner-review.html:7` loads `styles.css`.

- **"act() in partner-review.js reloads the detail and prepends the banner to #pr-detail; nothing scrolls it into view and nothing prevents a second click"** --> TRUE -- `partner-review.js:91-96`: on success, `act()` calls `loadDetail(selectedId, msg)`, which clears and rebuilds the detail then inserts the banner at the top of the detail panel (`partner-review.js:104`). No `scrollIntoView()` or equivalent exists anywhere in the file. No button-disabling logic exists; a second click while the first fetch is in-flight is unrestricted.

- **"partner-review.js reads localStorage['vitana.command_hub.token'] (never written by anything)"** --> TRUE -- `partner-review.js:11` reads `vitana.command_hub.token` first, falling back to `vitana.authToken`. Grep of the entire `command-hub/` directory shows `vitana.command_hub.token` is only ever READ (by `jev.js:9`, `partner-review.js:11`, `voice-budget.js:8`) and never written. `app.js` writes only `vitana.authToken` (lines 125, 1953, 36032). The first key is dead on read.

- **"the page has no refresh [of the token] and no 401 message"** --> TRUE -- `partner-review.js` has no token-refresh logic and no 401-specific handling. Lines 57 and 105 display a generic "Could not load: " + error string for any failure, including 401.

## Findings

F1 [minor] Plan step 5 references the wrong VTID -- "same pattern as VTID-04933"

Evidence: The plan says "add the new VTID to the allowlist (same pattern as VTID-04933)." VTID-04933 is the VTID that created partner-review itself (`command-hub-ownership-guard.js:31-32`). The sentence reads as if VTID-04933 is a prior allowlist entry to copy the pattern from, when it is actually the page being fixed. This is cosmetic/confusing, not functionally wrong, but the actual "new VTID" (the one for this fix, not yet allocated) is what needs adding.

Suggestion: Clarify: "add this fix's own VTID to the allowlist, following the same pattern as the existing VTID-04933 entry."

F2 [minor] Disabling "the clicked action buttons" is under-specified -- per-offering buttons also need it

Evidence: `partner-review.js:150-167` creates per-offering "Keep offline" and "Allow listing" buttons that also call `act()`. The plan says "disable the clicked action buttons while the request runs" but only references the Decision section buttons. The per-offering buttons have the same double-click race.

Suggestion: Specify that `act()` itself disables all `button` elements inside the detail panel (or at minimum the triggering button + all sibling action buttons) before the fetch, and re-enables them in both the success and error branches. A central guard in `act()` is simpler than per-call-site logic.

F3 [minor] Sibling standalone pages (jev.js, voice-budget.js) have the same or worse problems

Evidence: `jev.js:9-14` reads ONLY `vitana.command_hub.token` (never falls back to `vitana.authToken`), so it gets an empty token 100% of the time. Both pages also inherit the `overflow: hidden` from `styles.css`. These are out of scope for this plan but worth flagging so the planner knows the pattern repeats.

Suggestion: No change to this plan; note in Out-of-scope that jev.html and voice-budget.html have the same scroll and auth bugs for a follow-up.

F4 [minor] The fixed-position toast may overlap the header controls on short viewports

Evidence: The plan says "render the banner as a fixed-position toast-style message at the top of the viewport." On a mobile viewport (390x844), a fixed-top banner can overlap the State dropdown and Refresh button (`partner-review.css:5-6`), especially since the page will now be scrollable.

Suggestion: Add top padding/margin to the page body (or the `.pr-container`) equal to the toast height when a toast is visible, or position the toast below the header instead of at viewport top. Alternatively, use `position: sticky` inside `.pr-container` with a high z-index so it scrolls with the page but stays above content.

F5 [minor] The plan mentions no 401 handling for the initial `loadList()` call

Evidence: `partner-review.js:208` calls `loadList()` on page load, which hits `GET /api/v1/admin/partner-review/`. If the token is expired at page-load time, line 57 shows "Could not load: UNAUTHENTICATED" (generic). The plan's 401 handling description (step 3) focuses on "on any 401" generically but the implementation guidance only references a "sign-in expired" message. The initial load is the primary place users will see this, not just action requests.

Suggestion: Ensure the 401-specific message with the Command Hub link fires in `loadList()` and `loadDetail()` as well, not only in `act()`. A shared 401 handler wrapping `call()` is the cleanest approach.

## Questions for the planner

1. The `?v=` on the CSS/JS links in `partner-review.html` currently reads `20261007-VTID-04933-review`. Will the new value use the fix's own VTID (e.g., `20261007-VTID-XXXXX-review-fix`), or bump the date portion? This matters because CDN/browser caches key on the full query string.

2. The plan says "styles.css untouched (app shell unaffected)." Have you verified that no other standalone page (jev.html, voice-budget.html, orb-voice-bench.html) relies on `body { overflow: hidden }` for correct layout? If any of them do, the `body.pr-page` scoping approach is correct; if none do, a simpler `body { overflow: auto }` in styles.css itself might be the right fix for all standalone pages.

3. Should the 401 handler distinguish between "no token at all" (user opened the page directly, never signed in) and "token expired" (user was signed in, token timed out)? The current plan uses a single message for both cases, which is adequate but may confuse a user who has never opened the Command Hub at all.

## Verdict

CONVERGED -- No blockers or majors. All five findings are minor (cosmetic wording, under-specification of edge cases, and suggestions for completeness). The plan's three root causes are verified correct against the code, the proposed fix approach is sound and scoped, and the design respects the governance rules (no inline styles/scripts, CSP compliance, no production writes in tests, ownership guard updated, read-only staging verification). The plan is ready for owner approval.

## Planner responses — round 1
- F1 ACCEPTED — wording fixed: this fix's own VTID, following the VTID-04933 entry.
- F2 ACCEPTED — act() disables every button in the detail panel, including per-offering ones.
- F3 DEFERRED — out of scope here; recorded in "Out of scope" as a follow-up (jev/voice-budget scroll + token key).
- F4 ACCEPTED — banner is sticky inside .pr-container, not fixed to the viewport.
- F5 ACCEPTED — 401 handling lives in the shared call() wrapper, covering list, detail and actions.
- Q1: ?v= becomes <date>-<new VTID>. Q2: styles.css stays untouched; the app shell depends on its body rule, so the override is page-scoped. Q3: accepted — "no token" and "expired" get different messages.

## Round 2 — partner (verbatim)

## Round 1 findings — status

- F1 [minor] Ownership guard VTID wording --> **closed** — plan step 5 now reads "add this fix's own VTID to the allowlist, following the existing VTID-04933 entry." Clear.
- F2 [minor] Per-offering buttons also need disabling --> **closed** — plan step 2 now says "disable every button inside the detail panel (Decision buttons and the per-offering Keep offline / Allow listing buttons)." Explicit and complete.
- F3 [minor] Sibling standalone pages share the same bugs --> **closed** — recorded in the revised Out-of-scope section with the specific symptoms (scroll lock + never-written token key). Adequate for a follow-up.
- F4 [minor] Fixed-position toast overlapping header --> **closed** — changed to `position: sticky; top: 0` inside `.pr-container`. This stays below the header and scrolls naturally with the page. The `.pr-container` structure (`partner-review.css:2`, `partner-review.html:11`) supports a sticky child correctly.
- F5 [minor] No 401 handling for initial loadList() --> **closed** — plan step 3 now specifies "in the shared call() wrapper so it covers the initial loadList(), loadDetail() and every action." The dual message for "no token" vs "expired" is also addressed per the Q3 response.

## Verified premises (round 2 — checking revisions against the code)

- **"call() is the shared wrapper for all API requests"** --> TRUE — `partner-review.js:41-49` defines `call()` and every API interaction (`loadList` at line 55, `loadDetail` at line 102, `act` at line 91) goes through it. Adding 401 handling here covers all three code paths.

- **"j._status captures the HTTP status code"** --> TRUE — `partner-review.js:45-46` sets `j._status = r.status` on every response, so distinguishing 401 from other errors in `call()` is straightforward without changing the fetch logic.

- **".pr-container supports a sticky child"** --> TRUE — `partner-review.html:11` wraps the entire page in `<div class="pr-container">`, and `partner-review.css:2` gives it `max-width: 1280px; margin: 0 auto; padding: 24px 16px;`. With `body.pr-page { overflow: auto }`, the body becomes the scroll container and a `position: sticky; top: 0` element inside `.pr-container` will stick correctly at the viewport top while scrolling.

## Findings

No new blockers or majors. The revisions are internally consistent and all round-1 items are resolved.

## Questions for the planner

None.

## Verdict

CONVERGED — All five round-1 findings are closed. The revised plan is consistent with the code, the 401 handling is correctly scoped to the shared `call()` wrapper, the sticky banner approach is structurally sound given the page's DOM, and the out-of-scope items are recorded for follow-up. Ready for owner approval.
