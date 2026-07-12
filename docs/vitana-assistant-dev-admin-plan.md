# Vitana Assistant for Developer & Admin Roles — Extended Development Plan

**Status:** IMPLEMENTED (first full pass on this branch — see "Implementation Status" below).
**Scope:** `exafyltd/vitana-platform` (gateway/ORB backend) + `exafyltd/vitana-v1` (frontend surfaces)
**Date:** 2026-07-12

---

## 0a. Implementation Status (this branch)

Shipped in this branch (all gateway-side; frontend needs no change — the ORB widget already sends
`current_route`, which drives surface resolution):

| Plan phase | Delivered |
|---|---|
| **0 — Role cutover** | `admin_orb` persona (defaults; DB-overridable via the existing personality admin); admin-surface overlay in `live-system-instruction.ts`; community blocks (proactive leadership, guided journey, index coaching, proactive-opener override) gated off operational surfaces and replaced by a `BRIEFING-FIRST OPENING` protocol; `dev_orb` greeting/tools updated to briefing-first + two-step confirm; `assistant-role-registry.ts` developer/admin allowlists reconciled to real tool names; scoped enforcement `shouldBlockToolRoleAware` wired into `dispatchOrbTool` behind `FEATURE_ROLE_AWARE_ASSISTANT_ENV` (community stays shadow-only) |
| **1 — Dev briefing** | `services/assistant-briefing/{briefing-types,briefing-cache,developer-briefing-service}.ts` (9 timeout-bounded sources, deterministic ranking, next-step derivation); `GET /api/v1/assistant/briefing/developer`; session-start injection for `/command-hub` sessions; `dev_get_briefing` + T0 tools (`dev_list_pending_heals`, `dev_list_findings`, `dev_list_executions`, `dev_list_test_runs`, `dev_get_governance_controls`) |
| **2 — Dev actions** | `orb-tools/action-guard.ts` (brake control `assistant_actions_enabled`, two-step confirm, per-session rate limit, OASIS `vtid.decision.assistant_action` audit); T1 `dev_run_test_suite`/`dev_generate_finding_plan`/`dev_snooze_finding`/`dev_allocate_vtid`; T2 `dev_approve_heal`/`dev_reject_heal`/`dev_rollback_heal`/`dev_approve_finding_execute`/`dev_reject_finding`/`dev_cancel_execution`/`dev_publish_to_prod` (caller-JWT, exafy-admin enforced server-side)/`dev_disarm_control` (disarm-only asymmetry) |
| **3 — Admin briefing** | `admin-briefing-service.ts` (7 tenant-scoped sources, moderation-SLA/insight/alert/funnel ranking); `GET /api/v1/assistant/briefing/admin/:tenantId` behind `requireTenantAdmin`; session-start injection for `/admin` sessions (supersedes the legacy insights-only block, which remains as fallback); T0 `admin_get_briefing`/`admin_get_overview`/`admin_list_moderation_queue`/`admin_get_signup_funnel`/`admin_find_member`/`admin_list_invitations` |
| **4 — Admin actions** | `admin_invite_member`/`admin_revoke_invitation` (T1), `admin_approve_content`/`admin_reject_content`/`admin_grant_role`/`admin_revoke_role` (T2) — all through the action guard, all self-calling tenant-admin routes **with the caller's own JWT** (tenant isolation enforced by the platform, tenantId never taken from model output; developer/infra grants blocked by voice per VTID-01230) |
| **5 — Tests** | 25 new unit tests (briefing ranking determinism, action-guard state machine, registry↔tool-name reconciliation incl. cross-lane isolation); all 51 existing orb/live suites (697 tests) green; community instruction snapshots byte-identical; `authenticated-admin` tool-catalog snapshot intentionally updated |

Not yet shipped (follow-ups): proactive in-session alerts via the devhub SSE feed, scheduled push
briefings, LLM-judged eval suites wired into `/api/v1/testing`, Command Hub metrics tab extension,
exafy cross-tenant briefing variant.

Rollout: merge → staging auto-deploy → set `FEATURE_ROLE_AWARE_ASSISTANT_ENV=staging-only` on
`gateway-staging` → verify both lanes by voice → PUBLISH + graduate the flag to `staging+prod`.
Emergency brakes: disarm `assistant_actions_enabled` (kills all T1/T2 dispatch) or unset the flag.

## 0. Executive Summary

The Vitana Assistant (ORB, voice-first via Gemini Live + text channels) is today built for the
**Community** user role: its system instruction, behavioral blocks, memory retrieval, and tool
catalog are wellness/community-shaped. This plan turns it into a **role-aware assistant** with two
new first-class lanes:

1. **Developer Assistant** — the developer talks to Vitana inside the Command Hub and uses it to
   *develop the Vitana system itself*: drive self-healing, self-improvement (dev-autopilot),
   supervision, testing, deployments, and the full VTID develop→approve→execute→verify→deploy loop.
2. **Admin Assistant** — the tenant admin (or Exafy super-admin) talks to Vitana to *manage and
   supervise their tenancy-isolated space*: members, moderation, content/knowledge, notifications,
   analytics, autopilot supervision — always scoped to the tenant.

Both lanes open every session with a **structured briefing**:
- **Status** — what is the current health/state of my domain?
- **What's going on** — what happened since I last talked to you?
- **Immediate attention** — what needs action right now (ranked)?
- **Next step** — the single recommended next action, and guided decision support to execute it.

The critical insight from the codebase analysis: **almost everything the assistant needs already
exists as governed APIs.** The Command Hub exposes ~670 API call sites across 19 modules;
self-healing, dev-autopilot, testing, governance, deploy/publish, and ~40 admin route files are all
API-drivable. The assistant also already has the *seams* for role awareness (a `dev_orb` persona
overlay, role-gated tool injection, and a shadow role registry behind a feature flag that was never
cut over). This plan is therefore mostly **activation + orchestration + briefing synthesis**, not
greenfield construction — which dramatically reduces risk and respects the "never rebuild systems
that already exist" rule.

---

## 1. Current-State Analysis (Codebase Findings)

### 1.1 The assistant today (community-shaped, with dormant role seams)

End-to-end voice flow: `POST /api/v1/orb/live/session/start` → JWT identity (`user_id`,
`tenant_id`, `active_role` from `user_tenants` reconciled with `role_preference`) → SSE stream →
system instruction assembly → Gemini Live (Vertex) with function declarations → tool dispatch →
async memory extraction (Cognee → `memory_facts`/`memory_items`/`relationship_nodes`).

| Seam | File | State |
|---|---|---|
| System-prompt builder | `services/gateway/src/orb/live/instruction/live-system-instruction.ts` → `buildLiveSystemInstruction(...)` | Role header + `role_descriptions[activeRole]` exist, but ~all behavioral blocks (Vitana Index, Guided Journey, matchmaking…) are community-only and are emitted to every role |
| Surface resolution | `resolveSurface()` in the same file | `/command-hub` → `command-hub` surface (applies `dev_orb` overlay ✅); `/admin` → `admin` surface (**branch exists, no overlay — behaves as community**) |
| Persona registry | `services/gateway/src/services/ai-personality-service.ts` (`ai_personality_config` table + `PERSONALITY_DEFAULTS`) | `voice_live`, `dev_orb` (voice-capable), `developer_assistant` (autonomous, text-only), `operator_chat`, tenant override layer via `getEffectiveConfig` |
| Tool catalog | `services/gateway/src/orb/live/tools/live-tool-catalog.ts` → `buildLiveApiTools(mode, route, activeRole)` | Community tools always declared; `ADMIN_TOOL_SCHEMAS` (`services/admin-voice-tools.ts`) + `DEVELOPER_TOOL_DECLARATIONS` (`services/orb-tools/developer-tools.ts`) injected only for `admin|exafy_admin|developer`, with server-side re-check (`developerGate()`) |
| **Role registry (the intended home)** | `services/gateway/src/services/intelligence/assistant-role-registry.ts` (VTID-03240) | **Shadow-only.** Per-role `AssistantRoleProfile`: identity, tone, `tool_allowlist`/`denylist` (closed-world, deny-precedence), `memory_policy` (read/write categories), `context_source_allowlist`, `eval_suites`. Cutover gated behind `FEATURE_ROLE_AWARE_ASSISTANT_ENV` — never shipped |
| Memory scoping | `services/orb-memory-bridge.ts`, `retrieval-router.ts`, `context-pack-builder.ts` | `active_role` is **stamped on every memory write** but reads are tenant+user scoped only; retrieval routing is keyword-based, not role-based |
| Briefing precedents | `services/admin-scanners/briefing.ts`, `services/guide/morning-brief-scheduler.ts`, `services/assistant-continuation/providers/login-briefing.ts` | Community "new day overview" + admin scanner briefings exist as patterns to build on |

### 1.2 The developer plane (Command Hub) — what the Developer Assistant can drive

Command Hub: `services/gateway/src/frontend/command-hub/` (vanilla JS SPA, `app.js` ~54k lines,
19 nav modules). Everything below is a **real, governed API** today:

| Capability | API surface | Key routes/services |
|---|---|---|
| **Self-Healing** | `/api/v1/self-healing/*` — health, report, active, history, metrics/summary, **pending-approval, approve, reject, rollback/:vtid, kill-switch**, verify/:vtid, snapshots | `routes/self-healing.ts`; pipeline: `self-healing-probe.ts` → `self-healing-diagnosis-service.ts` (6-layer diagnosis) → `self-healing-injector-service.ts` → triage/snapshot/spec → `self-healing-reconciler.ts` |
| **Self-Improvement (Dev-Autopilot)** | `/api/v1/dev-autopilot/*` — scan, runs, scanners, findings lifecycle (`generate-plan`, `approve-auto-execute`, `reject`, `snooze`, batch), executions (+cancel/bridge/lineage), queue, config, kill-switch | `routes/dev-autopilot.ts`; engine `dev-autopilot-execute.ts` **actually writes branches, opens PRs, watches CI, merges, deploys**; `autopilot-worker` Cloud Run Job (Claude CLI executor) |
| **Supervision** | `/api/v1/supervisor/summary`, `/api/v1/ops/action-required`, `/api/v1/autonomy/pulse`, ops-overview-timeseries, `/api/v1/devhub/feed` (SSE ticker) | `supervisor-summary.ts`, `ops-action-required.ts`, `autonomy-pulse.ts`, `autonomy-trace.ts`, `devhub.ts` |
| **Testing** | `/api/v1/testing/*` — suites, run, runs/:id, cycles, orb-monitor status/trigger; Test Contract Registry (`test-contracts*.ts`, VTID-02954) | `routes/testing.ts`; verification engine `services/agents/vitana-orchestrator/` |
| **VTID lifecycle** | `/api/v1/vtid/*` (allocate, allocate-internal, create, list, :vtid), `/api/v1/specs/:vtid/{generate,validate,quality-check,approve}`, `/api/v1/oasis/vtid/terminalize` | `routes/vtid.ts`, `routes/specs.ts`, `vtid-terminalize.ts` |
| **Governance** | `/api/v1/governance/{evaluate,rules,violations,proposals,history}`, `/api/v1/governance/controls[/:key]` (the 3 kill-switches: `autopilot_execution_enabled`, `vtid_allocator_enabled`, autopilot loop) | `routes/governance.ts`, `governance-controls.ts`, `system-controls-service.ts` |
| **CI/CD & deploy** | `/api/v1/cicd/*` (create-pr, safe-merge, autonomous-pr-merge, approvals), `/api/v1/operator/*` (**publish** = staging→prod promote, revert, revert-both, promote, abort-canary, revisions, deployments) | `routes/cicd.ts`, `routes/operator.ts`, `deploy-orchestrator.ts`, `github-service.ts` |
| **OASIS events** | `/api/v1/oasis/{emit,tasks,specs,vtid-ledger}`, event stream APIs | `oasis-event-service.ts` (single emit choke-point), `oasis-projector` service |

**Known gaps the plan must respect:** `worker-runner`'s LLM is describe-only (real code authoring
only via dev-autopilot execute path); `oasis-operator` has no live source in-repo; `deploy-watcher`
is a stub; stranded-PR hazard (a finding with an existing unmerged PR must not be re-driven —
`dev-autopilot-execute.ts:364` guard; past incident: 530 flooded PRs); post-cutover (2026-06-08)
**prod is only reachable via PUBLISH or the escape-hatch script** — auto paths land on staging.

### 1.3 The admin plane — what the Admin Assistant can drive

Two admin concepts, both enforced server-side:
- **`exafy_admin`** (super-admin, cross-tenant): JWT `app_metadata.exafy_admin`, checked by
  `requireExafyAdmin` (`middleware/auth-supabase-jwt.ts`) in ~42 route files + `admin_read_all_*`
  RLS policies (`supabase/migrations/20260227000000_admin_rls_policies.sql`).
- **Tenant `admin`** (`user_tenants.active_role='admin'`, single tenant): enforced by
  `middleware/require-tenant-admin.ts` — JWT `tenant_id` must equal the `:tenantId` route param
  (cross-tenant → 403).

Tenant isolation is three-layered: Postgres RLS (`current_tenant_id()` request context on 33+
tables), JWT `app_metadata.active_tenant_id`, and gateway middleware. **The Admin Assistant must
inherit exactly this model — it acts with the caller's token, so isolation is enforced by the
platform, never by the prompt.**

API-drivable admin capabilities today (`routes/admin-*.ts` + `routes/tenant-admin/*`):
users/roles (list, lookup, grant/revoke via `/api/v1/roles`), tenants (list/detail/members,
settings PUT), invitations (create/revoke), moderation (reports; tenant content approve/reject/
flag), community admin (meetups/groups/live-rooms/creators), knowledge base CRUD + reindex,
notifications compose/broadcast, marketplace moderation, analytics/KPIs/health-index/insights
(approve/reject/dismiss/snooze), overview (summary, at-risk, activity, alerts), audit logs
(actions/access), autopilot supervision (settings, bindings, runs, waves, recommendations),
memory ops, wallet admin, self-healing supervision.

**Admin-plane gaps:** frontend `AdminGuard` under-gates (staff-level — must not be treated as an
authorization signal); no unified admin API namespace (~40 scattered files with duplicated
`verifyExafyAdmin` helpers); audit is fragmented across ~15 `*_audit` tables with no consolidated
query API; several settings screens (branding, feature flags, domains, billing) have only a
generic settings-blob PUT.

---

## 2. Target Experience

### 2.1 Developer Assistant (surface: `/command-hub`, role: `developer`)

**Session opening — the Developer Briefing (always, before anything else):**

> *"Good morning. **Status:** staging is green (rev gateway-staging-00341), prod is 2 releases
> behind staging. All three governance controls are armed. **Since yesterday:** dev-autopilot
> completed 3 executions (2 merged, 1 failed CI on `orb-live` types), self-healing auto-resolved 2
> incidents and has **1 fix awaiting your approval** (VTID-03412, gateway 500s on
> `/api/v1/live/rooms`, diagnosis: missing route mount after refactor). **Immediate attention:**
> (1) that pending self-healing approval — snapshot and diff are ready; (2) E2E-ORB-MONITOR has
> failed twice in a row. **Recommended next step:** review and approve VTID-03412 — say 'show me
> the diff' or 'approve it'."*

Then the developer can *converse the dev loop*: "scan the repo for i18n regressions", "generate a
plan for finding #82 and walk me through it", "approve and execute", "what's blocking VTID-03398?",
"run the voice test suite", "roll back the last self-healing fix", "publish to prod" (guarded), "arm
the kill switch on dev-autopilot".

### 2.2 Admin Assistant (surface: `/admin`, role: `admin` — tenant-scoped)

**Session opening — the Admin Briefing (tenant-scoped, always):**

> *"Here's Maxina right now. **Status:** tenant health index 82 (▲3 this week), 1,204 active
> members. **Since yesterday:** 34 signups (6 stuck in the funnel), 12 new content reports,
> autopilot ran 4 automations (all within guardrails). **Immediate attention:** (1) 3 content
> reports are >24h old and SLA-breaching; (2) an insight is pending your decision: 'engagement drop
> in Live Rooms, propose notification campaign'. **Recommended next step:** clear the 3 overdue
> reports — say 'show me the first report' and I'll walk you through approve/reject."*

Then the admin can manage the tenant: "invite anna@… as staff", "reject that report and notify the
author", "compose a notification to members inactive 30 days" (guarded), "snooze that insight for a
week", "who got the admin role this month?" (audit), "pause autopilot automations for the weekend".

### 2.3 Interaction principles (both roles)

1. **Briefing-first** — every session opens with Status → What's going on → Immediate attention →
   Recommended next step. Short, ranked, decision-oriented; deltas since the last session (using
   session continuity that already exists via `lastSessionInfo`).
2. **Guided execution** — for any action the assistant proposes, it presents *what will happen,
   what gate applies, and how to reverse it*, then asks for explicit confirmation for anything
   non-read-only. It never chains destructive actions.
3. **Governance is physics, not policy** — the assistant calls the same governed endpoints humans
   do (its token = the caller's token). `EXECUTION_DISARMED`, kill-switches, spec approval,
   tenant-admin middleware, and RLS gate the assistant identically. The prompt is a UX layer, not a
   security layer.

---

## 3. Architecture

### 3.1 Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Activate `assistant-role-registry.ts` as the single source of role behavior** (cut over `FEATURE_ROLE_AWARE_ASSISTANT_ENV` for `developer` and `admin` surfaces first, community unchanged) | The registry was explicitly built for this (VTID-03240) — identity, tone, tool allow/deny, memory policy, context sources, eval suites per role. Activating it beats adding a third ad-hoc mechanism |
| D2 | **One assistant, role lanes — not new assistants** | Reuse ORB session/transport/memory stack; converge the text-only `developer_assistant` persona and `dev_orb` voice overlay into the `developer` role profile; add `admin_orb` mirroring `dev_orb`. Avoids rebuilding (Always-9) and keeps the Operator Console brain separate |
| D3 | **New Briefing Engine as a read-only aggregation service** with two endpoints (developer/admin), consumed by session-start injection AND exposed as a tool (`get_briefing`) for mid-session refresh | Briefing must be deterministic, fast (parallel fan-in, per-source timeout, cached), and testable independent of the LLM |
| D4 | **Tool tiers with confirmation policy**: T0 read → T1 reversible write (confirm) → T2 destructive/outward (explicit confirm + governance evaluate + OASIS decision event) → T3 forbidden-to-assistant (governance-control writes limited to disarm-only, no bypass header, no direct DB) | Matches defense-in-depth; prevents the assistant from becoming a governance bypass |
| D5 | **Admin assistant is tenant-scoped by construction** — tools call `/api/v1/admin/tenants/:tenantId/...` with tenantId taken from the JWT identity, never from model output; exafy_admin gets a cross-tenant superset | Tenant isolation must not depend on the model behaving |
| D6 | **Role-gate the community prompt content** — wrap Vitana Index / Guided Journey / matchmaking blocks in `surface === 'vitanaland'` conditions | Today these leak into every role's prompt: token waste + wrong behavior on dev/admin surfaces |
| D7 | **Every assistant-initiated action emits an OASIS decision event** (`vtid.decision.assistant_action` with role, tool, args hash, confirmation evidence) | Auditability; consistent with the OASIS taxonomy (state transitions/decisions only) |

### 3.2 Component diagram (target)

```
ORB session start (route: /command-hub | /admin)
   │
   ├─ resolveSurface() ──────────────► 'command-hub' | 'admin'        [exists / extend]
   ├─ RoleProfile = getRoleProfile(activeRole)                        [exists, shadow → LIVE]
   │
   ├─ buildLiveSystemInstruction()
   │     ├─ dev_orb / admin_orb persona overlay                       [dev exists; admin NEW]
   │     ├─ community blocks gated off for dev/admin                  [NEW]
   │     └─ + BRIEFING CONTEXT (from Briefing Engine)                 [NEW]
   │
   ├─ buildLiveApiTools(mode, route, activeRole)
   │     └─ filtered by RoleProfile.tool_allowlist/denylist           [registry exists → enforce]
   │          ├─ developer toolset  ──► Command Hub APIs              [partial → extend]
   │          └─ admin toolset      ──► tenant-admin APIs             [partial → extend]
   │
   └─ Tool dispatch
         ├─ tier check + confirmation policy + governance evaluate    [NEW]
         ├─ role re-check server-side (developerGate/adminGate)       [exists / extend]
         └─ OASIS decision event emit                                 [NEW]

Briefing Engine (NEW, read-only)
   /api/v1/assistant/briefing/developer  ◄─ fan-in: supervisor-summary, ops/action-required,
        self-healing (health+pending-approval+metrics), dev-autopilot (queue+runs+executions),
        governance/controls, cicd/approvals+lock-status, testing/runs, operator/deployments,
        oasis events delta, devhub feed highlights
   /api/v1/assistant/briefing/admin/:tenantId  ◄─ fan-in: tenant overview (summary/at-risk/
        activity/alerts), kpis+health-index, insights pending, moderation queue+SLA, signups
        funnel, invitations, notifications recent, autopilot runs/waves, audit highlights
```

### 3.3 New/changed modules

| Module | Path (new files kebab-case) | Change |
|---|---|---|
| Briefing engine | `services/gateway/src/services/assistant-briefing/{developer-briefing-service.ts, admin-briefing-service.ts, briefing-types.ts, briefing-cache.ts}` | NEW — parallel fan-in with per-source timeout (≈1.5s) and graceful degradation (a failed source becomes a "couldn't check X" line, never a crash) |
| Briefing routes | `services/gateway/src/routes/assistant-briefing.ts` → `/api/v1/assistant/briefing/{developer, admin/:tenantId}` | NEW — guarded by `developerGate` / `requireTenantAdmin` respectively |
| Role registry enforcement | `assistant-role-registry.ts` + call sites in `live-tool-catalog.ts` (declaration filter), tool dispatcher (dispatch filter), `context-pack-builder.ts`/`retrieval-router.ts` (context-source + memory-category filter) | ENFORCE (flag-gated per surface) |
| Admin persona | `ai-personality-service.ts` `PERSONALITY_DEFAULTS` + migration seeding `ai_personality_config` row `admin_orb` (mirror of `dev_orb` field set); overlay branch in `live-system-instruction.ts` for `resolvedSurface === 'admin'` | NEW |
| Developer tools v2 | `services/gateway/src/services/orb-tools/developer-tools.ts` (extend) + handlers under `orb/live/tools/handlers/` | EXTEND — see §3.4 |
| Admin tools v2 | `services/gateway/src/services/admin-voice-tools.ts` (extend) + handlers | EXTEND — see §3.5 |
| Action guard | `services/gateway/src/orb/live/tools/action-guard.ts` | NEW — tier policy, confirmation state machine (propose → confirm token → execute), governance evaluate for T2, OASIS decision emit |
| Prompt slimming | `live-system-instruction.ts` | CHANGE — community behavior blocks emitted only for `vitanaland` surface |
| Frontend | `vitana-v1`: ORB widget already sends `current_route`; add role/surface affordances (briefing card render in `/admin` + Command Hub ORB, confirmation UI for T1/T2 actions if text surface) | MINOR |

### 3.4 Developer toolset (mapping to existing APIs)

Tier T0 (read, no confirmation):
`get_briefing`, `get_system_status` (supervisor summary + health), `get_action_required`,
`list_self_healing` (active/history/metrics/pending), `get_self_healing_diagnosis(vtid)`,
`list_autopilot_findings/runs/executions`, `get_execution_lineage(id)`, `get_vtid(vtid)` /
`list_vtids(filter)`, `get_spec(vtid)`, `get_governance_controls`, `get_governance_violations`,
`get_ci_status(pr)` / `list_cicd_approvals`, `list_deployments/revisions`, `get_test_runs` /
`get_test_suites`, `query_oasis_events(filter)`, `search_codebase` (existing), `get_pr_status`
(existing).

Tier T1 (reversible write, verbal confirmation):
`allocate_vtid` + `create_vtid_task` (allocator-gate respected), `generate_spec(vtid)`,
`quality_check_spec(vtid)`, `run_test_suite(suite)`, `trigger_orb_monitor`,
`generate_plan(finding_id)`, `snooze_finding` / `reject_finding`, `trigger_autopilot_scan`,
`release_claim(vtid)`, `create_governance_proposal`.

Tier T2 (destructive/outward, explicit confirm + governance evaluate + OASIS decision event):
`approve_spec(vtid)`, `approve_self_healing_fix` / `reject_self_healing_fix`,
`rollback_self_healing(vtid)`, `approve_finding_auto_execute` (must respect the stranded-PR guard),
`cancel_execution(id)`, `safe_merge_pr`, `publish_to_prod` (→ `/api/v1/operator/publish`, requires
VTID + reason, restates staging verification first), `revert_prod` / `revert_both`,
`terminalize_vtid`, `disarm_control(key)` (kill-switches: **disarm allowed, re-arm requires human
via Command Hub** — asymmetric by design).

Tier T3 (never exposed to the assistant): emergency bypass header, `arm` of execution controls,
direct DB writes, `allocate-internal` shared secret, modifying governance rules, any `gcloud`-level
operation.

### 3.5 Admin toolset (tenant-scoped; mapping to existing APIs)

T0: `get_briefing`, `get_tenant_overview` (summary/at-risk/activity/alerts), `get_kpis` /
`get_health_index`, `list_insights`, `list_content_reports` / `get_report(id)`,
`list_members` / `find_member`, `get_signup_funnel`, `list_invitations`,
`list_notifications_sent`, `get_autopilot_runs/settings`, `query_audit(actions|access)`,
`get_analytics(domain)`, `list_live_rooms/meetups/groups`.

T1: `invite_member(email, role)`, `revoke_invitation(id)`, `snooze_insight` / `dismiss_insight`,
`flag_content(id)`, `update_tenant_setting(key)` (whitelisted keys only), `refresh_kpis`,
`pause_autopilot_automations` / `resume` (tenant-level autopilot settings PATCH).

T2: `approve_content(id)` / `reject_content(id)`, `approve_insight(id)` (may trigger campaigns),
`compose_notification(audience, message)` (outward-facing broadcast — always explicit confirm +
read-back of audience size), `grant_role(user, role)` / `revoke_role` (via `/api/v1/roles`;
`developer`/`infra` grants remain super-admin-only per VTID-01230), `delete_meetup(id)`,
`self_healing_approve/reject` (where admin-visible).

T3: cross-tenant anything (unless `exafy_admin`), wallet admin spend/credit (Phase-later, if ever),
trust-tier changes, tenant creation/deletion.

### 3.6 Briefing content contract

Both briefing endpoints return the same envelope so the prompt injection and the `get_briefing`
tool are uniform:

```ts
{
  ok: true,
  role: 'developer' | 'admin',
  tenant_id?: string,
  generated_at: string,
  status: { headline: string, items: BriefingItem[] },        // current state
  since_last_session: { items: BriefingItem[] },              // delta (uses lastSessionInfo)
  attention: { items: AttentionItem[] },                      // ranked; each has severity,
                                                              // age, sla_breach?, action_hint
  next_step: { recommendation: string, tool: string,          // ONE recommended action
               args_template: object, tier: 0|1|2 },
  degraded_sources?: string[]                                 // sources that timed out
}
```

Attention ranking (deterministic, testable): SLA breaches > pending human approvals (self-healing,
insights, cicd approvals) > failing CI/tests (repeat failures ranked higher) > governance
violations > health-index drops > stale queues. Ranking logic lives in the briefing service, not
the prompt, so it is unit-testable and consistent across voice/text.

---

## 4. Phased Implementation Plan

Each phase is independently shippable, staging-first, behind flags, with its own VTID(s) and
acceptance criteria. Community lane is untouched until Phase 5 explicitly re-verifies it.

### Phase 0 — Foundations: role-aware cutover for dev/admin surfaces (est. 3–5 dev-days)

**Goal:** the assistant knows what role it is serving, with the right persona and *only* the right
prompt content — before any new capability.

1. Seed `admin_orb` persona (defaults + `ai_personality_config` migration), wire the overlay for
   `resolvedSurface === 'admin'` in `live-system-instruction.ts` (mirror of the existing
   command-hub/`dev_orb` overlay block).
2. Gate community behavioral blocks (Vitana Index, Guided Journey, pillars, matchmaking, community
   greeting choreography) to `vitanaland` surface only.
3. Enforce `assistant-role-registry.ts` for `developer` + `admin` roles only, behind
   `FEATURE_ROLE_AWARE_ASSISTANT_ENV=dev_admin`: `isToolAllowed()` applied at **both** tool
   declaration (`buildLiveApiTools`) and dispatch; `filterContextSourcesForRole()` applied in
   `context-pack-builder.ts`; `memory_policy.read_categories` applied in memory retrieval (dev/admin
   sessions stop pulling personal wellness memory — cross-role leakage = test failure, per the
   registry's own contract).
4. Update `ROLE_PROFILES` for `developer`/`admin` to match §3.4/§3.5 allowlists (registry currently
   lists aspirational tools like `list_autopilot_queue` — align names with real declarations).

**Acceptance:** ORB on `/command-hub` identifies as engineering co-pilot with zero wellness prompt
content; ORB on `/admin` identifies as tenant-operations assistant; community sessions
byte-identical prompts (snapshot test); role registry shadow telemetry shows 0 denied-tool
regressions for community.

### Phase 1 — Developer Briefing (read-only) (est. 5–8 dev-days)

1. Build `developer-briefing-service.ts` + `/api/v1/assistant/briefing/developer` (fan-in per §3.2,
   parallel with per-source timeout + cache ≈60s, `degraded_sources` reporting).
2. Session-start injection: when surface = command-hub, fetch briefing during bootstrap
   (`vitana-brain.ts` path) and prepend a `## CURRENT BRIEFING` section + greeting policy override
   ("open with the briefing: status → since-last → attention → next step; keep under ~45s voice").
3. Add T0 developer tools (§3.4) — declarations, handlers, `developerGate()` on every handler.
4. `get_briefing` tool for mid-session refresh ("what changed while we were talking?").
5. Delta computation using existing `lastSessionInfo` (last session timestamp → OASIS events +
   run/queue diffs since).

**Acceptance:** cold session on `/command-hub` opens with a correct 4-part briefing sourced from
live endpoints (verified against Command Hub tabs showing the same numbers); briefing endpoint
p95 < 2.5s; any single upstream failure degrades gracefully; all Q&A tools answer from live data
(no hallucinated status — if a source is degraded the assistant says so).

### Phase 2 — Developer Actions (guarded write path) (est. 8–12 dev-days)

1. Build `action-guard.ts`: tier policy table, propose→confirm→execute state machine (confirmation
   is a session-scoped one-time token bound to the exact tool+args — a fresh utterance "yes" only
   confirms the last proposed action), governance `POST /evaluate` invoked for every T2, OASIS
   `vtid.decision.assistant_action` emission on execute.
2. Add T1 tools, then T2 tools (§3.4), each wrapping its existing governed endpoint. Special cases:
   - `approve_finding_auto_execute`: pre-check stranded-PR guard + open-PR count; refuse batch
     approval by voice (one at a time).
   - `publish_to_prod`: requires the assistant to first read back staging verification state
     (staging smoke green, revision, VTID, reason), then explicit confirm; calls
     `/api/v1/operator/publish` — never dispatches EXEC-DEPLOY directly.
   - `disarm_control`: allowed; `arm` is not exposed (T3) — re-arming stays a deliberate human
     Command Hub act.
3. Multi-step guided flows in the persona (not code): review-diff → approve → watch → verify
   choreography for self-healing and autopilot findings; the assistant narrates each state
   transition it observes from T0 polling tools.
4. Rate limiting per session on T1/T2 (e.g., max N writes/minute) inside action-guard.

**Acceptance:** end-to-end demo on staging — assistant briefs on a pending self-healing fix, shows
diagnosis, takes verbal approval, executes `POST /self-healing/approve`, monitors, reports outcome;
attempted T2 without confirmation is refused; attempted tool outside role allowlist is refused at
declaration AND dispatch; every executed action visible as an OASIS decision event with actor
metadata; disarmed `autopilot_execution_enabled` blocks the assistant identically to a human.

### Phase 3 — Admin Briefing (tenant-scoped, read-only) (est. 5–8 dev-days)

1. `admin-briefing-service.ts` + `/api/v1/assistant/briefing/admin/:tenantId` behind
   `requireTenantAdmin` (exafy_admin may pass any tenantId; tenant admin only their own — enforced
   by the existing middleware, with tenantId sourced from JWT in the tool handler, never from model
   output).
2. Session-start injection for surface `admin` (same mechanism as Phase 1).
3. T0 admin tools (§3.5) wrapping `tenant-admin/*` + relevant `admin-*` routes.
4. SLA/attention rules for the admin domain: report age thresholds, funnel-stuck detection,
   health-index drop detection, pending insights.
5. For `exafy_admin`: cross-tenant briefing variant ("Maxina 82▲, Alkalma 74▼ — Alkalma has 9
   overdue reports") + `switch_tenant_focus` tool (read-focus only; does not mutate JWT tenant).

**Acceptance:** tenant admin gets a correct tenant-scoped briefing; a tenant-A admin token can
never elicit tenant-B data through any tool (adversarial prompt test suite); exafy_admin
cross-tenant summary correct; numbers match the admin console screens.

### Phase 4 — Admin Actions (guarded write path) (est. 8–12 dev-days)

1. T1 + T2 admin tools (§3.5) through the same action-guard (tiering, confirmation, OASIS
   decision events, rate limits).
2. `compose_notification` extra guard: read back audience definition + estimated recipient count
   before confirm; hard cap without an additional "yes, all N members" confirmation; respects
   server-side i18n (`tt()` catalog — assistant composes via template keys where they exist,
   CLAUDE.md §13b).
3. Role management flows: `grant_role`/`revoke_role` with read-back of current roles and the
   VTID-01230 constraint (developer/infra grants remain exafy_admin-only).
4. Decision-support choreography in the `admin_orb` persona: for every recommendation the assistant
   states option A/B, expected impact (from analytics endpoints), reversibility, and its
   recommendation — the "help the admin make the right execution decision" requirement.

**Acceptance:** moderation clear-the-queue demo end-to-end by voice on staging; broadcast
notification requires double confirmation and lands in `admin-notifications` sent log; all writes
appear in `tenant_admin_audit_log`/OASIS; RLS/tenant-isolation adversarial suite still green.

### Phase 5 — Continuous supervision, proactivity & self-improvement of the assistant itself (est. 6–10 dev-days)

1. **Proactive alerts in-session:** subscribe dev/admin ORB sessions to the existing `devhub` SSE
   feed / OASIS event stream; assistant interjects on severity ≥ threshold ("heads up — the staging
   deploy just failed smoke") using the existing orb-alert audio affordances.
2. **Scheduled briefings:** wire `morning-brief-scheduler.ts` pattern to developer/admin briefing
   endpoints → push notification with briefing headline (server-side i18n).
3. **Eval suites per role:** implement the `eval_suites` declared in `assistant-role-registry.ts` —
   briefing correctness (fixture-driven), tool-selection accuracy, refusal correctness (T2 without
   confirm, out-of-role tools, cross-tenant attempts), community-regression suite. Wire into
   `routes/testing.ts` suites so the assistant can *run its own evals* (self-improvement loop:
   dev-autopilot findings can target assistant failures).
4. **Telemetry:** per-session role-lane metrics (briefing latency, tool success rate, confirmation
   abandonment) via existing `llm-telemetry-service.ts` patterns; Command Hub Assistant ▸ Metrics
   tab extension.
5. Community-lane re-verification: full snapshot + smoke to confirm zero drift, then consider
   extending registry enforcement to all roles (separate decision).

**Acceptance:** eval suites runnable via `/api/v1/testing/run` and green; a synthetic staging
incident triggers an in-session developer interjection; scheduled morning briefing delivered.

---

## 5. Security & Governance Considerations

1. **The assistant's authority = the caller's token.** No service-role escalation for tool calls;
   `developerGate`/`requireTenantAdmin`/`requireExafyAdmin`/RLS apply unchanged. The shared-secret
   `allocate-internal` path is never given to the assistant.
2. **Prompt-injection containment:** briefing content and tool results include external text
   (report contents, PR titles, event messages). All injected context is wrapped in delimited
   "data, not instructions" framing; T1/T2 execution requires the *user's* confirmation utterance,
   so injected text can never trigger a write by itself. Adversarial tests in Phase 3/4 suites.
3. **Kill-switch asymmetry:** assistant may disarm, never arm. A global
   `ASSISTANT_ACTIONS_ENABLED` system control (DB-backed, same pattern as
   `system-controls-service.ts`) gates all T1/T2 dispatch — a single disarm reduces both lanes to
   read-only without redeploy.
4. **Audit:** every T1/T2 execution emits `vtid.decision.assistant_action` (role, user, tool, args
   hash, confirmation token id) — queryable in OASIS tab and `admin/audit/OasisEvents`.
5. **Parallel-execution rule:** the assistant never claims VTID tasks itself; it drives the
   existing single-claim orchestrator/dev-autopilot machinery, so Never-15 (no parallel VTID
   executions) holds.
6. **Staging-first respected:** nothing in the plan adds an auto-to-prod path; `publish_to_prod` is
   a voice wrapper around the same PUBLISH endpoint with the same VTID+reason requirements.

---

## 6. Testing & Verification Plan

| Layer | What | Where |
|---|---|---|
| Unit | Briefing ranking determinism, action-guard state machine, tier policy, registry allow/deny, tenantId-from-JWT | `services/gateway/test/` (jest) |
| Contract | Briefing envelope schema (Zod), each tool→endpoint mapping against route contracts | Test Contract Registry (`test-contracts*.ts`) — links tests to self-healing |
| Integration | Session-start briefing injection (both surfaces), tool declaration filtering per role, dispatch refusals | gateway integration tests + `/api/v1/testing` suites |
| Adversarial | Cross-tenant elicitation, T2-without-confirm, injected-instruction-in-report, out-of-role tool requests | New eval suite (Phase 5.3, started in Phase 3) |
| Regression | Community prompt snapshot byte-diff, community tool catalog unchanged, existing ORB e2e (`E2E-ORB-MONITOR`) | CI |
| Manual/staging | The Phase 2/4 end-to-end voice demos on `preview-gateway.vitanaland.com` | per Deployment Verification Protocol (§15 CLAUDE.md) |

---

## 7. Risks & Open Questions (for reviewer decision)

| # | Risk / question | Proposed default |
|---|---|---|
| R1 | `orb-live.ts` is a 683KB monolith mid-refactor ("A0–A8") — touching instruction/tool seams may collide with the refactor | Land changes in the modular `orb/live/**` tree only; coordinate with refactor owner before Phase 0 |
| R2 | Registry tool names vs. real declarations diverge (aspirational names like `publish_canary`) | Phase 0 step 4 reconciles; registry is source of truth *after* reconciliation |
| R3 | Should the assistant be allowed `approve_spec` (a governance gate designed as human consent)? | Yes but T2 with explicit verbal confirmation = "explicit consent" per IF-THEN rule 5; reviewer may demote to T3 |
| R4 | `compose_notification` by voice is high-blast-radius | Double-confirm + recipient-count read-back + honor per-tenant caps; reviewer may demote to T3 initially |
| R5 | Voice UX length: briefings must fit voice (≤~45s) while text can be richer | Briefing service returns full envelope; persona compresses for voice, text surface renders full card |
| R6 | Operator Console (`operator_chat`) overlap with Developer Assistant | Keep separate in this plan; converge later behind role registry (out of scope) |
| R7 | Which VTIDs to allocate | One parent VTID for the program + one per phase, allocated via the normal allocator before execution (plan intentionally ships without VTIDs — allocation is an execution step requiring `spec_status=approved`) |
| R8 | exafy_admin cross-tenant *write* focus-switching | Phase 3 ships read-focus only; cross-tenant writes remain per-tenant token/JWT — revisit after Phase 4 |

---

## 8. Estimated Effort Summary

| Phase | Scope | Est. |
|---|---|---|
| 0 | Role-aware cutover, admin persona, prompt slimming | 3–5 days |
| 1 | Developer briefing + T0 tools | 5–8 days |
| 2 | Developer actions (T1/T2) + action-guard | 8–12 days |
| 3 | Admin briefing + T0 tools | 5–8 days |
| 4 | Admin actions (T1/T2) | 8–12 days |
| 5 | Proactivity, evals, telemetry | 6–10 days |
| **Total** | | **~35–55 dev-days**, independently shippable phases |

Phases 1↔3 and 2↔4 are parallelizable across two developers after Phase 0.
