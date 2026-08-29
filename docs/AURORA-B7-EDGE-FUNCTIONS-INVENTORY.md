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
failing/falling back** — no Supabase edge-function secrets access from
this session, and making live billed API calls to find out was
deliberately not attempted without explicit authorization.

**Read further, these 7 split into two materially different risk tiers —
worth not conflating:**

- **6 read `GOOGLE_GEMINI_API_KEY`** (`ai-chat`, `extract-diary-insights`,
  `generate-enhanced-recommendations`, `generate-proactive-greeting`,
  `social-media-import`, and `transcribe-audio` partially) — the Gemini
  **Developer API** (`generativelanguage.googleapis.com`), billed against a
  standalone AI Studio API key. This is a **different billing mechanism**
  than the GCP-project/Cloud-Run billing this repo's CLAUDE.md documents as
  disabled for `lovable-vitana-vers1` — whether this specific key still has
  credit/is still active is genuinely unverified, not assumed broken.
- **1 (`generate-event-image`) calls Vertex AI's Imagen model directly**
  (`https://{region}-aiplatform.googleapis.com/.../imagen-3.0-fast-
  generate-001:predict`) using `GOOGLE_CLOUD_PROJECT_ID` +
  `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON` — this **is** GCP-project/IAM-billed
  infrastructure, the same mechanism the disabled-billing project used. If
  its configured project is `lovable-vitana-vers1`, this call has very
  likely been failing since 2026-08-16 — **this is the one to check first**,
  and checking it only needs reading (not calling) the function's
  configured `GOOGLE_CLOUD_PROJECT_ID`, which this session could not reach.

Given the gateway's own §2b history shows a Google-dependent code path can
fail **silently** for months before anyone notices (268 unnoticed
Anthropic-credit-balance→Gemini fallbacks over 14 days was the exact
precedent that produced the "never silent Google fallback" rule) —
`generate-event-image` in particular is the single highest-priority
follow-up this pass surfaced. Not fixed or further diagnosed here.

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

## Addendum, 2026-08-27 — checked the invocation logs this doc flagged as not done, and the result reframes the whole B7 question

This session has live Supabase log access (`query_logs`, ClickHouse SQL
over `edge_logs`/`function_logs`). Ran exactly the check this doc's own
"Not done" list named.

**`edge_logs` over the full available 24h window: 748,348 total entries,
738,369 of them `/rest/v1/*` (PostgREST) calls, and — checked with an
unfiltered count, not a name-by-name search that could miss a variant
path — exactly `0` matching `/functions/v1/*`.** That is real traffic
volume in the window (this isn't a quiet-project false negative the way
the credit_wallet CloudWatch check risked being), and it is a complete
count, not a sample. No external HTTP call reached any of the 74 Supabase
Edge Functions in the last 24 hours.

**This does not mean the functions never run at all** — `function_logs`
shows 209 `booted` events in the same window, and reading a few of them
live shows a recurring internal test-runner (`run-uptime-checks` invoking
`test-vertex-live` and similar diagnostic probes on a ~15-minute cadence)
still executing on a schedule. So there is scheduled/internal invocation
activity; there is just no evidence of real, external, frontend-driven
traffic reaching this layer at all in a full day, for any of the 74 —
including the 7 this doc flagged as having confirmed frontend callers
(`ai-chat`, `extract-diary-insights`, `generate-enhanced-recommendations`,
`generate-event-image`, `generate-proactive-greeting`,
`social-media-import`, `transcribe-audio`). Targeted searches for
`GOOGLE_GEMINI_API_KEY`/`generativelanguage`/`gemini-1.5`/`gemini-2` and
for `generate-event-image` by name, specifically, also returned zero.

**What this changes:** the original finding ("23 of 74 functions still
call GCP directly, is that broken since the 2026-08-16 shutdown?") may be
the wrong question to be asking with any urgency — if these functions
receive essentially no real frontend traffic today, whether their GCP
calls succeed or fail is close to moot in practice, the same way
`google-cloud-tts` turned out to be orphaned dead code rather than a live
bug once `useTextToSpeech.ts` was actually read. **This needs the same
treatment `google-cloud-tts` got, at the frontend-caller level**: check
whether `vitana-v1/src`'s call sites into `ai-chat` and the other 6 are
still live UI paths a user can actually reach, or whether the frontend has
already migrated off them the way TTS did and this doc's original static
grep (which only proved "a call site exists in the source," not "a user
can reach it today") was reading stale reachability the same way the
`autopilot_logs`/`credit_wallet` static-migration-file reads elsewhere in
this effort turned out to be. **Not resolved here** — this pass confirms
the traffic pattern, not the reason for it; the next step is reading the
frontend call sites directly, the same discipline B2/B3 already applied to
their own dead-reference findings.

**Caveat on the negative:** 24 hours is one day, not a representative
sample of every feature's real usage cadence (a feature only used a few
times a week wouldn't show up either) — this is suggestive and worth
acting on, not proof these 74 functions have zero users, ever.

**Followed through on `ai-chat` specifically, since it's the most central
of the 7 — and it is NOT the `google-cloud-tts` orphaned-code story.**
Traced its one caller (`src/services/aiVoiceService.ts`) to
`HealthCoachChat.tsx`, which is rendered from two pages
(`src/pages/ai/Companion.tsx`, `src/pages/Health.tsx`), both of which ARE
lazily routed in `App.tsx` (`Companion` confirmed rendered at a live
route; `Health` confirmed lazy-imported). **This is live, reachable,
routed UI — not dead code the frontend already moved off of.** Combined
with zero confirmed `/functions/v1/` traffic in the last 24h, the honest
read is: either genuinely low same-day usage of the health-coach chat
feature, or a real, currently-unconfirmed outage on a live user-facing AI
chat path. This is the one worth someone actually opening the Companion
or Health-coach chat screen to check by hand — this session has no
browser/Playwright access to the live frontend to do that itself.

## Addendum, 2026-08-29 (VTID-TBD) — `generate-event-image` traced: live, reachable, and NOT silently failing

This doc's own §"Followed through on `ai-chat`" section named
`generate-event-image` as the single highest-priority function still
needing this trace, since — unlike the other 6 Gemini-Developer-API
functions — it calls **Vertex AI's Imagen model directly** on
`GOOGLE_CLOUD_PROJECT_ID`/`GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON`, i.e. the
same GCP-project/IAM-billed infrastructure confirmed disabled for
`lovable-vitana-vers1` on 2026-08-16. Did the same static-reachability
trace `ai-chat` got, in `exafyltd/vitana-v1`.

**Verdict: live, reachable UI a real user can hit today — not orphaned
code.** The feature is a community-event cover-image generator
(`global_community_events` table — this is community events, not live
rooms or calendar, despite the ambiguous "event" name).

**Function behavior** (`supabase/functions/generate-event-image/index.ts`):
reads `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_REGION` (default
`us-central1`), `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON`; mints its own Google
OAuth2 JWT and calls `imagen-3.0-fast-generate-001:predict` on
`{region}-aiplatform.googleapis.com`. **Every failure path throws** —
missing creds (~line 169-171), OAuth token exchange failure (~244-248),
Imagen HTTP error (~280-290), missing image data (~298-301) — and the
top-level `catch` (~354-375) returns a non-2xx JSON error response
(`{success:false, error:"..."}`, mapped to 429/402/500), never a silent
200-with-placeholder. This is the opposite failure shape from the
"silent Google fallback" pattern the platform CLAUDE.md's §2b history
warns about.

**Call sites, both surfacing the error to the user, not swallowing it:**
- `src/components/EditMeetupPopup.tsx:196` (`handleGenerateImage`) — on
  error sets `generationError` state and fires a
  `notifyError('toasts.common.generationFailed')` toast (~218-246).
- `src/components/CreateEventPopup.tsx:308` (auto-generate-on-create) —
  on error shows one of several destructive toasts (rate-limit / credits
  / permission / generic "imageGenFailed") chosen by matching on the
  error message text (~332-344).

**Route trace:** both components render inside
`src/pages/community/EventsAndMeetups.tsx` (~51-58, mounted ~1142/1162),
which is lazily imported in `App.tsx:220` and mounted at the auth-guarded
`/comm/events-meetups` route (`App.tsx:1127-1131`) — confirmed live and
reachable. `CreateEventPopup` has a second independent live call path via
`src/pages/BusinessHub.tsx` (imported line 15, rendered lines 409/577).

**The actual live-severity finding, sharper than "is this broken":** if
this project's billing really is disabled, the failure IS visible to the
user today — but very likely **mis-attributed**. A Vertex 403 from a
billing-disabled project would plausibly match the `.includes('quota')`/
credits-style checks in `CreateEventPopup.tsx`'s error-message matching,
surfacing as "AI credits required" or a quota toast rather than anything
pointing at GCP infrastructure being off. An event still saves
successfully without its AI cover image either way (graceful degradation
at the data layer) — this is a real UX papercut on a live, routed
feature, not silent data loss, but the error message a user or on-call
engineer sees would send them chasing the wrong cause (a credits/billing
UI problem) instead of the real one (a decommissioned GCP project).
**Not verified here whether the configured project is actually
`lovable-vitana-vers1`** — this session could not read the live
`GOOGLE_CLOUD_PROJECT_ID` env var on the deployed function, the same gap
this doc's original finding flagged. That one remaining check — reading
the deployed function's env var, or just trying to create/edit a
community event with image generation and reading the resulting toast —
is what would convert this from "likely broken, confirmed live" to
"confirmed broken."

**Not done here:** wiring this to the existing Bedrock bridge pattern
(the gateway already has a Titan-image adapter per CLAUDE.md §2d,
`services/gateway/src/providers/titan-image.ts`) — that would need a new
image-generation bridge route analogous to `POST /api/v1/ai-bridge/generate`
(the text bridge B7's earlier rows built), not a drop-in reuse of it, and
is scoped as separate follow-on work, not assumed done by this trace.
