# B7 — Edge Functions Inventory (VTID-03738)

Part of `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md`'s B7 workstream ("74
Deno functions → Lambda/ECS, independent of the DB"). Note up front: B7 is
about **Deno edge-function runtime**, not the Postgres database — it is
"independent of the DB" per the plan's own framing, so it doesn't block on
Aurora/DMS status. But it surfaced a finding that goes well beyond B7's own
scope, flagged prominently below.

## Function count: plan is accurate

`exafyltd/vitana-v1/supabase/functions/` has 75 directories; one is
`_shared` (a helper library, not a deployable function); 74 have their own
`index.ts`. **Matches the plan's "74 functions" exactly.**

## Structural categorization (static grep across all 74 `index.ts`)

| Signal | Count | What it means for the Lambda/ECS port |
|---|---|---|
| Auth-dependent (`auth.getUser()` / reads an `Authorization: Bearer` header) | 50 | Needs a JWT-verification equivalent once Supabase Auth itself is retired — the platform owner's stated end-state (per this session's standing directive) is shutting down Supabase Auth too, so these 50 are coupled to whatever replaces it, not just to Aurora. |
| Uses `SUPABASE_SERVICE_ROLE`/service-role client | 43 | Needs an equivalent elevated-privilege path against Aurora (an IAM role/service credential, not a literal service-role key). |
| Cron/scheduled-looking (`cron`, `scheduled`, `CRON_SECRET` in source) | 7 | Needs an EventBridge Scheduler (or similar) trigger once ported — same pattern this session already built for `gateway-push-dispatch` (VTID-03676) after discovering GCP Cloud Scheduler had no working AWS equivalent. |

## ⚠️ Critical, out-of-B7-scope finding: 23 of 74 functions still call GCP/Gemini/Vertex directly

This was found while categorizing, not what B7 set out to look for — but it
directly contradicts this repo's own standing CLAUDE.md rules (banner: *"GCP
IS FULLY DECOMMISSIONED... Zero Vitana processes run on GCP any more"*;
IF-THEN rule 27: *"IF you are about to point any stage at vertex, Gemini, or
any other Google Cloud API → THEN STOP. There is no sanctioned Google
dependency left at all."*; ALWAYS 10a: *"Always use Claude via AWS Bedrock.
Always."*), so it is reported here rather than held for a separate pass.

**23 of 74 functions (31%) contain a live call to a Gemini/Vertex/Google
Cloud endpoint or read a `GEMINI_API_KEY`/`GOOGLE_CLOUD`-shaped env var.
Zero of the 74 call Bedrock, the direct Anthropic API, or OpenAI.** This
means the LLM-routing discipline CLAUDE.md documents in exhaustive detail
for the **gateway** (§2b, VTID-03563's "always Bedrock, never Anthropic,
never a silent Google fallback") has **no equivalent enforcement in
`vitana-v1`'s edge functions at all** — a structurally separate code
surface with its own, apparently unmigrated, AI provider story.

| Function | Confirmed frontend caller? |
|---|---|
| `ai-chat` | yes |
| `extract-diary-insights` | yes |
| `generate-enhanced-recommendations` | yes |
| `generate-event-image` | yes (2 call sites) |
| `generate-proactive-greeting` | yes |
| `social-media-import` | yes |
| `transcribe-audio` | yes |
| `analyze-patterns` | no — not found in frontend `src/`, other edge functions, or `supabase/migrations/` |
| `analyze-situation` | no — same as above |
| `analyze-visual-context` | no — same as above |
| `extract-user-interests` | no — same as above |
| `generate-maxina-summer-events` | no — same as above |
| `generate-memory-embedding` | no direct frontend hit, but called by 2 other edge functions — not dead |
| `generate-proactive-message` | no — not found anywhere checked |
| `generate-recommendations` | no — not found anywhere checked |
| `google-cloud-tts` | **no — confirmed orphaned, see below** |
| `integration-discovery` | no — not found anywhere checked |
| `linkedin-import` | no — not found anywhere checked |
| `search-memories` | no direct frontend hit, but called by 1 other edge function — not dead |
| `test-api-integration` | no direct frontend hit, but called by 1 other edge function — not dead |
| `transcribe-audio` | (listed above, has a direct caller) |
| `vertex-auth` | no direct frontend hit, but called by 1 other edge function — not dead |
| `vertex-live` | no direct frontend hit, but called by 2 other edge functions — not dead |
| `vitanaland-live` | no — not found anywhere checked |

**One is confirmed already fixed, not a live gap — worth noting so the
other 22 aren't over-read by association.** `google-cloud-tts` is the exact
function CLAUDE.md's 2026-08-18 changelog entry named as a live production
gap (*"`useTextToSpeech.ts`/`VoiceSettingsPanel.tsx` call `google-gemini-
tts`/`google-cloud-tts` Supabase edge functions directly... gets silence or
an error today"*). Reading the current `useTextToSpeech.ts` shows this was
already fixed by `BOOTSTRAP-FRONTEND-TTS-POLLY` — its own inline comment:
*"the `supabase` client import is gone with the two `functions.invoke(
'google-*-tts')` calls it existed for. Cloud speech now goes through the
gateway's Polly-first route."* `google-cloud-tts` is now unreferenced dead
code, not an active bug. **CLAUDE.md's changelog entry for this is stale**
— worth a doc-accuracy follow-up separate from this migration work.

**The other 7 with confirmed frontend callers (`ai-chat`,
`extract-diary-insights`, `generate-enhanced-recommendations`,
`generate-event-image`, `generate-proactive-greeting`,
`social-media-import`, `transcribe-audio`) are genuinely reachable, and
this pass did not check whether they are currently succeeding or silently
failing/falling back.** Given GCP billing was disabled 2026-08-16
(VTID-03599/VTID-03649) per this repo's own documented history, and given
the gateway's own §2b history shows a Google-dependent code path can fail
**silently** for months before anyone notices (268 unnoticed
Anthropic-credit-balance→Gemini fallbacks over 14 days was the exact
precedent that produced the "never silent Google fallback" rule in the
first place) — **this is the single highest-priority follow-up this pass
surfaced.** Not fixed or further diagnosed here; flagged for immediate
attention given the severity/precedent match.

## Not done in this pass

- Did not read any of the 74 functions beyond the categorization greps —
  no line-by-line review of what each does, no attempt to distinguish
  "silently degrades" from "throws visibly" from "already has its own
  non-Google fallback" for the 7 reachable GCP-dependent functions.
- Did not check `exafyltd/vitana-mobile` or the gateway backend for calls
  into any of these 74 functions — the "no caller found" list for the 10
  fully-unreferenced functions is scoped to `vitana-v1/src` +
  `supabase/functions/*` + `supabase/migrations/*` only, same gap B5/B6
  both flagged for the mobile app specifically.
- Did not check Supabase's own function-invocation logs/analytics (if
  reachable) to confirm the "no caller found" functions are truly unused
  in production traffic, vs. just unreferenced in this session's checked
  code surfaces — a static grep proves "no code path I found calls this,"
  not "this has never run."
- Did not scope the Lambda/ECS port itself (runtime shape, cold-start
  budget, which functions warrant a persistent ECS service vs. a Lambda) —
  pure inventory + a live-severity finding, no target-architecture design.
