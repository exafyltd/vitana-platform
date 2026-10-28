# Vitanaland ChatGPT plugin (VTID-04980, VTID-05152)

Packaging only. The plugin points at the existing Commerce MCP (the ChatGPT-only path `https://gateway.vitanaland.com/mcp/chatgpt`, VTID-04990) and Supabase OAuth. There is no second backend and no second identity system.

- `plugin.json` - listing (`extensions["com.openai"].interface`)
- `mcp.json` - the one MCP server, with its OAuth declaration (`extensions["com.openai"].auth`: `oauth`, dynamic client registration, scopes `email profile`)
- `skills/`, `assets/` - the onboarding skill and the 512px logo and composer icon
- `REVIEW-CASES.md`, `SUBMISSION.md` - review prompts and submission checklist

This is the layout OpenAI's plugin portal accepted for version 1.0.0 (submitted 2026-10-13). There is no Codex layout and no `.mcp.json`: the portal read the old `.mcp.json` and reported no authentication.

`services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts` keeps the package consistent with the live tool list.
