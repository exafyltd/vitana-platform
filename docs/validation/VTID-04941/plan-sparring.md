# Plan sparring record — VTID-04941 (Commerce MCP automation, phase A)

Plan hash (sha256 of the text between the plan markers): `811e7a2a7cfe7af502449421ec94639a2a7a93aac11e6773424c029590df9186`. Partner: plan-sparring-partner, 3 rounds, CONVERGED. Owner approved 2026-10-07 ("approved, run item 3", then "run phase a").

# Plan: make supplier onboarding fully automatable through the Commerce MCP (plug and play)

Planner: Claude Code session (owner: d.stevanovic@exafy.io). Date: 2026-10-07. Follows the Directory-listing plan (sparring record docs/validation/VTID-04938/plan-sparring.md); owner instruction 2026-10-07: "add MCP tools, so user gets plug and play solution, everything must be automated".

<!-- plan:begin -->
## Problem (verified in code)
`evaluateVerification` (`services/gateway/src/services/partner-onboarding-checklist.ts:238`) returns `live` only when every required step is `done`. A supplier working only through the assistant ends in `needs_action` because:
- `verification` and `mapping` have writers but no MCP tool: `routes/partner-onboarding.ts:280` (`POST /:orgId/verification/check`, upsert :374) and `routes/partner-onboarding-connections.ts:110-141,193` (mapping is derived from connection state).
- `tracking_test`, `billing_mandate`, `dpa`, `results_channel` have NO writer anywhere (no route, no service; `routes/partner-onboarding.ts:10-12` says they "land with their own VTID"). No tool can fix a step that nothing can complete.
- Verification level 1 and 2 can never pass today: `business_verification` and `licence` are hard-coded `not_configured` (`services/partner-verification.ts`, `routes/partner-onboarding.ts:355`) pending open spec questions Q2 (Stripe business verification vs VIES + billing mandate) and Q6 (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md:358-368). Only `affiliate_brand` (level 0) is reachable.
- Required steps per type (`services/gateway/src/services/partner-onboarding-checklist.ts:47-53`), each type listed in full: affiliate_brand = account, company, verification, catalogue, mapping, tracking_test, terms. supplier_shop and service_provider = account, company, verification, catalogue, mapping, tracking_test, terms, billing_mandate. practitioner_clinic = account, company, verification, catalogue, mapping, terms, dpa (no tracking_test). lab = account, company, verification, catalogue, mapping, results_channel, terms, dpa (no tracking_test).
- `commerce-mcp.ts:245,267` already lists these as `ON_SCREEN_STEPS`: the assistant returns `done_on_vitanaland` and a portal link.

## Honest scope
"Everything automated" is bounded by backends and owner/legal decisions that do not exist yet. This plan delivers what is buildable now, in order of how many suppliers it unblocks, and turns the rest into an owner decision brief rather than guessing.

## Phases (each its own VTID/PR after owner approval; each tool follows the existing MCP conventions: title + annotations, idempotent or `confirmed=true`-gated, supplier text inside the structured data envelope with the non-instruction note defined in item 3 of the already-sparred Directory plan (`docs/validation/VTID-04938/plan-sparring.md`))
**A. Verification and mapping through MCP (no new backend):**
1. Build on what exists, no parallel extraction and no new near-duplicate file names. The verification rules and I/O already live in `services/gateway/src/services/partner-verification.ts` (pure rules) and `partner-verification-io.ts` (VIES, DNS TXT, meta-tag fetch, SSRF-guarded fetch); only the orchestration (load org, call the I/O, compute, upsert the step row, emit `partner_org.verification_checked`, update `trust_level`) is still inline in `routes/partner-onboarding.ts:280-396`. Move that orchestration into `partner-onboarding-service.ts` as `checkVerification(s, caller, orgId)` (same `Caller`/`ServiceResult` pattern as `startOnboarding`/`updateCompany`/`submitForVerification`), and make the route a thin wrapper. For mapping, `reconcileMappingStep`/`refreshMappingStep` in `routes/partner-onboarding-connections.ts:104-170` are already framework-free: export and reuse them; only the connection-creation orchestration (`POST /:orgId/connections`, :193: load org, detection, insert, event) moves into a `startConnection` function in `partner-onboarding-service.ts`. Same guards, same OASIS events, org-admin authorization expressed through the service's existing `authorize()`.
   SSRF and input safety, two layers (corrected after sparring): (a) fetch time, unchanged and preserved by construction: every outbound website fetch goes through `ssrfGuardedFetch`/`assertPublicHost` in `services/platform-detect.ts:85-154` (used by `partner-verification-io.ts` and `detectPlatform`); (b) store time, NEW defence in depth: `parseCompanyFacts` (`services/partner-lifecycle.ts:133-145`) only checks that the website is a parseable http(s) URL, so `updateCompany` (async) additionally resolves the host with the same `assertPublicHost` and rejects a website that points at loopback, RFC1918, link-local (169.254.169.254), CGNAT or IPv6 equivalents with a clear `invalid_input` error, so an unusable value is never stored and `check_verification`/`connect_store` fail early rather than at detection. The sync `parseCompanyFacts` stays as is. A DNS answer can change after storing, so layer (a) stays authoritative. Tests: `update_business` with each internal address is rejected; a website that resolves public at store time but internal at fetch time (stubbed resolver) is refused by `check_verification` with nothing fetched; redirect-to-internal is refused.
   The existing circular import between `services/partner-onboarding-service.ts:33` and `routes/partner-onboarding.ts:36-40` (data-access helpers `loadOrg`, `loadChecklist`, `makeOrgKey`, `OrgRow`, `Supa` live in the route file, and `commerce-mcp.ts:44` imports them too) is acknowledged: this plan adds no new cycle (`checkVerification` needs only `loadOrg` and `Supa`, already imported). Moving those helpers into a service module is DEFERRED to a follow-up VTID (tracked as a note in this plan's record) so Phase A stays reviewable.
2. New tools: `check_verification` (runs the existing checks; returns per-check status and, when the domain proof fails, the exact DNS TXT record or meta tag to publish plus `next_action`; it is synchronous with a hard overall budget of 10 s and returns partial results with a per-check `pending`/`timed_out` status and `retry_after` instead of blocking, because VIES alone allows up to 8 s), and `connect_store` (runs platform detection for the website and starts the connection for the detected connector; for connectors that need the supplier's consent it returns the Vitanaland portal link for that connection, never a raw third-party OAuth URL, so the assistant cannot be used to relay a phishing URL and state tokens stay inside the portal; it returns the mapping state).
3. `get_onboarding_status` already returns `next_step` (checklist.ts:223, surfaced by `shapeStatus`, commerce-mcp.ts:259). It keeps `next_step` and gains a structured `next_action` that wraps it: `{ step, tool: <tool the assistant can call or null>, supplier_action: <what only the supplier can do: publish a DNS TXT, sign, authorise a mandate, or null>, link: <portal link or null> }`, derived from the checklist, so the assistant never has to guess.
4. Tests: jest per tool (auth, wrong-org 404-equivalent, idempotency, SSRF guard preserved, envelope), staging suite lists the MCP suite.

**B. Tracking test backend + tools (unblocks affiliate_brand, supplier_shop and service_provider as far as tracking goes; labs and clinics have no tracking_test). Gated on its own plan: Phase B gets its own plan, sparring and owner approval before any VTID; Phase A proceeds independently:** design per spec §8.3 (a signed test event with a matching click id arrives from the partner's platform); `start_tracking_test` returns the test link/id, `get_tracking_test_status` polls; the step turns `done` only on a verified event. Requires its own sparred design for the signature scheme and replay protection before code.

**C. Owner decision brief (no code):** `billing_mandate` (Stripe SetupIntent, spec §9.2 / Q2), `dpa` (e-signature method), `results_channel` (lab test file + channel), and level-1/2 business and licence verification (Q2, Q6). For each: the options, what the assistant can automate, what only the supplier can do (signature, bank mandate, Stripe-hosted onboarding, document upload), cost/legal consequences, and a recommendation. The assistant's role for human-only actions is one link plus a status poll, never collecting secrets or signatures itself. Stripe's own MCP connector is not authorized in this environment and is out of scope.

## Order and outcome
A first (every type benefits, no new backend), then B (an affiliate brand reaches `live` with no portal visit except accepting the Partner Terms on Vitanaland, which the spec requires, plus any DNS or hosting change the domain proof needs when the email domain does not match the website, which happens outside both the portal and the assistant), then C decisions unlock D phases for shops, clinics and labs. Known limitation, stated to suppliers and in the directory listing: until the Stripe/e-signature decisions in C land (they are open spec questions Q2 and Q6 and could take a long time), shops, service providers, clinics and labs cannot reach `live` through the assistant alone and finish those steps in the portal; the assistant tells them exactly which step and gives the link.

## Out of scope
Changing which steps are required per type, relaxing verification levels, accepting Partner Terms on a supplier's behalf (spec D1: the supplier accepts on Vitanaland), any change to Discover gating, the directory submission itself, and code for phase C.

## Change class
standard (gateway services/routes extraction, new MCP tools, auth-adjacent).

## Scope
vitana-platform: `services/gateway/src/services/commerce-mcp.ts`, `services/gateway/src/services/partner-onboarding-service.ts` (new `checkVerification`, `startConnection`), `routes/partner-onboarding.ts` and `routes/partner-onboarding-connections.ts` (thin wrappers), tests, `docs/validation/<VTID>/`, `docs/DATABASE_SCHEMA.md` if phase B adds tables.
<!-- plan:end -->

## Planner responses — round 1
- F1 [major] ACCEPTED — no new near-duplicate file; the verification rules/IO stay in `partner-verification.ts`/`partner-verification-io.ts`; only the orchestration moves into `partner-onboarding-service.ts` as `checkVerification`.
- F2 [major] ACCEPTED — each type's required steps are now listed in full (labs and clinics have no tracking_test); Phase B scope reworded; "zero portal visits" replaced by the accurate statement incl. the external DNS/hosting action.
- F3 [major] ACCEPTED — SSRF guard preserved by construction (`ssrfGuardedFetch` in the IO module), website validated by `parseCompanyFacts`/`updateCompany`, and tests drive internal-IP and redirect websites through `update_business` then `check_verification`.
- F4 [minor] ACCEPTED — `reconcileMappingStep`/`refreshMappingStep` are reused; only connection-creation orchestration moves.
- F5 [minor] ACCEPTED — Phase A explicitly extends `partner-onboarding-service.ts` with the `Caller`/`ServiceResult` pattern.
- F6 [minor] ACCEPTED — full repo-relative paths used.
- F7 [minor] ACCEPTED — Phase B is stated as gated on its own plan and sparring; Phase A proceeds independently.
- F8 [minor] ACCEPTED — `next_action` is a structured wrapper around the existing `next_step`; shape specified.
- Q1: `check_verification` has a 10 s overall budget and returns partial per-check status with `retry_after`. Q2: `connect_store` returns the portal link, never a raw third-party OAuth URL. Q3: the long-limitation is stated explicitly (plan and directory listing). Q4: the reference now names the sparred record `docs/validation/VTID-04938/plan-sparring.md` item 3.

## Planner responses — round 2
- F9 [major] ACCEPTED (option B) — the plan text is corrected: `parseCompanyFacts` is URL-format only; the guard is `assertPublicHost` at fetch time (authoritative) and a NEW store-time check in `updateCompany` (defence in depth) with the tests listed in Phase A.1. The "Q1" case (internal website stored, then `connect_store`) is now rejected at store time and still fails safely at fetch time.
- F10 [minor] ACCEPTED/DEFERRED — the existing cycle is acknowledged; no new cycle is added; moving the helpers is a follow-up VTID.

## Round 3 — partner status
F1-F10 closed. No new blocker or major. Questions: none.

## Verdict
CONVERGED after 3 rounds (standard class, cap 3). Awaiting owner approval.

## Implementation notes (deviations recorded while building; none widen the sparred scope)
- `startConnection`'s reuse-existing behaviour is opt-in (`reuseExisting`), so the portal route keeps its exact behaviour; only the MCP passes it.
- The shared SSRF guard `assertPublicHost` (services/platform-detect.ts) is hardened: it now judges bracketed IPv6 literals and IPv4-mapped addresses in hex form (`::ffff:7f00:1`), which `new URL` produces. Before, a bracketed host only failed closed because the DNS lookup of `[::1]` errored. Tests pin this (vtid-04941-verification-service.test.ts).
- `ON_SCREEN_STEPS` no longer lists `verification` and `mapping` (tools exist now); `terms`, `tracking_test`, `billing_mandate`, `dpa`, `results_channel` stay on-screen.
