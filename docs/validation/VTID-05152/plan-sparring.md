# Plan sparring record - VTID-05152

Plan hash (sha256 of the text between the plan markers, trimmed): `392ddc7c7d20241185039fc8215bb1f33ed41f7e7b87adf75bd9ffef2ef00109`. Partner: plan-sparring-partner (read-only, independent), 2 rounds, CONVERGED (standard class). Owner approval: in session 2026-10-13, "yes, go ahead" in answer to the Gate 1 message (final plan, both rounds' findings, the files, the test plan). The gate is in log mode; the session is recorded here and in the ledger row.

Round 2 (partner, summary): F1, F2, F3 closed; no new findings; verdict CONVERGED.


Change class: standard (more than 3 files; no migration, route, auth, deploy or governance file; packaging + one test)
Repo: exafyltd/vitana-platform
Scope (files): integrations/chatgpt-plugin/vitanaland/{plugin.json, mcp.json, README.md, SUBMISSION.md}, DELETE integrations/chatgpt-plugin/vitanaland/.mcp.json and .codex-plugin/plugin.json, services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts, docs/validation/<VTID>/*

<!-- plan:begin -->
## Problem (verified 2026-10-13)
The package submitted to OpenAI's plugin portal on 2026-10-13 (version 1.0.0, "In review") is `vitanaland-plugin-v6.zip`. The repo folder `integrations/chatgpt-plugin/vitanaland/` is the older layout, so the repo no longer describes what was submitted and the next upload would start from the wrong files:
- `mcp.json` has no `extensions["com.openai"].auth` block (the v6 one declares `type: "oauth"`, `client.mode: "dcr"`, `baseScopes: ["email","profile"]`). Without it the portal reads "no authentication"; this was the root cause of `auth_not_configured`.
- `.mcp.json` (type `http`, legacy) and `.codex-plugin/plugin.json` (legacy Codex copy) are still present. The portal was reading `.mcp.json` until v6 removed it, so keeping it in the repo invites the same mistake on the next upload.
- `plugin.json` has `category: "Productivity"`; v6 has `"Business & Operations"` and a `$schema` line.
- `README.md` and `SUBMISSION.md` describe the Codex layout as a fallback and say the manifest format was read "through search excerpts only" and must be validated at submission (it now has been, by the portal).
- `services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts` asserts the two layouts are identical and that `.mcp.json` exists with type `http`.
The skill (`skills/set-up-my-business/SKILL.md`) and both PNG assets are already byte-identical to v6 (checked with `diff -r`).

## Change
1. `plugin.json` and `mcp.json` are replaced by the exact contents of the v6 package (copied byte for byte from the zip's files: `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"` in `plugin.json` and `"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"` in `mcp.json`, category "Business & Operations", the `auth` block). The listing text is unchanged.
2. `.mcp.json` and `.codex-plugin/plugin.json` are deleted. Nothing else in the repo reads them at runtime (grep: the package test, README and SUBMISSION name them; `docs/validation/VTID-04980` and `VTID-05074` mention them as past scope, audit trail only and left unchanged).
3. `README.md` and `SUBMISSION.md` are updated: one portable layout; the Codex layout is gone; the auth declaration and category are named; the stale "fallback / unverified format" paragraph is replaced by the fact that the portal accepted this layout on 2026-10-13 (v1.0.0 in review).
4. The package test is rewritten for the single layout: manifest has name/version/listing fields, legal URLs, short description limit, 512px PNG assets (all kept); the Codex-equality and `.mcp.json` assertions are removed; the MCP config test now asserts `mcp.json` has exactly one server `vitanaland-commerce`, `type: "streamable-http"`, the production URL, and `extensions["com.openai"].auth` equal to `{ type: "oauth", client: { mode: "dcr" }, baseScopes: ["email","profile"] }`; a new assertion that the legacy files are absent (so they cannot return unnoticed); the skill and review-case tests are untouched.
5. No change to the gateway source, the OAuth endpoints, the plugin that is in review, or OpenAI's portal. The repo folder is documentation of what was submitted; nothing deploys from it.

## Tests (Jest, run by the gateway CI job)
`vtid-04980-chatgpt-plugin-package.test.ts` as described above. Also run the neighbouring suites that read the same constants if any: `vtid-04969-commerce-mcp-openai-metadata.test.ts`, `vtid-04990-chatgpt-oauth.test.ts` (unchanged, must stay green).

## Staging evidence
The test file lives under `services/gateway/**`, so the merge triggers `AWS-STAGE-DEPLOY-GATEWAY.yml` (`paths: services/gateway/**`) and STAGING-VERIFY runs on the exact merge commit, although the runtime image does not change (tests and `integrations/**` are not in it). So the normal flow applies: merge -> staging deploy -> STAGING-VERIFY (service smoke suite + this change's `staging-tests.json`) -> Gate 2 with machine evidence, stating plainly that the gateway runtime is unchanged. `staging-tests.json`: an `existing` entry `npx jest test/vtid-04980-chatgpt-plugin-package.test.ts` (cwd services/gateway) and the two read-only GETs of the staging discovery documents (200). The Gate 2 "yes" would promote the verified commit pinned; no new behavior reaches production beyond what is already there.

## Rollout
PR -> CI -> merge -> staging deploy -> STAGING-VERIFY -> Gate 2 -> promote the verified commit pinned. Rollback: revert the PR.

## Risks and what it accepts
- The v6 zip lives only in the build session's scratchpad; if it differs from what the portal stores, the repo would be wrong. Mitigation: the owner uploaded exactly v6 (the portal JSON screenshot shows the same `mcp.json` auth block), and the repo files are copied from the zip, not retyped.
- Deleting the Codex layout removes the ability to install the plugin as a Codex plugin from this folder. Accepted: nobody does (OpenAI's own Codex client signs in to the Commerce MCP via the MCP URL, not the folder), and the portal read the legacy file wrongly.
- A future upload to the portal is not automated; this change does not touch the portal.

## Non-goals
No change to listing wording, logo, the diagnostic probe removal (separate follow-up), `offline_access`, `/.well-known/openid-configuration`, or anything in the review.
<!-- plan:end -->

## Planner responses (round 1)
- F1 [major]: ACCEPTED. The test sits under `services/gateway/**`, so the gateway staging deploy and STAGING-VERIFY do fire. The plan now says so, drops the "no Gate 2" claim and follows merge -> staging -> STAGING-VERIFY -> Gate 2, with the evidence stating that the gateway runtime is unchanged. Q1: Gate 2 applies, no different approach (the test needs the `commerce-mcp` import). Q2: STAGING-VERIFY runs the service smoke suite plus the `staging-tests.json` entries; the Jest entry is a cheap guard, the discovery GETs prove the live document; redundancy accepted.
- F2 [minor]: ACCEPTED. Both `$schema` URLs are named in the plan, and the test pins them.
- F3 [minor]: ACCEPTED as no action. Named in the plan as audit trail, left unchanged.
