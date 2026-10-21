# PLAN B (rev 2) — Plan Sparring Gate (pre-VTID, standard for every new plan)

Owner directive (2026-10-03), standing for ANY plan from ANY producer: "No new VTID for such agent during planning
phase. It must be part of the pipeline before a new VTID is generated and it must be a standard process no matter how
many new plans we create. Every new plan must have a ping pong sparring agent to support improvement of the plan."

## Planner responses to round 1
F1 ACCEPTED — enforcement moves to the database (the only chokepoint every path shares): BEFORE INSERT trigger on
  vtid_ledger + allocate_global_vtid(..., p_sparring_id uuid DEFAULT NULL). Covers /allocate, /allocate-internal,
  /vtid/create, operator.ts:1516 direct INSERT, and session execute_sql alike. PreToolUse hook = UX only.
F2 ACCEPTED — "at spec stage" option removed. Autonomous producers correlate pre-VTID work by incident_id/plan_id uuid;
  the fix plan is sparred, then allocated. self-healing-diagnosis-service refactor is in scope (P4).
F3 ACCEPTED — sparring rounds live only in plan_sparring_sessions (not OASIS). OASIS events emitted at allocation:
  vtid.plan_sparring.attached / vtid.plan_sparring.missing (shadow), added to CicdEventType union.
F4 ACCEPTED — runFullQualityCheck deterministic checks run on plan text first (vtid optional) and are fed to the
  partner as evidence; on allocation oasis_specs is seeded with spec_hash = final_plan_hash; /specs/:vtid/approve
  refuses on hash drift without re-spar; legacy bypass at specs.ts:1198-1211 removed.
F5 ACCEPTED — hash binding defined below.
F6 ACCEPTED — full stage wiring (LLMStage union, VALID_STAGES, OPTIONAL_STAGES, RECOMMENDED_MODELS, LLM_SAFE_DEFAULTS);
  fallback = other Bedrock Claude model or null → hard fail ⇒ verdict 'escalated' (never deepseek, never Google);
  provider+model+latency logged per round.
F7 ACCEPTED — independence rules below.
F8 ACCEPTED — expedited mode below.
F9 ACCEPTED — class verified mechanically on PR diff.
F10 ACCEPTED — budgets + dedup below.
F11 ACCEPTED — new scenarios in operator (VTID-04465) and support (VTID-04456) suites in the same PR; contract change
  stated in PR; roles suite (VTID-04560) checked unaffected.
F12 ACCEPTED — approval identity below.
F13 ACCEPTED — PLAN_SPARRING_MODE=off|log|enforce, exit criteria below.
F14 ACCEPTED — disputed state below.
F15 ACCEPTED — store + endpoint are phase 1 prerequisites.

## Process
1. Planner drafts plan; declares change class (light | standard | expedited) and scope (system areas + files).
2. Deterministic pre-checks (spec-quality-agent, vtid optional): structure, risk, cross-VTID file conflicts, governance.
3. Partner round: findings {id, severity blocker|major|minor, claim, evidence, suggestion}, stored verbatim by the
   store (planner cannot edit/curate). Minimum floor: ≥3 verified-premise checks with evidence in round 1; a round-1
   CONVERGED with no evidence-bearing check is rejected by the store.
4. Planner answers each finding: accepted (change made) / rejected (rationale) / deferred (tracked where).
5. Same partner re-reviews revision + responses (context kept). Partner marks each rejected finding acknowledged or
   disputed. Disputed blocker/major = unresolved.
6. Verdict: converged (no open or disputed blocker/major) | escalated (round cap hit, disputed items, model failure,
   budget exhausted). Round cap: light 1, standard 3, expedited 1.
7. Human approval: required for every verdict (escalated shows disputed items side by side). Identity: verified
   exafy_admin actor via gateway JWT (Command Hub), or for Claude Code sessions the owner's in-conversation "yes"
   recorded with session id + verbatim quote (attested tier, see trust tiers).
8. Allocation: allocate_global_vtid(p_sparring_id) → trigger validates: record exists, verdict converged|escalated,
   human_approved_by set, final_plan_hash matches, not already bound to another VTID. Binds vtid on the record.
   No VTID is created for sparring itself.

## Hash binding
canonical = plan body (markdown) with CRLF→LF, trailing whitespace stripped, runs of blank lines collapsed; sha256.
Checked at: allocation (trigger), spec approval (/specs/:vtid/approve), PR CI (docs/validation/<VTID>/plan-sparring.md
carries the hash + record; CI job verifies against the store). Material drift ⇒ re-spar (light round allowed):
PR touches a system area (spec-quality-agent SYSTEM_AREAS) not declared, or exceeds its declared class.

## Independence
Partner model differs from planner model where possible (gateway: Bedrock Opus partner vs Sonnet planners; sessions:
agent frontmatter pins a different model than the session). Fixed adversarial system prompt; read-only tool allowlist
in the agent definition (Read, Grep, Glob only — no Bash write, no execute_sql, no Edit). Partner never sees planner's
private reasoning.

## Trust tiers
- gateway: partner run by gateway (Bedrock), record written by gateway service role — full trust.
- attested: Claude Code session ran an in-session partner and submitted the record through
  submit_plan_sparring_record RPC (security definer, validates shape/floor); marked attested, shown in Command Hub.
  Preferred session path: call POST /api/v1/plans/spar (gateway tier) when the session has GATEWAY_SERVICE_TOKEN or
  an exafy_admin JWT (same auth as /vtid/allocate since VTID-04727); attested is the fallback.

## Expedited (incident/hotfix)
One round, 10-min cap, auto-escalate to human; VTID allowed on human approval; mandatory full post-hoc sparring
within 24h tracked as a Command Hub attention item (Plan A integration). No "spar after with no gate".

## Light class
≤3 files, no supabase/migrations, routes, auth middleware, .github, deploy/pipeline, governance, or LLM routing files.
Declared by planner, verified by CI on the PR diff; exceeding ⇒ CI fails, re-spar at proper class.

## Cost
Per-producer daily token+USD budgets; dedup by plan_hash (identical plans reuse a record); budget exhausted ⇒
escalate to human queue, never allocate anyway. Shadow phase measures VTIDs/day per source to set caps.

## Phases
P1 Foundation (shadow): migration — plan_sparring_sessions table (plan_id, plan_hash, producer, class, trust_tier,
   rounds jsonb, verdict, human_approved_by, approval_evidence, vtid NULL, model/provider log), allocate_global_vtid
   p_sparring_id param, submit_plan_sparring_record RPC, vtid_ledger BEFORE INSERT trigger in log mode
   (PLAN_SPARRING_MODE via DB setting) writing plan_sparring_shadow_log; DATABASE_SCHEMA.md. Gateway: plan-sparring
   service + POST/GET /api/v1/plans/spar (requireAdminAuth or service token), stage wiring, OASIS types. Claude Code
   (both repos): .claude/agents/plan-sparring-partner.md, .claude/skills/plan-sparring/SKILL.md, CLAUDE.md standing
   rule (amend rule 2b / §4.1 ordering), PreToolUse hook that warns when allocation is attempted without a record.
P2 Producers pass sparring_id: human-initiated (operator chat/console, task intake, Command Hub, voice lifecycle
   tool) then autonomous (self-healing refactor to incident_id, dev autopilot, voice-improve, email intake, routines).
   Regression-suite scenarios in same PRs.
P3 Enforce: flip PLAN_SPARRING_MODE=enforce after ≥7 days with zero unknown callers in shadow log, all producers
   passing sparring_id, suites green. Remove specs.ts legacy bypass. CI hash check on PRs.
P4 Command Hub: sparring record in VTID drawer; approval UI for escalated plans; Overview attention items
   (pending approvals, expedited post-hoc due, shadow-log misses).

## Open for owner
- Retire /vtid/allocate-internal and /vtid/create (now gated by the trigger anyway) — proposed: keep, gated.
- Light class still needs human approval? Proposed: yes, one-click.

---
# REVISION 3 — planner responses to round 2 (supersedes conflicting text above)

N1 ACCEPTED — Only verified actors can approve. No caller can set verdict='converged' or human_approved_by through
  submit_plan_sparring_record; attested records land as 'pending_human_approval' (session-run partner is advisory
  evidence). Approval = one click in Command Hub (exafy_admin JWT) or POST /api/v1/plans/spar/:id/approve with
  exafy_admin JWT. A session's in-chat "yes" is recorded as context only, never as the approval. Additionally, the
  gateway re-runs its own Bedrock partner pass on attested plans before the approval button is enabled (gateway tier
  is the only tier that can produce 'converged'). EXECUTE on the RPC revoked from PUBLIC/anon/authenticated.
N2 ACCEPTED (part) / ESCALATED (part) — mode read from one-row plan_sparring_config table owned by a dedicated role
  vitana_governance_owner (no GUC); changes only via reviewed migration. Hourly reconciler (gateway) alerts on:
  trigger disabled (pg_trigger.tgenabled), ledger rows created without sparring_id, config changes → OASIS
  vtid.plan_sparring.tamper_detected + Overview P1. ESCALATED TO OWNER: moving mcp__Supabase__execute_sql /
  apply_migration from allow → ask in both repos' .claude/settings.json (changes owner's autonomous workflow; residual
  risk documented in CLAUDE.md either way).
N3 ACCEPTED — single transaction: DROP 3-arg, CREATE 4-arg with DEFAULT NULL, REVOKE ALL FROM PUBLIC, anon,
  authenticated; GRANT to service_role; NOTIFY pgrst 'reload schema'; written rollback migration; same grants for
  submit_plan_sparring_record.
N4 ACCEPTED — trigger gates only NEW VTIDs: if a ledger row with NEW.vtid already exists (upsert path) → pass.
  Otherwise require metadata.sparring_id valid (no RPC marker needed — direct INSERTs need a valid sparring_id too,
  which answers Q3). metadata.sparring_exempt_reason allowed only when current_user = vitana_governance_owner, always
  logged. Binding via SELECT … FOR UPDATE on the record, UNIQUE(vtid) on plan_sparring_sessions, partial unique
  index on vtid_ledger((metadata->>'sparring_id')). pgTAP/SQL test in CI covering upsert, new insert with/without
  record, hash mismatch, double-bind race, exempt role.
N5 ACCEPTED — every class has ≥2 passes: findings → planner responses → partner acknowledge/dispute pass. Caps:
  light 2, standard 3, expedited 2 (time-boxed 10 min total).
N6 ACCEPTED — canonical text = plan body only, between fixed markers <!-- plan:begin --> / <!-- plan:end -->,
  excluding responses; NFC normalize, strip BOM, CRLF→LF, strip trailing whitespace, collapse blank runs, single
  trailing newline; sha256. CI uses a read-only store credential secret PLAN_SPARRING_READ_TOKEN (gateway GET).
N7 ACCEPTED — hash hit on an already-bound record returns the existing VTID; no second allocation.
N8 ACCEPTED — RLS enabled, no anon/authenticated policies; rounds append-only (UPDATE revoked on rounds; append via
  gateway/RPC function only); documented in DATABASE_SCHEMA.md.
N9 ACCEPTED — partner gets Bash behind a PreToolUse read-only command filter (allow grep/rg/sed -n/ls/cat/git
  log|show|diff; deny everything else).

Answers: Q1 no — a tokenless session can never reach converged/approved without a verified click. Q2
vitana_governance_owner; flips only via reviewed migration PR approved by the owner. Q3 not needed (see N4).

---
# REVISION 4 — round 3 responses (final; verdict ESCALATED to owner)
N10 ACCEPTED — Break-glass procedure for P1 incidents when gateway/ALB/Bedrock is down: the owner (named holder of
  vitana_governance_owner) inserts the VTID with metadata.sparring_exempt_reason; trigger logs
  vtid.plan_sparring.break_glass; full post-hoc sparring mandatory within 24h, tracked as Overview P1; reconciler alerts
  on any exempt insert without a linked post-hoc record; pgTAP case added.
N11 ACCEPTED — vitana_governance_owner created NOLOGIN and NOT granted to postgres/service_role if Supabase permits
  (verified in pgTAP); otherwise accepted residual risk, every exempt insert raises a P1.
CLAUDE.md wording will state plainly: while execute_sql runs as postgres, trigger disable / config change / role
  assumption are DETECTED, not PREVENTED.

---
# OWNER DECISIONS 2026-10-04 (recorded verbatim intent)
1. settings.json allow→ask: delegated to planner, "don't overcomplicate" → KEEP as is (execute_sql/apply_migration
   stay allowed). Accepted residual: trigger disable / config change / role assumption are DETECTED (hourly reconciler →
   P1), not PREVENTED. CLAUDE.md states this plainly.
2. Break-glass holder = owner; post-hoc full sparring within 24h — approved.
3. Target DB is Aurora (Supabase being retired). The gate is plain Postgres (table, trigger, roles, RPC) and is built
   on whichever store holds vtid_ledger at implementation time, Aurora-ready. On Aurora we control roles fully →
   vitana_governance_owner NOLOGIN, not grantable from the app role (N11 resolved there, not a residual).
4. /vtid/allocate-internal and /vtid/create: keep (gated by the trigger).
5. Light class still needs one-click human approval: agreed.

# MODEL FOR SPARRING (owner: Opus 4.6 / Sonnet 4.5 not good enough; consider DeepSeek Flash 4.1) — pending owner pick
Proposal: partner = Claude Fable 5.1 on Bedrock for human-initiated plans; Claude Opus 5.5 on Bedrock for autonomous
producers (volume, daily budget). Partner model must differ from the planner model. Precondition: Bedrock Marketplace
subscription + real invoke test of both inference profiles before wiring (IF-THEN 31; 2026-08-10 sweep showed
fable-5/sonnet-5 unsubscribed). DeepSeek-V4.1-Flash considered: not as the gate (flash = speed/cost tier, already the
repo's worker/fallback tier; sends plans + code to api.deepseek.com outside AWS). Optional bake-off on today's two
sparring sessions as ground truth before final pick.

# ADDITION NOT YET SPARRED (light re-spar before VTID)
- Gateway-tier partner needs read-only code access to verify claims (file:line): read-only GitHub contents token or
  the code-index service; no write scopes.

# OWNER DECISION 2026-10-04 — SPARRING MODEL (supersedes the proposal above)
Partner model = Claude Opus 4.6 on AWS Bedrock, for every producer, "for now".
- One config value (PLAN_SPARRING_MODEL / plan_sparring stage in llm-defaults + policy), so a later upgrade is a config
  change, not code.
- Not yet referenced anywhere in the repo, and the 2026-08-10 sweep found every Opus profile except opus-4-5
  unsubscribed. Precondition before wiring: resolve the real inference-profile ID (aws bedrock
  list-inference-profiles, eu-central-1) and do a real invoke (IF-THEN 31); if AccessDenied → Marketplace subscription
  first.
- No fallback model: a failed partner call ends the session as 'escalated' (reason: model_unavailable), loudly — never
  Sonnet/DeepSeek/Google silently.
- Request shape for Opus 4.6: thinking {type: adaptive}, output_config.effort high.
- Independence holds: Claude Code planners run Opus 5.5; gateway planners run Opus 4.5 / Sonnet 4.6 / DeepSeek.

# LIGHT RE-SPAR RESPONSES (R1–R5, all ACCEPTED)
R1 — Dedicated fine-grained PLAN_SPARRING_GITHUB_TOKEN (contents:read + metadata:read, both repos only) in Secrets
  Manager; never the merge token. Partner tools: read_file(repo, path, ref, start, end), list_dir, search (GitHub code
  search, default branch, marked approximate). Every finding must cite a read_file result. ref pinned to the plan's
  base commit SHA, stored in the record. Tool calls per round capped inside the per-producer budget.
R2 — bedrock.ts extended: thinking/redacted_thinking blocks preserved verbatim across tool turns; thinking +
  output_config request fields. The IF-THEN 31 invoke test proves the full shape incl. one tool round-trip; if
  Bedrock rejects output_config.effort → escalate to owner, never silently drop it.
R3 — Sparring service always passes allowFallback:false in code; tool loop goes through llm-router (stage
  plan_sparring) for policy + telemetry; policy validation rejects any non-null fallback for this stage; test: primary
  failure ⇒ verdict escalated / model_unavailable with zero other provider calls.
R4 — Gate built on Supabase now (where vtid_ledger is written). plan_sparring_sessions, plan_sparring_config, new
  RPCs and trigger added to the Aurora RPC-parity + cutover checklists; on Aurora the trigger is created only after CDC
  stop at cutover; enforce only on the write store; post-cutover check pg_trigger.tgenabled='O'; reconciler queries the
  live store (config-resolved, not hardcoded).
R5 — Resolved profile must be an eu.* inference profile in eu-central-1; model ID recorded in RECOMMENDED_MODELS and
  LLM_SAFE_DEFAULTS.plan_sparring.

N12 ACCEPTED — router history type + renderAnthropicHistory extended together with bedrock.ts; R2 invoke test runs
  through llm-router.
VERDICT: CONVERGED (light re-spar, pass 2). Approval record carries: accepted residual (detect-not-prevent on Supabase
until Aurora cutover) and implementation preconditions (Opus 4.6 eu.* profile resolves + real invoke incl. tool
round-trip; Bedrock accepts output_config.effort; PLAN_SPARRING_GITHUB_TOKEN provisioned) — each escalates if it fails.
