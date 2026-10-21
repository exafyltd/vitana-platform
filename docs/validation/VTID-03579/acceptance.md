# VTID-03579 — Acceptance

Stop every gateway LLM call site from choosing its own provider. Provider
selection belongs to `llm_routing_policy` (Bedrock primary, DeepSeek fallback);
no call site may name Google.

Context: a routing table states intent, but only the call sites decide who
actually serves a request. That gap is why the Gemini API bill kept growing
while the policy table read as though the platform had already moved off it.

---

AC-1 — No gateway service selects an LLM provider in code.
Every converted call site resolves its provider through `callViaRouter`, so a
routing change moves it with no code edit.
TEST: services/gateway/test/inline-fact-extractor-deepseek.test.ts
TEST: services/gateway/test/services/user-model-synthesis.test.ts

AC-2 — No converted call site contacts a provider host directly.
Asserted as the ABSENCE of any fetch to api.deepseek.com,
generativelanguage.googleapis.com, aiplatform.googleapis.com or api.anthropic.com.
Asserting "Bedrock was called" instead would re-hardcode a provider one step
further along: it would break on the next legitimate routing change and still
miss a re-added direct fetch.
TEST: services/gateway/test/inline-fact-extractor-deepseek.test.ts

AC-3 — A provider failure never falls back to Google.
Per CLAUDE.md ALWAYS 10c a Claude stage falls back to another Bedrock model or
fails explicitly. The previous Vertex-to-Gemini cascade is replaced by its
opposite assertion.
TEST: services/gateway/test/inline-fact-extractor.test.ts

AC-4 — Multi-turn history reaches the model, current turn last.
Anthropic reads the final user message as the current turn; appending history
after the prompt would make the model answer a question from several turns ago.
Losing history entirely reads to a user as the assistant developing amnesia —
no error, no status code.
TEST: services/gateway/test/llm-router-agentic.test.ts

AC-5 — A tool round-trip is rendered per-provider and paired by id.
Bedrock gets Anthropic tool_use/tool_result blocks; DeepSeek gets the OpenAI
shape with role:'tool' messages keyed by tool_call_id. An unpaired tool_result
is a hard 400, not a degraded answer.
TEST: services/gateway/test/llm-router-agentic.test.ts

AC-6 — Every tool call the model requests is returned, not just the first.
Claude emits parallel tool calls; reading only the first executes one, returns
results for one, and leaves the model waiting on calls already made — a hang.
TEST: services/gateway/test/providers/bedrock-vision-tools.test.ts
TEST: services/gateway/test/llm-router-agentic.test.ts

AC-7 — The DeepSeek fallback carries conversation history too.
It is the standing fallback for every Bedrock stage, so without this a Bedrock
blip would silently reset the conversation rather than continue it.
TEST: services/gateway/test/llm-router-agentic.test.ts

AC-8 — A call with no history is unchanged from before.
Every pre-existing caller passes no history; the common single-turn path must
stay byte-identical.
TEST: services/gateway/test/llm-router-agentic.test.ts

AC-9 — Session summarization degrades safely.
A provider failure returns null so the caller falls back to the heuristic
builder rather than persisting a broken recap; whitespace is not a summary; the
600-char bound is enforced in code because a different provider can be markedly
more verbose than the Gemini Flash this was tuned against.
TEST: services/gateway/test/guide-session-summary-flow.test.ts

AC-10 — The remaining Google dependency is documented, not hidden.
Fact embeddings still call text-embedding-004 because Anthropic publishes no
embedding model. Carved out by exact path so any OTHER Google call still fails,
and separately asserted to EXIST so the test breaks when it is fixed.
TEST: services/gateway/test/inline-fact-extractor-deepseek.test.ts

---

OASIS_PROOF: llm.call.* emission changes in two directions, both intended.

MORE events: call sites that previously bypassed the router (gemini-operator,
inline-fact-extractor, knowledge-hub, user-model-synthesis,
guide/session-summaries, recommendation-llm-analyzer, natural-language-service,
assistant-core frame analysis) now emit llm.call.started / llm.call.completed /
llm.call.failed. Those calls were always happening — they were simply invisible
to OASIS, which is the defect this VTID exists to close. The rise in event
volume IS the fix, not a side effect of it.

FEWER events, for two services: assistant-service and gemini-operator hand-rolled
their own startLLMCall / completeLLMCall / failLLMCall around calls that now go
through the router, which emits the same three events itself. Both manual trios
are removed, so those services drop from two event pairs per turn to one.
Leaving them would have double-counted every ORB assistant and operator turn in
the exact topics the cost analysis reads.

New metadata.service values to expect: inline-fact-extractor, knowledge-hub,
user-model-synthesis, guide-session-summaries, recommendation-llm-analyzer,
orb-assistant, natural-language-service, natural-language-service-parse,
assistant-core-frame, gemini-operator, gemini-operator-tool-results.

No new topics, no schema change, no migration. Verification query:

  select metadata->>'service', metadata->>'provider', count(*)
    from oasis_events
   where topic like 'llm.call.%' and created_at > now() - interval '1 hour'
   group by 1,2 order by 3 desc;
