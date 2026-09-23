# VTID-04448 — Health Coach chat on the gateway; ai-chat and the Gemini memory functions retired (D12)

Frontend change: exafyltd/vitana-v1 (branch `claude/vitana-memory-system-analysis-55fq3g`).
Depends on VTID-04447 (the conversation API binds the turn to the signed-in user).

## Before
`HealthCoachChat` (AI Companion page) sent each message to the `ai-chat` Supabase edge
function. That function answered on Gemini, looked up memory through the Gemini
`search-memories` / `reinforce-memory` functions, wrote its own insights into the legacy
`ai_memory` table, and embedded them through `generate-memory-embedding`. The component
never rendered the reply: the user saw a typing indicator and then nothing.

## Acceptance criteria
- AC-1: a message is posted to `POST /api/v1/conversation/turn` with channel `orb`, the caller's own user/tenant id and the UI language; the thread continues on the next message. TEST: src/lib/coach-chat-api.test.ts (vitana-v1)
- AC-2: a refusal or a missing reply throws, and the chat shows the translated error toast. TEST: src/lib/coach-chat-api.test.ts (vitana-v1); outputs/desktop-error.png
- AC-3: the conversation (user and coach turns) is rendered in the card, in LTR and RTL, with no horizontal scroll at 390 px. Evidence: outputs/desktop-reply.png, outputs/mobile-reply.png, outputs/mobile-rtl-reply.png
- AC-4: `ai-chat`, `search-memories`, `reinforce-memory`, `generate-memory-embedding`, `extract-diary-insights`, `extract-user-interests`, `refresh-memory-metadata` and `src/services/aiVoiceService.ts` are gone; no source file invokes them and `config.toml` declares none. TEST: src/lib/coach-chat-api.test.ts (vitana-v1, tree guard)

## Verification
- vitana-v1 `vitest run`: 151 files, 859 tests passed.
- `tsc --noEmit -p tsconfig.app.json`: 166 errors before and after, none in touched files.
- ESLint clean on the touched files; `npm run i18n:inventory` regenerated.
- Screenshots from a local harness that renders the real component with the gateway call and the consent dialog stubbed. No network request was made.

## Not verified / owner steps
- Not verified live (needs VTID-04447 on staging and a signed-in member).
- Removing the source does not undeploy the functions: delete them from the Supabase project (`supabase functions delete <name>`).
- Still touching `ai_memory`: `fetch-user-context`, `get-proactive-context` (read) and `analyze-visual-context` (writes, no caller).
