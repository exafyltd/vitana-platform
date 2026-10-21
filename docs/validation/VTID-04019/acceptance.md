# VTID-04019 — W7a: no credential material in CLAUDE.md (the partial PATs in §16)

Context: gap analysis §5 R-11 and build plan W7 both list "remove the partial PATs from `CLAUDE.md` §16". The section printed the first characters of two live GitHub personal access tokens ("use these PATs with the GitHub REST API") in the one file every Claude Code session and every agent prompt force-loads (the agent executor's system prompt carries CLAUDE.md Part 1; the W4a bootstrap pack reads CLAUDE.md through the GitHub API). A prefix is not a full token, but it is credential material in a rules file, it invites the next session to ask for the rest, and nothing stopped a full token from being pasted next to it.

AC-1 — `CLAUDE.md` §16 no longer contains any token-shaped string; it now says where each token actually lives (`GITHUB_SAFE_MERGE_TOKEN` / `FRONTEND_DEPLOY_TOKEN` in AWS Secrets Manager wired by the deploy workflows; Actions repository secrets; a session uses the GitHub MCP tools and `add_repo`) and what to do if one is ever pasted anywhere (rotate, update the secret, redeploy, record).
TEST: services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts

AC-2 — A drift test scans `CLAUDE.md`, `README.md` and every markdown file under `docs/` (hundreds of files) for token shapes — GitHub fine-grained and classic tokens, AWS access key ids, OpenAI/Anthropic-style keys, JWTs — and fails the build on any hit; the detector is itself verified against fixtures (shapes, not real tokens) and ignores the env-var names and the `github_pat_…` prose mention.
TEST: services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts

Not done here (owner-gated, named in the plan's W7 row): rotating the two tokens whose prefixes were exposed — the prefixes have been in `main` for weeks, so rotation is the correct posture regardless of this edit; confirming/performing the Supabase `service_role` rotation flagged in `docs/HANDOFF-voice-quality.md`; declaring the prod gateway's operator/autopilot flags in `AWS-PROD-DEPLOY-GATEWAY.yml`.
