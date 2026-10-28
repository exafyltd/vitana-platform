# Plan sparring record - VTID-04984

Plan hash (sha256 of the text between the plan markers): `f2a4a97b1331e68a6b6d7723b4cc511d951dc8b7c9c58394c9c00d7df60447d5`. Partner: plan-sparring-partner (read-only, independent). Verdict: CONVERGED.

History: an earlier Operator model-picker plan (own catalog of Bedrock/DeepSeek/OpenAI/Qwen models) was REJECTED by the owner ("All models picked via Kiro and inside Kiro model selection"); no VTID was allocated for it. The Kiro model-selection plan then went 3 rounds (F1-F8, all closed), the owner corrected a premise ("Kiro always provides a model"), and finally asked for a simple version; the simplified plan below was sparred once more (round 4, CONVERGED, no findings) and approved.

# Plan: model selection inside Kiro (simplified per owner, 2026-10-08)

Change class: standard
Scope: services/gateway/src/services/kiro/{acp-client.ts,kiro-turn.ts}; services/gateway/src/routes/operator.ts; services/gateway/src/types/cicd.ts; services/gateway/src/frontend/command-hub/{app.js,styles.css,index.html}; scripts/ci/command-hub-ownership-guard.js; tests; docs/validation/<VTID>/; staging probes that pin ?v=.

<!-- plan:begin -->
Owner decisions (not to be re-argued): models are chosen only inside Kiro, from Kiro's own list; no catalog of our own, no Bedrock/DeepSeek/OpenAI/Qwen, Operator (LLM) threads unchanged. Kiro always provides a model list. Model selection must be simple. Owner rejected the previous version as over-complicated (special "no model" / credit-limit states, restart re-apply logic).

Design (the whole feature):
1. When the gateway opens a Kiro session it keeps the model list Kiro returns with the session (ACP `configOptions` entry with category `model`; the older `models` field if that is what Kiro sends) and the current model.
2. GET /api/v1/operator/kiro/sessions/:threadId/models returns that list and the current model. POST /api/v1/operator/kiro/sessions/:threadId/model {model_id} switches it through Kiro (`session/set_config_option`, or `session/set_model` on Kiro's v2 engine) and returns Kiro's updated list. exafy_admin, session owner only, same as the existing Kiro routes. One OASIS event `operator.kiro.model_selected`.
3. Command Hub: in a Kiro thread, a dropdown next to the Kiro badge showing Kiro's models with Kiro's names; picking one calls the POST. Each Kiro reply shows the model that answered.
4. Anything Kiro refuses (an unknown model, credits used up, any other error) is shown with Kiro's own error message through the existing Kiro error path. No extra states, no special cases of our own.

Not in this plan: no credit-limit detection of our own, no re-applying a choice after a session restart (a new session starts on Kiro's default, as in Kiro itself), no model catalog.

Tests: list parsing (configOptions and models shapes), switch (both methods, Kiro error passed through), routes admin/owner-only + OASIS event, dropdown fake-DOM test + screenshots; existing Kiro and Command Hub suites green. Staging read-only: the two routes answer 401 unauthenticated; served app.js contains the dropdown.
<!-- plan:end -->

## Rounds
- Round 1 (earlier, larger version): F1 major (protocol methods unverified) - accepted, cited kiro.dev/docs/cli/acp/ and agentclientprotocol.com/protocol/session-config-options; F2 major (listing would open a session) - accepted; F3-F7 minor - accepted.
- Round 2: all closed, CONVERGED.
- Round 3 (owner correction: Kiro always provides a model): credit-limit state added; F8 minor accepted; CONVERGED.
- Owner: "Model selection must be a piece of cake" - plan simplified to the version above (no credit-limit state, no restart re-apply, no extra states).
- Round 4 (simplified plan): verified against acp-client.ts, kiro-turn.ts, operator.ts, cicd.ts; no findings; CONVERGED.

## Owner approval
Approved by the owner in session 2026-10-08 ("Yes this approved"), plan hash above.

## Decisions taken inside the approved plan
- The dropdown is a native <select> (keyboard and screen-reader support built in), shown in a Kiro thread once its session exists; before the first message there is nothing to list, so nothing is shown.
- The model list is re-read after each Kiro turn (a session may have been opened or closed).
- On phones the dropdown is capped at 6.5rem so the title bar keeps its other controls.
- The VTID-04975 UI test's cache-bust check became "at or after the VTID-04975 version" (same pattern as VTID-04887), and the 14 staging probes that pin ?v= were repointed.
