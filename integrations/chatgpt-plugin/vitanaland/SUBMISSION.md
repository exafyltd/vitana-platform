# Vitanaland plugin - submission checklist

Listing content lives in `plugin.json` (`extensions.com.openai.interface`); the MCP server and its OAuth declaration live in `mcp.json`. One layout only.

## Owner (needs account access or approval)
- [ ] OpenAI organization verified under the EXAFY LTD identity; submitter has the Owner role; project uses global (not EU) data residency.
- [ ] Reviewer account created (see `docs/validation/VTID-04971/provisioning.sql`, owner-run) and its credentials entered in the submission form only.
- [ ] Domain verification token from the submission form set as `OPENAI_APPS_CHALLENGE_TOKEN` on the production gateway (served at `https://gateway.vitanaland.com/.well-known/openai-apps-challenge`, raw token only).
- [ ] Final submission.

## Package (done in this folder)
- [x] `plugin.json` + `mcp.json` (`streamable-http`, `https://gateway.vitanaland.com/mcp/chatgpt`, OAuth with dynamic client registration, scopes `email profile`)
- [x] One skill: `skills/set-up-my-business`
- [x] `assets/logo.png`, `assets/composer-icon.png` (512x512 PNG)
- [x] 5 positive and 3 negative cases: `REVIEW-CASES.md`

## Server (already live in production)
- [x] Public HTTPS MCP endpoint, OAuth 2.1 with protected-resource metadata, 401 challenge when unsigned
- [x] Every tool carries `readOnlyHint`, `destructiveHint`, `openWorldHint` and `securitySchemes`
- [x] Delegated AI tokens reach only `/mcp` and discovery routes; MCP client allow-list is fail-closed
- [x] Reviewer sandbox: submission recorded, never reaches staff review, members or go-live

## Still to produce (needs a ChatGPT session with the plugin installed)
- [ ] Screenshots of the flow in ChatGPT
- [ ] Demo video of P1-P5
- [ ] Run P1-P5 and N1-N3 once on web, iOS and Android and record the outcome here

## Submission status
Version 1.0.0 was submitted in OpenAI's plugin portal on 2026-10-13 and is in review. The portal accepted this layout. Category: Business & Operations.
