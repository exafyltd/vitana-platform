# D. Vitana architecture assessment

ORB and voice, conversation intelligence, memory and knowledge, tool and agent access, and the Autopilot execution
chain. Where code and docs disagree, this section follows the code.

## 1. Entry points

| Touchpoint | Client | Gateway endpoints |
|---|---|---|
| Web app | V1 has no ORB client of its own. `V1:index.html:67`, `:92` loads `GW/frontend/command-hub/orb-widget.js` (6,505 lines) from the gateway. React wrappers: `V1:src/hooks/useOrbVoiceWidget.ts` (init, context updates, role prewarm), `useOrbFrontDoor.ts`, `src/lib/orbActivate.ts`. | `GET /api/v1/orb/live/transport`, WS `/api/v1/orb/live/ws` (default since VTID-03471) or SSE `/live/stream` + `POST /live/stream/send`; `POST /live/session/start`, `/prewarm`, `/stop`; `/session/continuity` |
| Command Hub | Same widget; `surface: 'command-hub'` hard-coded (`GW/frontend/command-hub/app.js:35365`) | same |
| Mobile (Expo) | Native client `V1:apps/mobile/src/orb/` (protocol, session, WS/SSE transports, duplex gate). Transport order in `select-transport.ts` (VTID-05179): dev override, then SSE latch, then server choice, then default `sse`. | same |
| LiveKit | Python worker `P:services/agents/orb-agent` | `GW/routes/orb-livekit.ts`: `/orb/livekit/token` (`:701`), `/orb/context-bootstrap` (`:981`), `/orb/session/commit-memory`; tools via `POST /api/v1/orb/tool` (`GW/routes/orb-tool.ts:94`) |
| Text, member | `V1:src/lib/coach-chat-api.ts:57` | `POST /api/v1/conversation/turn` (`GW/routes/conversation.ts:193`), `/stream` (`:815`), `/history/:threadId`, `/threads/active` |
| Text, operator | Command Hub Operator Console | `/api/v1/operator/chat`, `/chat/stream` (`GW/routes/operator.ts:809`, `:847`) |
| Legacy | none found [unverified] | `POST /api/v1/orb/chat` (`GW/routes/orb-live.ts:13819`), `/start`, `/audio`, `/text` (`:13533-13766`) |

## 2. Voice pipelines

- **Provider selection.** `selectUpstreamProvider` (`GW/orb/live/upstream/upstream-provider-selector.ts:406`) reads the
  env `ORB_LIVE_PROVIDER`, then the `system_config` row `voice.active_provider` (`:451-471`).
  - Vertex Live is gone since the GCP shutdown. `resolveWithoutVertex` (`:380-400`, VTID-03723) forces Nova Sonic.
  - If the language is blocked for Nova, it tries the sr/ru Vertex bridges (`tryVertexBridgeRescue`, `:536-560`), then the
    cascade.
  - The file header (`:1-64`) still describes Vertex as the default and is stale.
- **The pipelines:**
  - Amazon Nova Sonic: primary, en/de (`nova-sonic-live-client.ts`).
  - Cascade: Transcribe → Bedrock → Polly/Fish (`cascaded-live-client.ts`, `ORB_CASCADED_VOICE_ENABLED`).
  - Serbian and Russian Vertex bridges: VTID-04000 and VTID-04813, on a separate GCP project with a window ending about
    2026-12-16.
  - LiveKit, behind gates (`active-provider-resolver.ts`). Whether it carries production traffic is [unverified].
- **One controller for WS and SSE.** `GW/orb/live/session/live-session-controller.ts` (3,362 lines): `handleLiveSessionStart`
  (`:982`), `handleLiveStreamSend` (`:3082`), `handleLiveSessionStop` (`:2861`). A WS start goes through
  `handleWsStartMessage` (`orb-live.ts:18476`) → `startLiveSessionForWs` → the same function.

## 3. Session bootstrap (one voice session start)

1. **Reconnect detection.** `transcript_history`, `reconnect_stage` and `conversation_id` mark a reconnect (`:1110-1145`).
2. **Identity.**
   - JWT via `optionalAuth`; on WS via `verifyAndExtractIdentity` (VTID-01224).
   - A missing tenant is filled from the primary membership cache (`orb-live.ts:660-668`).
   - No tenant is read from the body.
3. **Assistant Profile.** `resolveAssistantProfile` from the declared surface and view role (`:1179-1193`). Gap: no permission check on the declared surface (plan `mt-track-s-authz`).
4. **Context, branch by surface.**
   - **Work surface** (`:1384-1443`): admin briefing plus `buildWorkSurfaceKnowledge`. The member brain is skipped.
     `WORK_SURFACE_CONTEXT_MARKER` keeps member content out of the prompt (`session-profile.ts:48`).
   - **Member surface** (`:1445-1660`): `buildBootstrapContextPack` (`orb-live.ts:3145`, 5-minute cache), memory via
     `fetchMemoryContextWithIdentity` (`:3239`), last-session info, and role clamping (`:1550-1623`).
5. **Decision context.** `compileAssistantDecisionContext` (`GW/orb/context/compile-assistant-decision-context.ts:87`)
   runs the continuity, concept mastery, journey stage, pillar momentum, interaction style and match journey providers
   in parallel. It never throws, and source health is reported (`context-source-health.ts`).
   - `context-compiler.ts` is a skeleton. Its only caller is `routes/voice-journey-context.ts:74`.
6. **Greeting.** The greeting ladder still lives in `orb-live.ts`. The intended single brain,
   `services/conversation/decide-conversation-flow.ts`, has no live-transport caller found [unverified].
7. **Instruction.** `buildLiveSystemInstruction` (`GW/orb/live/instruction/live-system-instruction.ts:463`), the bootstrap
   packer, then `enforceInstructionBudget`.
8. **Tools.** `buildLiveApiTools` (`GW/orb/live/tools/live-tool-catalog.ts:108`), then `applySurfaceGate` (`:255`), then a
   provider byte budget. Nova declares about 43 of about 291 member tools, with a 64 KB budget [doc, code comments].
   `find_tool`/`use_tool` (`ORB_TOOL_SELECTION_ENABLED`, off) reach only tools already in the session catalog.
9. **Prewarm.** `POST /live/session/prewarm` and `nova-session-prewarm.ts` (VTID-03779) open a Nova stream after login.
   A prewarm fingerprint check governs reuse.

## 4. Conversation continuity

**Identifiers.**
- The server creates `session_id`.
- The client carries `conversation_id`, pinned at `:2047-2051` (VTID-02020).
- Command Hub sessions also bind `operator_thread_id`.
- Text threads come from `getOrCreateThread` (`GW/routes/conversation.ts:160`), are held in memory, and their messages
  persist to `conversation_messages`.

**Recovery.**
- A transport reconnect withholds the wake-brief (`:827-845`).
- `/session/continuity` keeps `orb_session_state` for 15 minutes (`orb-live.ts:16191-16247`).
- Cross-instance forwarding is in `cross-task-forward.ts`, because sessions live in memory per ECS task.
- The widget handles a cross-instance 404 (`orb-widget.js:4473-4509`).
- `session-failure-classifier.ts` classifies session failures.

**Session end.** `finalizeLiveSession` (VTID-04353) runs on every end path. It does four things:
- forces fact extraction plus a `memory_items` session summary;
- upserts `user_session_summaries`, keyed by `user_id + session_id` with no tenant (`services/guide/session-summaries-repository.ts:28`);
- writes open threads and promises;
- emits one `conversation.session.finalized` event.

**Extraction.** Cognee is removed (VTID-04344). `services/inline-fact-extractor.ts` is the only extractor. The atlas
still points at `cognee-extractor-client.ts`, which no longer exists.

**Voice and text use two context paths** (three counting legacy `/orb/chat`).

| Step | Voice | Text (`/conversation/turn`) |
|---|---|---|
| Identity | JWT, then primary-tenant cache | JWT bound by `bindConversationBodyIdentity`; another tenant needs a membership check |
| Role | profile + `resolveEffectiveRole` | **body `role`**; verified only for `developer_assistant` (plan `mt-track-s-authz`) |
| Context | `buildBootstrapContextPack` + decision context | retrieval router + `buildAssistantMemoryContext` |
| Working context | route, surface, trail | fixed `ui_context` |
| Model and tools | live instruction + live catalog | `processWithGemini` (llm-router, Bedrock) + `getGeminiToolDefinitions(role)` |
| Shared | data stores, `dispatchOrbTool`, `compileAssistantDecisionContext`, summaries | same |

## 5. Memory and knowledge

| Store | Read filter | Write path | Evidence |
|---|---|---|---|
| `memory_items` | `tenant_id` + `user_id` | `writeMemoryItemWithIdentity` | `GW/services/orb-memory-bridge-repository.ts:18-152`; `orb-memory-bridge.ts:630`, `:760` |
| `memory_facts` | `tenant_id` + `user_id`, `superseded_by IS NULL` | `write_fact` RPC through `services/memory/remember.ts` (Identity Lock, VTID-04364) | `orb-memory-bridge.ts:985` |
| `memory_diary_entries` | tenant + user | — | `orb-memory-bridge-repository.ts:161-172` |
| `diary_entries`, `ai_memory` | **user only** | — | `:178-205` |
| `relationship_nodes` / `relationship_edges` | via the memory broker | `memory-broker(-repository).ts` | — |
| `user_session_summaries` | user + session | finalize | above |
| Developer memory | `dev_agent_memory`, `dev_bootstrap_request_context` RPC | — | `orb-memory-bridge.ts:1322` |
| Knowledge base | `search_knowledge_docs` RPC, with no tenant filter seen (a global KB) | — | `GW/services/knowledge-hub.ts:67-80` |
| Tenant KB overlay | `searchTenantDocs(tenantId)`, baseline docs, per-tenant opt-outs | — | `GW/services/tenant-kb/tenant-kb-repository.ts:19-27`, `:80`, `:90` |
| Maxina manual | 102 files at `GW/kb/instruction-manual/maxina`, served by `GW/kb/kb-router.ts` | — | — |

**Scoping gaps:**
- `ROLE_REGISTRY.memoryScope` (`member | developer | none`) is never read outside `role-registry.ts`. Work-surface
  isolation comes from the bootstrap branch and the marker, not from a memory policy.
- Memory continuity across tenants is undecided (C §4). Reads are partitioned by tenant, while summaries, diary and
  `ai_memory` are not. The mix is inconsistent.
- **Dev fallback identity.** When `isDevSandbox()` is true, which happens when `ENVIRONMENT`/`VITANA_ENV` contains "dev"
  or "sandbox", anonymous memory reads and writes fall back to one shared `DEV_IDENTITY` (`orb-live.ts:614-640`,
  `orb-memory-bridge.ts:861-881`). mt-identity removes the `…0001` literals.
- **Legacy `/orb/chat`** builds its prompt from client `meta.tenant`/`meta.role` (`orb-live.ts:13983-13989`); no current caller found [unverified].
- **Consent-gated paths exist.** `report_to_specialist` uses a two-gate RPC over the user's raw turns
  (`orb-tools-shared.ts:636-680`); also `remember-confirm-gate.ts` and `calendar-write-guard.ts`.

## 6. Tools and agent access

| Element | Today | Evidence |
|---|---|---|
| Catalog | 70 inline declarations plus domain declarations. Admin and developer catalogs are added when `roleGetsPrivilegedVoiceTools(role)` is true. About 399 handler names live in `services/orb-tools/*`. `GW/services/tool-manifest.json` lists 686 tools with surface, category, role and status. | `live-tool-catalog.ts:2885-2911` |
| Surface gate | vitanaland: member delegation; command-hub: allowlist; commerce gate; admin/backoffice allowlist | `live-tool-catalog.ts:143-255` |
| Dispatcher | `dispatchOrbTool` (`GW/services/orb-tools-shared.ts:5520`) for voice, text and LiveKit. Unknown tool → error. Records the decision. **Role-policy check in shadow only** (`:5536-5550`, `FEATURE_ROLE_POLICY_ENFORCE` off). | — |
| Handler gates | `developerGate`, `adminGate`: role-string checks (plan `mt-track-s-authz`) | — |
| Delegation | `orb/delegation`: provider router plus executor using the member's own provider credentials (15 s timeout). `operator_delegate` (Command Hub) runs an Operator turn. `delegate_to_agent` uses the orchestrator dispatcher (§7). | `GW/orb/delegation/*`; `GW/orb/live/tools/delegation-tools.ts` |
| Specialist hand-off | Devon via `switch_persona` / `report_to_specialist`. Devon is the only enabled specialist. Voice-gender rule 42a/b applies. | `live-system-instruction.ts:799-800` |
| Autopilot from ORB | `tool_activate_recommendation`, `tool_create_index_improvement_plan`, `autopilot-controller-tools.ts`, `community-autopilot-tools.ts` | `orb-tools-shared.ts:1642`, `:2838` |
| Connectors | `executeCapability({userId, tenantId: id.tenant_id ?? ''})`: the tenant can be an empty string. Providers: Google, Microsoft, Apple, Fitbit, Oura, Strava, Terra, Vital, DoctorBox, vitana-hub. | `orb-tools-shared.ts:1149-1153`; `GW/connectors/runtime/dispatcher.ts` |

## 7. Autopilot and execution chain

| System | Purpose | Trigger | Ledger | Flags (default) | Status |
|---|---|---|---|---|---|
| Dev Autopilot | Find, plan and ship fixes as PRs | `DEV-AUTOPILOT.yml` scan (07:00 and 19:00); gateway ticks `autoApproveTick`, `lazyPlanTick`, `backgroundExecutorTick` (`GW/services/dev-autopilot-execute.ts:3719`, `:4083`, `:2896`) | `dev_autopilot_runs/_plan_versions/_executions/_outcomes`; `vtid_ledger` rows with `source: 'dev-autopilot-auto-approve'` | `DEV_AUTOPILOT_EXECUTOR_ENABLED` on unless `'false'`; PR approval hold pinned on staging only | live |
| Operator Console → Dev Autopilot | Turn an operator sentence into a PR | console turn or `operator_delegate` | same plus `operator_threads` | `OPERATOR_EXECUTION_ONRAMP_ENABLED` off by default | built; covered by `test/vtid-04465-operator-pipeline-regression.test.ts` |
| AP-xxxx automations | 150 automations (144 implemented) | heartbeat loop, cron, events, manual | `automation_runs` (`tenant_id NOT NULL`; no user, role or surface) | arm check; shadow-unsafe skip | live code, shadow on staging |
| Community Autopilot | Member suggestions with typed actions | scan; member confirmation | `agent_runs` (plane `community_autopilot`) with principal user, tenant, role and channel | `COMMUNITY_AUTOPILOT_SCAN_ENABLED` | live code |
| Orchestrator v2 | Agent-as-tool, delegation jobs, run ledger | `delegate_to_agent` | `agent_runs`, `agent_run_steps`, `agent_run_signals`, view `agent_runs_unified` | `ORCHESTRATOR_DELEGATION_PERSIST_ENABLED`; policy and budgets shadow only (`GW/routes/orchestrator.ts:9-17`) | partly built (the plan doc says nothing is built, which is stale) |
| Worker orchestrator | Legacy claim plane | `POST /api/v1/worker/orchestrator/tasks/:vtid/claim` | `vtid_ledger` claim columns | allowlist `isAutonomousExecutionTask` (`GW/routes/worker-orchestrator.ts:1087-1102`) | legacy |
| Autopilot event loop | Polling loop | — | — | `AUTOPILOT_LOOP_ENABLED` off unless `'true'` (`GW/index.ts:1782`) | off by default |
| Project Manager | Observe and decide; merge under §7b | ticks | — | `PM_AGENT_ENABLED` off; `PM_MODE=live` on staging only | staging |
| Jev | TypeSafe decision adapter (not an executor) | gates | — | inert without a key | dark |
| Kiro runner | Kiro coding sessions for the Operator | Operator | `kiro_runs`, `kiro_run_events` | `KIRO_RUNNER_TOKEN` | admin only |

**Agent registry.** `agents_registry` v2 (`20260923120000…sql:14-32`) has card columns: skills, domains, `roles_allowed`,
`surfaces_allowed`, `llm_stage`, budgets, owner, `eval_suite`, `enabled`.
- Only `enabled` is enforced (`assertAgentEnabled`).
- No execution path selects an agent by skill, domain or role.
- Several seed rows point at directories that no longer exist (cognee-extractor, conductor, crewai-gcp).

**Traceability** (directive §3.5, §5):

| Record | User | Tenant | Role | Surface | Module | Run id | Verification |
|---|---|---|---|---|---|---|---|
| `vtid_ledger` | thread label only (`requested_by`) | `tenant TEXT DEFAULT 'vitana'` (not a tenant UUID) | — | — | `module` (coarse) | VTID | status only |
| `oasis_events` | `actor_id` when passed | **no column** | `actor_role` when passed | `surface` when passed | `module` | VTID | `staging.verify.*` events |
| `agent_runs` | `user_id`, `principal` | `tenant_id` | in `principal` | `principal.channel` | — | id, `parent_run_id`, `root_run_id` | — |
| `dev_autopilot_executions` | `approved_by` (UUID) | — | — | — | — | id, `parent_execution_id` | `failure_stage` |
| `automation_runs` | `trigger_source` | `tenant_id` | — | — | `automation_id` | id | — |

No single id links an ORB turn to a tool call, an execution run and verification evidence. The `conversation_turn_id`
column on `oasis_events` is referenced only in `upstream-message-handler.ts`.

**Governance on this chain:**
- `isExecutionArmed` treats a missing control row as **armed** (`GW/services/system-controls-service.ts:440-463`).
- `POST /api/v1/governance/evaluate` **fails open**: if Supabase is missing or the rules fetch fails, it returns
  `allowed: true` (`GW/controllers/governance-controller.ts:84-106`).
- The Operator `run_task` logs its evaluation on the placeholder `VTID-DEV-AUTOPILOT`, with no actor
  (`GW/services/gemini-operator.ts:1723-1742`).

## 8. Historical ORB VTIDs (directive §6)

| VTID | What it is | Status today |
|---|---|---|
| VTID-01216 | Unified Conversation Intelligence layer (`GW/routes/conversation.ts:2`) | **Wired.** `/api/v1/conversation` serves V1 coach chat. Memory moved to the orchestrator and broker (VTID-02058), LLM to the router on Bedrock, identity binding to VTID-04447. The `modelUsed='gemini-2.5-pro'` label at `:524` is stale. |
| VTID-01219 | Gemini Live voice-to-voice | Code present. Vertex is no longer a destination except the sr/ru bridges (VTID-03723). Replaced by Nova Sonic. |
| VTID-01222 | ORB WebSocket server `/orb/live/ws` (`GW/index.ts:1715-1727`) | **Wired.** Default transport since VTID-03471; its start logic was replaced by `ws-start-adapter.ts`. |
| VTID-01223 | Playwright MCP visual verification (`GW/routes/visual-interactive.ts`) | Not ORB-related |
| VTID-01224 | JWT-first identity for memory isolation, bootstrap context pack, tool calling | **Wired and extended** (`live-session-controller.ts:1153`, `:1446-1657`; `orb-live.ts:292-320`) |

## 9. Flags that govern ORB behaviour

- **Provider:**
  - `ORB_LIVE_PROVIDER` and `voice.active_provider`.
  - `NOVA_SONIC_ENABLED` and `NOVA_SONIC_GLOBAL_ENABLED`, both exact `'true'`.
  - `ORB_CASCADED_VOICE_ENABLED`, `VERTEX_SERBIAN_BRIDGE_ENABLED`, `VERTEX_RUSSIAN_BRIDGE_ENABLED`,
    `ORB_LIVEKIT_CANARY_ENABLED`: all default off.
- **Tools:** `ORB_TOOL_SELECTION_ENABLED`, `FEATURE_ROLE_POLICY_ENFORCE`, `ORB_DEVON_PRECONNECT_ENABLED`: all off.
- **Memory and brain, on unless `'false'`:** `ORB_VOICE_SESSION_SUMMARY_ENABLED`, `BRAIN_CONTEXT_PACKER`, the remember and
  recall holds and backstops.
- **Registry:** `GW/services/conversation/conversation-flag-registry.ts`.
- **`ORB_WS_TRANSPORT`** goes through `isFeatureLive`. Its default was not checked [unverified].

## 10. Gaps against directive §3.4, §3.5 and §6

1. **Context paths.** Voice and text resolve context differently (§4). The directive needs one resolution for every
   touchpoint.
2. **Role and authorization.** The served role comes from the declared surface, and the dispatcher's role policy is
   shadow-only. Capability resolution therefore rests on role strings (plan `mt-track-s-authz`).
3. **Memory scope.**
   - `memoryScope` is not enforced.
   - Tenant partitioning is inconsistent across stores.
   - The KB is global, with a tenant overlay used only by some readers.
4. **Mid-session changes.** A surface or role change restarts the conversation, which keeps context consistent. It also
   means continuity across a role switch lives in the summaries and continuity row, not in the session.
5. **Traceability.** No correlation id spans ORB → execution → verification, and `oasis_events` has no tenant column.
6. **Hot files.** `orb-live.ts` (19,278 lines) is the hub for routes, the WS server, the bootstrap pack, legacy text
   chat and tool execution. Every ORB change collides there, including mt-packs `persona-pack`.
