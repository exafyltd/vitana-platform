# Gateway Google/Gemini/Vertex Dependency Audit (2026-08-28)

CLAUDE.md's own standing rule (IF-THEN 27 / NEVER 27) says: *"IF you are
about to point any stage at vertex, Gemini, or any other Google Cloud API
→ THEN STOP. There is no sanctioned Google dependency left at all."* Three
exceptions were already documented (§2b's dead-code `vertex` adapter in
`llm-router.ts`, §2d's `IMAGE_PROVIDER=vertex` default, §2c's "Cloud TTS
debug route... Google only, on purpose").

`grep -rln "generativelanguage.googleapis.com\|vertexai\|GEMINI_API_KEY\|
GoogleGenerativeAI\|GOOGLE_CLOUD_PROJECT" services --include="*.ts"`
(excluding `node_modules`/`.test.ts`) returned 27 real source files —
9x more than the 3 already named. Audited every one, file by file, reading
actual call sites rather than trusting grep hits at face value. Full
per-file classification table and detail available in this pass's working
notes; summarized here by outcome.

## Result: 3 already-documented, ~18 dead/false-positive, 6 genuinely new

**Confirmed matching the 3 already-documented exceptions exactly:**
`llm-router.ts`'s `vertex` adapter, `intent-cover-service.ts` /
`cover-image-outpaint.ts`'s `IMAGE_PROVIDER` switch, and `orb-live.ts`'s
`GET /debug/tts` route.

**Dead code or false positives (~18 files):** env vars declared but never
read (`gemini-operator.ts`, `assistant-core.ts`, `knowledge-hub.ts`,
`intent-classifier.ts`), comment-only hits (`index.ts`,
`orb/delegation/types.ts`, `user-model-synthesis-repository.ts`,
`scripts/repair-vtid-0541.ts`, `scripts/seed-db-i18n.ts`), flags that
default off (`GEMINI_LIVE_USE_API_KEY` in `orb/live/config.ts` and its
client `gemini-api-key-live-client.ts`; `DEV_AUTOPILOT_USE_JOB` in
`dev-autopilot-execute.ts`), bare connectivity probes with no generation
call (`orb-livekit.ts`'s admin test panel), and a Command Hub
`Boolean(env var set)` health flag (`routes/llm.ts`). `orb-live.ts`'s
Vertex Live primary-connect path is the already-known "Vertex Live killed
outright" situation from §2e — not counted as new. `nova-sonic-test-runner.ts`
is the already-documented `/api/v1/voice-lab/nova/tests/run` diagnostic
from §2e-bench.

## 6 genuinely new findings

**1–2. `embedding-service.ts` and `memory-facts-service.ts` — unconditional
OpenAI→Gemini embedding fallback, no flag, hot path.** Both call the
standalone Gemini Developer API (`GOOGLE_GEMINI_API_KEY`, NOT
GCP-project-billed Vertex — unaffected by the `lovable-vitana-vers1`
shutdown) whenever OpenAI's embedding call fails, for *every* memory/
semantic-search write and query path in the gateway (`intent-embedding.ts`,
`memory-broker.ts`, `navigation-catalog.ts`, `routes/semantic-memory.ts`,
`routes/admin-embeddings-backfill.ts`, plus every `write_fact()` call via
`generateFactEmbeddingAsync()`). **This is the most consequential finding**
— it's live, unflagged, and would actually work today if
`GOOGLE_GEMINI_API_KEY` still holds a valid key, meaning the platform may
already be quietly depending on Google for embeddings without anyone
choosing that. Fixing it needs a Bedrock/Titan-embeddings fallback this
codebase doesn't have yet (Titan's embedding dimension doesn't match the
existing `vector(1536)`/`vector(768)` columns either — a real migration
question, not a one-line swap). **Not fixed in this pass** — flagging for
a deliberate follow-up, the same reasoning this whole migration effort has
applied to every non-trivial provider swap.

**3. `orb/delegation/providers/google-ai.ts` — ORB's `consult_external_ai`
voice tool, real and wired, despite a stale comment calling it an "empty
stub."** Fires when a user has connected their own Google AI Studio key
(BYOK, via `user_connections`/`ai_assistant_credentials`) and ORB routes a
question to it. Unlike the two findings above, this uses the *user's own*
key, not a platform credential — plausibly an intentional "consult another
AI provider" product feature rather than a policy violation, but the
`providers/index.ts` registry comment claiming it's unwired is wrong and
should be corrected so nobody trusts it. **Not touched** — needs a product
call on whether user-BYOK external-AI consult is still meant to exist,
not a code fix.

**4. `voice-lab/livekit-test-eval.ts` — real Vertex `generateContent` call
behind an admin test endpoint, unflagged.** `POST /api/v1/voice-lab/tests/eval`
and `/tests/run`, reachable by any `exafy_admin` JWT or a verified Google
service-account `id_token` (a live Google API call in its own right,
unrelated to billing). Would fail today either on a config error (`GOOGLE_CLOUD_PROJECT`
likely unset on ECS) or an ADC/network error (no GCP metadata server) —
not a live outage risk, just dead-in-practice code nobody flagged as such.

**5. `cloud-run-admin.ts` — wired into the operator deploy-revert admin
panel, targets Cloud Run infrastructure CLAUDE.md's own banner says was
physically deleted.** `describeService`/`listRevisions`/
`updateTrafficToRevision` in `routes/operator.ts` (10+ call sites) use
`GoogleAuth`/ADC to call `run.googleapis.com` for the `gateway` Cloud Run
service — deleted 2026-08-16 per VTID-03599/VTID-03649. Any admin hitting
that panel today gets a clean failure, not a working revert — a stale,
unhelpful admin feature rather than a security risk. **Safe cleanup
candidate**, not fixed here (touches multiple route handlers, deserves its
own pass rather than a rushed deletion).

**6. `routes/debug-ai-studio-models.ts` — a TEMPORARY debug route,
explicitly marked for removal, never removed. FIXED in this pass.** Its
own header said *"REMOVE THIS FILE once the correct model id is
confirmed"* — and the path it was diagnosing
(`GEMINI_LIVE_USE_API_KEY`/`AI_STUDIO_LIVE_MODEL`) is itself dead code
(finding set above: that flag defaults off, voice runs on Nova Sonic
exclusively per §2e). No remaining purpose, real risk (proxies a live
Gemini API key to any `exafy_admin`), zero benefit. Deleted the route file
and its test (`test/routes/debug-ai-studio-models.test.ts`) and both
`index.ts` mount points. `tsc --noEmit` clean; `test/routes/` full sweep
76/76 suites, 1521/1522 tests passing (1 pre-existing skip) — no new
failures, no orphaned references outside two historical-rationale comments
in already-dead-code files (`gemini-api-key-live-client.ts`,
`orb/live/config.ts`) left alone since they're explaining a past
investigation, not live code.

## What this does and doesn't mean

Findings 1–2 are the one item here worth real product attention — a
platform CLAUDE.md that says "no Google dependency left at all" is being
quietly contradicted on the exact hot path (memory writes) this migration
effort's B3 audit already spent significant effort verifying data
integrity on. Findings 3–5 are lower-stakes (BYOK feature, dead endpoints)
and don't need urgent action. Finding 6 is closed.
