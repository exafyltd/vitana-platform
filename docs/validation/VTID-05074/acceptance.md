# VTID-05074 — public privacy, terms and support pages for the Vitanaland ChatGPT plugin listing

Owner decision 2026-10-12 ("Yes, go ahead", Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED). Problem: OpenAI's plugin portal failed the draft's automated checks: privacy policy "not accessible" (its fetcher does not run JavaScript; the app's /privacy and /terms are client-rendered), subtitle over 30 characters, no Support URL. The app's own /privacy and /terms are the Maxina mobile app's documents.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: services/gateway/src/index.ts mounts a new router at /legal/vitanaland-commerce (owner `commerce-plugin-legal`), next to the Commerce MCP mounts.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/legal/vitanaland-commerce/privacy (staging, read-only GET).

OASIS_PROOF: not applicable. The router serves three constant, read-only HTML pages: no state changes, no decisions, no user input, nothing to record (the route files carry no OASIS emission by design). Request volume is covered by the gateway's normal access logs.

CURL_PROOF: staging returns 200 `text/html; charset=utf-8` for `/legal/vitanaland-commerce/privacy`, `/terms` and `/support`, each containing its heading; any other path or method answers 404.

## Acceptance criteria

AC-1: `GET /legal/vitanaland-commerce/{privacy,terms,support}` return 200 static English HTML with `Cache-Control: public, max-age=300`, and each page has its heading.
  TEST: services/gateway/test/commerce-plugin-legal.test.ts
AC-2: The pages contain no script, inline style, event handler, external resource or form, and never mention the Maxina app.
  TEST: services/gateway/test/commerce-plugin-legal.test.ts
AC-3: The pages are always on: the Commerce MCP switches do not affect them. Nothing in the request (query, headers) changes the page.
  TEST: services/gateway/test/commerce-plugin-legal.test.ts
AC-4: Unknown paths and any method but GET answer 404; the router is mounted under `/legal/vitanaland-commerce` beside the unchanged `/mcp` and `/.well-known` mounts.
  TEST: services/gateway/test/commerce-plugin-legal.test.ts
AC-5: The plugin package (both layouts) points the privacy, terms and support URLs at these pages and has a subtitle of at most 30 characters ("Onboard your business").
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts

## Limits
- The field name `supportURL` is a best guess from OpenAI's portal wording ("Support URL is required"); if the portal does not read it from the package, the owner sets it in the portal's metadata screen. The portal's category check ("Productivity") is an owner choice made in the portal.
- Jest cannot run in the build session (registry blocked); CI is the first run. The page markup was rendered locally with a stubbed router and checked for the forbidden elements.
- Out of scope: vitanaland.com's own /privacy and /terms (Maxina documents, including the `&amp;` heading), MCP tools, sign-in, allow-list.
