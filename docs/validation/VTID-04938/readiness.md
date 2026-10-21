# VTID-04938 — Readiness verification: Commerce MCP in the Claude Connectors Directory

Read-only, code and docs only. Nothing was run against production.

## 1. Claude callback URLs and OAuth client registration — NOT proven by code; owner re-check needed
- The MCP is a resource server only; sign-in is Supabase Auth's OAuth 2.1 server (`routes/commerce-mcp.ts`, `authorizationServer()`), which does dynamic client registration (clients send their own `redirect_uris`). Nothing in either repo keeps a redirect allow-list for the MCP (`grep` for `auth_callback`/`uri_allow_list` finds only a vitana-v1 unit-test fixture using `https://claude.ai/api/mcp/auth_callback`).
- A real Claude connection to staging was run by the owner on 2026-10-05 (VTID-04882 acceptance) and failed on the `openid` scope; the fix (scopes `email profile`) is shipped, and VTID-04882 records that the owner re-runs the real connection once. This session found no recorded successful end-to-end run, for `claude.ai`, `claude.com` or Claude Code loopback callbacks.
- **Action for the owner (one human check, no code):** after the sandbox is live, connect once from claude.ai (and once from the `claude.com` host if reachable) and confirm sign-in and consent complete. Supabase DCR needs no per-URL registration by us.

## 2. What a pure-MCP organisation can reach — it cannot reach `live` today
`evaluateVerification` (`partner-onboarding-checklist.ts:238`) returns `live` only when every required step is `done`; otherwise `needs_action`. Required steps per type (`REQUIRED_BY_TYPE`, lines 47-53):

| Type | Required steps |
|---|---|
| supplier_shop, service_provider | account, company, verification, catalogue, mapping, tracking_test, terms, billing_mandate |
| affiliate_brand | account, company, verification, catalogue, mapping, tracking_test, terms |
| practitioner_clinic | account, company, verification, catalogue, mapping, terms, dpa |
| lab | account, company, verification, catalogue, mapping, results_channel, terms, dpa |

Which of these an assistant can complete with the 7 existing tools:
- account: automatic. company: `update_business`. catalogue: `add_product`/`update_product` (synced). terms: the supplier accepts on the website (link in every status result).
- verification: written only by the portal route `routes/partner-onboarding.ts:300,377`; no MCP tool.
- mapping: written only by `routes/partner-onboarding-connections.ts:117,127`; no MCP tool.
- tracking_test, billing_mandate, dpa, results_channel: no MCP tool and no gateway writer found outside the portal flows.

**Consequence:** a supplier who does everything through the assistant ends in `needs_action`, never `live`; products stay hidden drafts by design (migration 20261001120000). For the Directory listing the connector must therefore describe itself honestly ("register and prepare; finish verification in the portal") or the plan gains an item that exposes `verification`/`mapping`/`tracking_test` through MCP tools (each is a write to a verification step and needs its own sparred plan). This is raised to the owner as a scope decision; it does not block the listing itself.

## 3. Icon
- `public/brand` in vitana-v1 holds only `vitana-og-default.jpg`.
- The owner supplied the MAXINA logo (1254x1254 RGB JPEG, black mark on white, square). Anthropic's submission page names an icon but gives no size or format in the text read; the portal validates on upload. Plan: use it as supplied for the portal (convert to PNG at upload if the portal asks). Note the brand mismatch: the logo says MAXINA, the connector is named Vitanaland Commerce; the owner decides whether the listing is named after the product (Vitanaland) or the portal brand (MAXINA).

## Outcome
Items 2-7 proceed as planned. Two owner decisions came out of this check: (a) the live-ness gap in section 2, (b) the listing name vs the logo in section 3.
