# Vitanaland ChatGPT plugin (VTID-04980)

Packaging only. The plugin points at the existing Commerce MCP (the ChatGPT-only path `https://gateway.vitanaland.com/mcp/chatgpt`, VTID-04990) and Supabase OAuth. There is no second backend and no second identity system.

- `plugin.json`, `mcp.json`, `skills/`, `assets/` - portable plugin layout
- `.codex-plugin/plugin.json`, `.mcp.json` - Codex layout (same content)
- `REVIEW-CASES.md`, `SUBMISSION.md` - review prompts and submission checklist

`services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts` keeps the package consistent with the live tool list.
