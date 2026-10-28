# VTID-03848 — ORB: BackOffice assistant surface + admin overlay

VTID: VTID-03848
Spec: approved (generate → validate pass → quality-check pass 95 → approve; `outputs/g1-spec-*.json`).
Owner decision (2026-09-13, in conversation): "build the backoffice surface and admin overlay in VTID-G".
Scope: gateway only — `services/gateway/src/orb/live/surface.ts` (new), `services/ai-personality-service.ts` (two surface keys + voice defaults), `orb/live/instruction/live-system-instruction.ts`, `orb/live/tools/live-tool-catalog.ts`, `orb/live/session/live-session-controller.ts`, `routes/orb-live.ts`, `services/backoffice-voice-tools.ts` (new), `services/backoffice/command-orchestrator.ts` (new, extracted from `routes/backoffice-commands.ts`), `services/backoffice/erp-access-resolver.ts` (new, extracted from `routes/backoffice-access.ts`), tests, this pack. No migration, no frontend change (the ORB widget already sends `current_route`), no prod workflow touched. Stacked on VTID-03842 (#3291).

No route is added or mounted: the HTTP surface is unchanged; the voice surface is a new ORB tool set on an existing session path.

OASIS_PROOF: the only OASIS emitter this VTID touches is `audit()` in `services/backoffice/command-orchestrator.ts` (moved verbatim from `routes/backoffice-commands.ts`, VTID-03842): `emitOasisEvent({ vtid: 'VTID-03842', type: 'backoffice.<event>', source: 'gateway', surface: channel === 'voice' ? 'orb' : 'api', payload: { tenant_id, command_id, approval_id, … } })` fires once per real transition (`command.executed|failed|queued|rejected`, `approval.approved|rejected|refused`, `policy.updated`) — never on polling, heartbeats, or the voice catalog reads (`backoffice_list_commands`/`backoffice_my_access`/`backoffice_pending_approvals` emit nothing). The one new voice-side emission path is `backoffice_command` → `submitCommand(channel:'voice')`, asserted by `test/vtid-03848-orchestrator-voice-ceiling.test.ts` (a Commit-tier voice request is rejected before any bridge call; `emitOasisEvent` mocked and reached through the real orchestrator) and `test/routes/backoffice-commands.test.ts` (18/18 unchanged after the extraction — `expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'backoffice.command.executed' }))`). `nova_prewarm_skipped_work_surface` is a session diag (`emitDiag`), not an `oasis_events` row. Live `oasis_events` rows cannot be shown until #3291's migration is applied and the routes are on staging.

## Acceptance criteria

AC-1 — One surface resolver: `vitanaland | command-hub | admin | backoffice`, mobile always community, explicit surface wins
TEST: `test/orb/live/surface.test.ts` (17 cases incl. `/backofficex` and `/administration` not matching, mobile override, explicit override). The three former copies (instruction builder, controller telemetry, `deriveSurfaceRole`) now call it; `deriveSurfaceRole` maps backoffice → Navigator role `backoffice`, so the Navigator never offers community or admin routes there.

AC-2 — BackOffice persona overlay (`backoffice_orb`) and admin persona overlay (`admin_orb`) on their surfaces; community and Command Hub unchanged
TEST: `test/orb/live/instruction/work-surface-overlays.test.ts` — identity-lock line and base identity swap on `/backoffice/*` and `/admin/*`; `/health` keeps the companion; mobile on `/backoffice` keeps the companion; `/command-hub` keeps the engineering co-pilot. `test/orb/live/characterization/system-instruction.characterization.test.ts` snapshots unchanged (7/7). Both overlays are editable per tenant through the existing `ai_personality_config` surfaces (`VALID_SURFACE_KEYS` now lists them) — no migration needed, rows are optional overrides.
UI: n/a.

AC-3 — Strict separation of tools: community/developer tools are ABSENT (not merely discouraged) on the admin and backoffice surfaces; backoffice gains its own four tools; admin keeps admin tools only
TEST: `test/orb/live/tools/surface-gated-catalog.test.ts` (7 tests: backoffice = navigation + `search_knowledge` + `backoffice_*` + Google grounding, no `search_memory`/diary/events/admin tools; admin = navigation + `admin_*`/admin-domain tools, no community or backoffice tools; community and command-hub byte-unchanged; anonymous not widened). `test/orb/live/characterization/tool-catalog.characterization.test.ts` snapshots unchanged (4/4).

AC-4 — Memory scoping: no community brain/bootstrap context (profile, health, diary, activity, facts) is injected on admin or backoffice surfaces
TEST: `work-surface-overlays.test.ts` "community brain context is NOT injected" and the admin case (a bootstrap containing a sleep score and a diary line does not appear in the rendered instruction; the ACTIVITY AWARENESS override is skipped).

AC-5 — Voice ceiling is Draft, enforced by the same orchestrator the HTTP route uses, not by prompt wording
TEST: `test/vtid-03848-orchestrator-voice-ceiling.test.ts` (read and draft execute on the bridge with `actor.channel: 'voice'`; Commit and High-risk are rejected `voice_not_permitted` and never reach the bridge; audit rows recorded) and `test/vtid-03848-backoffice-voice-tools.test.ts` (8 tests: every tool denied off-surface and without identity; `backoffice_command` calls `submitCommand` with `channel: 'voice'`, `confirm: false`, a per-session-turn idempotency key; refused Commit returns the reason plus a next step; unknown type refused before the orchestrator; `list_commands` filtered by capability and tier-labelled; `pending_approvals` read-only and marks own requests; `my_access`).

AC-6 — Route refactor is behaviour-preserving
TEST: `test/routes/backoffice-commands.test.ts` (18) and `test/routes/backoffice-access.test.ts` (14) pass unchanged against the extracted `command-orchestrator.ts` / `erp-access-resolver.ts`; `test/orb/live/characterization/tool-dispatcher.characterization.test.ts` passes.

AC-7 — Nova Sonic sessions on a work surface never reuse the login-time prewarm (built with no route = community persona and tools)
TEST: `test/orb/live/prewarm/orb-live-prewarm-wiring.test.ts` (VTID-03779 shape pin updated to require the `&& !isWorkSurface(sessionSurface)` gate on the claim) and `test/orb/live/upstream/nova-bedrock-factory-memo.test.ts` (window widened for the added lines; invariant unchanged). A `nova_prewarm_skipped_work_surface` session diag is emitted on the skip. Cost: a cold start for operators on `/admin`, `/backoffice`, `/command-hub`.

AC-8 — No hardcoded spoken sentence (NEVER rule 41)
TEST: both new personality blocks are intent text only (no quoted example sentence, no per-language variant); `test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts` passes in the full run (`commands.log`).

AC-9 — Type-check + full suite
TEST: `outputs/tsc.txt`; `commands.log` full-suite tail.

## Not verified / owed

- Not heard on a real device: this session cannot place an ORB voice call. The overlays and gating are verified structurally (rendered instruction, catalog, dispatcher, orchestrator), not by a live conversation on `/backoffice`. The next real signal is a staging session from a BackOffice manager after #3284/#3291/this merge and the bridge provisioning.
- The Navigator has no `backoffice`-role rows in the nav catalog yet, so `navigate` on `/backoffice` answers with a clarification rather than a route until the wave-1 screens VTID registers them (BO-001..BO-063 exist on the frontend side only).
- Command Hub (`/command-hub`) deliberately keeps its existing catalog and community memory: the developer is also a member, and the owner's decision named admin and backoffice.
- Operator chat (text) is unchanged; it lives on the Command Hub surface. A BackOffice text chat is a screen for the wave-1 screens VTID and will call the same orchestrator with `channel: 'chat'`.
