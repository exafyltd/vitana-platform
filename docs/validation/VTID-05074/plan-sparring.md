# Plan sparring record - VTID-05074

Plan hash (sha256 of the text between the plan markers): `4622bb8af0abf3d4943eae706489693774d30550225704186a497bfad5999fff`. Partner: plan-sparring-partner (read-only, independent, Claude Opus on Bedrock per CLAUDE.md rule 53), 2 rounds, CONVERGED (standard class). Owner approval: in session 2026-10-12, "Yes, go ahead" in answer to the Gate 1 message (final plan, both rounds' findings, the draft page wording, the files, the test plan). The gate is in log mode; the session is recorded here and in the ledger row.

Round 2 (partner, summary): F1-F6 closed; F2 closed after re-verifying against origin/main (round 1 had read a stale checkout); no new blocker or major findings; verdict CONVERGED.


Change class: standard
Repo: exafyltd/vitana-platform (gateway) with a small package edit in integrations/chatgpt-plugin/vitanaland/
Scope (files): services/gateway/src/routes/commerce-plugin-legal.ts (new), services/gateway/src/index.ts (one mount line), services/gateway/test/ (new test file; plus the existing vtid-04980-chatgpt-plugin-package.test.ts, whose legal-URL host assertion and field list change), integrations/chatgpt-plugin/vitanaland/plugin.json and .codex-plugin/plugin.json (URLs, subtitle), docs/validation/<VTID>/*

<!-- plan:begin -->
## Problem (verified)
1. The OpenAI plugin portal's automated checks fail on our draft: "privacy policy website is not accessible" (the portal's own fetch; it works in a normal browser), "subtitle must be 30 characters or fewer" (ours is 34), "Support URL is required", "category could not be confirmed".
2. The listing points at https://vitanaland.com/privacy and /terms. Those pages are the Maxina mobile-app documents (`vitana-v1/src/pages/legal/PrivacyPolicy.tsx`; its title string is "Datenschutzerklärung | Maxina Mobile App" in `vitana-v1/src/i18n/de/screens.json:9910`, German by default). The terms page body heading shows a raw `&amp;` (i18n key `maxinaAppAmpWebsiteTermsUse`). Neither mentions suppliers, the Commerce Portal or AI assistants. They are client-rendered SPA routes, so a fetcher that does not run JavaScript sees no policy text.
3. The plugin is served from gateway.vitanaland.com, the domain OpenAI verifies. The gateway already serves public text on /.well-known (`routes/commerce-mcp.ts:86`, mounted at `index.ts:1198`).

## Change
A. New public, read-only, unauthenticated router `commerce-plugin-legal.ts` mounted at `/legal/vitanaland-commerce`:
   - `GET /privacy`, `GET /terms`, `GET /support`: static English HTML (200, `text/html; charset=utf-8`), no JavaScript, no inline styles or scripts, no external resources, `Cache-Control: public, max-age=300`, `X-Robots-Tag` unset so the pages stay indexable.
   - Pages are plain semantic HTML built from constants in the router file (no database, no env, no user input, nothing reflected).
   - Served regardless of the Commerce MCP switches (`COMMERCE_MCP_ENABLED`, `COMMERCE_MCP_CHATGPT`, both present on origin/main in `routes/commerce-mcp.ts`); legal pages must not disappear with a feature switch. Mounted as its own router in `index.ts`, next to the `/mcp` and `/.well-known` mounts, not added to an existing router.
B. Page content (drafted below, owner approves wording at Gate 1; it makes no legal claim beyond what the code does):
   - Privacy: who runs it (EXAFY LTD, Vitanaland); what the assistant tools can read and write for the signed-in supplier (business name and type, company details, products and services as hidden drafts, verification check results, onboarding status); what ChatGPT receives (only what the tools return); what is never handled in chat (passwords, identity documents, bank or payment details, Partner Terms acceptance); sign-in uses the supplier's own Vitanaland account (OAuth), the assistant gets a delegated token limited to the Commerce tools; how to disconnect (revoke the connection in ChatGPT and in the Vitanaland account); contact via the support page; a link to the general Vitanaland privacy policy for everything else.
   - Terms: the plugin is a convenience for suppliers; the supplier stays responsible for what they submit; the assistant cannot accept the Partner Terms or submit without the supplier's confirmation; Partner Terms and billing are accepted on Vitanaland; link to the Partner Terms and general terms.
   - Support: short page with how to get help and the support contact. The contact is the existing Commerce portal page https://vitanaland.com/commerce unless the owner names an address at Gate 1.
C. Package edits: `privacyPolicyURL`/`termsOfServiceURL` point to the new pages on gateway.vitanaland.com; add the support URL field; `shortDescription` becomes "Onboard your business" (21 characters); category set to the portal's closest commerce/business value (decided in the portal's own list; unverified here).
D. Tests (Jest, in the gateway job): each route returns 200 `text/html`, contains required headings and no `<script`, no `style=`, no `onclick`; unknown path under the prefix returns 404; the router has no auth requirement and no write methods (POST returns 404/405); the existing `vtid-04980-chatgpt-plugin-package.test.ts` is updated: its legal-URL assertion (line 38, `^https://vitanaland.com/`) accepts the website URL on vitanaland.com and the privacy, terms and support URLs on `https://gateway.vitanaland.com/legal/vitanaland-commerce/`, its field list (line 34) gains `supportURL`, and a new assertion pins `shortDescription` length <= 30; `/mcp` and `/.well-known` behaviour untouched (existing VTID-04990 tests stay green).
E. Staging: add the three paths to this change's `staging-tests.json` (read-only GETs against the staging gateway). After merge, STAGING-VERIFY, then Gate 2.

## Non-goals
No change to vitanaland.com's own /privacy and /terms (the Maxina documents and the `&amp;` bug are a separate frontend ticket, reported to the owner). No change to MCP tools, OAuth, the allow-list or the loopback logic. No production write outside the normal staging-first deploy.

## Risks and rollback
- A wrong or over-broad statement in the policy text is the main risk: wording is owner-approved at Gate 1 and avoids unverified retention claims by pointing to the general policy.
- Route collision with an existing `/legal` mount: checked in the plan step by the partner; the router mounts only under `/legal/vitanaland-commerce`.
- Rollback: revert the PR (routes only; the package files are separate and re-uploadable).
<!-- plan:end -->

## Test plan
Jest unit tests as in D; local lint/typecheck as available (jest/tsc may be unavailable locally, CI is the first run); read-only staging GETs in STAGING-VERIFY.


## Planner responses (round 1)
Note: the partner's checkout was stale. /home/user/vitana-platform was a detached HEAD at the VTID-04980 merge (9c92455e), before the VTID-04990 merge (PR #3964). The planner moved the checkout to origin/main (97bfacc1) before answering; findings F2 and the "04990 tests" claim came from the stale tree.
- F1 [major]: ACCEPTED. The assertion at test line 38 requires `^https://vitanaland.com/`. Plan section D now lists the 04980 test in scope and states the exact edits. The VTID reference in the plan was to the 04990 test file for `/mcp` behaviour, which exists on origin/main; both files stay in scope.
- F2 [major]: REJECTED as a factual error. `COMMERCE_MCP_CHATGPT` exists on origin/main (`routes/commerce-mcp.ts`, 3 matches; merged in PR #3964 under VTID-04990), and the staging workflow pins it. The wording is now explicit that both switches exist and that the legal pages ignore them.
- F3 [minor]: ACKNOWLEDGED. No change; the pages have no scripts, inline styles or external resources and the tests assert that.
- F4 [minor]: ACCEPTED. Title quoted exactly in the plan.
- F5 [minor]: ACCEPTED. The `&amp;` is in the terms body heading, not the SEO title; plan corrected (it remains a non-goal).
- F6 [minor]: ACCEPTED. `supportURL` added to the 04980 test's field list, per section D.
- Q1: separate router mounted in `index.ts` beside the existing `/mcp` and `/.well-known` mounts (line numbers re-read on origin/main by the implementer); no gating.
- Q2: the category is an owner decision at Gate 1; the package keeps "Productivity" until the owner names the portal value.
