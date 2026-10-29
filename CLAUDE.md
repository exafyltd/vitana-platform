# CLAUDE.md - Vitana Platform Development Guide
**CANONICAL REFERENCE - Last Updated: 2026-10-20**

This file contains critical information for AI assistants working on the Vitana platform.
**READ THIS BEFORE MAKING ANY CHANGES.**

> **GCP is decommissioned.** Project `lovable-vitana-vers1` is permanently dead (billing off 2026-08-16, Cloud Run
> `gateway` deleted, VTID-03599/VTID-03649); every Vitana process runs on AWS. The only Google uses run on a separate,
> dedicated GCP project with a 90-day window ending ~2026-12-16 (review reminder 2026-12-06): the `sr`/`ru` Vertex
> Live voice bridge (`VERTEX_SERBIAN_BRIDGE_ENABLED`, VTID-04000; `VERTEX_RUSSIAN_BRIDGE_ENABLED`, VTID-04813) and
> `sr`/`ru` audiobook narration by Google Cloud TTS (`AUDIOBOOK_GOOGLE_RU_ENABLED`, `AUDIOBOOK_GOOGLE_SR_ENABLED`, cap
> `AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK`, VTID-05026). Each language has its own switch and single-language
> predicate — never widened into a list. Some code defaults still fall back toward Google when their env var is unset
> (§2c–§2e): before touching a `gcloud`/Cloud Run/GCP reference, check whether it is this carve-out or the general
> decommission. Details: `.claude/rules/backend.md` (§2e-vertex-serbian-bridge, §2e-audiobook-google).

---

## ⚙️ AUTONOMY CONTRACT — TWO OWNER GATES (STANDING RULE — VTID-04947)
Owner decision 2026-10-07: *"Run the processes end to end — only ask after the plan comes back from sparring, and
after it is verified on staging, to confirm publish to production."* Applies to both repos and every Claude Code
session. The absolute rule against testing on production and every production-safety rule still stand; this contract
removes the questions in between, not the safety.

**The owner is asked exactly two questions per change:**

1. **Gate 1 — the sparred plan.** One message: final plan, every sparring round's findings with the planner's
   answers, the verdict, the files in scope, and the test plan. Nothing else is asked with it.
2. **Gate 2 — "Staging verified — ready for deployment to production?"** Built only from machine evidence:
   STAGING-VERIFY run link, test counts, the verified commit, every commit between production and it, migrations in
   the release, and a "Decisions taken" list. A change that deploys nothing has no Gate 2; it is done when merged
   with green checks.

**Policy approval replaces Gate 1 for CI-sparred plans (owner decision 2026-10-14, VTID-05214/05218).** A plan
sparred by `PLAN-SPAR.yml` whose session converged is approved by the policy `converged-auto-v1` (recorded on the
sparring record and accepted by the `vtid_ledger` gate); it is not sent to the owner. A plan that does not converge
after its re-plan session is parked on the Command Hub board, with no message. A plan Claude Code spars with its own
local partner still goes to the owner as Gate 1.

**The owner's "yes" at Gate 1 (or the policy approval) is the standing instruction for everything up to Gate 2 for
that plan's VTIDs.** It is recorded as the approval line in `docs/validation/<VTID>/plan-sparring.md` (with the plan
hash) and in the ledger row's metadata. That record is an audit trail; the protection is the mechanical checks (CI
gates, STAGING-VERIFY). After "yes", without asking: allocate the VTID(s) (citing the sparring record), set the
ledger row in_progress/approved, implement, run the local checks, push, open the PR, mark it ready once checks are
green, merge (or enable auto-merge), watch the staging deploy and STAGING-VERIFY, and fix forward on any failure.

**Never ask the owner about:** VTIDs, branch names, PR titles, merge timing, re-running a check, fixing your own CI,
test design, or which of two reasonable implementations to use inside the approved plan.

**When unsure:**
- *Unsure of a fact* (does X exist, what does Y do, did Z pass) → verify it read-only in the code, the CI logs or the
  data first. Never guess and never ask the owner something the code can answer.
- *Unsure of intent inside the approved plan* → choose the most conservative option (smaller change, existing
  pattern, nothing deleted) and list it under "Decisions taken" in Gate 2.

**Stop and ask mid-flight only for:** (a) work outside the approved plan that one more sparring round with the same
partner does not converge on, (b) a production write not covered by the two gates, (c) a security or data-loss risk,
(d) the same failure surviving 3 fix-forward attempts. Each such stop is one message with the evidence and a
recommended answer.

**After merge the session keeps going.** In a cloud session it arms a `send_later` self check-in about 8 minutes
after merge and re-arms it every 5 minutes, up to 2 hours, until STAGING-VERIFY has a result for the merge commit.
Then it sends Gate 2 or fixes forward. It never sleep-polls. If the session ends first, any later session or the
Operator Chat sends Gate 2 from the STAGING-VERIFY evidence.

**"Yes" at Gate 2** → dispatch the production workflow pinned to the verified commit (see the scoping rules for
in-session approval, IF–THEN 26), then report the post-deploy check result in one line.

---

## 🤝 CLAUDE CODE ↔ KIRO COLLABORATION (STANDING RULE — VTID-05145)
Git is the only channel between Claude Code and Kiro sessions — the owner never relays. At session start run
`node <vitana-platform>/scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>` and work lanes whose
`next_actor` is you; state your session id + lane in your first reply; claim a lane before touching it, one session per
lane; push and update the lane file before ending. Full rules: `.claude/rules/collaboration.md`.
**Roles — `.claude/rules/collaboration.md` §7–§7b is the source of truth** (owner decisions 2026-10-14, VTID-05218,
and 2026-10-20): Kiro plans, builds and reviews — a lane is accepted by the reviewer agent `vitana-lane-reviewer`,
never by its builder; CI spars every `plan(` PR (`PLAN-SPAR.yml`), a converged plan is approved by policy and CI
allocates its VTIDs; the Project Manager merges under the PM merge rule §7b (staging-only deploy paths; the plan
driver applies the same rule while the PM is not live) and sends Gate 2; Claude Code is optional and handles
exceptions (`executor: claude` lanes, parked plans, partner outages; the exceptions seat takes them while Claude is
unavailable). A protected gate file (§3a, e.g. `CLAUDE.md`) never merges on a reviewer-agent accept alone: it needs
the owner's instruction naming the plan plus a reviewer-agent accept on the current head (Claude Code is retired). Kiro deploys to production only on the owner's
explicit command in the conversation (§7c: a full publish, or only one session's changes) and never writes a live
system from session tools. See `.claude/rules/collaboration.md` §7–§8b.

---

# PART 1: CORE RULES (Always / Never / If–Then)
These are **non-negotiable behavioral rules** for developing the Vitana platform. ALWAYS, NEVER and IF–THEN are
numbered separately ("ALWAYS 20", "NEVER 27", "IF–THEN 26"). Numbers are stable: a retired number is never reused, and
the retired-number index at the end of Part 1 says where its substance lives now.

---

## ✅ ALWAYS RULES

### Source of Truth & Governance
1. **Always treat OASIS as the single source of truth** for task state, lifecycle, and governance.
2. **Always verify VTID existence** before execution, deployment, or automation.
2b. **Every task that results in a commit gets its own VTID — allocated only after its plan is sparred and approved**
    (rules 51–55): owner Gate 1 for a locally sparred plan, or CI policy `converged-auto-v1`. A Kiro plan's VTIDs are
    allocated by CI PLAN-SPAR on convergence, never by hand. A bug report, a feature ask, a "fix this", a doc change —
    all count. **Never ask the user whether a VTID is needed, never ask them to supply one**, and once the plan is
    approved, allocate without waiting for confirmation. When the user directly instructed the work, that instruction
    plus the approved plan is the approval: set `spec_status='approved'` and `status='in_progress'` on the row (see
    IF–THEN 5). Distinct fixes in one conversation get distinct VTIDs. Procedure: §4.1. (VTID-03448, VTID-04868)
4. **Always respect existing governance rules** over new ideas or optimizations.
5. **Always require `spec_status=approved`** before execution.
6. **Always terminalize tasks** (`is_terminal=true`) when finished.
7. **Always emit OASIS events** for real state transitions.

### AI Providers (STANDING RULE — VTID-03563)
10a. **Always use Claude via AWS Bedrock (`provider: 'bedrock'`). Always.** A permanent, standing decision of the
     platform owner (2026-08-10), not to be re-litigated or re-asked. Every stage in `llm_routing_policy` that needs a
     Claude model points at the **`bedrock`** provider — never at `anthropic`.
10b. **Never route a stage at the direct Anthropic API (`provider: 'anthropic'`).** That account has **no credit
     balance**: every call returns `400 invalid_request_error` ("credit balance is too low") and then **silently falls
     back to Gemini/Vertex** — why: that is how the Gemini bill kept growing while the policy table claimed Claude
     (268 failures in 14 days, 2026-08-10). Bedrock bills to AWS and is unaffected. See §2b.
10c. **Never "fix" a Claude outage by failing a stage back to `vertex`/Gemini.** A Claude stage's fallback is another
     Bedrock model or an explicit hard failure — never Google. A silent Google fallback is what made this invisible
     for months.

### Infrastructure & Deployment (AWS — GCP is decommissioned, see banner above)
11. **Always use AWS account `472838866351`, region `eu-central-1`.** The only cloud account/region Vitana
    infrastructure runs in.
12. **Always resolve ECS/ALB service state dynamically** — `aws ecs describe-services`, `aws elbv2
    describe-target-groups` — never hardcode a task count, IP, or URL.
13. **Always push images to Amazon ECR**, never `gcr.io`/Artifact Registry (both unreachable — GCP billing is off).
14. **Always expose `/alive`** as the health endpoint.
15. **Always use port `8080`.**
16. **Always read the live ECS task definition** (`aws ecs describe-task-definition`) before editing or redeploying
    it — why: task-def drift (a secret ARN, an env var) has caused silent outages (VTID-03513, VTID-03516).
17. **Always deploy via the canonical `AWS-*-DEPLOY-*.yml` GitHub Actions workflows** — never a manual `aws ecs
    update-service` outside CI.
20. **Always verify a deploy on both ends.** Before building, grep the deploy source for the critical routes/features;
    after the deploy, curl the critical endpoints and expect JSON — a `text/html` response means the route is not live
    (failed deploy or wrong code). Never assume deployment success without that check.

### Database & Memory
21. **Always use the platform's Postgres store (Aurora, migrating off Supabase — see §3) as the persistent data store.**
22. **Always enforce tenant isolation (RLS).**
23. **Always use snake_case table names.**
24. **Always update `DATABASE_SCHEMA.md` when schema changes.**
25. **Always route DB mutations through Gateway APIs.**
26. **Always treat `memory_items` as canonical infinite memory.**
27. **Always use pgvector for semantic memory.**
28. **Always scope memory by tenant + role.** Tenant context missing → do not proceed.
29. **Always retrieve memory selectively (relevance-based).**
30. **Always log memory debug snapshots in dev.**

### Frontend & UX
31. **The sidebar is fixed:** exactly 10 items in their fixed order, Start Stream in the sidebar utility zone. Start
    Stream is private AI + screen share — never Go Live / Live Rooms. Changing the sidebar (structure, order,
    navigation, moving Start Stream out) is forbidden.
35. **Always treat ORB as voice-first, multimodal.**
36. **Always comply with CSP (no inline scripts/styles).**
37. **Always bundle JS locally.**
38. **Always respect fixed layout regions.**
39. **Always use Markdown specs (no Figma).**
40. **Always maintain WCAG 2.2 AA compliance.** A failing accessibility check blocks the release.

---

## ❌ NEVER RULES

### Architecture & Logic
1. **Never invent new projects, environments, or services.** AWS is canonical production for **every** Vitana
   service (the GCP↔AWS parallel period ended with the GCP billing shutdown 2026-08-16, VTID-03599/VTID-03649;
   service table §1b). A new AWS resource (a new ECS service, a new ALB rule) still needs its own VTID.
3. **Never execute without a VTID.**
4. **Never deploy without OASIS approval.**
7. **Never mix tenant data.**
8. **Never bypass RLS.**
9. **Never write directly to the database from workers.**
10. **Never mark polling or heartbeats as OASIS events.**

### Infrastructure & CI/CD
11. **Never hardcode URLs, paths, or service names.**
12. **Never deploy to the wrong AWS account/region** (`472838866351` / `eu-central-1`).
13. **Never use `/healthz` for a health check.**
14. **Never use a container registry other than Amazon ECR.**
15. **Never run parallel VTID executions.**
16. **Never skip schema documentation updates.**
17. **Never push ungoverned production changes.**

### Frontend & UX
24. **Never introduce inline JS or CSS.**
25. **Never load JS from CDNs.**
26. **Never add new Wallet routes.**
27. **Add UI screens only when the task asks for them**, and register them per the vitana-v1 screen rules (screen
    manifest `src/design/screen-manifest.json`, navigation registry `screens.json`/`exclusions.json`, parity ledger).
28. **Never break layout invariants.**
29. **Never ship experimental UI to prod.**
30. **Never violate CSP, even temporarily.**

### AI & Autonomy
33. **Never override AI routing rules.**
34. **Never enable autonomy without explicit approval.**
35. **Never allow silent model fallback.**
36. **Never skip memory retrieval.**
38. **Never bypass, hide or skip a governance gate, a governance failure or a validation step.**
39. **Never change provider priority ad-hoc.**

### Spoken Wording (STANDING RULE — VTID-03622)
41. **NEVER hardcode a sentence Vitana speaks — not a greeting, not a recovery line, not a per-language variant, not a
    template with a blank in it.** Every spoken string is **composed by the model at runtime**: write the INTENT
    ("briefly acknowledge you're back, hand the floor to the user") in English (§13b), not the finished sentence. A
    hardcoded line overrides the system prompt's `FLEXIBLE WORDING — ABSOLUTE` rule and is invisible to every
    cadence/anti-repeat mechanism in the greeting brain — why: one hardcoded reconnect line was heard 49 times by one
    user (VTID-03622).
42. **IF** about to write a user-facing spoken string in a prompt → **THEN STOP**, write the intent instead. Tell: a
    quoted sentence in the user's language in a `.ts` file, especially a `Record<lang, string>`. **This is about SPEECH
    only** — push notifications/emails/errors stay catalog entries via `tt()` (§13b), translated and reviewable.

### Persona Voices (STANDING RULE — VTID-04445)
42a. **Every Vitana voice, in every language, on every voice pipeline, is a woman's voice. Every Devon voice, in every
     language, on every pipeline, is a man's voice.** Owner rule, 2026-09-23 — not to be re-litigated. The rule and
     the gender of every voice id we can serve live in `orb/live/voice/persona-voice-gender.ts`;
     `test/vtid-04445-persona-voice-gender.test.ts` walks every table (Nova, Polly, Fish, Gemini, the LiveKit agent's
     defaults) and fails the build on a wrong-gender or unknown voice.
42b. **IF** a language has no male voice on the session's pipeline → **THEN** Devon does not join the call (the ticket
     stays filed, `ticket_filed_no_handoff`, Vitana keeps the member) — never let Devon speak with Vitana's voice, and
     never fall back from Devon's voice to hers on a synthesis error. Adding a voice means recording its gender in
     `persona-voice-gender.ts` from the provider's own catalog.

### Customer Support Pipeline (STANDING RULE — VTID-04456)
42c. **Every change that touches customer support must keep
     `test/vtid-04456-customer-support-pipeline-regression.test.ts` green** (gateway Jest CI; locally
     `npm run test:support`). It runs the real code of every stage end to end over an in-memory database: ticket
     intake (app route, `report_to_specialist`, typed `submit_*` tools), the Vitana→Devon hand-off, `append_to_ticket`,
     spec drafter, auto-dispatch, execution bridge, PR contract, completion reconciler. Golden scenarios: an in-app bug
     report, a bug reported to Vitana by voice, a bug raised in the conversation with Devon.
42d. **IF** the suite fails after your change → **THEN** fix the change. Do not loosen an assertion unless you changed
     the pipeline's contract on purpose, and then say so in the PR. **IF** you add a new support behaviour (a new
     intake path, a new ticket state, a new hand-off rule) → **THEN** add it as a scenario to the suite in the same PR.

### Operator Pipeline (STANDING RULE — VTID-04465)
42e. **Every change that touches the Operator Console → Dev Autopilot path must keep
     `test/vtid-04465-operator-pipeline-regression.test.ts` green.** It covers the console turn and its auth gate,
     `autopilot_run_task` and the on-ramp, the executor claim, the agent session and runner checks, the PR contract,
     the approval hold, the CI/deploy/verification watchers, the self-heal bridge and fix mode, env ownership, cancel,
     the retry breaker and outage gate, and the VTID ledger; it runs the real code of every stage over an in-memory
     database and GitHub, and is mutation-verified. Locally run `npm run test:operator`.
42f. **IF** the suite fails after your change → **THEN** fix the change; loosen an assertion only when you changed the
     pipeline's contract on purpose, and say so in the PR. **IF** you add a new operator behaviour (a new execution
     state, a new gate, a new hand-off) → **THEN** add it as a scenario to the suite in the same PR.

### Which Vitana Assists (STANDING RULE — VTID-04560)
42g. **The role whose screens are shown decides which Vitana assists — never the device, never where the user logged
     in.** Community screens get the community Vitana, the Command Hub the developer Vitana, admin screens the admin
     Vitana, BackOffice screens the BackOffice Vitana. The widget declares `surface` + `view_role`; the gateway
     resolves one Assistant Profile per session (`orb/profile/assistant-profile.ts`) before the setup envelope is
     built, and every consumer (instruction, tools, greeting, context, prewarm) reads it through
     `orb/profile/session-profile.ts`. A work surface never carries member content (RULE 0, Guided Journey, health,
     diary, memory garden) — `WORK_SURFACE_CONTEXT_MARKER` enforces it.
42h. **Every change that touches the ORB profile, the greeting ladder, the role switch or the developer assistant must
     keep `test/vtid-04560-role-separation-regression.test.ts` green** (`npm run test:roles`). It pins the profile
     matrix, both greeting ladders, per-surface instructions, the text-path engineering gate, the role registry, the
     dual-write role functions, the atlas drift guard (every route file claimed by a domain), the snapshot, the deep
     dive's read-only tools and the evaluation set. A new role gets a `ROLE_REGISTRY` entry; a new route file gets an
     atlas domain.

### Test / Service / Automation Accounts (STANDING RULE — VTID-03991)
43. **NEVER let a test, service, or automation account become visible to a real community member, in any form.** Not
    a DM, not a group-roster slot, not a search/directory result, not a "new member" feed entry. Why: two automation
    identities inserted into `user_tenants` set off the welcome-chat trigger for 445 real members and took two slots
    of a capped group (VTID-03990). This generalizes what `notification_test_actors` (VTID-03506, vitana-v1) does for
    notifications to every real-member-facing surface.
44. **IF** creating (or scripting the creation of) a test/service/automation account that will exist in the shared
    production tenant → **THEN** register its `user_id` in **both** allowlists before it can ever be inserted into
    `user_tenants`/`profiles` as a member — `service_bot_accounts` (this repo, VTID-03990, blocks fan-out broadcasts
    like welcome-chat) and `notification_test_actors` (`exafyltd/vitana-v1`, VTID-03506, blocks per-content
    notifications). Registering AFTER the account has real-member-facing rows is cleanup, not prevention.
45. **IF** building or reviewing any new query/endpoint/screen that lists, searches, recommends, or otherwise surfaces
    community member profiles to a real end user (member directory, "who's new", suggested connections,
    activity/leaderboard feeds, group rosters, etc.) → **THEN** it must exclude both allowlists above, the same way
    `fire_welcome_chat_on_membership()` does. Never assume a surface that queries `profiles`/`app_users`/`user_tenants`
    broadly and renders results to a real member is safe by default.

### Staging Verification Gate (STANDING RULE — VTID-04610)
Owner decision 2026-09-26. Full process: `docs/DEPLOYMENT-PIPELINE.md`. Applies to both repos.

46. **Merge → staging deploy → STAGING-VERIFY → ready message → PUBLISH.** Every merge that deploys is followed
    automatically by a test run against the new staging deployment: the service's smoke suite plus the change's own
    suite (`docs/validation/<VTID>/staging-tests.json`). A change is not done at merge, and not done at "deploy
    green" — it is done when that run has passed on the exact deployed commit.
47. **No suite, no merge.** **IF** a change deploys and no test proves it on staging → **THEN** write that test in the
    same PR. Never after the deploy, never "verified by looking".
48. **Staging tests are read-only.** Staging writes to the production Supabase project (test-account rules IF–THEN 31,
    31b, 32). Suites read, render and probe; anything that needs a write is proven by CI unit/integration tests. **No
    automated test suite ever targets production.** Production gets only read-only checks: the post-deploy
    verification (automatic rollback on failure, VTID-04647) and scheduled health checks — unauthenticated GETs of
    health and build-info endpoints, no sign-in, no writes, no browser suite. A browser suite runs on staging
    (VTID-04648).
49. **Ready message — two channels only.** **IF** STAGING-VERIFY passes → **THEN** the Claude Code session that merged
    the change, and the Command Hub Operator Chat, ask the developer: *"Staging verified — ready for deployment to
    production?"*, with the verified commit, what passed, and **every commit between production and the verified
    commit**. Not DevOps Chat, not push, not a PR comment. The merging session keeps watching until the result exists;
    merging is not a stopping point.
50. **"Yes" goes directly to PUBLISH** (the Command Hub promotion, or the same prod workflows dispatched from Claude
    Code pinned to the verified commit). Only the commit that passed is promoted — if staging now serves a newer,
    unverified commit, wait for its own verification. **IF** STAGING-VERIFY fails → **THEN** no ready message and no
    PUBLISH: fix forward and re-verify; never skip, disable or loosen a test to get green.

### Plan Sparring Gate (STANDING RULE — VTID-04868)
Owner decision 2026-10-03: *"Every new plan must have a ping pong sparring agent to support improvement of the plan …
before a new VTID is generated, and it must be a standard process no matter how many new plans we create."* Applies to
both repos and to every plan producer — Claude Code sessions, Operator Chat/Console, task intake, Dev Autopilot,
self-healing, voice, email intake, routines. Procedure: skill `.claude/skills/plan-sparring/`. There is no
trivial-change exemption.

51. **Plan → sparring → owner approval (or, for a CI-sparred plan that converged, policy approval
    `converged-auto-v1`, VTID-05214) → VTID → code.** No VTID is allocated for a plan that has not been sparred, and no
    VTID is ever allocated for the sparring itself.
52. **The partner is independent and adversarial.** It sees the plan and the code, never the planner's reasoning; it
    verifies the plan's premises against the code (`file:line`) and its findings are kept verbatim. Every finding gets
    an answer — accepted (plan changed), rejected (reason) or deferred (where tracked) — and goes back to the same
    partner. At least two passes for every change class; cap 3 rounds (standard). A rejection the partner still
    disputes is unresolved and goes to the owner.
53. **Partner model: Claude Opus 4.6 on AWS Bedrock** (owner decision 2026-10-04), one config value
    (`PLAN_SPARRING_MODEL`). **Fallback chain (owner decision 2026-10-19 — sparring must never stop on burned
    quota):** Opus 4.6 → Bedrock Sonnet 4.6 (`PLAN_SPARRING_FALLBACK_MODEL`) → DeepSeek `deepseek-v4-pro`
    (`PLAN_SPARRING_LAST_RESORT_MODEL`; kill switch `PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED=false`). The chain lives in
    the partner pass (`plan-sparring/partner.ts`), is sticky per round, logged loudly and recorded per entry in
    `model_log.fallback_tier`. Only when all three fail does the session escalate `model_unavailable`. Never Google.
54. **The gate is the database**, not this text: a `vtid_ledger` trigger checks every new VTID for a
    converged-or-escalated, owner-approved sparring record (or a converged, policy-approved one) with a matching plan
    hash. It runs in log mode first, then enforce. While sessions can run `execute_sql` as `postgres`, a disabled
    trigger or changed mode is **detected (hourly reconciler → P1), not prevented** — an accepted residual (owner
    decision 2026-10-04) until the Aurora cutover gives full role control.
55. **Break-glass** (P1 incident with gateway or Bedrock down): only the owner allocates through the exemption role,
    logged as `vtid.plan_sparring.break_glass`; a full sparring follows within 24h.

---

## 🔁 IF–THEN RULES

### VTID & Execution
1. **IF** a task has no VTID → **THEN** get one per ALWAYS 2b / §4.1 once its plan is sparred and approved (a Kiro
   plan's come from CI PLAN-SPAR) and continue. **STOP only when allocation fails** (allocator disabled, DB error) —
   never for the mere absence of one, and never as a prompt to ask the user for one.
2. **IF** `spec_status ≠ approved` → **THEN DO NOT EXECUTE**, unless the user has directly instructed the work in this
   conversation and its plan is approved — then set `spec_status='approved'` yourself when the VTID is allocated
   (ALWAYS 2b) and proceed.
3. **IF** `is_terminal=true` → **THEN DO NOT MODIFY TASK.**
4. **IF** task is `scheduled` → **THEN treat as standby only.**
5. **IF** task is moved to `in_progress` manually → **THEN treat as explicit consent.**

### Governance
6. **IF** governance fails → **THEN execution is forbidden.**
7. **IF** emergency bypass is used → **THEN log + escalate.**
8. **IF** execution is disarmed → **THEN monitor only.**
9. **IF** rules conflict → **THEN prefer stricter rule.**
10. **IF** uncertain → **THEN** follow the Autonomy Contract (VTID-04947): verify a fact read-only in code/logs/data
    first; for intent inside an approved plan, take the most conservative option and list it in Gate 2. Stop and ask
    only for the four cases the contract names.

### Infrastructure
11. **IF** AWS account/region ≠ `472838866351`/`eu-central-1` → **THEN STOP.**
12. **IF** service URL is unknown → **THEN resolve dynamically via `aws ecs`/`aws elbv2`.**
13. **IF** `/healthz` is used → **THEN replace with `/alive`.**
14. **IF** a container image is pushed anywhere but ECR → **THEN fix before deploy.**
15. **IF** CI/CD token is missing → **THEN abort merge.**

### Targeted Visual Verification (UI changes)
After a UI change, screenshot only what you changed (Playwright, desktop 1400×900 and mobile 390×844), interact with
the changed element (click the button, open the modal or drawer, fill the form, follow the redirect) and screenshot the
result, then view every screenshot: spacing, alignment, clipped text, mobile overflow, tap targets, the interaction's
result. Problems → fix and re-screenshot. **Never report a UI change as done without having inspected screenshots of
exactly what you changed.** A text-only/i18n string change may rely on the i18n tests instead.
- Playwright deps missing on WSL2 → `LD_LIBRARY_PATH="/tmp/chromium-libs/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"`
  or install via `apt download` + `dpkg-deb -x`.
- Playwright impossible → `curl` the page HTML and verify the changed element is in the DOM (fallback, not standard).

**Test user UUID:** `a27552a3-0257-4305-8ed0-351a80fd3701` — for when an authenticated user is needed (Playwright
screenshots, API calls, profile checks).

31. **NEVER write as this account — on ANY host. Reading is fine everywhere.** Not a post, comment, like, profile edit,
    onboarding step, or wallet call. **There is exactly one Supabase project and every frontend (incl.
    preview/staging) writes to it** — the host selects which code runs, not which database gets written, so "do it on
    the preview instead" mitigates nothing. Sign-in's own auth session is the sole unavoidable exception; anything
    else needs an explicit recorded reason, touches only rows this account owns, and gets reverted after. (VTID-03506)
31b. **Community content is the absolute case — no exception applies.** Posts, comments, likes, chat messages reach
    real feeds/lock screens instantly and can't be recalled; this account is a full tenant member, so a "harmless"
    test post is indistinguishable from a real one.
32. **IF** verifying a change needs content that doesn't exist yet → **THEN** verify against existing content, a
    unit/integration test, or a local Supabase — if none cover it, **raise it as a blocker, don't route around it.**
    Why: 5 test posts once became 960 notifications and 600 pushes to real members (`trg_notify_community_post` fans
    out tenant-wide; deleting the posts recalled nothing). DB-level suppression only silences notifications — it does
    **not** keep test content out of the real feed, so it is not a licence to write.

**Auth for frontend screenshots (Supabase REST):**
```typescript
// Sign in via API, inject into localStorage — no brittle form selectors
const session = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'e2e-test@vitana.dev', password: process.env.TEST_USER_PASSWORD }),
}).then(r => r.json());
await page.evaluate(s => {
  localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(s));
  localStorage.setItem('vitana.authToken', s.access_token);
  localStorage.setItem('vitana.viewRole', 'community');
}, session);
await page.reload();
```

### CI/CD Pipeline — STAGING-FIRST
Automatic (push/merge) deploys land on **staging only**; each deploy workflow's `cutover_gate` job keeps them away
from production. Production is reached **only** via the Command Hub PUBLISH button or a deliberate manual
`workflow_dispatch` of the relevant `AWS-PROD-DEPLOY-*.yml`, pinned and with a recorded reason (manual dispatch is
never frozen).

21. **IF** you push/merge to `main` → **THEN it deploys to STAGING** (gateway via `AWS-STAGE-DEPLOY-GATEWAY.yml` → ECS
    service `vitana-gateway`), not production. Verify on `preview-aws-gateway.vitanaland.com`, not prod.
22. **IF** you need code on PRODUCTION → **THEN do NOT push and expect prod to update.** Click PUBLISH in the Command
    Hub (promotes the tested staging build) or run the pinned manual dispatch of `AWS-PROD-DEPLOY-*.yml` with a
    recorded reason (IF–THEN 26).
23. **IF** you are tempted to manually dispatch a prod deploy workflow "to be safe" → **THEN STOP.** That is the old
    auto-to-prod habit. Auto = staging; prod = PUBLISH or a deliberate manual dispatch with a recorded reason only.
24. **IF** `worker-runner` / `orb-agent` / the autopilot executor needs a prod update → **THEN** use the relevant
    `AWS-PROD-DEPLOY-*.yml` workflow's manual `workflow_dispatch`. They have no staging twin: manual-dispatch-only.
25. **IF** making frontend CSS/JS changes (Command Hub) → **THEN bump the `?v=` cache-busting parameter in
    index.html.** The change auto-deploys to STAGING; it reaches prod only when PUBLISH is clicked.
26. **IF** a production deploy is approved WITHIN a session (in conversation, run as a manual `workflow_dispatch`, not
    PUBLISH) → **THEN it ships only this session's change(s), never whatever else is on staging/`main`.** Pin this
    session's merge commit via the `expected_commit`/`commit_sha` input of the live `AWS-PROD-DEPLOY-*.yml` (`gh
    workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo exafyltd/vitana-platform -f reason="…" -f expected_commit=<sha>`,
    or the Command Hub), never the defaults that ship the whole ref/staging build (`promote-staging` without
    `expected_commit`; `AWS-PROD-DEPLOY-FRONTEND.yml`/`DEPLOY.yml` `commit_sha` falling back to `github.sha`). **Never
    use `publish-to-prod.sh --ref`**: `workflow_dispatch` takes only a branch or tag, and the script wraps the dead
    GCP-era `EXEC-DEPLOY.yml` — never dispatch `EXEC-DEPLOY.yml`, for this or any other reason. **A pinned commit
    ships the full snapshot, every ancestor included:** before dispatching, diff it against the commit
    `/api/v1/admin/build-info` reports as live in production (§15); every commit in range must be this session's own
    or separately approved by the user — else **STOP and tell the user** exactly what else would ship. A PUBLISH
    promotion needs no extra scoping (it promotes the full tested staging build by design).

### AI & Autonomy (`AI-27`–`AI-31`, cited elsewhere as IF–THEN 27–31)
- AI-27. **IF** you are about to point an LLM-routing stage (`llm_routing_policy` — planner/worker/validator/
  operator/memory/triage/classifier) at `vertex`, Gemini, or any other Google Cloud API → **THEN STOP** — no
  sanctioned Google dependency for LLM routing, absolute. ORB voice runs on Amazon Nova Sonic (+ the
  Transcribe/Bedrock/Fish or Polly cascade) except the `sr`/`ru` carve-outs in the GCP banner (gated in
  `upstream-provider-selector.ts`; audiobook predicates under `services/guided-journey/`; a failed or capped render
  answers 422, never another voice). No Google call anywhere else; a new bridge language is a new switch, predicate
  and VTID, never a widened list.
- AI-28. **IF** validation is needed → **THEN use Claude (via Bedrock).**
- AI-29. **IF** an AI call is made → **THEN log provider, model and latency; IF** model fallback occurs → **THEN log
  it explicitly.** A fallback that lands on Google is an incident, not normal operation.
- AI-30. **IF** TTS is used → **THEN specify model_name explicitly.**
- AI-31. **IF** Bedrock is unconfigured (`BEDROCK_ROLE_ARN` unset) → **THEN the adapter reports `not_configured` and
  the router SKIPS it.** Flipping routing to `bedrock` before that var is set does not fail loudly — it quietly serves
  the fallback instead. Configure and verify Bedrock FIRST, then flip routing. Never the other way round.

### Retired-number index
Numbers retired by the 2026-10-20 cleanup (VTID-05280). An old reference to one of them lands here.

| Retired | Now |
|---|---|
| ALWAYS 3, 8, 9, 10 | generic, removed — memory: ALWAYS 26–29; gates: ALWAYS 4, IF–THEN 6–8, §5, rules 46–55; invariants: NEVER 35, 38, ALWAYS 10c |
| ALWAYS 18 (log provider/model/latency) | AI-29 |
| ALWAYS 19 (CI/CD governed) | ALWAYS 17, NEVER 17 |
| ALWAYS 21–22 (infra: verify after deploy, deploy source on `origin/main`) | ALWAYS 20 (deploys go through CI, ALWAYS 17); ALWAYS 21–22 now mean Database & Memory only |
| ALWAYS 32–34 (sidebar, Start Stream) | ALWAYS 31 |
| NEVER 2, 40 (bypass governance gates / validation) | NEVER 38; IF–THEN 6–7; rule 50 |
| NEVER 5, 6, 19, 20, 31, 32, 37 | generic, removed — IF–THEN 10 (verify, don't assume), NEVER 35, 38, ALWAYS 10c, ALWAYS 26 |
| NEVER 18 (assume deploy success) | ALWAYS 20 |
| NEVER 21–23 (Start Stream, sidebar) | ALWAYS 31 |
| IF–THEN 16–19 (deployment verification) | ALWAYS 20 |
| IF–THEN 20 (`git reset --hard origin/main` before deploy) | deleted — deploys go through CI (ALWAYS 17) |
| IF–THEN 16–20 (memory) | ALWAYS 26–29 (tenant context: ALWAYS 28), ALWAYS 7, ALWAYS 24 + NEVER 16 |
| IF–THEN 21–25 (frontend: sidebar, external JS, canon, accessibility, screen inventory) | ALWAYS 31; ALWAYS 36–37 + NEVER 24–25; IF–THEN 9; ALWAYS 40; NEVER 27 — IF–THEN 21–25 now mean CI/CD only |
| IF–THEN 26–30 (visual verification steps) | the "Targeted Visual Verification" paragraph — IF–THEN 26 now means CI/CD 26, 27–31 the AI rules (`AI-27`–`AI-31`) |
| IF–THEN 26 (AI: route Claude at Bedrock) | ALWAYS 10a |

---

# PART 2: TECHNICAL REFERENCE
The detailed reference sections live in path-scoped files under `.claude/rules/`, loaded automatically only when a
session touches a matching path (a pure move — nothing rewritten or summarized):

- **§1, §1b, §8, §9, §11, §12, §15, §16** (GCP decommission history, AWS production topology, environment variables,
  CI/CD workflows, quick reference, document references, deployment verification, staging-first pipeline) →
  `.claude/rules/infrastructure.md`
- **§2, §2b–§2e, §3, §6, §7, §10, §13, §13b, §13c, §14** (services architecture, LLM routing/Bedrock,
  TTS/image/voice providers, database, OASIS events, worker orchestrator API, coding conventions, server-side i18n,
  commerce vision, memory & intelligence architecture) → `.claude/rules/backend.md`

**§4 (VTID System) and §5 (Governance) stay here, unscoped**, so VTID allocation and the governance kill switches apply
whatever files a session opens.

---

## 4. VTID SYSTEM
### 4.1 Allocation (STANDING RULE — VTID-03448, VTID-04868)
**Settled: never ask the user "should this have a VTID" or "do you have a VTID for this".** Every task that results
in a commit gets one. **It is allocated only after its plan is sparred and approved** (Part 1 rules 51–55): owner
Gate 1 for a plan sparred with a local partner (skill `plan-sparring`), or CI policy `converged-auto-v1` for a
`plan(` PR. A Kiro plan's lane VTIDs are allocated by CI PLAN-SPAR on convergence — Kiro never allocates by hand
(`.claude/rules/collaboration.md` §7a). A session that allocates itself passes the sparring id (`p_sparring_id`) once
the gateway tier is live.

Procedure, in order of preference:

1. **Gateway API**: `POST /api/v1/vtid/allocate` with `{ source, layer, module }` (see §11 for URL resolution).
   Returns `{ vtid, num, id }`. **Since VTID-04727 it needs `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` or an
   `exafy_admin` JWT** (enforced on staging; production logs unauthenticated calls until it is flipped to enforce). A
   session without either uses path 2.
2. **Direct Supabase RPC** (when the gateway isn't reachable from the session): call
   `allocate_global_vtid(p_source, p_layer, p_module)` via the Supabase MCP/CLI against the `VITANA` project. Returns
   the same shape.
3. Either path atomically mints the next `VTID-XXXXX` and creates the ledger shell row in one transaction —
   allocated and registered can never split.
4. Immediately follow up with an `UPDATE vtid_ledger` (or the equivalent gateway PATCH) to set a real
   `title`/`summary`/`description` (never leave the "Allocated - Pending Title" placeholder), and set
   `status='in_progress'` + `spec_status='approved'` when the user has directly instructed the work.
5. **If the allocator itself is disabled** (`VTID_ALLOCATOR_ENABLED` false and no DB override) — that's the one real
   stop condition. Tell the user allocation is blocked and why; do not fabricate a VTID number and do not silently
   proceed without one.
6. One VTID per distinct piece of work. Two unrelated fixes requested in the same message get two VTIDs.
7. **Picking up an existing VTID** (from Claude Code, Kiro IDE or the Operator): `scripts/dev/resume-vtid.sh <VTID>`
   or the Operator tool `dev_resume_vtid` show its ledger row, PRs, evidence, notes and deploy state — continue that
   VTID, never allocate a new one for it. A session that stops before merge writes "Where it stopped / Open / Next" in
   its PR body (the template's Handoff section); the resume pack shows it. (VTID-05060)

### VTID Format
- Pattern: `VTID-XXXXX` (5 digits, zero-padded)
- Example: `VTID-01200`

### Target Roles (VTID-01010)
```typescript
const TARGET_ROLES = ['DEV', 'COM', 'ADM', 'PRO', 'ERP', 'PAT', 'INFRA'] as const;
```
- `INFRA` must be exclusive (cannot combine with others)

### Task Lifecycle
```
scheduled → in_progress → [claimed] → [executing] → completed/failed
                                                   ↓
                                            is_terminal=true
                                            terminal_outcome=success|failed|cancelled
```

### Task Eligibility (for worker execution)
A task is eligible when:
1. `status === 'in_progress'`
2. `spec_status === 'approved'`
3. `is_terminal === false`
4. `claimed_by === null` OR `claimed_by === this_worker`
5. **(VTID-03516) It is the autonomous plane's own work** — `metadata.source === 'self-healing'` or
   `metadata.autonomous_execution === true`.

**Criterion 5 is not optional bookkeeping — without it the other four describe a session's own VTID exactly** (§4.1
has a session set `status='in_progress'` + `spec_status='approved'` on the VTID it works itself). Why: for six days
the worker-runner claimed those VTIDs seconds after allocation and terminalized them failed (VTID-03516, changelog
2026-08-06).

### Two execution planes, one ledger (VTID-03516)
There are **two** ways work gets done here and they share `vtid_ledger`:

| Plane | Who executes | Marks its rows with |
|---|---|---|
| **Session** | a Claude Code session / a human, in-conversation | anything else (`metadata.source` is free text — `claude-code`, `orb-voice`, `aws-sns-gchat-alerts`, …) |
| **Autonomous** | worker-runner → worker-{backend,memory,ai,…} | `metadata.source='self-healing'` or `metadata.autonomous_execution=true` |

- **Never** widen the autonomous claim pool with a denylist of session-looking `metadata.source` values. `source` is
  free text and most session VTIDs carry no `claude` marker at all. The gate is an **allowlist**
  (`isAutonomousExecutionTask()`, `routes/worker-orchestrator.ts`), enforced on both the pending feed and the claim
  write path.
- **New autonomous producers must set `metadata.autonomous_execution = true`.** Being `in_progress` + `approved` is
  not sufficient.
- **Never "fix" this by populating `ANTHROPIC_API_KEY` on the worker-runner** — with a working key it would
  autonomously edit code for a VTID a session is concurrently working (silent concurrent writes, against "Never run
  parallel VTID executions"). The eligibility predicate is the actual fix.

---

## 5. GOVERNANCE
### Hard Governance Rules
1. **EXECUTION_DISARMED** - Global kill switch for autonomous execution
2. **AUTOPILOT_LOOP_ENABLED** - Controls autopilot polling
3. **VTID_ALLOCATOR_ENABLED** - Controls VTID allocation
4. One VTID at a time per worker (no parallel execution)
5. Memory-first (workers don't write to DB directly)
6. Idempotent completion (safe to call complete multiple times)

### Governance Endpoints
- `POST /api/v1/governance/evaluate` - Evaluate governance for action
- `GET /api/v1/governance/status` - Get governance status

### Bypass Header (Emergency Only)
```
X-BYPASS-ORCHESTRATOR: EMERGENCY-BYPASS
```

---

## CHANGE LOG
In `docs/CHANGELOG.md` (recent) and `docs/CHANGELOG-ARCHIVE.md` (pre-2026-08-19) — an audit trail, not a rule; read
it on demand (`get_why`, git archaeology, a past incident). Incident numbers belong there, not here.

## Codebase intelligence (recommended)
RepoWise and Graphify are the fastest way into unfamiliar or cross-module code; use them when they help, not as a
gate. Source code and tests stay the final authority over any index result — never invent a relationship the index or
the source does not support.
- **RepoWise** (the MCP server for this repository and checkout; on a stale-index hint run `repowise update`):
  `get_overview` (once, unfamiliar area), `search_codebase`, `get_context`, `get_symbol` (full bodies only when
  needed), `get_why` (rationale, before a refactor), `get_risk` (before changing shared or high-risk files).
- **Graphify** (when `graphify-out/graph.json` exists): `graphify query "<question>" --budget 1500`,
  `graphify path "<A>" "<B>"`, `graphify explain "<concept>"`; `graphify-out/wiki/index.md` for broad navigation,
  `graphify-out/GRAPH_REPORT.md` only for architecture review. `graphify update .` refreshes the graph (AST-only, no
  API cost); `graphify claude install` once per repository for the built-in Claude integration.
