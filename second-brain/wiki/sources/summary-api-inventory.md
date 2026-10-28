# Summary: API Inventory

> Summary of the comprehensive VITANA API inventory covering Supabase Edge Functions, frontend hooks, database RPCs, and external integrations.

## Content

### What This File Is

The `API_INVENTORY.md` is a December 2024 codebase scan cataloging every API surface in the Vitana project. It provides structured entries for each API with type, location, methods, request/response shapes, auth requirements, and screen references.

### High-Level Statistics

| Category | Count |
|----------|-------|
| Supabase Edge Functions | 56 |
| Frontend Data Access Hooks | 120+ |
| Database RPC Functions | 32 |
| External Integrations | 5 major |
| **Total Distinct APIs** | **~210+** |

### API Distribution

- Internal (Edge Functions + RPC): 42%
- Frontend Hooks (Supabase queries): 57%
- External SDK Integrations: 2%

### External Integration Summary

| Provider | Purpose | Functions |
|----------|---------|-----------|
| Vertex AI / Gemini | AI chat, voice, analysis | 8 |
| Stripe | Payments, tickets, subscriptions | 4 |
| CJ Dropshipping | Product catalog, orders | 6 |
| Google Cloud TTS | Text-to-speech | 1 |
| LinkedIn/Social | Profile import | 2 |

### Edge Function Modules

The 56 Supabase Edge Functions are organized into modules:

**AI and Intelligence (EF001-EF015):**
- `vertex-live`, `vitanaland-live` -- real-time voice streaming (WebSocket).
- `generate-personalized-plan` -- AI health plans.
- `analyze-patterns` -- health data pattern discovery.
- `generate-memory-embedding`, `reinforce-memory`, `refresh-memory-metadata` -- AI memory.
- `analyze-visual-context` -- multimodal visual AI.
- `generate-autopilot-actions`, `execute-autopilot-action` -- autopilot system.
- `ai-insights`, `analyze-situation` -- general AI insights.
- `generate-daily-matches`, `process-match-interaction` -- matching.
- `translate-text` -- real-time translation.

**Voice and TTS (EF016-EF018):**
- `google-cloud-tts`, `openai-tts` -- text-to-speech synthesis.
- `generate-greeting` -- personalized AI greeting.

**Payments and Commerce (EF019-EF022):**
- `stripe-create-checkout-session`, `stripe-webhook` -- Stripe payments.
- `stripe-create-ticket-checkout`, `stripe-ticket-webhook` -- event ticket checkout.

**Campaign and Distribution (EF023-EF028):**
- `distribute-post`, `queue-campaign-recipients`, `process-campaign-queue` -- campaign processing.
- `og-campaign`, `og-event`, `og-share` -- Open Graph meta tags for sharing.

**CJ Dropshipping (EF029-EF034):**
- `cj-get-token`, `cj-search-products`, `cj-get-product-details` -- product catalog.
- `cj-create-order`, `cj-track-shipment`, `cj-webhook-handler` -- order management.

**Admin and Tenant Management (EF035-EF039+):**
- `bootstrap_admin`, `set_active_tenant`, `list_my_memberships`, `list_super_admins`, `remove_super_admin` -- tenant and admin management.

### Gateway API Routes

In addition to edge functions, the gateway service in vitana-platform exposes routes under `/api/v1/` for:
- Worker orchestrator (register, claim, heartbeat, complete)
- VTID CRUD
- OASIS events
- Governance evaluation
- Operator actions
- Autopilot recommendations

### Auth Patterns

- Most edge functions require JWT authentication.
- Some (OG tag endpoints, webhooks) are public or use signature verification.
- Admin functions require `exafy_admin` or `service_role`.
- The gateway uses dual JWT validation (Platform + Lovable Supabase).

## Related Pages

- [[api-gateway-pattern]]
- [[supabase]]
- [[vitana-v1]]
- [[vitana-platform]]

## Sources

- `raw/architecture/API_INVENTORY.md`

## Last Updated

2026-04-12
