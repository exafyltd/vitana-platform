# VTID-04840 — Vitana sets up a supplier's business by voice

Slice 3 of the AI-first Commerce setup (owner decisions 2026-10-02: AI setup is
primary; Vitana is in-app; voice only drafts — the supplier confirms the review
card with ONE tap and only that tap writes; the owner runs the end-to-end test
on staging). Builds on VTID-04838 (`/api/v1/commerce/ai-setup`).

VALIDATION_PROFILE: gateway_backend

OASIS_IMPACT: no — the voice tool only drafts; the write and its
`commerce.ai_setup.applied` event stay in VTID-04838's apply endpoint.

## Acceptance criteria

AC-1: `draft_business_setup` is declared on the authenticated commerce surface only, and only when COMMERCE_AI_SETUP_ENABLED is exactly "true"; off, every catalog is unchanged (the VTID-04542 payload snapshots stay byte-identical).
  TEST: services/gateway/test/vtid-04840-commerce-setup-opening.test.ts
  TEST: services/gateway/test/orb/live/commerce-surface.test.ts
  TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts
AC-2: The tool returns at once (inside the 3 s voice tool budget), drafts in the background and hands the draft to the screen as `orb_directive: commerce_setup_draft` (or `commerce_setup_draft_failed` with an error code); a second call while reading starts nothing new.
  TEST: services/gateway/test/vtid-04840-commerce-setup-opening.test.ts
AC-3: Voice writes nothing: the module never calls apply; it refuses off the commerce surface, when signed out, when switched off and for a non-website, and shares the 10-per-hour draft limit with the portal endpoint.
  TEST: services/gateway/test/vtid-04840-commerce-setup-opening.test.ts
  TEST: services/gateway/test/commerce-ai-setup.test.ts
AC-4: Opened from the setup sheet (`commerce_setup: true`, first turn only, switch on), the commerce opener asks for the website as an English INTENT naming the tool — no scripted sentence (NEVER rule 41); every other opener is unchanged.
  TEST: services/gateway/test/vtid-04840-commerce-setup-opening.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
AC-5: The widget exposes `VitanaOrb.startCommerceSetup()` (one-shot `commerce_setup` on the next session start) and forwards the three directives as `vitana:commerce-setup-reading|draft|failed` window events; once a draft is there it lets the current sentence finish and closes the full-screen orb so the review card underneath is visible.
  TEST: docs/validation/VTID-04840/staging-tests.json (deployed widget body)

## Scope

- New: `services/gateway/src/orb/live/tools/commerce-setup-tool.ts`, `services/gateway/src/services/commerce-ai-setup-flag.ts`, the Jest suite, this evidence pack and the staging suite.
- Changed: tool catalog commerce gate, `orb-live.ts` tool switch + session field, session start (`commerce_setup`), session profile + greeting decision (commerce setup opener), the draft limiter moved from the route into the service (shared with voice), `orb-widget.js` (+ Command Hub `?v=` bump, ownership-guard allowlist).
- The commerce persona is unchanged; the guidance lives in the tool description and the opener intent, so nothing changes while the switch is off.
- Not on the cascade or the Vertex bridges: commerce sessions run on Nova (de/en); the cascade allowlist is pinned and stays as is.
