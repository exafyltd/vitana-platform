# CLAUDE.md - Vitana Platform Development Guide
**CANONICAL REFERENCE - Last Updated: 2026-08-19**

This file contains critical information for AI assistants working on the Vitana platform.
**READ THIS BEFORE MAKING ANY CHANGES.**

> **GCP IS FULLY DECOMMISSIONED — with ONE narrow, explicit, time-boxed
> exception (VTID-04000, §2e-vertex-serbian-bridge).** GCP project
> `lovable-vitana-vers1` billing was disabled 2026-08-16 and the GCP
> `gateway` Cloud Run service was deleted the same night
> (VTID-03599/VTID-03649 emergency response). `lovable-vitana-vers1` stays
> permanently dead — nothing in this section reverses that. **Separately**,
> the platform owner opened a brand-new, dedicated GCP project (90-day free
> credit window) and asked to revive the Vertex Live API — never deleted,
> only made structurally unreachable, see `upstream-provider-selector.ts`'s
> own VTID-03723 header — for **Serbian voice sessions only**, behind
> `VERTEX_SERBIAN_BRIDGE_ENABLED=true`. Every other Vitana process still
> runs on AWS exclusively: no OASIS, no autopilot, no other agent, no Cloud
> Run, no Cloud Scheduler on GCP anywhere else. Before touching any
> `gcloud`/Cloud Run/Artifact Registry/GCP-project reference below, check
> whether it's this one narrow carve-out or the general decommission — they
> are not the same thing, and conflating them either reintroduces the
> silent-fallback pattern that caused the original Gemini cost incident
> (§2b) or wrongly blocks the platform owner's own explicit, scoped
> decision. See the CHANGE LOG entry for this pass for what was touched and
> what is still an open follow-up (a few code-level defaults still fall
> back toward Google when their controlling env var is unset — see
> §2c/§2d/§2e).

---

# PART 1: CORE RULES (Always / Never / If–Then)

These are **non-negotiable behavioral rules** for developing the Vitana platform.

---

## ✅ ALWAYS RULES

Claude must **always** do the following:

### Source of Truth & Governance

1. **Always treat OASIS as the single source of truth** for task state, lifecycle, and governance.
2. **Always verify VTID existence** before execution, deployment, or automation.
2b. **Always self-allocate the VTID.** Every new task — a bug report, a
    feature ask, a "fix this," a doc change, anything that results in a
    commit — gets its own VTID, allocated by Claude itself from the ledger
    (`POST /api/v1/vtid/allocate`, or directly via the `allocate_global_vtid`
    Supabase RPC when the gateway endpoint isn't reachable from the session)
    at the START of the work, BEFORE touching any code. This is standing,
    permanent governance — yesterday, today, and always. **Never ask the
    user whether a VTID is needed, never ask them to supply one, and never
    wait for confirmation before allocating.** Set `spec_status='approved'`
    and `status='in_progress'` on the freshly allocated row when the user
    has directly instructed the work in conversation — that instruction
    IS the approval (see IF-THEN rule "task moved to in_progress manually
    → explicit consent"). Multiple distinct fixes in one conversation get
    multiple distinct VTIDs, not one VTID shared across unrelated changes.
    (VTID-03448)
3. **Always check memory first** before proposing changes, fixes, or new systems.
4. **Always respect existing governance rules** over new ideas or optimizations.
5. **Always require `spec_status=approved`** before execution.
6. **Always terminalize tasks** (`is_terminal=true`) when finished.
7. **Always emit OASIS events** for real state transitions.
8. **Always assume defense-in-depth** (multiple gates are intentional).
9. **Always prefer existing systems** over rebuilding.
10. **Always fail loudly** if a required invariant is missing.

### AI Providers (STANDING RULE — VTID-03563)

10a. **Always use Claude via AWS Bedrock (`provider: 'bedrock'`). Always.**
     This is a permanent, standing decision made by the platform owner on
     2026-08-10 and is not to be re-litigated or re-asked. Every stage in
     `llm_routing_policy` that needs a Claude model points at the
     **`bedrock`** provider — never at `anthropic`.

10b. **Never route a stage at the direct Anthropic API (`provider:
     'anthropic'`).** That account has **no credit balance**. Every call
     returns `400 invalid_request_error — "Your credit balance is too low
     to access the Anthropic API"` and then **silently falls back to
     Gemini/Vertex**, which is how the Gemini bill kept growing while the
     policy table claimed two stages were already on Claude. Measured
     2026-08-10: 268 such failures in 14 days, 33 in one day. Bedrock bills
     to AWS and is unaffected by that balance. See §2b.

10c. **Never "fix" a Claude outage by failing a stage back to
     `vertex`/Gemini.** A Claude stage's fallback is another Bedrock model
     or an explicit hard failure — never Google. A silent Google fallback
     is what made this invisible for months.

### Infrastructure & Deployment (AWS — GCP is decommissioned, see banner above)

11. **Always use AWS account `472838866351`, region `eu-central-1`.** This is
    the only cloud account/region Vitana infrastructure runs in.
12. **Always resolve ECS/ALB service state dynamically** — `aws ecs
    describe-services`, `aws elbv2 describe-target-groups` — never hardcode
    a task count, IP, or URL.
13. **Always push images to Amazon ECR**, never `gcr.io`/Artifact Registry
    (both are permanently unreachable now — GCP billing is off).
14. **Always expose `/alive`** as the health endpoint.
15. **Always use port `8080`.**
16. **Always read the live ECS task definition** (`aws ecs
    describe-task-definition`) before editing or redeploying it — task-def
    drift (a secret ARN, an env var) has repeatedly caused silent outages
    here (VTID-03513, VTID-03516).
17. **Always deploy via the canonical `AWS-*-DEPLOY-*.yml` GitHub Actions
    workflows** — never a manual `aws ecs update-service` outside CI.
18. **Always log provider, model, and latency for AI calls.**
19. **Always treat CI/CD as governed, not ad-hoc.**
20. **Always verify source code BEFORE deployment** — grep for critical routes/features in the deploy source to confirm they exist.
21. **Always verify deployment AFTER deploy** — curl critical endpoints to confirm the new code is live (check for JSON responses, not HTML 404s).
22. **Always verify the deploy source is on latest `origin/main`** before deploying — run `git fetch origin && git log --oneline origin/main -3` and compare with local repo.

### Database & Memory

21. **Always use the platform's Postgres store (Aurora, migrating off Supabase — see §3) as the persistent data store.**
22. **Always enforce tenant isolation (RLS).**
23. **Always use snake_case table names.**
24. **Always update `DATABASE_SCHEMA.md` when schema changes.**
25. **Always route DB mutations through Gateway APIs.**
26. **Always treat `memory_items` as canonical infinite memory.**
27. **Always use pgvector for semantic memory.**
28. **Always scope memory by tenant + role.**
29. **Always retrieve memory selectively (relevance-based).**
30. **Always log memory debug snapshots in dev.**

### Frontend & UX

31. **Always preserve sidebar structure and order.**
32. **Always keep exactly 10 sidebar items.**
33. **Always keep Start Stream in the sidebar utility zone.**
34. **Always treat Start Stream as private AI + screen share.**
35. **Always treat ORB as voice-first, multimodal.**
36. **Always comply with CSP (no inline scripts/styles).**
37. **Always bundle JS locally.**
38. **Always respect fixed layout regions.**
39. **Always use Markdown specs (no Figma).**
40. **Always maintain WCAG 2.2 AA compliance.**

---

## ❌ NEVER RULES

Claude must **never** do the following:

### Architecture & Logic

1. **Never invent new projects, environments, or services.** AWS is now
   canonical production for **every** Vitana service — the GCP↔AWS
   parallel/DR period (VTID-03398, VTID-03409, VTID-03410, VTID-03411,
   VTID-03414, VTID-03415, VTID-03419) ended when GCP billing was disabled
   2026-08-16 (VTID-03599/VTID-03649). See §1b for the full service table.
   A new AWS resource (a new ECS service, a new ALB rule) still needs its
   own VTID — this rule is about not inventing infrastructure ungoverned,
   not about GCP specifically any more.
2. **Never bypass governance gates.**
3. **Never execute without a VTID.**
4. **Never deploy without OASIS approval.**
5. **Never rebuild systems that already exist.**
6. **Never assume context that is not verified.**
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
18. **Never assume deployment success without verification.**
19. **Never silence errors.**
20. **Never auto-fix without explaining root cause.**

### Frontend & UX

21. **Never move Start Stream outside the sidebar.**
22. **Never confuse Start Stream with Go Live / Live Rooms.**
23. **Never change sidebar navigation.**
24. **Never introduce inline JS or CSS.**
25. **Never load JS from CDNs.**
26. **Never add new Wallet routes.**
27. **Never invent UI screens.**
28. **Never break layout invariants.**
29. **Never ship experimental UI to prod.**
30. **Never violate CSP, even temporarily.**

### AI & Autonomy

31. **Never hallucinate data.**
32. **Never invent memory.**
33. **Never override AI routing rules.**
34. **Never enable autonomy without explicit approval.**
35. **Never allow silent model fallback.**
36. **Never skip memory retrieval.**
37. **Never respond confidently when uncertain.**
38. **Never hide governance failures.**
39. **Never change provider priority ad-hoc.**
40. **Never bypass validation.**

### Spoken Wording (STANDING RULE — VTID-03622)

41. **NEVER hardcode a sentence Vitana speaks. Not a greeting, not a
    recovery line, not a per-language variant, not a template with a
    blank in it.** Every spoken string must be **composed by the model at
    runtime** — write the INTENT ("briefly acknowledge you're back, hand
    the floor to the user") in English (§13b), not the finished sentence.
    A hardcoded line overrides the system prompt's own `FLEXIBLE WORDING —
    ABSOLUTE` rule and is invisible to every cadence/anti-repeat mechanism
    in the greeting brain. Real cost: VTID-03622 shipped one hardcoded
    reconnect line and a user heard it **49 times** (Nova drops ~10% of
    sessions at open, §2e, so reconnects aren't rare).

42. **IF** about to write a user-facing spoken string in a prompt →
    **THEN STOP**, write the intent instead. Tell: a quoted sentence in the
    user's language in a `.ts` file, especially a `Record<lang, string>`.
    **This is about SPEECH only** — push notifications/emails/errors stay
    catalog entries via `tt()` (§13b), which must stay translated/reviewable.

### Test / Service / Automation Accounts (STANDING RULE — VTID-03991)

43. **NEVER let a test, service, or automation account become visible to a
    real community member, in any form.** Not a DM, not a group-roster slot,
    not a search/directory result, not a "new member" feed entry. Real cost:
    VTID-03990 — two automation identities (`claude-code-agent`,
    `operator-autopilot`) were inserted directly into `user_tenants` and the
    VTID-03089 welcome-chat trigger, which only excluded one hardcoded bot
    user id, treated them as real new members — 445 real members got an
    identical intro DM within milliseconds, and both accounts occupied two
    of the 100 slots in a capped system group. The platform owner's own
    words: "those test accounts, non-real accounts should never reach the
    production, it looks ugly and confusing for the real members." This is
    the same standing concern `notification_test_actors` (VTID-03506, this
    repo's sibling community-app rule) already codifies for notifications —
    this rule generalizes it to every real-member-facing surface, not just
    that one.
44. **IF** creating (or scripting the creation of) a test/service/automation
    account that will exist in the shared production tenant → **THEN**
    register its `user_id` in **both** allowlists before it can ever be
    inserted into `user_tenants`/`profiles` as a member — `service_bot_accounts`
    (this repo, VTID-03990, blocks fan-out broadcasts like welcome-chat) and
    `notification_test_actors` (`exafyltd/vitana-v1`, VTID-03506, blocks
    per-content notifications). Registering AFTER the account already has
    real-member-facing rows is cleanup, not prevention — VTID-03990 needed a
    separate, explicit data-deletion pass (445 `chat_messages` +
    2 `chat_group_members` rows) because the accounts existed and acted for
    almost a day before anyone noticed.
45. **IF** building or reviewing any new query/endpoint/screen that lists,
    searches, recommends, or otherwise surfaces community member profiles to
    a real end user (member directory, "who's new", suggested connections,
    activity/leaderboard feeds, group rosters, etc.) → **THEN** it must
    exclude both allowlists above, the same way `fire_welcome_chat_on_membership()`
    now does. A surface that queries `profiles`/`app_users`/`user_tenants`
    broadly and renders results to a real member is exactly the shape of gap
    VTID-03990 closed for one specific trigger — don't assume a new one is
    safe by default.

---

## 🔁 IF–THEN RULES

Claude must apply the following **conditional logic**:

### VTID & Execution

1. **IF** VTID does not exist → **THEN self-allocate one immediately (see
   Part 1 rule 2b / §4.1) and continue. THEN STOP only applies to VTIDs
   that fail to allocate (allocator disabled, DB error) — never to the
   mere absence of one, and never as a prompt to ask the user for one.**
2. **IF** `spec_status ≠ approved` → **THEN DO NOT EXECUTE**, unless the
   user has directly instructed the work in this conversation, in which
   case set `spec_status='approved'` yourself when self-allocating (rule
   2b) and proceed.
3. **IF** `is_terminal=true` → **THEN DO NOT MODIFY TASK.**
4. **IF** task is `scheduled` → **THEN treat as standby only.**
5. **IF** task is moved to `in_progress` manually → **THEN treat as explicit consent.**

### Governance

6. **IF** governance fails → **THEN execution is forbidden.**
7. **IF** emergency bypass is used → **THEN log + escalate.**
8. **IF** execution is disarmed → **THEN monitor only.**
9. **IF** rules conflict → **THEN prefer stricter rule.**
10. **IF** uncertain → **THEN stop and ask.**

### Infrastructure

11. **IF** AWS account/region ≠ `472838866351`/`eu-central-1` → **THEN STOP.**
12. **IF** service URL is unknown → **THEN resolve dynamically via `aws ecs`/`aws elbv2`.**
13. **IF** `/healthz` is used → **THEN replace with `/alive`.**
14. **IF** a container image is pushed anywhere but ECR → **THEN fix before deploy.**
15. **IF** CI/CD token is missing → **THEN abort merge.**

### Deployment Verification

16. **IF** deploying an ECS service → **THEN grep source for critical routes/features BEFORE building the image.**
17. **IF** deploy completes → **THEN curl critical endpoints and confirm JSON response (not HTML 404).**
18. **IF** curl returns `text/html` content-type → **THEN the route does NOT exist on deployed code — deploy failed or wrong code.**
19. **IF** deploying by hand rather than via CI → **THEN run `git fetch origin && git log --oneline origin/main -3` and compare with the checkout you're building from to confirm it has latest code.**
20. **IF** the checkout you're deploying from is behind `origin/main` → **THEN run `git reset --hard origin/main` before deploying.**

### Targeted Visual Verification (MANDATORY - Updated 2026-04-14)

**Core principle: screenshot what you changed, interact with it, verify it works — before reporting done.**

26. **AFTER finishing any UI change** (button, layout, page, modal, form, nav) → run this protocol BEFORE telling the user it's done:

    **Step 1 — Identify what to verify:**
    Look at your own diff. What pages/components did you change? Those are the ONLY pages you need to screenshot. Not 20 pages — just the ones you touched.

    **Step 2 — Screenshot the changed page(s):**
    Use Playwright to navigate to the specific page you changed. Screenshot it in BOTH viewports:
    - Desktop: 1400×900
    - Mobile (iPhone 14): 390×844
    ```typescript
    // Example: you changed the Settings page
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('https://vitanaland.com/settings'); // AWS ECS — the old Cloud Run URL is dead, GCP is decommissioned
    await page.screenshot({ path: '/tmp/settings-mobile.png' });
    ```

    **Step 3 — Interact with the changed element:**
    If you added/changed a button → click it, screenshot the result.
    If you added/changed a modal → open it, screenshot it open.
    If you added/changed a form → fill it, screenshot the filled state.
    If you added/changed a redirect → navigate, verify the URL changed.
    If you added/changed a drawer → open it, screenshot the overlay.

    **Step 4 — Read and inspect the screenshots:**
    Use the Read tool to view each screenshot image. Check:
    - Does the element look correct? (spacing, alignment, colors)
    - Is text readable and not clipped?
    - On mobile: is there horizontal overflow? Are tap targets large enough?
    - Does the interaction produce the expected result?
    - Are there any visual glitches, overlapping elements, or missing content?

    **Step 5 — Fix or report:**
    - If the screenshot shows problems → fix them, redeploy, re-screenshot.
    - If the screenshot looks correct → report completion WITH the screenshot evidence.

27. **NEVER** report a UI change as "done" without having taken and visually inspected a screenshot of the specific thing you changed.
28. **NEVER** screenshot 20 pages when you changed 1 button. Verify what you changed, not the entire app.
29. **IF** Playwright deps are missing on WSL2 → set `LD_LIBRARY_PATH="/tmp/chromium-libs/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"` or install via `apt download` + `dpkg-deb -x`.
30. **IF** you cannot run Playwright at all → use `curl` to fetch the page HTML and verify the changed element exists in the DOM. This is a fallback, not the standard.

**Test user UUID:** `a27552a3-0257-4305-8ed0-351a80fd3701`
Use this user when an authenticated user is needed for testing (e.g., Playwright screenshots, API calls, profile checks).

31. **NEVER write as this account — on ANY host. Reading is fine everywhere.**
    Not a post, comment, like, profile edit, onboarding step, or wallet call.
    **There is exactly one Supabase project and every frontend (incl. preview/
    staging) writes to it** — the host selects which code runs, not which
    database gets written, so "do it on the preview instead" mitigates
    nothing. Sign-in's own auth session is the sole unavoidable exception;
    anything else needs an explicit recorded reason, touches only rows this
    account owns, and gets reverted after. (VTID-03506)
31b. **Community content is the absolute case — no exception applies.** Posts,
    comments, likes, chat messages reach real feeds/lock screens instantly and
    can't be recalled; this account is a full tenant member, so a "harmless"
    test post is indistinguishable from a real one.
32. **IF** verifying a change needs content that doesn't exist yet → **THEN**
    verify against existing content, a unit/integration test, or a local
    Supabase — if none cover it, **raise it as a blocker, don't route around
    it.** Real cost when this wasn't followed: 5 test posts became **960
    notifications and 600 pushes** to real members in ~6 minutes
    (`trg_notify_community_post` fans out tenant-wide); deleting the posts
    didn't recall the pushes. DB-level suppression now exists but only
    silences notifications — it does **not** keep test content out of the
    real feed, so it's not a licence to write.

**Auth for frontend screenshots (Supabase REST):**
```typescript
// Sign in via API, inject into localStorage — no brittle form selectors
const session = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'e2e-test@vitana.dev', password: 'VitanaE2eTest2026!' }),
}).then(r => r.json());
await page.evaluate(s => {
  localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(s));
  localStorage.setItem('vitana.authToken', s.access_token);
  localStorage.setItem('vitana.viewRole', 'community');
}, session);
await page.reload();
```

### CI/CD Pipeline — STAGING-FIRST (CRITICAL - Updated 2026-06-04)

> **Cutover rule (time-gated):** the switch flips at **Mon 8 Jun 2026, 10:00
> Europe/Berlin** (08:00 UTC). **Before** that instant, every deploy path
> reaches production on push as it always did. **At/after** it, every automatic
> (push) deploy path is FROZEN from prod and auto deploys land on **staging
> only**. Production is then reached **only** via (a) the single PUBLISH button
> in the Command Hub, or (b) a deliberate manual run — `workflow_dispatch` of
> the relevant deploy workflow, or `scripts/deploy/publish-to-prod.sh`. The gate
> lives in each deploy workflow's `cutover_gate` job; manual dispatch is never
> frozen. No redeploy is needed to flip it — it is purely time-based.

21. **IF** you push/merge to `main` **on/after the cutover** → **THEN it deploys to STAGING (gateway via `AWS-STAGE-DEPLOY-GATEWAY.yml` → ECS service `vitana-gateway`). It does NOT touch production. Verify on `preview-aws-gateway.vitanaland.com`, not prod. (The GCP `STAGE-DEPLOY.yml`/`gateway-staging`/`preview-gateway.vitanaland.com` path this rule originally described is dead — GCP is decommissioned.)**
22. **IF** you need code on PRODUCTION (post-cutover) → **THEN do NOT push and expect prod to update. Either click PUBLISH in the Command Hub (promotes the tested staging build) or run `scripts/deploy/publish-to-prod.sh --service <svc> --vtid <id> --reason "<why>"` (the explicit exception).**
23. **IF** you are tempted to manually dispatch a prod deploy workflow "to be safe" post-cutover → **THEN STOP. That is the old auto-to-prod habit. Auto = staging. Prod = PUBLISH button or escape-hatch/manual dispatch (`AWS-PROD-DEPLOY-GATEWAY.yml` etc.) only, with a recorded reason.**
24. **IF** `worker-runner` / `orb-agent` / the autopilot executor needs a prod update → **THEN use the escape-hatch script or the relevant `AWS-PROD-DEPLOY-*.yml` workflow's manual `workflow_dispatch`. These have no staging twin, so they are manual-dispatch-only.**
25. **IF** making frontend CSS/JS changes (Command Hub) → **THEN bump the `?v=` cache-busting parameter in index.html. Post-cutover the change auto-deploys to STAGING; it reaches prod only when PUBLISH is clicked.**
26. **IF** a production deploy is approved WITHIN a session — i.e. the user
    approves shipping to prod in conversation, and it is carried out via the
    escape-hatch script or a manual `workflow_dispatch`, **not** via the
    Command Hub PUBLISH button → **THEN that deploy is scoped exclusively to
    the change(s) this session made, never to "whatever else is currently on
    staging/`main`."** PUBLISH is a deliberate, human-operated decision to
    promote the *entire* tested staging build; an in-session approval is a
    narrower thing — consent for the specific fix this session produced, not
    a blanket sign-off on unrelated work that happens to be sitting on
    staging/`main` at the same moment (someone else's merged-but-unverified
    PR, a half-finished feature flag flip, etc.). Concretely: pin the deploy
    to this session's own commit via the `expected_commit`/`commit_sha` input
    on the relevant `AWS-PROD-DEPLOY-*.yml` workflow's own `workflow_dispatch`
    — rather than accepting the tools' own defaults
    (`AWS-PROD-DEPLOY-GATEWAY.yml`'s default `promote-staging` mode with no
    `expected_commit`, or `AWS-PROD-DEPLOY-FRONTEND.yml`/`DEPLOY.yml`'s
    `commit_sha` falling back to `github.sha`), all of which ship the
    ref/staging build **as a whole**, not just this session's diff. **Do not
    use `publish-to-prod.sh`'s `--ref` for this** — it forwards straight to
    `gh workflow run --ref`, which GitHub's `workflow_dispatch` API only
    accepts as a branch or tag, never a raw commit SHA, so passing a commit
    there fails outright before anything deploys; the script also wraps
    `EXEC-DEPLOY.yml`, the GCP/Cloud Run-era workflow §9 already flags as
    dead code (GCP is decommissioned, §1) — do not dispatch it at all, for
    this or any other reason. Dispatch the live `AWS-PROD-DEPLOY-*.yml`
    workflow directly instead (`gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml
    --repo exafyltd/vitana-platform -f reason="…" -f
    expected_commit=<this-session's-merge-commit-SHA>`, or the Command Hub).
    **Pinning a commit is necessary but not
    sufficient on its own:** every one of these deploy paths checks out (or,
    for `promote-staging`, ships an image built from) the FULL repository
    snapshot AT that commit, never a diff — so a pinned commit still carries
    every commit that is already an ANCESTOR of it, including anything merged
    to `main`/staging before this session's own work that this conversation
    never reviewed or approved. Before dispatching, diff the pinned commit
    against the revision **currently live in production** (its
    `/api/v1/admin/build-info` reports the deployed commit — §15) and confirm
    every commit in that range is either this session's own or something the
    user has separately approved. **IF** that range contains changes this
    session didn't produce and the user hasn't approved, and they can't be
    excluded (no deploy path here ships a pinned diff, only a full snapshot)
    → **THEN STOP and tell the user** exactly what else would ship alongside
    their change, rather than treating "the commit is pinned" or "the deploy
    tool defaults to `main`" as authorization to ship everything up to that
    point. This does not apply to a PUBLISH-button promotion — that action's
    entire, documented purpose is promoting the full current staging build,
    and needs no additional scoping.

### Memory

16. **IF** memory exists → **THEN retrieve, don't recreate.**
17. **IF** memory is irrelevant → **THEN do not inject.**
18. **IF** tenant context is missing → **THEN do not proceed.**
19. **IF** memory write fails → **THEN emit error event.**
20. **IF** memory schema changes → **THEN migrate + document.**

### Frontend & UX

21. **IF** change touches sidebar → **THEN it is forbidden.**
22. **IF** JS must run → **THEN it must be external.**
23. **IF** UI spec conflicts with canon → **THEN canon wins.**
24. **IF** accessibility fails → **THEN block release.**
25. **IF** screen is not in inventory → **THEN do not add it.**

### AI & Autonomy

26. **IF** a stage needs Claude → **THEN route it at `provider: 'bedrock'`,
    never `'anthropic'`.** (VTID-03563 — see ALWAYS 10a/10b and §2b.)
    **This supersedes the former rules 26 and 27**, which said to use Gemini
    Pro for the planner and Gemini Flash for the worker. Those are obsolete:
    the standing direction is Claude-on-Bedrock, off Google.
27. **IF** you are about to point an LLM-routing stage (`llm_routing_policy`
    — planner/worker/validator/operator/memory/triage/classifier) at
    `vertex`, Gemini, or any other Google Cloud API → **THEN STOP.** There
    is no sanctioned Google dependency for LLM routing at all — that part
    of this rule is unchanged and absolute. **This does NOT cover ORB
    voice-to-voice any more.** ORB voice used to fall back to Vertex Live
    for every language; that general fallback is still permanently dead
    (GCP billing disabled 2026-08-16, VTID-03649) and voice runs on Amazon
    Nova Sonic (+ the Transcribe/Bedrock/Fish or Polly cascade for
    languages Nova can't speak) for every language except one. **Serbian
    is the sole, deliberate exception (VTID-04000, §2e-vertex-serbian-bridge):**
    a NEW, dedicated GCP project (never `lovable-vitana-vers1`) behind
    `VERTEX_SERBIAN_BRIDGE_ENABLED=true`, narrowly gated in
    `upstream-provider-selector.ts` so no other language or session can
    ever reach it. Do not reintroduce a Google call ANYWHERE else — this
    carve-out is one language, one flag, one narrow selector gate, not a
    general reopening.
28. **IF** validation is needed → **THEN use Claude (via Bedrock).**
29. **IF** model fallback occurs → **THEN log explicitly.** A fallback that
    lands on Google must be treated as an incident, not as normal operation.
30. **IF** TTS is used → **THEN specify model_name explicitly.**
31. **IF** Bedrock is unconfigured (`BEDROCK_ROLE_ARN` unset) → **THEN the
    adapter reports `not_configured` and the router SKIPS it.** Flipping
    routing to `bedrock` before that var is set does not fail loudly — it
    quietly serves the fallback instead. Configure and verify Bedrock
    FIRST, then flip routing. Never the other way round.

---

# PART 2: TECHNICAL REFERENCE

---

## 1. GCP INFRASTRUCTURE — DECOMMISSIONED (2026-08-16), DO NOT USE

**GCP is fully off.** Project `lovable-vitana-vers1` had billing disabled
2026-08-16 and the GCP `gateway` Cloud Run service was deleted the same
night (VTID-03599/VTID-03649 emergency response, prompted by the Gemini
cost incident chain in §2b's history). No process — OASIS, autopilot,
agents, Cloud Run, Cloud Scheduler, Cloud Build, Artifact Registry — runs
on GCP any more. There is no rollback path back to GCP; AWS (§1b) is the
only cloud. `gcloud`/Cloud Run/Artifact Registry commands that used to live
in this section are gone — do not run them, they will fail against a
disabled-billing project. If you find a live reference to
`lovable-vitana-vers1`, `us-central1`, `pkg.dev`, `gcr.io`, or a
`*.run.app` URL anywhere (a workflow, a task def, a script default), treat
it as dead code to be removed on sight, not as a fallback target.

---

## 1b. AWS PRODUCTION (VTID-03398, VTID-03409, VTID-03410, VTID-03411, VTID-03414, VTID-03415, VTID-03419, VTID-03599/VTID-03649)

**AWS is canonical production for every Vitana service.** gateway and
community-app were cut over first, as sole production, under **VTID-03419**
(2026-07-27; DNS execution record in `docs/AWS-CUTOVER-RUNBOOK.md` §3).
Every other service in the table below was built as parallel/DR
infrastructure under the VTIDs listed and became the **only** production
once GCP billing was disabled 2026-08-16 (VTID-03599/VTID-03649) — there is
no GCP instance left to be "the canonical one" instead. A new AWS resource
not listed in the table below still needs its own VTID.

| Service | VTID | ECS resource / dispatch | Public URL / access | Deploy workflow |
|---|---|---|---|---|
| gateway | VTID-03398 | ECS service `vitana-gateway-awsdr`, task def family `vitana-gateway-awsdr`, target group `vitana-tg-gateway-awsdr` | `https://dr-gateway.vitanaland.com` (ALB host rule, priority 5) | `AWS-PROD-DEPLOY-GATEWAY.yml` |
| community-app (frontend) | VTID-03409, cut over to sole production VTID-03419 | ECS service `vitana-community-app-awsdr` (now serving `vitanaland.com` apex + `www`, not just the `dr-app` DR hostname), target group `vitana-tg-community-awsdr` | `https://dr-app.vitanaland.com` (ALB host rule, priority 6) **and** `https://vitanaland.com` (apex/`www`, since VTID-03419 — routed via a Cloudflare Worker whose origin was repointed at cutover time, not by DNS alone, see runbook §3.2); static SPA build bakes the canonical gateway URL (`gateway.vitanaland.com`, itself AWS since VTID-03419) into `.env.production` — no runtime env var to flip | `AWS-PROD-DEPLOY-FRONTEND.yml` (in `exafyltd/vitana-v1`) — still on static `AWS_STAGING_ACCESS_KEY_ID`/`SECRET` repo secrets, not yet OIDC (follow-up) |
| oasis-operator | VTID-03410 | ECS service `vitana-oasis-operator-awsdr` (256 CPU/512MB, stateless, no DB dependency), target group `vitana-tg-oasis-op-awsdr` | `https://dr-oasis-operator.vitanaland.com` (ALB host rule, priority 7) | `AWS-PROD-DEPLOY-OASIS-OPERATOR.yml` — first CI/CD path this service has ever had; its source didn't exist in git and was restored from a stale `.backup` snapshot |
| oasis-projector | VTID-03411 | ECS service `vitana-oasis-projector`, fixed `desiredCount` — **no autoscaling**, the Ledger Writer has no cross-instance locking | No public ALB/DNS — internal DB reconciliation loop; verify via ECS `healthStatus` (`/ready`) | `AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml` |
| worker-runner | VTID-03411 | ECS service `vitana-worker-runner`, fixed `desiredCount` | No public ALB/DNS — polls outward to gateway; verify via ECS `healthStatus` (`/alive`) | `AWS-PROD-DEPLOY-WORKER-RUNNER.yml` |
| verification-engine | VTID-03411 | ECS service `vitana-vitana-verification-engine`, fixed `desiredCount` | No public ALB/DNS — self-registers heartbeat outward; verify via ECS `healthStatus` (`/health`) | `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` |
| orb-agent | VTID-03414 | ECS service + task def family `vitana-orb-agent` — **pre-existing** from the unexplained 2026-07-09 bulk-provisioning event; this VTID added the missing deploy pipeline on top | No public ALB/DNS — outbound to LiveKit Cloud; verify via ECS `healthStatus` (`/alive`) | `AWS-PROD-DEPLOY-ORB-AGENT.yml` |
| autopilot-executor | VTID-03415 | No ECS service — one-shot task. Task def family `vitana-autopilot-executor`, dispatched per-execution via `ecs:RunTask` from `dispatchExecutorJobAws()` (`services/gateway/src/services/aws-ecs-admin.ts`), selected by `DEV_AUTOPILOT_JOB_CLOUD=aws\|gcp` env var — **must be `aws`**; the `gcp` branch is dead code left over from the dual-cloud period and will fail (no GCP job runner exists any more) | N/A — no long-running service to curl | `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` — build+push+register only, no service to roll; the next RunTask dispatch picks up the new `:LATEST` revision automatically |

Shared infra across all of the above:

| Item | Value |
|---|---|
| AWS account / region | `472838866351` / `eu-central-1` |
| ECS cluster | `Vitana-ECS-Cluster` (shared with AWS staging) |
| Database | RDS Aurora PostgreSQL `vitana-aurora-prod` (writer/reader) — DMS-replicated from the same Supabase-hosted Postgres project used pre-cutover (`inmkhvwdcuyhnxkgfvsb`). **This is not a Supabase→Aurora application cutover** — see §3 for the actual current state, which the code does not yet fully match this table's aspirational framing. |
| Redis | ElastiCache `vitana-redis-prod` |
| ALB | `vitana-alb-prod` — all host-header rules sit **below** priority 10 (see hard rule below) |
| Deploy auth | GitHub OIDC federation, `AWS_PROD_ROLE_ARN` (all except community-app's frontend workflow — see its row above) |
| Deploy trigger | Every `AWS-PROD-DEPLOY-*.yml` is `workflow_dispatch`-only, required `reason`, never on push |
| Command Hub PUBLISH target | `PUBLISH_TARGET_CLOUD` (gateway env var, VTID-03420) **must be `aws`** — `gcp` is dead, there is no GCP target left to promote to. When `aws`, PUBLISH promotes **AWS staging → AWS prod**: `POST /publish` resolves the commit `vitana-gateway` staging actually serves (HTTP build-info, never ECS status) and dispatches `AWS-PROD-DEPLOY-GATEWAY.yml` in `promote-staging` mode with `expected_commit` pinned — the exact tested ECR image ships, no rebuild. `/operator/revisions` for the gateway rows is likewise build-info-backed. `GCP_DUAL_PUBLISH_ENABLED`/`AWS_DUAL_PUBLISH_ENABLED` were dual-cloud-period flags for refreshing/dispatching a GCP leg alongside AWS — **both are now no-ops to leave on; turn them off**, there is no GCP leg left to refresh. |

**Secrets intentionally deferred (2026-07-24):** `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` are not populated in AWS Secrets Manager pending an AWS
sponsorship decision for Anthropic — GitHub tokens, Supabase, and DB
credentials are live. Task definitions that would reference these two
secrets have them omitted rather than pointed at an empty value (an empty
secret fails ECS provisioning with `ResourceInitializationError` before
the container starts) — see `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`'s
header comment for the concrete example.

**Full build record, exact commands, and pre-existing-state findings:**
`docs/AWS-PRODUCTION-BUILD-LOG.md`.

**The GCP→AWS cutover this section used to gate is complete and irreversible** —
GCP billing is off, so there is no rollback target and no further sign-off
needed to treat AWS as canonical. `docs/AWS-CUTOVER-RUNBOOK.md` (VTID-03412)
is now a historical record of how the cutover was executed, not a
still-open checklist.

### Hard rules specific to AWS prod

- **Never** deploy to AWS prod on push — `AWS-PROD-DEPLOY-GATEWAY.yml`
  has no `on: push` trigger. Prod only moves via the Command Hub PUBLISH
  button or `publish-to-prod.sh`, both `workflow_dispatch`, never push.
- **Never** confuse `vitana-gateway` (AWS staging) with
  `vitana-gateway-awsdr` (AWS prod) — same ECS cluster, similarly named.
  The ALB target group named `vitana-tg-gateway-prod` actually serves
  **staging** — verify via `/api/v1/admin/health`'s `env` field, never by
  resource name. IaC lives in the private `exafyltd/vitana-infra` repo,
  whose own README says **"DO NOT terraform apply YET"** (checked-in state
  is stale vs. live infra) — see `docs/AWS-CUTOVER-RUNBOOK.md` §1 before
  ever running `terraform plan`/`apply` there.
- **Never** confuse the bare `vitana-community-app`/`vitana-oasis-operator`
  ECS services with the real, ALB-fronted
  `vitana-community-app-awsdr`/`-staging`/`vitana-oasis-operator-awsdr` —
  same name-collision trap as gateway above, except the bare-named ones
  are **not staging**, they're 2026-07-09 mystery-provisioning orphans
  (see the roster below) with zero ALB/service-discovery attached at all.
- **IF** adding a host-header listener rule to `vitana-alb-prod` →
  **THEN** give it priority < 10 — the existing path-based rules (`/api/*`,
  `/ws/*` at priority 10) match before higher-numbered host-header rules
  regardless of `Host`, and will silently route to staging otherwise.
- **Never** assume a service not in the §1b table has AWS infrastructure,
  or that a live AWS resource is governed just because it exists —
  `orb-agent`'s ECS service/task-def predated its own deploy pipeline
  (2026-07-09 bulk-provisioning event, exactly **27 ECS services** created
  in the same 3-second window — 4 later got a CLAUDE.md §1b entry and a
  deploy pipeline the same way `orb-agent` did, **23 remain fully
  undocumented**). **That 23-service roster is now named and classified**,
  not just estimated at "~17-22" — see
  `docs/AURORA-MIGRATION-STATUS-2026-09-10.md`'s 2026-09-11 addendum for
  the complete list, of which four
  (`vitana-auth-proxy`, `vitana-dev-console-ui`,
  `vitana-github-sync-service`, `vitana-mcp-gateway`) are confirmed fully
  dormant vs. which seventeen are alive and running real workloads with no
  external ingress path, and what is and isn't established about what the
  latter group actually does.
  Check for a matching `AWS-PROD-DEPLOY-*.yml` before trusting a running
  service reflects `main`; extending to a new service needs its own VTID.
- **Never** autoscale `oasis-projector`, `worker-runner`, or
  `verification-engine` — `oasis-projector`'s Ledger Writer has no
  cross-instance locking. Fixed `desiredCount` is deliberate.
- GitHub OIDC federation (no static AWS keys) is required for prod
  deploys — never add a static-key IAM user the way AWS staging did.
  community-app's frontend workflow is a documented, temporary exception.

---

## 2. SERVICES ARCHITECTURE

### Deployable Services (AWS ECS — see §1b for exact ECS service/task-def names)
| Service | Source Path | Service Name |
|---------|-------------|----------------|
| Gateway | `services/gateway/` | `gateway` |
| OASIS Operator | `services/oasis-operator/` | `oasis-operator` |
| OASIS Projector | `services/oasis-projector/` | `oasis-projector` |
| Verification Engine | `services/agents/vitana-orchestrator/` | `vitana-verification-engine` |
| Worker Runner | `services/worker-runner/` | `worker-runner` |

### Non-Deployable Services (Libraries/Local)
- `services/agents/` - Agent implementations
- `services/mcp/` - MCP protocol
- `services/mcp-gateway/` - MCP gateway
- `services/deploy-watcher/` - Deploy watcher
- `services/oasis/` - OASIS core
- `services/validators/` - Validators

### Service Path Map
Located at: `config/service-path-map.json`

---

## 2b. LLM ROUTING — BEDROCK PROVIDER (VTID-03403)

> **⭐ STANDING DECISION (VTID-03563): Claude runs on AWS Bedrock, always —
> never the direct Anthropic API.** Not up for re-litigation. Reason: the
> direct Anthropic account has no credit balance, so `provider: 'anthropic'`
> calls fail and the router used to **silently fall back to Google**
> (measured 268 such failures in 14 days before this was caught). Bedrock
> bills to AWS and is unaffected. **Order matters (IF-THEN rule 31):**
> verify `BEDROCK_ROLE_ARN` is set and working BEFORE flipping
> `llm_routing_policy` to `bedrock` — an unconfigured adapter reports
> `not_configured` and the router silently serves the fallback instead,
> reproducing the exact bug this decision exists to end.

`services/gateway/src/services/llm-router.ts` selects a provider per-stage
from the DB-backed `llm_routing_policy` table (Command Hub dropdown), via
`ADAPTERS: Record<LLMProvider, ProviderAdapter>` — `bedrock`, `anthropic`,
`openai`, `vertex`, `deepseek`, `claude_subscription`. **`vertex` is dead
code — GCP billing is off (§1).** A stage pointed at it fails outright
rather than falling back; that's a bug to fix, not tolerate.

- **Region** `eu-central-1` (`AWS_BEDROCK_REGION` → `AWS_REGION` →
  `us-east-1`). **Activation gate** `BEDROCK_ROLE_ARN` — unset means the
  adapter reports `not_configured` and is skipped, same as any provider
  with missing credentials.
- **Model selection** needs a resolved cross-region **inference profile
  ID** (`BEDROCK_MODEL_ID`, else `PROVIDER_FLAGSHIPS.bedrock` in
  `llm-defaults.ts`), not a bare model ID. ID suffix (`-v1:0` or none) is
  **not** a reliable convention — newer profiles drop it, older ones keep
  it; both are valid. Source of truth is `aws bedrock
  list-inference-profiles`, never this file's prose.

**⚠️ `ACTIVE` in the profile listing does NOT mean invokable.** Measured
2026-08-10: of 22 `ACTIVE` Anthropic profiles, only **3** actually invoke:

| Profile | Real invoke |
|---|---|
| `eu.anthropic.claude-sonnet-4-6` | ✅ works |
| `global.anthropic.claude-sonnet-4-6` | ✅ works |
| `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` | ✅ works |
| `eu.anthropic.claude-opus-4-5-20251101-v1:0` | ✅ works — **re-measured 2026-09-13 (VTID-03846):** invoked normally as the `worker` policy primary on staging (29.6s, 3,517 in / 2,768 out tokens). The 2026-08-10 sweep had every Opus profile as unsubscribed; this one is not. |
| Every Haiku profile, every other Opus profile (incl. the task def's `claude-opus-4-7`), `claude-sonnet-5`, `fable-5` | ❌ `AccessDeniedException` (account not subscribed via `aws-marketplace`, not an IAM problem) — as measured 2026-08-10; only the Opus 4.5 row above has been re-measured since, so re-invoke before trusting this row for any other profile |
| `claude-3-7-sonnet`, `claude-3-5-sonnet`, `claude-sonnet-4-20250514` | ❌ end-of-life / not found |

An unsubscribed model doesn't fail loudly — it serves 100% fallback forever
while the policy table still reads `bedrock`. **Before pointing a stage at
a Bedrock model, invoke it for real, not just list it:**
```bash
python3 -c "import json;open('/tmp/b.json','w').write(json.dumps({'anthropic_version':'bedrock-2023-05-31','max_tokens':16,'messages':[{'role':'user','content':'hi'}]}))"
aws bedrock-runtime invoke-model --region eu-central-1 \
  --model-id eu.anthropic.claude-sonnet-4-6 --body fileb:///tmp/b.json /tmp/o.json
```
(`--cli-binary-format` is AWS CLI v2 only; v1 omits it.) Note: the live
task def's `BEDROCK_MODEL_ID` (`eu.anthropic.claude-opus-4-7`) is one of
the unsubscribed ids — harmless (it's only the dropdown default) but
misleading if picked from the UI.

Vision + forced tool calling are supported (VTID-03496) — `image`/`images`
become Anthropic content blocks, `tools`/`forceTool` become `tools` +
`tool_choice`, same wire shape as `anthropicAdapter`. Implementation:
`services/gateway/src/providers/bedrock.ts` (`invokeBedrock()`) does the
`BedrockRuntimeClient.send()` call; `bedrockAdapter` in `llm-router.ts`
adapts it to `ProviderAdapter`. `BEDROCK_ROLE_ARN`/region are read at call
time, so a task-def env change takes effect without a restart.

---

## 2c. TTS — AMAZON POLLY PROVIDER (VTID-03495)

Gateway TTS routes through `services/gateway/src/services/tts/tts-provider.ts`,
selected by `TTS_PROVIDER=google|polly`. **⚠️ Code's internal fallback when
unset is still `google` — GCP is off, so that default is a hard failure,
not safe.** Production/staging task defs must set `TTS_PROVIDER=polly` and
`TTS_POLLY_STRICT=true` explicitly (verify on the live ECS task defs).
Without strict mode, an unservable request tries to fall back to Google —
which no longer exists — instead of failing fast.

| Call site | Format | Behaviour |
|---|---|---|
| ORB greeting bridge, reminder pre-render, ORB `/tts` route | PCM/MP3 | Polly-first when configured |
| Admin voice preview (`voice-config.ts`) | MP3 | Explicit `provider:'polly'` param only, ignores `TTS_PROVIDER` |
| Cloud TTS debug route | MP3 | Google only, on purpose — it's a diagnostic |

**Three Polly gotchas that will produce a plausible-but-wrong result if missed:**
1. **No Serbian voice, any engine** — `resolvePollyVoice('sr')` returns null.
   With Google gone too, **Serbian TTS is currently silent/broken in
   production** until a third provider or an accepted product gap.
2. **PCM is 8kHz/16kHz only, never 24kHz** — `synthesizeGreetingBridgeAudioPcm()`
   returns `{audioB64, sampleRateHz}`; hardcoding 24kHz plays audio 1.5× fast.
3. **No `speakingRate` field** — rate becomes SSML `<prosody rate="N%">`,
   forcing `TextType:'ssml'` + XML-escaping (plain text only at rate 1.0).

Locale coverage: `de en es fr pt pl ru zh ar` all resolve; `pt` is pinned to
pt-BR (Camila); `sr` is the only unresolved locale (returns null, not a
wrong-language voice).

### ✅ VERIFIED against the live API 2026-08-20 (BOOTSTRAP-POLLY-NARRATION-CACHE)

This table had carried "not verified against the live Polly API" since
VTID-03495 — the building session had no AWS credentials. It has now been
checked with real `DescribeVoices` + `SynthesizeSpeech` calls in
`eu-central-1`. Run `scripts/tts/verify-polly-voices.ts` to re-check.

- **Serbian is genuinely absent — confirmed, not assumed.** 106 voices, 42
  language codes, nothing matching `sr`/`hr`/`bs`/`sh` under any spelling.
  `POLLY_UNSUPPORTED_LANGS` is correct and no Polly setting closes the gap.
- **Every pinned voice exists and supports its pinned engine.** The
  docs-derived table was right; nothing needed repair.
- **Russian is the quality floor and is unfixable inside Polly** —
  `Tatyana` **and** `Maxim` are both `standard`-only. There is no neural
  Russian voice at all, so this is a product limitation, not a config gap.
- **Six of nine languages can upgrade engine without changing voice.**
  `en`/Joanna, `de`/Vicki, `fr`/Lea, `es`/Lucia, `pt`/Camila, `pl`/Ola all
  support **`generative`** on the *same* voice id and are pinned to
  `neural`. Same speaker, better engine. `ar` (Hala) and `zh` (Zhiyu) are
  neural-only and stay put.
- Generative was verified to support **mp3, PCM 16k, PCM 8k and SSML
  `<prosody rate>`**, and the rate genuinely *applies* (70% → 6.40s,
  150% → 3.41s vs 4.82s plain) rather than being accepted and ignored.

**⚠️ Order matters if you flip the engine.** Generative costs roughly 1.9x
neural per character. Guided-topic lesson audio had **no cache** until
BOOTSTRAP-POLLY-NARRATION-CACHE, so the multiplier would have applied to
every single My Journey tap rather than once per rendered asset. Cache
first (`NARRATION_AUDIO_CACHE`, §2c-cache below), then flip. The narration
cache key includes the engine, so flipping invalidates cleanly instead of
serving stale neural audio under a generative configuration.

### 2c-cache. Guided-topic narration audio cache (BOOTSTRAP-POLLY-NARRATION-CACHE)

`synthesizeGuidedTopicNarrationAudio()` runs on every guided-topic session
start and had no cache, so each My Journey tap re-synthesized the full
~1,800-char lesson. The audio is deterministic and there are ~2,000 assets
(254 topics x 8 languages), so this was a per-tap bill and a per-tap
latency cost on the exact path the VTID-03650→03685 chain was about.

`NARRATION_AUDIO_CACHE=off|memory|s3` (default **`memory`**; an
unrecognised value resolves to `memory`, never `off` — a typo must not
silently restore per-tap billing). `s3` additionally needs
`NARRATION_AUDIO_BUCKET`; without it the code logs an error and falls back
to `memory` rather than to nothing. Provision with
`scripts/aws/setup-narration-audio-cache.sh` (bucket + lifecycle + scoped
`s3:GetObject`/`PutObject` on `vitana-ecs-task-role`).

**⚠️ The S3 leg has never executed against a real bucket** — the dependency
was newly added, the bucket does not exist yet, and the task role has no
s3 grant. Treat it as unproven until a real `cache=hit store=s3` is
observed in the gateway logs on a second tap of the same topic. Per §2b's
own lesson, configuration is not verification. The `memory` leg is tested
and works today; it just does not survive a deploy or a scale-out.

Failure posture is deliberately **unlike** the `DB_I18N_TARGET` Aurora seam,
which throws rather than falling back: a cache holds no truth and a miss has
a correct cheap recovery (synthesize), so store errors log loudly and
degrade to synthesis. A partial render is never written — every chunk-failure
path bails before the write, so a transient Polly blip cannot be frozen into
a permanently truncated lesson.

**⚠️ Live gap: this seam is gateway-only.** `vitana-v1`'s
`useTextToSpeech.ts`/`VoiceSettingsPanel.tsx` call `google-gemini-tts`/
`google-cloud-tts` Supabase edge functions **directly**, bypassing all of
the above. With GCP off, any user with a stored Google `tts_voice`
preference (persisted per-user, ten hardcoded Chirp3-HD IDs) gets silence
or an error today. Needs a Polly-backed edge function + preference
migration in `exafyltd/vitana-v1` — not done, flagged so it isn't lost.

### 2c-fish. Fish Audio — language-coverage TTS fallback (VTID-03970)

Polly's Serbian gap above (`sr`, "currently silent/broken in production")
now has a fallback: `services/gateway/src/services/tts/fish.ts`, invoked
from inside `tryPollySynthesis()`'s failure branch (`tts-provider.ts`) —
**only** when the language is one Polly has no voice for at all, never on
a transient Polly API error. Fish is a multilingual zero-shot TTS
provider (`docs.fish.audio`) — it is not a third value for `TTS_PROVIDER`,
it is strictly a fallback layered under the existing `polly`/`google`
switch, so every one of `tryPollySynthesis`'s existing call sites (ORB
`/tts` route, greeting bridge, reminder pre-render) benefits without
being individually touched.

**Opt-in, same shape as every other provider here — deploying this code
changes nothing.** Gated on BOTH `TTS_FISH_FALLBACK_ENABLED=true` AND
`FISH_API_KEY` being set (mirrors `BEDROCK_ROLE_ARN`'s "unconfigured →
`not_configured` → skipped" contract, IF-THEN 31 — `isFishConfigured()`
checks both, and the cascade eligibility gate below uses that combined
check, not the flag alone, so a half-configured Fish never gets reported
as available and then fails at the actual synthesis call).

**Voice table is curated, not a live catalog lookup — and this mattered
immediately.** Fish hosts community-uploaded voice clones with zero
content moderation on sample text. The Serbian `reference_id` initially
proposed for this integration (`f8c26ecae994449faf73bcfae844076b`,
"Srpski Razgovorni Glas") turned out to carry an explicit sexual
description and `sexy`/`intimate`/`breathy` tags in its own Fish Audio
metadata — unusable for a health/wellness assistant. Rejected; not used
anywhere. In its place: `sr` → `2ad62aaf885e4a14add09fe4a38ffd23`
("Milica - Female Serbian"), published by Fish Audio's own official
account (`author.nickname === 'Fish Official'`), described by Fish itself
as "A natural, professional Serbian voice ... suited to voice assistants,
customer support and everyday narration" — verified via `GET
/model/{id}` 2026-09-16. `FISH_VOICES` in `fish.ts` is a short, manually
reviewed table like `POLLY_VOICES` for exactly this reason — never a
request-time search of Fish's public catalog.

**Closes the cascade's one remaining gap too, same opt-in.**
`orb/live/upstream/cascaded-config.ts`'s `evaluateCascadeEligibility()`
already knew `sr-RS` is a real Amazon Transcribe streaming language
code — Serbian's ONLY blocker for the full Transcribe→Bedrock→TTS cascade
was the missing Polly voice, never STT. With Fish configured, `sr` now
resolves `ttsProvider:'fish'` and becomes cascade-eligible;
`cascaded-live-client.ts`'s synthesis leg falls back to `synthesizeFish()`
whenever `resolvePollyVoice(lang)` is null. With Fish unconfigured
(the default), behaviour is byte-for-byte unchanged — `sr` still reports
`no_polly_voice` exactly as before this VTID.

**✅ Live synthesis verified (VTID-03983).** The HTTP 402s during
VTID-03970's build were never a credit problem — `getFishModel()`
defaulted to the paid `s2.1-pro` model, and Fish's S2.1 Pro also has a
free tier, `s2.1-pro-free` (no character cap, no SLA/latency guarantee,
requests may be retained for model improvement — acceptable for a
rarely-hit language-gap fallback, not high-volume traffic). The SAME
unfunded key synthesized real audio against `s2.1-pro-free` on the first
try: HTTP 200, a valid 29,256-byte MP3 (128kbps/44.1kHz) for Serbian text
"Zdravo, ovo je test." A parallel `pcm` request's byte count implies a
duration (1.81s at 16kHz) matching the mp3's own duration (1.83s) almost
exactly — Fish honors the requested sample rate, confirming
`FISH_PCM_SAMPLE_RATE_HZ = 16_000` was correct all along. `getFishModel()`
now defaults to `s2.1-pro-free`; `scripts/tts/verify-fish-voice.ts` runs
the same live checks repeatably (also fixed a real pre-existing TS
strictness bug in the script itself — `meta` was untyped `unknown`,
never caught because the script could never run past the 402 before).
One metadata curiosity found while re-checking the voice, not a blocker:
the model's own `languages` field reports `["hr"]` (Croatian), not `sr`,
despite the title/tags/description all being explicitly Serbian — Fish's
language classification is coarser than its own marketing copy; the real
synthesis call above produced correct Serbian-sounding output regardless.

**Still not provisioned in AWS:** `FISH_API_KEY` does not exist in AWS
Secrets Manager and is not wired into any ECS task definition —
`scripts/aws/setup-fish-audio-secret.sh` provisions the secret (no
Claude Code session has `secretsmanager:CreateSecret`, same constraint
as every other provider secret here), but adding it to
`AWS-STAGE-DEPLOY-GATEWAY.yml`'s task-def wiring was deliberately left
undone in the same PR — that workflow's secret-resolution loop hard-fails
(`exit 1`) the ENTIRE staging deploy if a listed secret is not found in
Secrets Manager yet, and this session had no way to confirm the secret
exists before merging. Provision the secret first, confirm it, then wire
the task def — never the other way round (the same ordering discipline
IF-THEN 31 already requires for Bedrock).

### 2c-fish-scope. Nova Sonic / Polly / Fish — what's actually isolated, what isn't (VTID-03987)

Raised explicitly by the platform owner after a cascade latency fix
(VTID-03986) touched a file Polly-backed languages also depend on: "there
must be a separation to avoid misbehaving" between Nova2Sonic (voice-to-
voice) and TTS providers (Polly, Fish). Two different things are true here
and both matter — don't conflate them.

**Structurally guaranteed, no discipline required:** `NovaSonicLiveClient`
and `CascadedLiveClient` are different classes, chosen once per session by
`upstream-client-factory.ts`'s `createUpstreamClient()` switch. A session
gets exactly one. Nothing in `cascaded-live-client.ts` or anything under
`orb/live/upstream/cascaded/` is *reachable* from a Nova Sonic session —
not by convention, by construction. Barge-in specifically lives entirely in
`nova-sonic-live-client.ts` (fires `interruptedHandler` off Nova's own
`contentEnd.stopReason:"INTERRUPTED"`) and `full-duplex-gate.ts` — the
cascade never calls its own `interruptedHandler` at all (grep it — the
cascade's own file header has said "no barge-in mid-generation" since
VTID-03683, unrelated to any Fish work). Nothing Fish/cascade-scoped can
touch Nova's interrupt handling without deliberately opening those two
files.

**NOT isolated, and this is the real boundary to respect:** Polly and Fish
are two interchangeable TTS *backends* plugged into the SAME
`CascadedLiveClient` — that one class also owns Transcribe (STT) and the
turn/silence-gating state machine. `ru`/`pl`/`tr`/`zh`/`ar` are
cascade-eligible via Polly (live in production today); `sr` is
cascade-eligible only via Fish (opt-in). A change to `sendAudioChunk()`,
`runTurn()`'s turn logic, or anything in `cascaded-live-client.ts` outside
the TTS-selection call runs identically for every cascade language,
Polly-backed ones included — it is never possible to scope such a change
to "Fish only" without duplicating the STT/turn-gating pipeline, which this
codebase has been burned by duplicating before (VTID-03644's five diverged
language-name copies, VTID-03696's desynced workflow `paths:` list). Don't
duplicate the pipeline to manufacture isolation that would only drift.

TTS backend SELECTION is formalized instead:
`orb/live/upstream/cascaded/tts-backend.ts` exports `pollyBackend`/
`fishBackend` (each a `synthesize(text, lang)` call, swap-safe
independently) and `synthesizeCascadeReply()` (the Polly-first/Fish-fallback
selection order, single source of truth). **Rule:** a change inside
`pollyBackend`/`fishBackend` — which model/voice/engine a backend uses — is
backend-local, safe to touch for Fish-only work without touching Polly. A
change to `synthesizeCascadeReply()`'s selection order, or to anything in
`cascaded-live-client.ts` outside that one file, affects every cascade
language and needs a regression test against a Polly-backed language (e.g.
`ru`), not just `sr`/Fish — `test/orb/live/upstream/cascaded/tts-backend.test.ts`
and `cascaded-live-client-audio-gating.test.ts` both do this already; keep
the pattern.

---

## 2d. IMAGE GENERATION — AMAZON TITAN (VTID-03497)

Vertex Imagen generated images and no Anthropic model does, so this is a
separate Bedrock adapter (`services/gateway/src/providers/titan-image.ts`),
not an llm-router provider. Two consumers: `cover-image-outpaint.ts`
(outpainting) and `intent-cover-service.ts` (text-to-image) — both must be
covered, not just one.

Selected by `IMAGE_PROVIDER=vertex|bedrock`. **⚠️ Code's internal fallback
when unset is still `vertex` — now permanently unreachable.** Production/
staging must set `IMAGE_PROVIDER=bedrock` explicitly (verify on live ECS
task defs); also gated on `BEDROCK_ROLE_ARN` (§2b).

**Three Titan constraints that produce a plausible-but-wrong image if missed:**
1. **Only fixed width/height pairs — 1600x900 isn't one.**
   `nearestTitanSize()` maps to 1280x720 (largest 16:9), outpaint upscales
   back. Weights aspect ratio over area on purpose — satisfying 16:9 with a
   square crop would visibly letterbox the subject.
2. **Outpaint mask polarity is INVERTED vs Imagen, and unverified against a
   real call.** Imagen: white=generate. Titan: documented the other way, so
   the code negates the mask before sending. Backwards = the **subject**
   gets regenerated instead of the margins — a plausible-looking wrong
   image. Override via `TITAN_OUTPAINT_MASK_POLARITY=black-generates|
   white-generates` (default `black-generates`) — **flip this first** if
   output looks wrong. Mask resize uses `kernel:'nearest'` to stay two-tone.
3. **Not offered in every region** — `AWS_TITAN_IMAGE_REGION` is its own
   var (→ `AWS_BEDROCK_REGION` → `AWS_REGION` → `us-east-1`), doesn't
   inherit blindly. Wrong region = opaque model-not-found.

Also: Titan reports content-policy blocks in an `error` field on a **200**
response (doesn't throw) — mapped to `error:'blocked'`. There is **no**
server-side letterbox-blur fallback (that's frontend-only); a Titan
failure surfaces as an error, not a degraded image.

**Before flipping `IMAGE_PROVIDER=bedrock`:** run
`scripts/images/verify-titan-image.ts` — checks model availability, the
16:9 size mapping, and renders a deterministic red-subject probe that
detects inverted mask polarity automatically. Needs `bedrock:InvokeModel`
on the gateway task role.

---

## 2e. ORB VOICE — NOVA SONIC (VTID-03501)

**Voice runs on Amazon Nova Sonic (+ the Transcribe/Bedrock/Polly-or-Fish
cascade for languages Nova can't speak) for every language except one —
Serbian goes through a narrow, explicit Vertex Live bridge on a NEW GCP
project instead, see §2e-vertex-serbian-bridge (VTID-04000).** GCP's
2026-08-16 shutdown killed the GENERAL Vertex Live fallback outright — that
part is unchanged and still true for every other language. `VERTEX_LIVE_
UNAVAILABLE=true` (`orb-live.ts`) forces Nova through its own
runtime/language gates instead of degrading to Vertex, and gates the
premature-close reconnect (below) onto the honest `connection_issue` signal
instead of a doomed round trip to a dead endpoint — note this flag is
declared on `upstream-provider-selector.ts`'s context type but is no longer
actually READ there (VTID-03723 made the force-through unconditional); it
is NOT the mechanism the Serbian bridge uses either (see
§2e-vertex-serbian-bridge for `VERTEX_SERBIAN_BRIDGE_ENABLED`, a separate,
narrower flag). **This is zero-behavior-change until the flag is actually set on
the live task definition — verify directly, don't assume it from this file.**

Global activation: `NOVA_SONIC_GLOBAL_ENABLED='true'` (exact string) widens
**who** gets Nova past the canary allowlist — `enabled`/language
(`en/de/fr/es`)/`aws-ecs` runtime gates still apply. Promoted sessions
report `reason:'nova_global_enabled'`, `canary:false`; reversible via one
`AWS-PROD-DEPLOY-GATEWAY.yml` dispatch (`nova_sonic_global_enabled=false`).

**Known failure mode, still unroot-caused:** Nova drops ~10% of sessions
with `code: nova_stream_error, diagnostic: "Premature close"` — the
bidirectional HTTP/2 stream dies at open (`audio_in=0`, `audio_out=0`,
`greeting_sent=true`) and **the user hears silence with no visible error**.
`audio_out===0` is a perfect discriminator for this reason vs. any other
close. The HTTP/1.1 workaround used for Bedrock (§2b) doesn't apply here —
`InvokeModelWithBidirectionalStream` requires HTTP/2.

With `VERTEX_LIVE_UNAVAILABLE` set, a premature-close now reports the
honest `connection_issue` signal rather than attempting a reconnect to
dead Vertex — this is a harder open problem than before the GCP shutdown,
since the old mitigation (silently reconnect to Vertex) is gone. A real
fix needs either a Nova-side retry or another AWS-native recovery path.

### 2e-duplex. Full-duplex voice / barge-in (VTID-03706) — STAGING ONLY

**`ORB_FULL_DUPLEX_ENABLED=true`.** Anything else — unset, `false`, a
typo, a leftover `staging-only` — resolves to OFF, giving the
pre-VTID-03706 half-duplex behavior, byte-for-byte. Rollback is flipping
this value, not reverting code. **Deliberately NOT set on
`AWS-PROD-DEPLOY-GATEWAY.yml`** — it changes live audio behavior for every
voice session and needs real-device echo evidence first (below).

**The rule this replaces:** the mic used to be gated SHUT while the model
spoke, in the client AND the server. So Nova received literal silence
during its own turn and its native barge-in
(`contentEnd.stopReason:"INTERRUPTED"`) could never fire — `sendEndOfTurn()`
is a documented no-op for Nova, so that event is the *only* thing that
actually stops generation. Anything quieter than 0.06 RMS could never
interrupt at all, and confirmation took ~384 ms on top.

**The rule now:** the mic never closes. During playback a frame is emitted
for *every* capture callback — verbatim above the echo floor, **digital
silence** below it. That is what makes it safe: Nova gets a continuous,
correctly-timed stream (so its turn detection works) while AEC residue is
zeroed instead of forwarded (so it cannot interrupt itself).

- Source of truth for tuning: `DUPLEX_GATE` in
  `src/orb/live/duplex/full-duplex-gate.ts`. `orb-widget.js` and
  `orb-voice-bench.js` mirror the literals; `full-duplex-gate.widget-parity.test.ts`
  fails the build if any copy drifts.
- **Nova's `INTERRUPTED` is the authority** on whether the turn yielded.
  The client's own detection only stops local playback fast (~128 ms) so
  the interruption *feels* instant. Don't "fix" a barge-in bug by making
  the client authoritative.
- Confirmation counts **voiced** frames, not merely gate-open ones —
  otherwise the hangover ticks a single cough up to the threshold in
  silence. A test pins this; it was a real bug caught before shipping.

### 2e-bench. ORB Voice Bench — `/command-hub/orb-voice-bench.html`

**The standing tool for anything you have to HEAR.** Two tabs, both needing
a real browser, speaker and (for tab 2) microphone.

**Use it — do not build a second one.** Everything else that exists is
silent by construction and none of it would catch a bad voice:
`/api/v1/voice-lab/nova/tests/run` checks Nova config, the selector table,
codecs and stream latency; `/tests/eval` checks which tools the model would
call; `runVoiceProbe()` GETs `/api/v1/orb/health` and asserts booleans — its
own comment records that the audio-path probe was never built.

**Tab 1 — TTS output.** Calls the real `POST /api/v1/orb/tts` for every
locale, decodes the result with `decodeAudioData`, plays it, and measures
it. Catches the three failures a status code cannot:
- **200 OK and silent** — peak amplitude below `TTS_SILENCE_PEAK`.
- **Wrong language** — the route echoes the `lang` it actually served;
  fluent audio in the wrong language sounds like a working system.
- **Undecodable** — an error body wearing an audio mime.

`sr` is listed with an EXPECTED-FAIL reason (Polly has no Serbian voice in
any engine), so the known gap neither hides nor reddens the sweep — and if
it ever starts passing, the verdict says so and tells you to update
`TTS_EXPECTED_FAIL`. Base URL blank = same origin; point it at
`preview-aws-gateway.vitanaland.com` to bench staging.

**Tab 2 — voice-to-voice.** The echo/barge-in gate, below.

**⚠️ The one thing that cannot be verified in CI: does this device's echo
open the gate?** There is no acoustic path in a unit test and Playwright
renders pixels, not sound. Open tab 2 on a real device, speakerphone,
headphones off, at realistic volume. It runs the identical gate against the
real mic/speaker, and starts no ORB session. Echo test must report **zero**
gate openings. If it reports any, full duplex is unsafe on that device
class — do not enable it there, and do not "fix" it by lowering
thresholds.

### 2e-vertex-serbian-bridge. Serbian voice — Vertex Live, on a NEW GCP project (VTID-04000)

**One narrow, explicit, time-boxed exception to "Vertex is not a
destination" (VTID-03723).** Serbian has no Nova Sonic voice and no Polly
voice; the Transcribe->Bedrock->Fish cascade built to cover it
(VTID-03970/03987) was measured live and does NOT fix the underlying
problem — VTID-03998 found that tuning Fish's `latency` request field makes
no measurable difference at realistic reply length (6 trials, ~535 chars:
`'normal'` avg ~9.6s, `'low'` avg ~9.6s; Fish's real throughput is ~50-60
chars/sec regardless of mode). Combined with the cascade's own
LLM-completion latency, that is what was blowing past the 30s
`greeting_timeout` stall watchdog for pre-login `sr` sessions. The platform
owner opened a **brand-new, dedicated GCP project** (never
`lovable-vitana-vers1`, which stays permanently decommissioned) with a
90-day free-credit window and asked to revive Vertex Live for Serbian only
— Gemini Live natively speaks Serbian in one hop (confirmed: `sr` is in
Google's own supported-language list for the Live API), so none of the
cascade's three-hop turn-shaping cost applies.

**The infrastructure was never deleted — only made unreachable.**
`VertexLiveClient` (full protocol handling, OAuth token caching/refresh,
prewarming) and the AWS-compatible ADC bootstrap
(`services/gateway/src/lib/gcp-adc-bootstrap.ts` — takes
`GCP_SERVICE_ACCOUNT_JSON` from Secrets Manager, writes it to disk, points
`GOOGLE_APPLICATION_CREDENTIALS` at it so `GoogleAuth`/ADC resolves on ECS,
which has no GCP metadata server) are the same code that ran in production
before the shutdown. Serbian's Gemini TTS voice mapping
(`voice-mapping.ts`'s `GEMINI_TTS_VOICE_FALLBACKS.sr`/
`NEURAL2_TTS_VOICE_FALLBACKS.sr`) was already correctly configured and
needed no change. What WAS rewired: `upstream-provider-selector.ts`
(VTID-03723) hardened every branch so no session could EVER resolve to
`provider: 'vertex'` again, after a real incident (staging's
`voice.active_provider` row silently routing pl/pt sessions to a dead
Vertex, which spoke fluent English because nothing else ever got consulted)
— `ctx.vertexUnavailable` is declared on the context type but is **no
longer read anywhere**; the force-through is unconditional now, not
flag-gated.

**The carve-out, `orb/live/upstream/vertex-serbian-bridge.ts` +
`upstream-provider-selector.ts`'s `tryVertexBridgeRescue()`:** a new,
narrow rescue helper — same "returns null when it does not apply" contract
as its sibling `tryCascadeRescue()`, checked BEFORE it at all 5 call sites
(`resolveWithoutVertex`, both branches of `evaluateNovaRequest`, both
branches of `evaluateNovaCanary`) — fires ONLY when BOTH are explicitly
true:
- `isVertexSerbianBridgeEnabled()` — `VERTEX_SERBIAN_BRIDGE_ENABLED` exact
  string `'true'` (same activation-gate convention as
  `NOVA_SONIC_GLOBAL_ENABLED`/`isCascadeEnabled()` — a typo is off).
- `isVertexSerbianBridgeLanguage(lang)` — the session language is `sr`
  (any region/script suffix), and ONLY `sr`. Never widened to a language
  list.

New `SelectionReason: 'vertex_serbian_bridge'` so telemetry/dashboards can
tell this narrow path apart from every historical vertex reason. Both
fields are precomputed by the caller (`routes/orb-live.ts`'s
`connectToLiveAPI`) exactly like `nova`/`cascade` — the selector itself
never reads env vars or inspects language strings.

**⚠️ `VERTEX_PROJECT_ID`'s own code default is still the DECOMMISSIONED
project.** `orb/live/config.ts`: `process.env.GOOGLE_CLOUD_PROJECT ||
process.env.GCP_PROJECT_ID || 'lovable-vitana-vers1'`. If the new task-def
sets `VERTEX_SERBIAN_BRIDGE_ENABLED=true` without ALSO setting
`GOOGLE_CLOUD_PROJECT` (or `GCP_PROJECT_ID`) to the new project, the bridge
will pass its own config-presence check (the string is never empty) and
then fail for real against a project with no billing account. Always
verify both are set together — this is the same ordering discipline
CLAUDE.md's Bedrock IF-THEN 31 already requires ("configure and verify
FIRST, then flip the routing flag — never the other way round"), here for
`GOOGLE_CLOUD_PROJECT`/`VERTEX_SERBIAN_BRIDGE_ENABLED` instead.

**Provisioning — pivoted from an AWS-Secrets-Manager service-account key to
Workload Identity Federation (WIF), because the key design was blocked at
the GCP org level.** `scripts/aws/setup-vertex-serbian-bridge.sh` (dry-run
by default, `--apply` to create; refuses outright if `--gcp-project
lovable-vitana-vers1` is passed) still exists and still creates a scoped
service account + downloadable key for AWS Secrets Manager — but that path
was never actually usable on the platform owner's own GCP org, because the
org-wide policy `iam.disableServiceAccountKeyCreation` blocks EVERY
service-account private-key download, confirmed live in the Console by the
org Owner repeatedly. That is an org-level block on the action itself, not
a permissions gap any identity can be granted around.

**What's actually wired on staging is WIF instead** — Google's own
recommended keyless alternative. The platform owner provisioned it
themselves via Google Cloud Shell (`gcloud iam workload-identity-pools
create vitana-aws-pool`, `... providers create-aws vitana-aws-provider
--account-id=472838866351`, `gcloud iam service-accounts
add-iam-policy-binding vitanaland@project-da3eb05a-c86e-47cb-85f
.iam.gserviceaccount.com --role=roles/iam.workloadIdentityUser
--member="principal://iam.googleapis.com/projects/20926255361/locations/
global/workloadIdentityPools/vitana-aws-pool/subject/<aws-principal-arn>"`)
— this trusts one specific AWS principal directly and lets it exchange its
own native AWS credentials for a GCP token via Google's STS endpoint, with
no downloadable key ever created. `gcloud iam workload-identity-pools
create-cred-config` then produces the authoritative `external_account`
credential config JSON — Google's own docs confirm this file contains no
private key (only pool/provider/STS-endpoint federation metadata), so it
is safe to store as a **plain, non-secret value**, unlike a service-account
key.

`AWS-STAGE-DEPLOY-GATEWAY.yml` assigns that JSON to a static
`GCP_CRED_CONFIG` variable and wires `GOOGLE_CLOUD_PROJECT`/
`VERTEX_AI_LOCATION`/`VERTEX_SERBIAN_BRIDGE_ENABLED`/
`GCP_SERVICE_ACCOUNT_JSON` UNCONDITIONALLY (no `describe-secret`, no `if`
guard — there is no absent-vs-present secret state any more) in the same
strip/re-add block as `AURORA_CA_BUNDLE_PATH`. `gcp-adc-bootstrap.ts` and
`google-auth-library`'s `GoogleAuth()` both already handle an
`external_account` credential JSON generically — zero code changes were
needed to consume it. **Not yet independently confirmed against a live
token exchange** — verifying the config resolves a real GCP OAuth token
locally was attempted and blocked by this session's own sandbox safety
layer (flagged as a containment-escape-shaped action, due to the config's
AWS-instance-metadata `credential_source` URLs); the config is Google's
own authoritative tool output against the real, live pool/provider/
binding, not hand-constructed, but the real signal is still the next real
`sr` session on staging reporting `reason:'vertex_serbian_bridge'` in
`oasis_events` and actually producing audio. Full detail: `docs/validation/
VTID-04000/acceptance.md`.

**⚠️ Pre-existing parity gap, surfaced by this PR's own CI, not caused by
it — read before flipping the flag.** This repo's `voice-pipeline-parity`
scanner (report-only, runs on every gateway PR) flagged 13 `high`-severity
`missing_in_vertex` items on PR #3369: 7 OASIS event topics
(`orb.live.context.bootstrap`, `orb.live.context.bootstrap.skipped`,
`orb.live.tool.executed`, `orb.navigator.requested`,
`orb.navigator.blocked`, `admin.briefing.injected`,
`feedback.ticket.created`) and 6 watchdog settings
(`session_timeout_ms`, `conversation_timeout_ms`,
`max_connections_per_ip`, `max_reconnects`, `max_history_chars`,
`extraction_throttle_ms`) that the LiveKit/Nova pipeline has and
`VertexLiveClient` does not. These are not regressions this VTID
introduced — `VertexLiveClient` has been structurally unreachable since
VTID-03723 while the LiveKit/Nova side kept shipping features, so the gap
accumulated during the months Vertex sat dormant. **Concretely: a real
Serbian bridge session, once enabled, will not get the same
session/conversation timeout enforcement, connection-count capping,
reconnect capping, or OASIS observability every Nova/cascade session
gets.** `safety_critical: 0` on the scan (no crash/security-class gap),
but a session with no watchdog timeout is a real operational risk under
real Serbian traffic, not just a documentation gap. Before promoting this
bridge past a small canary, either backport the missing watchdogs into
`VertexLiveClient` or confirm gateway-level timeouts elsewhere already
bound it — do not assume parity with Nova/cascade sessions just because
the code path is the same one that ran before the 2026-08-16 shutdown.

**⚠️ No longer inert on staging, once this PR's WIF wiring merges — this
superseded the original "ships inert" design.** The original plan
(`VERTEX_SERBIAN_BRIDGE_ENABLED` gated behind an AWS-Secrets-Manager
`describe-secret` check, absent by default) really was inert until an
operator provisioned the secret. The WIF replacement above wires
`GOOGLE_CLOUD_PROJECT`/`VERTEX_AI_LOCATION`/`VERTEX_SERBIAN_BRIDGE_ENABLED`/
`GCP_SERVICE_ACCOUNT_JSON` UNCONDITIONALLY on `AWS-STAGE-DEPLOY-GATEWAY.yml`
— there is no secret to be absent any more, so the bridge activates for
real on the very next staging deploy after this merges, with no separate
operator step. `AWS-PROD-DEPLOY-GATEWAY.yml` is untouched — prod stays
inert regardless.

**⚠️ The bridge's tool catalog is byte-budgeted (VTID-04026) — do not
"restore" the full catalog for Serbian without re-measuring.** Post-login
`sr` sessions closed with `upstream_ws_close code:1007 "Request contains an
invalid argument."` on ~80% of sessions — never at setup, always ~300 ms
after the FIRST generation request — which the widget surfaces as the
endless spoken "hold on, I'm reconnecting" loop. Three greeting-wording
fixes (VTID-04010/04014/04015) did not move the rate because the greeting
was never the cause: an authenticated community session declares **290
function declarations = 226 KB** of JSON in `setup.tools` (anonymous: 2 /
4.9 KB), on top of the 30 KB instruction the `instruction-budget.ts` guard
bounds — the catalog itself had no bound, and Gemini Live rejects the
oversized aggregate on the first generation, not the handshake (the exact
shape `live-system-instruction.ts` already recorded from the pre-shutdown
era). Proven live, same account/language/deployment, only the surface
changed: community (290 tools) 2/8 turns completed, admin (134 tools /
45 KB) 8/8. `orb/live/tools/vertex-tool-catalog-budget.ts` now packs the
catalog to `VERTEX_TOOL_CATALOG_BYTE_BUDGET` (default 48 KB, inside the
measured-working point; `0` disables) with a priority list — navigation,
`end_conversation`, memory/diary/reminders, the guided-journey/teacher
tools, persona hand-off, calendar, messaging, daily logs — kept first;
applied in `orb-live.ts`'s envelope builder ONLY when
`session.upstreamProvider === 'vertex'` (never keyed on language), so Nova
Sonic and the cascade keep the full catalog. A trim is an OASIS diag
(`stage=vertex_tool_catalog_trimmed`), not a console line, because
VTID-04021's handoff could not even confirm whether the instruction guard
was firing without CloudWatch. The ~80/20 split on byte-identical requests
is consistent with `VERTEX_AI_LOCATION=global` routing to backends with
different effective limits — a hypothesis, not established; shrinking the
request fixes the failure whichever backend serves it. Raising the budget
is an env change once a larger value is observed to hold on staging.

**90-day window.** This is a bridge, not a standing architecture decision
— when the credit window ends (or the cascade's own turn-shaping latency
gets fixed some other way), the fix is one flag flip
(`VERTEX_SERBIAN_BRIDGE_ENABLED=false`) plus deleting the GCP project and
its WIF pool/provider/binding; the selector code can stay (inert, harmless)
or be removed in a follow-up cleanup VTID.

---

## 3. DATABASE (SUPABASE — Aurora migration is IN PROGRESS, not complete)

> **Status check against this repo, 2026-08-18 — do not assume Aurora is
> primary anywhere yet.** `SUPABASE_URL`/PostgREST is still the connection
> used by ~231 files under `services/gateway/src`; `AURORA_DATABASE_URL` is
> referenced by 2. `DB_I18N_TARGET` (the one seam with a real Aurora write
> path — VTID-03515/03517) still defaults to `supabase`, and its own header
> comment says explicitly: *"Not a migration, and not Aurora becoming
> primary."* A DMS reconciliation script
> (`scripts/reconciliation/aurora-supabase-reconcile.ts`) exists but per its
> own VTID-03649 commit note had **not yet been exercised against real
> credentials** as of 2026-08-16. Treat "we've moved to Aurora" as the
> **target direction**, not the current state, until each of these is
> re-verified — most consumers reading this file should keep writing
> Supabase-client code exactly as before; only touch the Aurora seam if you
> are specifically working the DB migration itself.

### Critical Rules
1. **PostgreSQL tables MUST use `snake_case`** (vtid_ledger, oasis_events)
2. **TypeScript code MUST reference EXACT table names**
3. **Check DATABASE_SCHEMA.md before creating any table**

### Core Tables
| Table | Purpose |
|-------|---------|
| `vtid_ledger` | Central VTID task tracking |
| `oasis_events` | System-wide event log |
| `personalization_audit` | Cross-domain personalization audit — **⚠️ confirmed still missing in live Supabase** (`to_regclass` null, re-checked 2026-08-29). **Investigated 2026-08-29: reachable but NOT a silent-failure bug.** The one real call site (`writePersonalizationAudit()` in `personalization-service.ts`, invoked fire-and-forget from `GET /api/v1/personalization/snapshot`) already checks `response.ok` and logs loudly via `console.error` on failure, and the route never awaits it (`.catch(err => console.warn(...))`) — so every snapshot request logs a write failure but the user-facing response is unaffected. The two `app.js`/`app.js.backup*` hits are static Command Hub schema-catalog metadata, not live queries. Net: a known, correctly-degrading gap in the audit trail, not a confidently-wrong response — building the table (or retiring the audit feature) is a product decision, not a bug fix. |
| `services_catalog` | Service catalog |
| `products_catalog` | Product catalog |
| `d44_predictive_signals` | Proactive intervention signals — **⚠️ does not exist in live Supabase**, confirmed reachable from a live admin screen (Intelligence → Signals) that surfaces this as a visible error. See `docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 2. |
| `contextual_opportunities` | D48 opportunity surfacing |
| `risk_mitigations` | D49 risk mitigation — **⚠️ does not exist in live Supabase**, route is mounted but no confirmed caller found — same "registered but never invoked" shape confirmed for the `AP-0710` monetization-vulnerability automation. See `docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 3 and Addendum 10. |

### vtid_ledger Key Columns
| Column | Type | Values |
|--------|------|--------|
| `vtid` | TEXT | Primary key (VTID-XXXXX format) |
| `status` | TEXT | scheduled, in_progress, completed, pending, blocked, cancelled |
| `spec_status` | TEXT | draft, pending_approval, approved, rejected |
| `is_terminal` | BOOLEAN | Task completion flag |
| `terminal_outcome` | TEXT | success, failed, cancelled |
| `claimed_by` | TEXT | Worker ID that claimed the task |
| `claimed_until` | TIMESTAMPTZ | Claim expiration |

### DEPRECATED - DO NOT USE
- `VtidLedger` (PascalCase) - Empty, use `vtid_ledger`

---

## 4. VTID SYSTEM

### 4.1 Self-Service Allocation (STANDING RULE — VTID-03448)

**This question is permanently settled. Do not re-ask the user "should this
have a VTID" or "do you have a VTID for this" ever again.** Every task gets
one, Claude allocates it itself, first step, no exceptions.

Procedure, in order of preference:

1. **Gateway API** (preferred when the gateway is reachable from the
   session): `POST /api/v1/vtid/allocate` with `{ source, layer, module }`
   (see §11 for URL resolution). Returns `{ vtid, num, id }`.
2. **Direct Supabase RPC** (when the gateway isn't reachable, e.g. a
   Claude Code session without a live gateway endpoint): call
   `allocate_global_vtid(p_source, p_layer, p_module)` via the Supabase
   MCP/CLI against the `VITANA` project. Returns the same shape.
3. Either path atomically mints the next `VTID-XXXXX` and creates the
   ledger shell row in one transaction — allocated and registered can
   never split.
4. Immediately follow up with an `UPDATE vtid_ledger` (or the equivalent
   gateway PATCH) to set a real `title`/`summary`/`description` (never
   leave the "Allocated - Pending Title" placeholder), and set
   `status='in_progress'` + `spec_status='approved'` when the user has
   directly instructed the work in the current conversation.
5. **If the allocator itself is disabled** (`VTID_ALLOCATOR_ENABLED`
   false and no DB override) — that's the one real stop condition. Tell
   the user allocation is blocked and why; do not fabricate a VTID
   number and do not silently proceed without one.
6. One VTID per distinct piece of work. Two unrelated fixes requested in
   the same message get two VTIDs, not one shared across both.

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
5. **(VTID-03516) It is the autonomous plane's own work** — `metadata.source
   === 'self-healing'` or `metadata.autonomous_execution === true`.

**Criterion 5 is not optional bookkeeping — without it the other four
describe a Claude Code session's own VTID exactly.** §4.1 tells every session
to write `status='in_progress'` + `spec_status='approved'` onto the VTID it is
about to work itself. For six days the worker-runner read that as an
invitation, claimed those VTIDs ~20-30s after allocation, failed instantly on
a missing `ANTHROPIC_API_KEY`, and terminalized them `rejected`/`failed`. See
the 2026-08-06 VTID-03516 changelog row.

### Two execution planes, one ledger (VTID-03516)

There are **two** ways work gets done here and they share `vtid_ledger`:

| Plane | Who executes | Marks its rows with |
|---|---|---|
| **Session** | a Claude Code session / a human, in-conversation | anything else (`metadata.source` is free text — `claude-code`, `orb-voice`, `aws-sns-gchat-alerts`, …) |
| **Autonomous** | worker-runner → worker-{backend,memory,ai,…} | `metadata.source='self-healing'` or `metadata.autonomous_execution=true` |

- **Never** widen the autonomous claim pool with a denylist of session-looking
  `metadata.source` values. `source` is free text and most session VTIDs carry
  no `claude` marker at all — a denylist catches three strings and keeps
  sweeping everything else. The gate is an **allowlist**
  (`isAutonomousExecutionTask()`, `routes/worker-orchestrator.ts`), enforced on
  both the pending feed and the claim write path.
- **New autonomous producers must set `metadata.autonomous_execution = true`.**
  Being `in_progress` + `approved` is no longer sufficient and never should
  have been.
- **Never "fix" this by populating `ANTHROPIC_API_KEY` on the worker-runner** —
  with a working key it would autonomously edit code for a VTID a session is
  concurrently working (silent concurrent writes, against "Never run
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

## 6. OASIS EVENTS

### Event Taxonomy
| Category | Examples | When to Emit |
|----------|----------|--------------|
| `vtid.lifecycle.*` | started, completed, failed | State changes |
| `vtid.stage.*` | planner.started, worker.success | Stage transitions |
| `vtid.decision.*` | claimed, released, retried | Decisions |
| `vtid.error.*` | failed, blocked | Errors |
| `telemetry.*` | heartbeat, polled | **NEVER to OASIS** |

### Critical Rule
> **OASIS is for STATE TRANSITIONS and DECISIONS — not loops.**
> Polling ≠ progress. Heartbeat ≠ event. Repetition ≠ signal.

### Event Schema
```typescript
{
  id: UUID,
  type: string,          // Event type (e.g., vtid.lifecycle.completed)
  topic: string,         // Event topic/category
  source: string,        // Service name
  vtid: string,          // Associated VTID
  service: string,
  status: string,        // info, success, warning, error
  message: string,
  payload: JSONB,
  created_at: TIMESTAMPTZ
}
```

---

## 7. WORKER ORCHESTRATOR API

### Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/worker/orchestrator/register` | Register worker |
| DELETE | `/api/v1/worker/orchestrator/register/:id` | Deregister worker |
| GET | `/api/v1/worker/orchestrator/workers` | List workers |
| GET | `/api/v1/worker/orchestrator/tasks/pending` | Get pending tasks |
| POST | `/api/v1/worker/orchestrator/claim` | Claim a task |
| POST | `/api/v1/worker/orchestrator/release` | Release a claim |
| POST | `/api/v1/worker/orchestrator/route` | Route to subagent |
| POST | `/api/v1/worker/orchestrator/heartbeat` | Send heartbeat |
| POST | `/api/v1/worker/subagent/start` | Report subagent start |
| POST | `/api/v1/worker/subagent/complete` | Report subagent complete |
| POST | `/api/v1/worker/orchestrator/complete` | Report orchestrator complete |
| POST | `/api/v1/worker/orchestrator/terminalize` | Terminalize VTID |

---

## 8. ENVIRONMENT VARIABLES

### Required for Gateway
```bash
PORT=8080
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE=xxx
GITHUB_SAFE_MERGE_TOKEN=xxx
```

### Governance Controls
```bash
AUTOPILOT_LOOP_ENABLED=true|false
VTID_ALLOCATOR_ENABLED=true|false
```

### Optional
```bash
NODE_ENV=production|development|test
# Command Hub PUBLISH-button frontend promotion (exafyltd/vitana-v1). Without it,
# gateway still publishes; response reports frontend_promote.ok=false.
FRONTEND_DEPLOY_TOKEN=<PAT with actions:write on exafyltd/vitana-v1>
FRONTEND_DEPLOY_REPO=exafyltd/vitana-v1
# Must be 'aws' — 'gcp' is dead dual-cloud-period code (VTID-03420).
PUBLISH_TARGET_CLOUD=aws
# Amazon Polly / Titan / Bedrock — see §2b/2c/2d. Must be set explicitly;
# the code's own fallback is still 'google'/'vertex', both dead (GCP is off).
TTS_PROVIDER=polly
TTS_POLLY_STRICT=true
# Fish Audio TTS fallback for languages Polly has no voice for (sr, etc.) —
# see §2c-fish. Off/unconfigured by default; both must be set to activate.
TTS_FISH_FALLBACK_ENABLED=true
FISH_API_KEY=xxx
IMAGE_PROVIDER=bedrock
BEDROCK_ROLE_ARN=xxx
VERTEX_LIVE_UNAVAILABLE=true
OPENAI_API_KEY=xxx
# Serbian-only Vertex Live bridge on a NEW GCP project — see
# §2e-vertex-serbian-bridge (VTID-04000). Off/unconfigured by default;
# GOOGLE_CLOUD_PROJECT/VERTEX_AI_LOCATION must point at the NEW project,
# never lovable-vitana-vers1 (permanently decommissioned).
VERTEX_SERBIAN_BRIDGE_ENABLED=true
GOOGLE_CLOUD_PROJECT=<new-project-id>
VERTEX_AI_LOCATION=us-central1
GCP_SERVICE_ACCOUNT_JSON=xxx
# Byte budget for the tool catalog the Vertex bridge declares (VTID-04026,
# §2e-vertex-serbian-bridge). Unset = 48 KB default; 0 disables the guard.
VERTEX_TOOL_CATALOG_BYTE_BUDGET=49152
```

`GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL`,
`GEMINI_API_KEY` were removed from this list 2026-08-18 — all point at a
decommissioned project; safe to remove from a live task def if still set.

---

## 9. CI/CD WORKFLOWS

### Key Workflows

Canonical deployment is the AWS `AWS-*-DEPLOY-*.yml` family (§1b) plus
`AWS-STAGE-DEPLOY-GATEWAY.yml` for staging. `EXEC-DEPLOY.yml` and ~15 other
GCP-oriented workflow files still in `.github/workflows/` (`AUTO-DEPLOY.yml`,
`STAGE-DEPLOY.yml`, `PROVISION-MEMORYSTORE.yml`, etc.) are dead — GCP is
decommissioned (§1) — do not dispatch them; safe cleanup candidates.

| File | Purpose |
|------|---------|
| `AWS-PROD-DEPLOY-GATEWAY.yml` | Canonical gateway prod deployment (VTID governance, `workflow_dispatch` only, required `reason`) |
| `AWS-STAGE-DEPLOY-GATEWAY.yml` | Gateway staging, auto-deploys on push to `main` |
| `MCP-GATEWAY-CI.yml` | MCP Gateway CI |

### Deployment Requirements
1. VTID must exist in OASIS ledger before deploy (VTID-0542)
2. Governance evaluation must pass (VTID-0416)
3. All deploys go through governed CI pipeline

---

## 10. CODING CONVENTIONS

### TypeScript
- Use strict types
- Use Zod for validation
- Use Express Router pattern

### API Patterns
- All API routes under `/api/v1/`
- Use snake_case for JSON response fields
- Return `{ ok: boolean, error?: string, data?: T }`

### File Organization
```
services/<service>/
  src/
    index.ts           # Entry point
    types.ts           # TypeScript types
    routes/            # API routes
    services/          # Business logic
  Dockerfile
  package.json
  tsconfig.json
```

---

## 11. QUICK REFERENCE (AWS)

### Get a service's live status / task def
```bash
aws ecs describe-services --cluster Vitana-ECS-Cluster \
  --services vitana-gateway-awsdr --region eu-central-1
```

### Get a service's public URL
Resolve via the ALB host-header rule for that service (see §1b's table) —
e.g. gateway is `https://gateway.vitanaland.com`. There is no per-service
dynamic-URL lookup equivalent to `gcloud run services describe`; ECS
services sit behind the shared `vitana-alb-prod` ALB, not their own URL.

### Deploy a service
Deploys go through the canonical `AWS-*-DEPLOY-*.yml` GitHub Actions
workflow for that service (§1b/§9) — `workflow_dispatch` with a required
`reason` for prod, automatic on push for staging. Do not build/push/register
a task definition by hand outside CI.

### Check service logs
```bash
aws logs tail /ecs/vitana-gateway-awsdr --region eu-central-1 --since 1h
```

---

## 12. DOCUMENT REFERENCES

| Document | Purpose |
|----------|---------|
| `DATABASE_SCHEMA.md` | Canonical database schema reference |
| `config/service-path-map.json` | Service to path mapping |
| `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` | Canonical gateway deployment workflow |
| `docs/AWS-PRODUCTION-BUILD-LOG.md` | Full AWS build record and pre-existing-state findings |
| `docs/AWS-CUTOVER-RUNBOOK.md` | Historical record of the GCP→AWS cutover execution |
| `docs/MOBILE_DEVICE_TESTING.md` | Device-level frontend testing (sim-use: iOS Simulator / Android) |

---

## 13. VTID REFERENCES IN THIS CODEBASE

Key VTIDs that established patterns:
- **VTID-0416** - Gateway Deploy Governance Lockdown
- **VTID-0542** - VTID Allocator Hard Gate
- **VTID-01010** - Target Role System
- **VTID-01032** - Multi-service Auto-deploy
- **VTID-01181** - DB-backed Allocator Toggle
- **VTID-01187** - Execution Governance Defense in Depth
- **VTID-01200** - Worker-Runner Execution Plane

---

## 13b. SERVER-SIDE i18n (PR #2269)

The gateway emits some strings directly to users (push notifications, email
subjects, voice greetings, error bodies) where the frontend can't intercept
and translate. The German community has been complaining about English text
showing on their lock screen — this is the surface that causes it.

### Hard rule

**Never** hardcode a user-visible string in a gateway response. Use the
catalog:

```ts
import { tt, type GatewayI18nKey } from '../i18n/catalog';
import { getUserLocale, bulkGetUserLocales } from '../i18n/server-locale';

// Single user
const lc = await getUserLocale(supa, user_id);
title: tt('notif.diary_reminder.title', lc),
body:  tt('notif.diary_reminder.body', lc, { count: 3 }),

// Cron fan-out (many users)
const locales = await bulkGetUserLocales(supa, userIds);
for (const u of users) {
  const lc = locales.get(u.user_id);
  await notify(u.user_id, tt('notif.x.title', lc), tt('notif.x.body', lc));
}
```

### Adding a new key

1. Add the key to `GatewayI18nKey` union in `services/gateway/src/i18n/catalog.ts`.
2. Add translations to **all four** locale objects (DE, EN, ES, SR). DE
   must be a real translation; ES/SR can start as a copy of EN and graduate
   through the audit workflow later.
3. Use `tt(key, locale, params?)` in the route handler.

### Locale resolution priority

1. `app_users.locale` (canonical)
2. `memory_facts.fact_key='preferred_language'` (fallback)
3. `'de'` (default)

5-min in-process cache. Cron jobs that fan out over thousands of users
must use `bulkGetUserLocales` to batch-fetch in one query.

### What does NOT need translation

- **System instructions sent to the LLM** (`buildLiveSystemInstruction`,
  agent personas, tool prompts) — the LLM reads English instructions and
  emits German output when told `Respond ONLY in {language}`. Translating
  system prompts hurts model performance.
- **Internal state identifiers** (currency codes, tab IDs, status enums) —
  these are not user-visible.
- **Debug/telemetry logs** — never translated.

---

## 13c. VITANALAND COMMERCE — LONG-TERM VISION (self-service merchant onboarding)

**Standing product-direction framework, not a technical spec** — evaluate
recurring Discover/Commerce work against this, not just the immediate ticket.

**Goal:** any business (existing or new) connects to Discover the way
DoctorBox/Awin/Amazon.ae/Admitad did, **without an engineer hand-writing a
SQL migration.** Today's path is fully manual (catalog gathering →
affiliate negotiation → engineer seeds `merchants`/`products` by hand);
target is self-service, Shopify-like (low-friction onboarding, app-store
connection flow, merchant control over their own catalog/pricing).

**Near-term rule:** when doing incremental Discover/Commerce work (new
merchant seed, sync provider, attribution mechanism, commission flow),
prefer schema/config choices a future onboarding UI could drive over ones
only an engineer running a migration could drive — and flag it explicitly
when a shortcut adds to the hand-seeded onboarding debt pile, rather than
silently repeating it.

---

## 14. MEMORY & INTELLIGENCE ARCHITECTURE (VTID-01225)

This section documents the complete Memory & Intelligence stack, including how data flows from input (ORB/Operator Console) through extraction, storage, and retrieval for personalized responses.

### Data Input Channels

| Channel | Technology | Entry Point |
|---------|------------|-------------|
| **ORB Voice** | Amazon Nova Sonic (WebSocket) — see §2e; the Gemini Live API this row named is decommissioned | `orb-live.ts` |
| **Operator Console** | REST API (Text/Tasks) | `conversation.ts` |

### Memory Garden Categories (13 Total)

| Category Key | Display Name | Source Mappings |
|--------------|--------------|-----------------|
| `personal_identity` | Personal Identity | personal_identity |
| `health_wellness` | Health & Wellness | health |
| `lifestyle_routines` | Lifestyle & Routines | preferences |
| `network_relationships` | Network & Relationships | relationships, community, events_meetups |
| `learning_knowledge` | Learning & Knowledge | learning, education, skills |
| `business_projects` | Business & Projects | tasks |
| `finance_assets` | Finance & Assets | products_services |
| `location_environment` | Location & Environment | location, travel |
| `digital_footprint` | Digital Footprint | digital, online |
| `values_aspirations` | Values & Aspirations | goals |
| `autopilot_context` | Autopilot & Context | autopilot |
| `future_plans` | Future Plans | plans, milestones |
| `uncategorized` | Uncategorized | conversation, notes |

### Process Flow (Sync - User Response Path)

```
User Input (ORB/Operator)
       │
       ▼
┌──────────────────────────────────────────┐
│  1. Write raw conversation               │
│     writeMemoryItemWithIdentity()        │
│     → memory_items (category: conv)      │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  2. Retrieval Router (D2)                │
│     retrieval-router.ts                  │
│                                          │
│     Rules (priority order):              │
│     • vitana_system (100) → Knowledge    │
│     • personal_history (90) → Memory     │
│     • health_personal (85) → Memory      │
│     • external_current (80) → Web        │
│     • general_knowledge (50) → Knowledge │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  3. Context Pack Builder                 │
│     buildContextPack() /                 │
│     buildBootstrapContextPack()          │
│                                          │
│     Sources:                             │
│     • Memory Garden (fetchDevMemory)     │
│     • Knowledge Hub (searchKnowledge)    │
│     • Web Search (disabled in bootstrap) │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  4. LLM Generation (Claude via Bedrock)  │
│                                          │
│     System Instruction includes:         │
│     - User context from memory           │
│     - Personalization data               │
│     - Domain-specific knowledge          │
└──────────────────────────────────────────┘
       │
       ▼
   Response to User
```

### Process Flow (Async - Extraction & Persistence)

```
Session End / Conversation Complete
       │
       ▼
┌──────────────────────────────────────────┐
│  1. Cognee Extraction                    │
│     cogneeExtractorClient.extractAsync() │
│                                          │
│     Extracts:                            │
│     • PERSON entities                    │
│     • DATE entities                      │
│     • LOCATION entities                  │
│     • RELATIONSHIP entities              │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  2. Persist Extraction Results           │
│     persistExtractionResults()           │
│                                          │
│     A. RELATIONSHIP GRAPH (VTID-01087)   │
│        → relationship_ensure_node() RPC  │
│        → relationship_nodes table        │
│                                          │
│     B. MEMORY FACTS (VTID-01192)         │
│        → write_fact() RPC                │
│        → memory_facts table              │
│        → Semantic keys: user_name,       │
│          user_birthday, fiancee_name     │
│        → Provenance: assistant_inferred  │
│        → Auto-supersession built-in      │
│                                          │
│     C. MEMORY ITEMS (Legacy)             │
│        → Direct INSERT                   │
│        → memory_items table              │
│        → Uses source category mapping    │
└──────────────────────────────────────────┘
```

### Database Schema (Memory & Intelligence)

```
┌─────────────────────────────────────────────────────────────────┐
│                      MEMORY GARDEN                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  memory_facts (VTID-01192)     memory_items (VTID-01104)       │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │ fact_key             │      │ category_key         │        │
│  │ fact_value           │      │ content              │        │
│  │ entity (self/discl)  │      │ content_json         │        │
│  │ provenance_source    │      │ importance           │        │
│  │ provenance_confidence│      │ embedding (pgvector) │        │
│  └──────────────────────┘      └──────────────────────┘        │
│                                         │                       │
│                          memory_category_mapping                │
│                          ┌──────────────────────┐               │
│                          │ source → garden      │               │
│                          │ health → health_well │               │
│                          │ tasks → business_proj│               │
│                          └──────────────────────┘               │
│                                                                 │
│  memory_garden_config (13 categories)                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ personal_identity, health_wellness, lifestyle_routines,  │   │
│  │ network_relationships, learning_knowledge, business_proj, │   │
│  │ finance_assets, location_environment, digital_footprint, │   │
│  │ values_aspirations, autopilot_context, future_plans,     │   │
│  │ uncategorized                                             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                   RELATIONSHIP GRAPH (VTID-01087)               │
├─────────────────────────────────────────────────────────────────┤
│  relationship_nodes → relationship_edges → relationship_signals │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ node_type       │  │ from_node_id    │  │ signal_type     │  │
│  │ display_name    │  │ to_node_id      │  │ signal_value    │  │
│  │ metadata        │  │ relation_type   │  │ computed_at     │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `services/gateway/src/services/cognee-extractor-client.ts` | Cognee extraction + persistence |
| `services/gateway/src/services/retrieval-router.ts` | Routing decisions for context sources |
| `services/gateway/src/services/context-pack-builder.ts` | Builds context pack for LLM |
| `services/gateway/src/services/orb-memory-bridge.ts` | Memory read/write bridge |
| `services/gateway/src/routes/orb-live.ts` | ORB Live API session handling |
| `supabase/migrations/20260119000000_vtid_01192_infinite_memory_v2.sql` | memory_facts + write_fact() |
| `supabase/migrations/20260203000000_vtid_01225_extend_memory_category_mapping.sql` | Extended 13 categories |

### Retrieval Router Rules

| Rule Name | Priority | Triggers | Primary Source |
|-----------|----------|----------|----------------|
| `vitana_system` | 100 | "vitana", "oasis" | Knowledge Hub |
| `personal_history` | 90 | "remember", "my name", "told you" | Memory Garden |
| `health_personal` | 85 | "my health", "my sleep" | Memory Garden |
| `external_current` | 80 | "news", "weather", "stock price" | Web Search |
| `general_knowledge` | 50 | "what is", "how to" | Knowledge Hub |

### write_fact() RPC (VTID-01192)

```sql
write_fact(
  p_tenant_id UUID,
  p_user_id UUID,
  p_fact_key TEXT,           -- Semantic key: user_name, user_birthday, fiancee_name
  p_fact_value TEXT,         -- The value: "Dragan Alexander", "September 9, 1969"
  p_entity TEXT,             -- 'self' or 'disclosed'
  p_fact_value_type TEXT,    -- 'text', 'date', 'number'
  p_provenance_source TEXT,  -- 'user_stated', 'assistant_inferred'
  p_provenance_confidence FLOAT -- 0.0 to 1.0
) RETURNS UUID
```

**Features:**
- Auto-supersession: New fact with same key replaces old
- Provenance tracking: Source and confidence stored
- Entity scope: Distinguishes user facts vs facts about others

### Critical Fix (VTID-01225)

**Before:** `extractAsync()` called Cognee, logged results, then **dropped them**
**After:** `extractAsync()` calls Cognee, then **persists to 3 storage systems**:
1. `relationship_nodes` via `relationship_ensure_node()` RPC
2. `memory_facts` via `write_fact()` RPC
3. `memory_items` for legacy retrieval compatibility

---

## 15. DEPLOYMENT VERIFICATION PROTOCOL (VTID-01228)

**This is mandatory for EVERY deployment. No exceptions.**

Deployments have repeatedly failed because the checkout being deployed had stale code, or the wrong branch was deployed. This protocol prevents that.

> **Staging-first note:** by default you are verifying **STAGING**
> (ECS service `vitana-gateway` / `preview-aws-gateway.vitanaland.com`),
> because pushes to `main` auto-deploy staging only. The same curl/revision
> checks below apply — just point them at the staging URL and expect
> `env=staging`. You verify **production** only after a PUBLISH-button
> promotion or an escape-hatch (`scripts/deploy/publish-to-prod.sh`) /
> manual-dispatch deploy — never as a side effect of a push.

### Pre-Deploy Verification (BEFORE the CI build starts)

1. **Verify source code has the expected changes:**
   ```bash
   # Example: Verify sessions route exists before deploying Gateway
   grep -r "sessions" services/gateway/src/routes/live.ts | head -5
   ```
2. **If deploying by hand from a local checkout, verify it's on latest main:**
   ```bash
   git fetch origin
   git log --oneline origin/main -3   # Compare with local repo
   git log --oneline HEAD -3          # Should match
   # If behind:
   git reset --hard origin/main
   ```
3. **Verify the build succeeds locally (TypeScript compiles):**
   ```bash
   cd services/<service> && npm run build
   ```

### Post-Deploy Verification (AFTER the ECS deploy succeeds)

1. **Curl a critical endpoint that only exists in the new code:**
   ```bash
   # Check content-type: must be application/json, NOT text/html
   curl -s -o /dev/null -w "%{http_code} %{content_type}" \
     -X POST "https://gateway.vitanaland.com/api/v1/live/rooms/test/sessions" \
     -H "Content-Type: application/json" -d '{}'
   # Expected: "401 application/json..." (auth required, but JSON = route exists)
   # FAILURE: "404 text/html..." (Express default = route does NOT exist)
   ```
2. **Check the /alive endpoint:**
   ```bash
   curl -s "https://gateway.vitanaland.com/alive"
   ```
3. **Check the latest deployment is serving:**
   ```bash
   aws ecs describe-services --cluster Vitana-ECS-Cluster \
     --services vitana-gateway-awsdr --region eu-central-1 \
     --query 'services[0].deployments'
   ```

### Key Diagnostic: HTML 404 vs JSON 404

| Response | Content-Type | Meaning |
|----------|-------------|---------|
| `Cannot POST /api/v1/...` | `text/html` | **Route does NOT exist** — wrong code deployed |
| `{"error":"ROOM_NOT_FOUND"}` | `application/json` | Route exists, business logic error — correct code |

### Failure Protocol

If post-deploy verification fails:
1. **Do NOT tell the user "deployment succeeded"** — it didn't
2. Check which deployment is serving: `aws ecs describe-services --cluster Vitana-ECS-Cluster --services <svc>`
3. Check the build/deploy logs in the GitHub Actions run
4. Verify the source that was submitted had the correct code

---

## 16. CI/CD DEPLOYMENT PIPELINE — STAGING-FIRST (AWS)

**The staging-first model is unchanged by the AWS cutover — only the
underlying cloud is. The old "merge to main → manually dispatch a GCP prod
deploy" flow is gone because GCP itself is gone.**

### The model: push freely → staging; one button → prod

| Action | Where it lands | How |
|--------|----------------|-----|
| Push / merge to `main` (gateway) | **STAGING** (ECS `vitana-gateway`) | `AWS-STAGE-DEPLOY-GATEWAY.yml`, automatic |
| Promote to **production** | `gateway` (+ frontend) | **PUBLISH button** in Command Hub |
| Exceptional manual prod deploy | single service | `scripts/deploy/publish-to-prod.sh` |

- **`AWS-STAGE-DEPLOY-GATEWAY.yml`** auto-deploys staging on every push to
  `main` under `services/gateway/**`. Smoke-gates on `/api/v1/admin/health`
  → `env=staging`.
- **`AWS-PROD-DEPLOY-*.yml`** (one per service, §1b) is `workflow_dispatch`-only
  with a required `reason` — never on push. That's the deliberate prod
  lever, driven by the PUBLISH button and the escape-hatch script.

### End-to-End Deployment Checklist (STAGING-FIRST)

When changing code:

1. **Code fix** — on the feature/`claude/` branch.
2. **Commit** — include a VTID (`(VTID-XXXXX)`) or `BOOTSTRAP-<description>`.
3. **Push** — to the `claude/` branch; open a PR.
4. **Merge to `main`** — this auto-deploys to **STAGING only**.
5. **Verify on staging** — `preview-aws-gateway.vitanaland.com` (gateway) /
   `preview-aws.vitanaland.com` (frontend, see `exafyltd/vitana-v1`
   CLAUDE.md). Confirm `env=staging`. Do **NOT** expect or look for a prod
   deploy here.
6. **Ship to production** — when staging is verified, click **PUBLISH** in the
   Command Hub (promotes the exact tested staging build). For the rare
   out-of-band case, dispatch the service's `AWS-PROD-DEPLOY-*.yml` workflow
   directly (`scripts/deploy/publish-to-prod.sh` wraps the dead GCP-era
   `EXEC-DEPLOY.yml` — do not use it; see the subsection below):
   ```
   gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo exafyltd/vitana-platform \
     -f reason="why this exceptional prod deploy is justified"
   ```
7. **Verify prod** — only after PUBLISH/escape-hatch, per §15.

### Do NOT manually dispatch a prod deploy workflow as a routine step

Merging deploys staging. Prod is a deliberate, separate, governed action
(PUBLISH button or escape-hatch script with a recorded reason). If you find
yourself hand-dispatching `AWS-PROD-DEPLOY-GATEWAY.yml` to prod as a
routine step rather than a deliberate, reasoned action, stop — that
reintroduces the auto-to-prod behavior the staging-first cutover removed.

### A session-approved manual prod deploy ships that session's change only (Part 1 IF-THEN 26)

When the user approves a production deploy in conversation and it goes out
via a manual `workflow_dispatch` — **not** the Command Hub PUBLISH button —
the approval covers this session's own change, not the current state of
staging/`main` as a whole. Pin the commit on the workflow's own input:

```
gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo exafyltd/vitana-platform \
  -f reason="why this exceptional prod deploy is justified" \
  -f expected_commit=<this session's merge commit SHA>
```

**Do not use `scripts/deploy/publish-to-prod.sh` for this.** Its `--ref`
forwards straight to `gh workflow run --ref`, which GitHub's
`workflow_dispatch` API only accepts as a branch or tag — never a raw
commit SHA — so passing a commit there fails before anything deploys. The
script also wraps `EXEC-DEPLOY.yml`, the GCP/Cloud Run-era workflow §9
already flags as dead code now that GCP is decommissioned (§1); do not
dispatch it. Dispatch the live `AWS-PROD-DEPLOY-*.yml` workflow for the
service directly instead, as above.

Leaving `expected_commit` empty, or `deploy_mode` at its default
(`promote-staging`) with no `expected_commit`, ships whatever staging is
currently running **as a whole** — including any other work that happens
to have landed on `main` or staging ahead of this session's commit, whether
or not the user in this conversation ever saw or approved it. That is
exactly what PUBLISH is *for* (a deliberate, human-operated promotion of
the entire tested staging build) and exactly what an in-session approval
is not.

**Pinning `--ref`/`expected_commit` is necessary, not sufficient.** The
workflow checks out (or, for `promote-staging`, ships an image built from)
the full repository snapshot AT that commit, not a diff — so a pinned
commit still includes every ANCESTOR commit, including anything merged to
`main`/staging before this session's own work that nobody in this
conversation reviewed. Diff the pinned commit against what
`/api/v1/admin/build-info` reports as currently live in production (§15)
and confirm every commit in that range is this session's own or separately
approved. If it isn't, and it can't be excluded — no path here ships a
pinned diff, only a full snapshot — stop and tell the user what else would
ship alongside theirs rather than shipping it silently.

### CSS/JS Cache-Busting

The Gateway serves static files with `Cache-Control: no-cache, no-store, must-revalidate`, so browser caching is NOT an issue. However, `index.html` has `?v=` parameters on CSS/JS links. **Always bump these version strings** when making frontend changes to be safe:
```html
<link rel="stylesheet" href="/command-hub/styles.css?v=YYYYMMDD-HHMM" />
<script src="/command-hub/app.js?v=YYYYMMDD-HHMM"></script>
```

### GitHub access for API operations (VTID-04019 — no token material in this file)

This section used to print the first characters of two live personal access
tokens. It no longer does, and must never again: a rules file that every
session force-loads is the worst place for credential material, partial or
not (`services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts`
fails the build if a `github_pat_…`/`ghp_…`-shaped prefix reappears here or
under `docs/`).

Where the tokens actually live, and how each consumer gets them:

- **Gateway / executor (`GITHUB_SAFE_MERGE_TOKEN`)** — AWS Secrets Manager,
  wired into the ECS task definitions by `AWS-STAGE-DEPLOY-GATEWAY.yml` /
  `AWS-PROD-DEPLOY-*.yml`; the platform repo's PR/merge/dispatch calls in
  `services/gateway/src/services/github-service.ts` read it from the
  environment.
- **`exafyltd/vitana-v1` (`FRONTEND_DEPLOY_TOKEN`)** — same mechanism; the
  operator's cross-repo reads (`dev_read_file` / `dev_search_codebase` with
  `repo:"exafyltd/vitana-v1"`) and the PUBLISH button's frontend promotion
  use it.
- **A Claude Code session** — uses the GitHub MCP tools (`mcp__github__*`)
  and `add_repo`; it never needs, and must never be given, a raw PAT in
  conversation or in a file.
- **GitHub Actions** — repository secrets, referenced as
  `${{ secrets.… }}` in the workflow that needs them.

If a token is ever pasted into a file, a chat, or a log, treat it as leaked:
rotate it in GitHub, update the Secrets Manager value, redeploy the task
defs that carry it, and record the rotation in this file's CHANGE LOG.

---

## CHANGE LOG

| Date | Change | VTID |
|------|--------|------|
| 2026-09-18 | **Post-login Serbian on staging, one hour after VTID-04026: "it does not even understand the simplest question." Read the logs before touching anything — speech recognition was fine, every `input_transcription` was clean Serbian ("Koji broj trenutno stoji moj Vitana indeksa?"). The silence is on the TOOL-RESPONSE leg.** Every authenticated `sr` session died the same way: the question needs a tool (`get_day_summary`, then `get_current_screen`), the tool runs in ~560 ms, `response_sent:true`, then ~10 s of nothing and `turn_complete` with `audio_out` unchanged; the user repeats ("Da me čuješ?", "Halo, je me čuješ?"), every turn stays silent, and the unanswered calls surface on turn 5 as `upstream_ws_close 1007 "Request contains an invalid argument."` mid-sentence. Sessions that spoke after a tool response in the previous 3 days: zero. **Root cause:** `VertexLiveClient.sendToolResult` (and the twin envelopes in `gemini-api-key-live-client.ts` and the legacy `sendFunctionResponseToLiveAPI` in `orb-live.ts`) sent `function_responses[]` with only `name`+`response` — the function-call `id` was deliberately omitted on a VTID-01224-era note ("Vertex rejects `id` with 1007"), measured on `gemini-2.0-flash-exp`. Google's current Live API reference says the opposite for today's model: FunctionResponses "are matched to the respective FunctionCall objects by the `id` field", and the model does not respond until the response arrives. The gateway already parsed `fc.id` into `callId`; it was dropped at the wire only. **Fix:** both clients remember the ids the server issued in `tool_call` and echo `id: callId` (each once); a callId the server never issued (the session layer's `randomUUID()` placeholder) is never echoed; the legacy sender gets the same via the exported `isServerIssuedFunctionCallId()`. Nova Sonic already required the id; the cascade is untouched; the bridge stays Serbian-only. 6 new/rewritten tests; targeted suites 5/93 green; `tsc --noEmit` clean. `scripts/orb/verify-vertex-serbian-bridge.mjs` gains `--utterance-pcm=` so a real user turn (16 kHz PCM, any language — the bridge answers in Serbian) can be driven over SSE; it ends the turn with trailing silence, never `/live/stream/end-turn` (the widget does not call it, and `client_content{turn_complete:true}` on an audio-only session closes 1007 — measured 2/2). **Verified live after merge (#3409 → `0b24cd8`): baseline on the previous build 0/2 (tool response sent, 20 s silence, watchdog); after the fix 6/6 sessions spoke on the same turn as the tool call, first reply audio 1.2–2.1 s after the utterance, 0 × 1007** (`docs/validation/VTID-04036/`). **Answered the owner's question in-session:** Google's Serbian speech is not separable from Gemini in the bridge — Gemini Live is one audio-to-audio model; a "Google STT/TTS + Bedrock Claude" Serbian path is the existing three-hop cascade with a Google TTS backend instead of Fish (likely ~3–5 s/reply instead of 10, still no barge-in) — a possible follow-up when the GCP credit window ends, not built here. **Flagged, not fixed:** `get_current_screen` reported the pre-login `/maxina` screen for a logged-in session; `voice.latency.measured` labels turns ≥1 `gemini-2.0-flash-exp` (stale constant). | VTID-04036 |
| 2026-09-18 | **Post-login Serbian voice on staging looped "hold on, I'm reconnecting" — the VTID-04021 handoff's open problem, closed with measurement instead of a fourth rewording.** Traced read-only in `oasis_events`: every failing authenticated `sr` session reached `setup_complete` (`upstream_ws_state:1` at `greeting_sent`) and closed `1007 "Request contains an invalid argument."` ~290 ms after the FIRST generation request — the greeting, or on the sessions whose greeting survived, the user's first utterance (`input_transcription` ×N → close at `turn_count:1`), which is why the audible cue (suppressed only while nothing has been heard yet) then repeats on every turn. That is the shape `live-system-instruction.ts` already documents for the pre-shutdown incident ("1007 on the very first client_content send (setup itself is accepted)") — so the handoff's instruction-budget lead was half right: the aggregate IS too large, but it is the TOOL CATALOG the instruction guard never covered. Measured with `buildLiveApiTools` on this commit's parent: authenticated community = **290 declarations / 226 KB** (65 core = 96 KB + 225 domain = 130 KB), admin = 134 / 45 KB, anonymous = 2 / 4.9 KB. Then isolated live rather than argued: added `--route=` to `scripts/orb/verify-vertex-serbian-bridge.mjs` (the surface is the one knob that changes envelope size without code) and ran 8+8 authenticated trials on staging, same account/language/deployment — community surface **2/8** completed a turn (6 × 1007), admin surface **8/8**, fluent Serbian on every one, first-audio latency 1.0–1.5 s vs 1.4–2.0 s. Ruled out with a scan of all 290 schemas: no invalid JSON-schema keyword (the only hits are property names such as `title`), no duplicate names; the voice is the same on passing anonymous sessions. **Fix:** `orb/live/tools/vertex-tool-catalog-budget.ts` — pure first-fit packer, priority list kept first (navigation, `end_conversation`, memory/diary/reminders, guided-journey/teacher, persona hand-off, calendar, messaging, daily logs), remainder in catalog order, `google_search` untouched, default 48 KB (inside the measured-working point), `VERTEX_TOOL_CATALOG_BYTE_BUDGET` overrides, `0` disables; wired in `orb-live.ts`'s envelope builder gated on `session.upstreamProvider === 'vertex'` only — never on `sr` — with a queryable `vertex_tool_catalog_trimmed` OASIS diag. 14 new tests (packer, env resolver, the REAL catalog, a source contract on the wiring); `surface-gated-catalog` re-run green; `tsc --noEmit` clean. **Not touched, on the owner's instruction:** the pre-login thinking-text-spoken bug (visible again in admin trial 1's transcript). Evidence: `docs/validation/VTID-04026/`. Post-merge AC-7 is the same script on the default surface expecting 8/8. | VTID-04026 |
| 2026-09-18 | **W5c of the operator agent plan: `dev_ecs_tasks` — the Operator Console can finally see ECS tasks, not just services (gap analysis §4.4 item 4).** `dev_aws_ecs_status` (VTID-03836) described a service's rollout and `dev_cloudwatch_logs` (VTID-04020) read its logs, but neither could answer "is the executor task for this execution still alive?" (the VTID-04011 watchdog reclaimed a live task as dead) or "why do the stale `vitana-autopilot-executor:2` tasks exit 2?" (noted in the Run #4 record, never answered) — and the one-shot executor has no ECS service at all, only a task family, so the service tool cannot even address it. `aws-ecs-readonly.ts` gains `listEcsTasks` (`ListTasksCommand` by `serviceName` for a §1b service or by `family` for `vitana-autopilot-executor`, then one `DescribeTasksCommand`; newest first; `truncated` from `nextToken`), `normalizeTasksQuery` (target refused before any AWS call unless listed; RUNNING default / STOPPED; limit 10 default / 25 max) and `summarizeEcsTask` (task id, status, health, `family:revision`, launch type, cpu/memory, created/started/stopped, stop code + reason, per-container exit code/reason/image tail — all bounded). Wired as `dev_ecs_tasks` on the operator wire schema behind the existing `OPERATOR_AWS_READONLY_ENABLED` switch and the `dev_*` developer/admin gate; an IAM denial is returned verbatim. Same client, same broad task role (the recorded VTID-03929 decision), still never StopTask/RunTask/UpdateService from this module. Six suites that mock `aws-ecs-readonly` with an explicit factory now export the new names (the schema reads them at load). 11 new tests; the VTID-04020 / 03835 / 03946 / 04022 / 04023 / 04028 / 04018 suites re-run green; `tsc --noEmit` clean. **Not verified live** — `ecs:ListTasks` / `ecs:DescribeTasks` on `vitana-ecs-task-role` are unverified; the first staging call is the exercise, exactly as VTID-04020's first call was for `logs:FilterLogEvents`. | VTID-04035 |
| 2026-09-18 | **W4j of the operator agent plan: cancel a queued or running Dev Autopilot execution from the Operator Console (`autopilot_cancel_execution`) — the tool W4h's own record left out.** VTID-04032 made a cancel real and put `Cancel run` on the Autopilot Live rows; VTID-04033 put the agent's steps under the reply that queued it — so "stop that, wrong file" is now said in the console, where no tool could act on it. New `operator-cancel-tool.ts`: with no id, the executions that can be cancelled right now (`cooling`/`running`, newest first, ≤ 20, with VTID, executor, claimed env, branch, ECS task id) — read-only, the message says nothing was cancelled; with an id, VTID-04032's `cancelExecution` (cooling: cancelled at once; running: marked cancelled, ECS `StopTask` best effort, the agent halts at its next turn boundary) with the reply saying which happened, a refused StopTask verbatim, and that nothing will be pushed or opened. Same posture as the VTID-04030 tools: the VTID-03851 caller gate before any read (anonymous / non-admin refused naming the tool), actor `operator-chat:<verified user_id>` on the row and the existing `dev_autopilot.execution.cancelled` event, a prefix resolves only among cancellable rows and must be unique, every `cancelExecution` refusal passed through as an error. Registry, wire schema, dispatch and both prompt sources (VTID-03838 rule kept byte-identical; the model is told a held execution is reject's business, to list and ask rather than guess, and never to cancel on its own judgement). No new OASIS topic, flag, schema, route or UI change. 13 new tests; the VTID-04030 / 04007 / 03838 / 03851 / 04018 suites re-run, 86 tests green; `tsc --noEmit` clean. **Not verified live** — the first cancel from the staging console is the exercise and answers the `ecs:StopTask` permission question by itself. | VTID-04034 |
| 2026-09-18 | **W4i of the operator agent plan: the Operator Console follows an execution it queued (gap analysis §4.6 follow-through, §3.10 "status of what I asked for").** After W2/W4f a turn could queue (`autopilot_run_task` / `autopilot_execute_task`) or approve (`autopilot_approve_execution`) a Dev Autopilot execution, and the reply ended with "it will run on the next executor tick" — the operator then had to open Autopilot Live and find the row to learn whether the agent had even been claimed. Now the console follows it where it was asked for: `extractFollowedExecutionIds` takes the successful queue/approve results' `execution_id`s off the reply's tool results (deduplicated; review and failed results never follow), `followOperatorExecution` opens the same per-execution SSE tail the Autopilot Live view uses (`GET /executions/:id/stream`, VTID-03897, bearer as query), keeps the last 40 step frames, and closes on the stream's own `terminal` frame; `renderOperatorExecutionFollow` draws a panel under the reply — a chip linking to `/command-hub/autopilot/live/#autopilot-live-exec-<id>`, a pulsing `queued · following` / `approved · following` marker that becomes the terminal outcome (`held for approval`, `completed`, `failed`, `cancelled`, `reverted`, `rejected`, `archived` — every topic the route emits is labelled, pinned by a test against the route source), and the step lines (`turn N · agent.tool: …`, errors red, passing checks green). A new thread drops the follows. No gateway change, no new route, no OASIS change — the stream and its terminal set are VTID-03897/04029's, untouched; classes only (CSP gate re-run clean), cache-bust bumped, VTID-04033 allowlisted in the Command Hub ownership guard. Found on the way: the VTID-04031 suite pinned the exact cache-bust string, so the held W4h bump would have failed its own CI — relaxed to at-or-after (the VTID-04028 form) inside the W4h commit before it was pushed. 9 new tests; the W4d / W4g / W4h / VTID-03947 / VTID-03822 / VTID-03949 console suites re-run green; `tsc --noEmit` clean; visually verified on a local harness (a scripted turn queuing one execution + a scripted step stream ending in `awaiting_approval`) at 1400×900 and 390×844 (`docs/validation/VTID-04033/outputs/`). **Not verified live** — the next `autopilot_run_task` from the staging console after this deploys is the exercise; it depends on nothing the owner has to pin. | VTID-04033 |
| 2026-09-18 | **W4h of the operator agent plan: cancel a RUNNING Dev Autopilot agent execution (gap analysis §4.6, the last item — and a real gap, not a missing button).** `POST /executions/:id/cancel` existed but `cancelExecution` only ever PATCHed `cooling` rows: a running agent (Run #4 spent 18 of 22 minutes on nine identical `tsc` runs) could not be stopped from anywhere, its ECS task ran to the deadline and whatever it returned was applied. Now: (1) the route cancels a `running` row at once — one PATCH scoped `status=eq.running`, `metadata.cancelled = {by, at, reason, was, ecs_task_arn, ecs_task_stopped, ecs_task_error}` merged per VTID-04011, one `dev_autopilot.execution.cancelled` event, terminal side effects — after a best-effort ECS `StopTask` on the task ARN the dispatch loop now records (`recordDispatchedTask`, `metadata.ecs_task_arn`); `ecs:StopTask` is unverified on `vitana-ecs-task-role`, so a denial is recorded and returned, never assumed. (2) The agent cooperates: the VTID-04011 heartbeat reads the row back after each beat and raises a flag (`onCancelRequested`, once) that the loop polls at every turn and tool boundary (`isCancelled`), plus checks before `tsc`, each jest target and the push — the run ends `{ok:false, cancelled:true}`, nothing pushed, usage outcome `cancelled`. (3) The decision stands: `applyExecutionResult` closes a cancelled result as `cancelled` (never `failed`, never the self-heal bridge) and ignores a late `failed` result on an already-cancelled row, so StopTask killing a task mid-turn cannot spawn a self-heal child. Command Hub: `Cancel run` on running (and `Cancel` on cooling) Live rows, reason prompt, row updated in place, toast says whether the task was stopped. 16 new tests; heartbeat / fix-mode / check-guard / executor / approval / watcher / loop suites re-run green; `tsc --noEmit` clean; visually verified on a local harness at 1400×900 and 390×844 (`docs/validation/VTID-04032/outputs/`). **Not verified live** — the first cancel of a real staging run is the exercise and answers the StopTask permission question by itself. With W4d–W4h the §4.6 console-UX list is closed. | VTID-04032 |
| 2026-09-17 | **W4g of the operator agent plan: the cost / model badge (gap analysis §3.10 — "meta.provider/model returned but never rendered" — and §4.6).** The router returned token usage and the serving provider/model on every call; the operator layer forwarded provider/model in `meta` and dropped the usage, so the console could never say what a turn cost. New pure `operator-turn-cost.ts`: `pricingKeyForModel` (exact `MODEL_COSTS` key, else a Bedrock inference-profile id such as `eu.anthropic.claude-sonnet-4-6` reduced to `claude-sonnet-4-6`), `turnUsageFields` (tokens + `estimateCost`; an unknown model is `cost_priced:false` with cost 0 — never silently free), `summarizeTurnCost` (plan + final calls folded: token totals, summed cost, `model_calls`). `gemini-operator.ts` threads `usage` through both router calls and puts `usage` / `cost_usd` / `cost_priced` / `model_calls` / `duration_ms` on the reply meta and the per-call fields on each W4d `model.turn` frame. Command Hub: a badge on every reply meta row (`deepseek · deepseek-flash · 6.0s · 7.6k↑ 700↓ · $0.0016`, breakdown on hover), model-call lines in the live transcript, a phone-width wrap rule, cache-bust bumped (the W4d pin is now at-or-after). 10 new tests; the W4d / user-role / OASIS-chat suites re-run green; `tsc --noEmit` clean; visually verified on a local harness at 1400×900 and 390×844 (`docs/validation/VTID-04031/outputs/`). **Not verified live** — the next Operator Console message on staging after this deploys shows the badge with real DeepSeek usage. Rates are list prices, an estimate. **Still open from §4.6:** cancel of a running agent. | VTID-04031 |
| 2026-09-17 | **W4f of the operator agent plan: review / approve / reject a held Dev Autopilot execution from the Operator Console (gap analysis §4.6, the last approve item).** W4e (VTID-04029) put the diff review on the Command Hub rows; the console that asked for the execution could neither list what was waiting nor decide. New `operator-approval-tools.ts`: `autopilot_review_execution` (no id → every `awaiting_approval` execution, newest first, VTID resolved through the finding; an id → the stored preview bounded for the model: PR title, body ≤ 2 000 chars, files ≤ 60, `--stat`, diff ≤ 12 000 chars with truncation reported; a row no longer held is reported by status), `autopilot_approve_execution` (→ `approveExecution`, PR opened, row `ci`) and `autopilot_reject_execution` (→ `rejectExecution`, branch deleted best effort, row `cancelled`, reason ≤ 500 chars). Every handler runs the VTID-03851 caller gate before any Supabase read — anonymous / non-admin turns are refused naming the tool — and the actor written on the row and the VTID-04029 events is `operator-chat:<verified user_id>`, never a model argument. Ids may be the 8-character prefix operators see; a prefix resolves only among held rows and must be unique (none / ambiguous / too short are named refusals). Registry, wire schema, dispatch and both prompt sources (VTID-03838 rule; the model is told the tools never start work, to list and ask rather than guess, and never to approve or reject on its own judgement of the diff). No new OASIS topic, flag, schema or UI change. 15 new tests; the VTID-04007 / 03838 / 03851 / 04018 / 04029 suites re-run, 93 tests green; `tsc --noEmit` clean. **Not verified live** — same owner steps as W4e (`OPERATOR_PR_APPROVAL_REQUIRED=true` on staging, executor image rebuild); the first chat-driven Approve is the Test Run #7 variant for this slice. **Still open from §4.6:** cost/model badge, cancel of a running agent. | VTID-04030 |
| 2026-09-17 | **W4e of the operator agent plan: a diff preview with Approve / Reject BEFORE the Dev Autopilot agent opens a PR (gap analysis §4.6, the commit-tier / maker-checker item).** Every agent run went straight from `commitAndPush` to `openPullRequest`; the first time a human saw the change was as an open PR with CI running, and "no" meant closing it. Now, when the execution was told to hold — row `metadata.require_approval` (the operator on-ramp stamps it from `OPERATOR_PR_APPROVAL_REQUIRED=true`) or the executor process's `DEV_AUTOPILOT_PR_APPROVAL_REQUIRED=true`; never in fix mode — the runner pushes the branch (the scratch clone dies with the task), computes the diff against the base and returns `awaiting_approval` instead of opening the PR. New `dev-autopilot-approval.ts`: `stageExecutionForApproval` (status `awaiting_approval`, `metadata.pending_approval` with a bounded stat/patch/file preview merged into the row's metadata per VTID-04011, one `dev_autopilot.execution.awaiting_approval` event), `approveExecution` (opens the PR with the stored title/body through `github-service.createPullRequest`, records `metadata.approved`, re-enters `applyExecutionResult` with the PR so the row moves to `ci` with the same `pr_opened` event + memory row as an auto-opened PR; a PR-open failure leaves the row waiting), `rejectExecution` (deletes the branch best-effort, `cancelled` + `metadata.rejected`, `.rejected` event). Routes `GET /executions/:id/diff`, `POST …/approve`, `POST …/reject` (exafy_admin, actor = verified identity). Migration widens the status CHECK (applied live before merge); the active list, the same-finding inflight guards and the stream's terminal topics know the status; the concurrency cap deliberately does not count a human hold. **Command Hub:** the Autopilot Live view's Dev Autopilot rows get an amber `AWAITING_APPROVAL` pill, `▸ Diff` (stat + colour-coded patch inline), `Approve → open PR` and `Reject` — found while doing it that the Dev Autopilot page's own `renderDevAutopilotExecutionCard()` is dead code (its only caller is never invoked), so the controls live where operators actually look, and the card is kept in step. 20 new tests; 12 executor/watcher/bridge/agent suites re-run, 153 tests green; `tsc --noEmit` clean; visually verified on a local harness at 1400×900 and 390×844 (`docs/validation/VTID-04029/outputs/`). **Not verified live** — needs `OPERATOR_PR_APPROVAL_REQUIRED=true` on staging (owner pin) and the executor image rebuilt from this commit; the first held run and its Approve from the Command Hub is Test Run #7. **Still open from §4.6:** cost/model badge, cancel of a running agent; operator-chat approve/reject tools. | VTID-04029 |
| 2026-09-17 | **W4d of the operator agent plan: the Operator Console turn streams as Server-Sent Events with a live tool-call transcript (gap analysis §4.6, first item).** `POST /api/v1/operator/chat` answered one JSON body after the whole turn — model call, every tool, final model call — so a turn that read three files and tailed a log group was a "Sending..." button for its whole duration, then one bubble, with the VTID-03822 tool-activity lines appearing only afterwards and without timings. `processWithGemini()` gains an optional `onEvent` sink emitting `model.turn` (plan/final, provider, model, duration), `tool.call` (index, name, args ≤ 1.2 KB) and `tool.result` (ok, duration_ms, clipped error, governance flag, excerpt ≤ 600 chars) around the real tool loop — fire-and-forget, a throwing sink is swallowed, no sink means no emission. The `/chat` handler body became `runOperatorChatTurn()` shared by `POST /chat` (unchanged) and new `POST /chat/stream`: same validation (400 JSON before any header), authz marker, OASIS chat events, thread record and turn memory, framed `turn.started → model.turn/tool.call/tool.result → reply (the exact /chat body) or error → done` with a 15 s heartbeat; client-gone detection is `res.on('close')`, because on Node ≥ 16 the request's own `close` fires the moment the JSON body is consumed (the first test run proved it — every frame after `turn.started` went silent). The Command Hub reads the fetch body as a stream (EventSource cannot POST), renders the transcript live under the messages (running lines pulse, done lines carry `✓ · 1.2s`, failures `✗ — error`), keeps the measured durations on the final activity lines, and falls back to `/chat` only when no stream is obtainable (404 / non-event-stream), never after a turn already ran. 16 new tests (sink around a real `run_code` round, route framing incl. error/400/admin identity, `/chat` unchanged, client source guards); 10 operator suites re-run, 101 tests green (one VTID-03851 source slice re-pointed at the shared function); `tsc --noEmit` clean. **Visually verified** against a local harness (statics from the working tree + stubbed APIs + a scripted three-tool turn, nothing live) at 1400×900 and 390×844 — `docs/validation/VTID-04028/outputs/`; the console's own sidebar+chat split at 390 px is the pre-existing VTID-03949 layout, untouched. **Not verified live** — the next Operator Console message on staging after this deploys is the exercise. **Still open from §4.6:** diff preview + Approve/Reject before a PR, cost badge, cancel. | VTID-04028 |
| 2026-09-17 | **Operator memory recall is now top-10, category-diverse and bounded (the recall side of gap analysis §4.3).** `recallDevMemory` served the top-5 rows by raw cosine similarity and the rendered block had no size bound — with W4c writing rows from every turn, one incident-heavy thread would fill every slot with near-duplicate `incident` rows and crowd out the one `decision`/`convention` that mattered. New `dev-memory-ranking.ts`: fetch 20 candidates, `diversifyRecallHits` (round-robin over categories in similarity order — every category with a hit is seated before any second seat — cap 4 per category, 10 rows, dedupe, output re-sorted by similarity), `renderDevMemoryBlock` (VTID-03892 header unchanged, per-row title/content clip, 6 KB total, worst dropped first); `buildDevMemoryContextBlock` delegates to both. No schema/RPC/flag change. 5 new tests; VTID-03892/03930/04022 suites re-run, 30 tests green; `tsc --noEmit` clean. With W4a (bootstrap), W4b (threads + summary-aware query), W4c (accrual) and this, §4.3 is closed except §4.6's SSE/approve items. | VTID-04027 |
| 2026-09-17 | **W4c of the operator agent plan: memory that accrues (gap analysis §4.3, the half W4b left open).** `writeDevMemory` fired for five tool names only (VTID-03928); an owner decision stated in chat, a gotcha the console hit, a preference — all died with the browser tab, and a failed Dev Autopilot run left no memory of why. New `operator-turn-memory.ts`: after each completed `/api/v1/operator/chat` turn the `memory` routing stage (its own Bedrock-primary/DeepSeek-fallback order, never Google) extracts ≤3 durable facts as JSON (`decision` / `convention` / `incident` / `preference` / `gotcha` — `task_outcome` stays the tool-outcome writer's and the executor's), parsed tolerantly, clamped, deduped, VTID picked up, written with `source:'session'` + `turn-extracted` tags and thread provenance; trivial turns are skipped before any model call. The executor's `applyExecutionResult` now writes a `task_outcome` row when a run opens a PR and a `gotcha` row when a run fails (reason includes the W0 CI excerpt). Fire-and-forget, fail-open, gated on `OPERATOR_TURN_MEMORY_ENABLED` (default off, not pinned). 13 new tests; operator-chat/thread/executor suites re-run, 69 tests green; `tsc --noEmit` clean. **Not verified live** — the owner's staging pin is the exercise. **Still open from W4b/§4.6:** SSE streaming of the turn with the tool transcript; diff preview + Approve before a PR. | VTID-04025 |
| 2026-09-17 | **W4a verified live on staging, and its first real defect fixed the same hour.** Staging served `2545dcc` (VTID-04018) and a read-only operator turn (exafy_admin session, no tool call, DeepSeek Flash, 5.95 s) answered from the bootstrap pack: staging `2545dcc7acef` / prod `7ba9a8eebad1` from live build-info, VTID-04019 as the newest change-log row — both correct. The open-PR section read `(unavailable: Open pull requests timed out after 2500ms)`. Two causes: `listOpenPrsWithStatus` (VTID-01154) fetched CI state per PR **sequentially** (N+1 GitHub calls), and its feed item never carried the PR title, so even on success the pack rendered the branch as the title. **Fix (VTID-04024):** `Promise.all` over the per-PR CI lookups + `title` on `GitHubFeedItem` (every caller benefits); new one-call `listOpenPrsBare`; the pack's `resolvePlatformOpenPrs` races the enriched list against a 1.5 s budget and falls back to the bare list marked `(platform CI state omitted …)` — the section is never unavailable just because CI enrichment is slow. 9 new tests; the W4a and github-service read-access suites re-run, 32 tests green; `tsc --noEmit` clean. **Next signal:** the open-PR section on the next staging turn lists `exafyltd/vitana-platform#…` rows with `ci=…` and no fallback note. | VTID-04024 |
| 2026-09-17 | **W5b (read-only SQL) of the operator agent plan: `dev_run_sql_readonly` — the Operator Console can run one bounded SELECT instead of reading four allowlisted tables newest-first.** `dev_db_query` (VTID-03837) cannot join, aggregate or touch any other table, so "how many executions failed per stage this week" was unanswerable from the console. New `operator-sql-readonly.ts`, five independent layers: kill switch `OPERATOR_SQL_READONLY_ENABLED`; its OWN connection `OPERATOR_SQL_READONLY_DATABASE_URL` (a read-only login role on the Aurora reader — never a silent reuse of `AURORA_DATABASE_URL`'s `vitana_admin` superuser or the RLS diagnostic's `authenticator` URL; unset → `not_configured`, IF-THEN 31's posture); statement validation (comments stripped, one statement, SELECT / WITH … SELECT / plain EXPLAIN only, no data-modifying CTE, no locking clause, no `pg_sleep`/`pg_read_file`/`pg_terminate_backend`/`set_config`/`dblink`/`lo_*`/`nextval`/SELECT INTO, ≤ 4 KB); `BEGIN READ ONLY` + `SET LOCAL` statement/lock/idle timeouts, always `ROLLBACK`, pool opened with `default_transaction_read_only=on`; `SELECT * FROM (…) LIMIT n+1`, cells clipped, 24 KB payload cap. Every execution logged with thread + statement fingerprint + rows + ms (readable via `dev_cloudwatch_logs`). Developer/admin only through the existing `dev_*` gate. 16 new tests; 4 read-tool suites / 61 tests green; `tsc --noEmit` clean. **Ships inert and is NOT verified live** — the read-only role, its secret and the task-def wiring are the owner's (declared in the deploy workflow), and this session has no VPC route to Aurora's Postgres port; the first staging call is the exercise. The rest of W5b (deploy-workflow dispatch table, the `vitana-v1` write lane) stays open and owner-gated. | VTID-04023 |
| 2026-09-17 | **W4b of the operator agent plan: server-side Operator Console threads and rolling summaries (gap analysis §4.3).** The console's transcript lived only in the browser (`localStorage`, VTID-03822) and its `dev_agent_memory` recall (VTID-03892) ran against the raw current message, so "now rebuild the image" retrieved nothing about the thread it belonged to. New `operator-threads.ts`: after every `/api/v1/operator/chat` turn the thread is upserted and the user/tool/assistant messages appended to `operator_threads`/`operator_messages` (fire-and-forget, off the reply's critical path); every `OPERATOR_THREAD_SUMMARY_EVERY` (10) turns the rolling summary is rewritten from the last 30 messages + the prior summary through the `memory` routing stage (its own Bedrock-primary/DeepSeek-fallback order — never Google); `processWithGemini` now recalls against `buildRecallQuery(summary, message)`. Fail-open by construction: `OPERATOR_THREADS_ENABLED` default off (not pinned anywhere yet), a missing table warns once naming the migration and records nothing, a Supabase or router failure never touches the reply. Migration `20260917230000_vtid_04022_operator_threads.sql` **applied to the live project 2026-09-17 22:20 UTC** (Supabase MCP `apply_migration`, pre/post-checked, both tables empty) because the Migration Drift Check (VTID-03486) rejects a declared-but-absent table before merge; the remaining step is pinning the flag on staging. `DATABASE_SCHEMA.md` documents both tables. 15 new tests; 7 operator-chat suites re-run, 79 tests green; `tsc --noEmit` clean. **Still W4b, not done:** memory writes from every tool outcome, SSE streaming of the turn with the tool transcript, diff preview + Approve before a PR (§4.6). | VTID-04022 |
| 2026-09-17 | **W5a of the operator agent plan: `dev_cloudwatch_logs` — the Operator Console can finally read what a service logged (gap analysis §4.4 item 3).** Until now the console saw a service's ECS rollout state (VTID-03836) and its DB rows (VTID-03837) but never its logs — the first thing a session reads when staging misbehaves (`aws logs tail /ecs/vitana-gateway`, §11). New `aws-cloudwatch-logs-readonly.ts`, same posture as `aws-ecs-readonly.ts`: separate module and cached client under the gateway task's own broad role (the recorded VTID-03929 decision), imports only `FilterLogEventsCommand`, the group must match `/ecs/vitana-<service>` before any AWS call, window (30 min default / 24 h max), events (50 / 200), per-message (600 chars) and total (24 KB) payload all bounded, an IAM denial returned verbatim. Wired as a `dev_*` (developer/admin) tool on the operator wire schema behind the existing `OPERATOR_AWS_READONLY_ENABLED` (staging only). New dependency `@aws-sdk/client-cloudwatch-logs`. 12 new tests; 3 suites / 47 tests green with the VTID-03835 read-tools and VTID-04018 pack suites; `tsc --noEmit` clean. **Verified live 2026-09-17 22:18 UTC, and the answer is "not yet":** with staging on `54e97c5`, the first `dev_cloudwatch_logs` call (read-only operator turn, DeepSeek Flash, one tool call) returned verbatim `…assumed-role/vitana-ecs-task-role/… is not authorized to perform: logs:FilterLogEvents on resource: arn:aws:logs:eu-central-1:472838866351:log-group:/ecs/vitana-gateway because no identity-based policy allows the logs:FilterLogEvents action` — the honest-error posture worked exactly as designed; the grant (`logs:FilterLogEvents` + `logs:DescribeLogGroups` on `/ecs/vitana-*`) on `vitana-ecs-task-role` is the owner's, declared in IaC/the deploy workflow, never hand-edited on the task def. | VTID-04020 |
| 2026-09-17 | **W7a of the operator agent plan: the partial GitHub PATs are out of this file.** §16 printed the first characters of two live personal access tokens ("use these PATs with the GitHub REST API") in the one file every session force-loads and every agent prompt carries (the executor's system prompt embeds Part 1; the W4a bootstrap pack reads this file through the GitHub API). Replaced with where each token actually lives — `GITHUB_SAFE_MERGE_TOKEN`/`FRONTEND_DEPLOY_TOKEN` in AWS Secrets Manager wired by the deploy workflows, Actions repository secrets, and the GitHub MCP tools for a session — plus the leak rule (rotate, update the secret, redeploy, record). New `test/vtid-04019-no-token-prefixes-in-docs.test.ts` scans `CLAUDE.md`, `README.md` and every markdown file under `docs/` (487 files) for token shapes (GitHub fine-grained/classic, AWS access key ids, `sk-`/`sk-ant-` keys, JWTs) and fails the build on any hit; 488/488 passing. **Owner follow-up, not done here:** rotate the two tokens whose prefixes sat in `main` for weeks; the Supabase `service_role` rotation and the prod operator-flag declarations remain open W7 items. | VTID-04019 |
| 2026-09-17 | **W4a of the operator agent plan: the Operator Console's session bootstrap pack (gap analysis §4.1).** The console's codebase knowledge was a hand-typed six-bullet constant (`CODEBASE_OVERVIEW_BLOCK`, VTID-03930) refreshed by hand. New `operator-bootstrap-pack.ts` assembles, on every operator turn — the main turn and, per §4.1, the tool-result turn too — what a Claude Code session starts with: CLAUDE.md Part 1 rules and the newest 20 CHANGE LOG rows (read through the GitHub contents API, since the gateway container ships no CLAUDE.md), `config/service-path-map.json`, the `DATABASE_SCHEMA.md` table index, live `build-info` for the gateways named in `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS`, open PRs on both repos (platform with CI state), the last 10 `deploy.*`/`dev_autopilot.*` OASIS events, and the tool catalog rendered from the declarations the model is actually given this turn — never a hand-typed list. Every source is bounded and timed out at 2.5 s and fails open to one `(unavailable: …)` line; the fetched sections are cached 5 min with coalesced concurrent builds; the whole pack is capped at 40 KB. Gated on `OPERATOR_BOOTSTRAP_PACK_ENABLED=true` (pinned on staging with the two build-info targets; prod untouched); the VTID-03930 block stays as the pack's floor. 16 new tests (renderers, assembly/size budget, fail-open per source, cache/coalescing, wiring, staging pin); the VTID-03930/03892/03838 prompt suites still pass; `tsc --noEmit` clean. **Not verified live** — the first operator turn on staging after this deploys is the exercise; `(unavailable: …)` lines in the served prompt name what to fix. Thread summaries / memory-against-summary (§4.3) are W4b. | VTID-04018 |
| 2026-09-17 | **W3 of the operator agent plan: the CI feedback loop runs in fix mode instead of starting over.** Until now a CI failure on a Dev Autopilot PR meant triage → `revertExecutionPR` (close the PR, delete the branch) → a child re-running the same plan from a fresh clone of `main` and opening a NEW PR — the first attempt discarded even for a one-line fix, and the VTID-04005 log excerpt only a hint. Two latent defects on that path: the PR-flood guard in `runExecutionSession` refuses any child whose parent still carries a `pr_url` (the parent is `reverted`, not in the guard's exclusion list), and the child was pointed at a branch that had just been deleted. **Now, for an agent-executor parent at stage `ci` (not DRY_RUN):** the PR stays open; `spawnChildExecution` writes `metadata.fix_mode = { branch, pr_number, pr_url, parent_execution_id }` on the child beside the inherited executor/override and `parent_failure`; the agent runner clones that branch (`prepareWorkspace({ existingBranch })`), fetches `main` for the diff base (`fetchRefSha`/`listChangedFilesSince`), builds `buildFixModeTaskPrompt` (PR files, CI evidence, attempt N of M, no starting over, no skipping tests), runs the post-hoc scope/coverage/tsc/jest checks on the WHOLE PR diff, refuses to push if this run edited nothing, fast-forwards onto the same branch (`commitAndPush({ force:false })`) and returns the parent's PR so the watcher's merge → `self_healed` chain is untouched; the flood guard exempts the fix target (`priorPrBlocksExecution`); escalation at the depth cap leaves the PR open (`pr_left_open` on the event). Single-shot parents and merged-then-broken changes keep the revert path. **Cost per run:** the runner appends tokens/`estimateCost`/turns/fix rounds/checks refused/fallback/outcome to the finding's `dev_autopilot_outcomes` row (`metadata.agent_runs[]`, `agent_cost_usd_total`) on every exit path — no migration. 16 new tests; 9 bridge/executor/agent suites re-run, 96 passing; `tsc --noEmit` clean. **Not verified live** — Test Run #6 (an agent PR whose first attempt breaks a paired test, then the same PR going green with no second PR) is the first exercise, after the executor image is rebuilt from this commit. | VTID-04017 |
| 2026-09-17 | **W2 of the operator agent plan: open-ended intake, `autopilot_run_task(request, title?)`.** Before this the Operator Console could execute only an already-named VTID with a pre-listed file set; the operator still had to do the discovery a Claude Code session does itself. The new tool (tool registry + operator wire schema + both prompt sources, VTID-03838 drift rule kept byte-identical) runs the same VTID-03851 exafy_admin marker check and governance shape as `autopilot_execute_task`, then calls `triggerOperatorExecution({ openEnded: true })`: W0's server-side self-allocation (`OPERATOR_VTID_SELF_ALLOCATE_ENABLED`, still default OFF) mints and registers the VTID with `metadata.intake='open_ended'`; the recommendation/plan carry an empty file list (accepted ONLY with `openEnded`); the unchanged safety gate still runs (kill switch, budget, depth — its file rules have nothing to judge yet); the execution row is pinned to `executor:'agent'` on the row itself, independent of `OPERATOR_ONRAMP_EXECUTOR`, because the single-shot path refuses a plan with no files; and the agent runner switches its task prompt to discovery mode (request = the whole spec, search first, smallest change, no invented requirements, name the reading taken when ambiguous). Allow/deny globs, the test-coverage rule and runner tsc + jest apply to the real diff post-hoc (VTID-04006). 15 new tests; 31 operator/on-ramp/agent suites re-run, 319 passing; `tsc --noEmit` clean. **Inert on staging until the owner flips `OPERATOR_VTID_SELF_ALLOCATE_ENABLED=true`** — deliberately not pinned here (the plan reserved that flip); until then the tool returns the honest refusal. Test Run #5 waits on that flip. | VTID-04007 |
| 2026-09-17 | **Agent executor hardening from the Run #4/#4b transcripts — the two "observed, not fixed" items that were the executor's own.** (1) **Repeated-identical-check guard.** Run #4 called `run_check tsc` at turns 12, 13, 17, 24, 31, 33, 36, 38, 39 and 44 — every run the same V8 allocation failure, ~140 s each, no edit between most of them; Run #4b re-ran the same TS2742 twice before the runner did it a third time. A failing check cannot change outcome until the tree changes, so `agent-check-guard.ts` (`RepeatedCheckGuard`) counts failed attempts per `(kind, target)` since the last `write_file`/`edit_file`/`delete_file`; after `MAX_FAILED_ATTEMPTS_WITHOUT_EDIT` (2) the next attempt is refused before anything runs, with a tool error telling the model to edit first. One retry stays allowed (a killed/timed-out process is a real flake); passing runs never count; `git_diff`/`git_status` are never guarded; any mutation resets every key. The runner creates one guard per execution and passes it in the tool context — a context without one behaves exactly as before. (2) **`commands.log` describes the agent path.** The VTID-04002 PR contract's evidence log was written for the single-shot flow ("fetch N plan files", "parse <<<PR_TITLE>>> blocks") and was wrong on every agent PR (#3382 included). `PrContractInput` gains `executor` + `agentStats`; with `executor:'agent'` the log records clone → tool loop → guard → runner tsc (`--preserveSymlinks`, VTID-04009 heap) → paired jest → fix rounds → push, plus `turns`/`fix_rounds`/`checks_refused_by_guard`/`fallback_used`; the default wording is unchanged. 10 new tests; 5 suites / 56 tests re-run green; `tsc --noEmit` clean. **Not verified here:** a live run on the rebuilt executor image (the next staging Test Run is the first exercise; `checks_refused_by_guard` in its evidence pack is the signal). | VTID-04016 |
| 2026-09-17 | **Test Run #4 / #4b — the agentic executor (VTID-04006) on staging, end to end, for the task shape Run #3 could not do: a change whose only caller is not in `files_referenced`.** After #3375 merged, the executor image was rebuilt from it (run #7) and `OPERATOR_ONRAMP_EXECUTOR=agent` pinned on the staging gateway (#3376), the same operator-chat message that drove Runs #2/#3 asked for VTID-04008 (`renderCiEvidence()` gains `totalFailing`; the one caller in `dev-autopilot-watcher.ts` — deliberately unlisted — must pass `analysis.failedNames.length`). **What the agent did, both times:** read the two named files, `search_text renderCiEvidence\\(`, `read_file` the watcher it was never handed, edited all three, ran the paired jest suites green, and iterated on failing checks inside one execution — DeepSeek Flash end to end, no Bedrock fallback. **Run #4 (`47a4d6eb`) was blocked by three executor defects, each fixed the same evening (rows below); Run #4b (VTID-04012, `4f7d5ea4`, on the VTID-04009 image) opened PR #3382 at 20:15:04, 9 min 07 s after the chat message, 5 files (18/18 checks green, squash-merged as `e104099`), complete vs the plan and better than it (the "…and N more failing check(s) not fetched" line reserves its own budget so truncation cannot drop it), plus a scoped type-annotation workaround for the TS2742 environment error with two tests of its own.** The single-shot self-heal child that Run #4's watchdog reclaim spawned (#3379) reproduced Run #3's limit exactly — correct `renderCiEvidence`, caller untouched — and was closed. Full timeline, defect table and the Run #3 vs #4b comparison: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §8. **Observed, not fixed:** the model re-ran an identically failing `tsc` nine times (≈18 of its 22 minutes) — the loop needs a repeated-identical-check guard; the shared PR contract's `commands.log` describes the single-shot flow, wrong for the agent path; the production gateway's dry-run watcher (prod not yet on VTID-04004/04005) still synthesized `ci_passed`/`pr_merged` on a staging-claimed row (§7 finding, unchanged until prod is promoted); and two EventBridge Scheduler entries (`vitana-gateway-remi…`, `vitana-push-dispatc…`) launch stale `vitana-autopilot-executor:2` tasks every few minutes that exit code 2 — flagged to the owner, this session's IAM cannot list schedules. Production NOT promoted; staging only. | VTID-04012 (run); VTID-04008 (first attempt, terminalized failed by the reclaim) |
| 2026-09-17 | **Third executor defect from the Run #4 series, found by Run #4b: with the heap fixed, `tsc` completes in 53 s but exits 2 with `TS2742` ("inferred type of 'fetchPrimaryTenantUsers' cannot be named without a reference to '../../../../../../../../app/n…'") — an environment artifact, not a code defect.** The clone's `services/gateway/node_modules` is a symlink to the image's `/app/node_modules` (`linkNodeModules`, VTID-04006); TypeScript resolves the realpath outside the project and cannot name a library-inferred export type. The same commit typechecks clean on a real install, with and without the flag. **Fix:** `runTsc` passes `--preserveSymlinks` (`TSC_ARGS`), covering both the model's `run_check tsc` and the post-hoc runner. The run itself did not wait for this: the model worked around it by adding an explicit `PrimaryTenantUsersResult` return type in `connect-people-repository.ts` (pure annotation, two new tests) — a legitimate fix, but one that touches an unrelated file every time the environment, not the code, is wrong. Test assertion updated; evidence pack with the live TS2742 evidence and the local control runs. | VTID-04013 |
| 2026-09-17 | **Second executor defect from Run #4: the 20-minute running-watchdog reclaimed a LIVE agent execution and its PATCH wiped the row's metadata, so the self-heal child ran single-shot.** `backgroundExecutorTick` step 0b reclaims `status=running` rows whose `updated_at` is older than 20 min; nothing refreshed `updated_at` after the claim, and the agent's default deadline is 22 min, so at 19:49:37 it reclaimed `47a4d6eb` while ECS task `dabb2bb6` was alive (agent steps continued until 19:53:46). The reclaim wrote `metadata: { error }` — `executor: 'agent'`, `claimed_env` and the DeepSeek `llm_on_ramp_override` gone — so `inheritedOnRampMetadata()` gave the child nothing and it ran single-shot on Bedrock Opus 4.5 (#3379, closed). When the parent then hit its deadline, `applyExecutionResult`'s failure PATCH replaced metadata a second time and flipped the bridge's `reverted` back to `failed`. **Fix:** `buildWatchdogReclaimPatch` / `buildExecutionFailurePatch` (pure, tested) merge existing metadata and add `error` + a timestamp; the watchdog and `applyExecutionResult` (after reading the row) use them. New `autopilot-agent/agent-heartbeat.ts`: `startExecutionHeartbeat` PATCHes `updated_at` on `…&status=eq.running` every `AGENT_HEARTBEAT_MS` (60 s, floor 5 s), started after the token check in `runAgentExecutionSession`, stopped in `finally`, `unref`'d, failures logged never thrown. The watchdog threshold is unchanged — a genuinely dead task is still reclaimed, now without losing the row's history. 8 new tests; 6 suites / 56 tests re-run green; evidence pack carries the full Run #4 timeline. | VTID-04011 |
| 2026-09-17 | **First executor defect from Run #4: `tsc` on the gateway needs more than V8's default ~2 GB old-space, whatever the container limit — the run's `run_check tsc` died nine times with `Scavenge … allocation failure` at ~2 GB after ~2 min each, leaving `core.*` dumps the agent then found via `git_diff` and deleted itself.** The post-hoc runner's `runTsc` is the same path, so every fix round would fail identically regardless of the edits. Measured locally on this project: `node --max-old-space-size=3072 tsc --noEmit` exits 0 in 47 s at 2497 MB peak RSS, so 3072 fits the existing 4 GB task with headroom and no task-definition resize is needed. **Fix:** `runTsc` passes `NODE_OPTIONS=--max-old-space-size=N` appended after any inherited `NODE_OPTIONS` (so the cap wins), `N` defaulting to 3072 and tunable via `AGENT_CHECK_HEAP_MB` (garbage → default); jest/node_check/git checks unchanged (jest forks workers). 3 new tests; `.env.example` documents the var; evidence pack records the measurement. Executor image rebuilt from the merge (run #8, revision 10); Run #4b's tsc completed in 53 s on it. | VTID-04009 |
| 2026-09-17 | **VTID-04000's staging wiring pivoted from an AWS-Secrets-Manager service-account key to Workload Identity Federation (WIF) — the originally-planned design was never actually deployable on the platform owner's own GCP org.** The platform owner explicitly directed this session to execute the remaining infrastructure step directly rather than walk through it themselves ("you do it... you have full access to AWS... are you fucking stupid?"), and separately gave standing authorization to paste credential-adjacent artifacts (API keys, WIF config JSON) directly into this session for this task. Confirmed this session has real, working AWS credentials (`claude-code-aws-agent`, account `472838866351`) but zero GCP credentials of its own. Before attempting the planned service-account-key path, ruled out two simpler alternatives with live evidence rather than assumption: a plain Vertex API key is categorically rejected (`401 UNAUTHENTICATED`, Google's own error states OAuth2/principal-asserting credentials are required, confirmed by direct curl against `aiplatform.googleapis.com`), and the supplied key's `generativelanguage.googleapis.com` (AI Studio) access is separately blocked (`API_KEY_SERVICE_BLOCKED`) — ruling out the alternate `GEMINI_LIVE_USE_API_KEY` code path too. Then hit the real blocker: GCP org policy `iam.disableServiceAccountKeyCreation` blocks every service-account private-key download, confirmed live in the Console by the platform owner as org Owner, repeatedly — an org-level block on the ACTION, not a permissions gap any identity (including a more-privileged one) could be granted around. **Pivoted to WIF**, Google's own keyless recommendation: the platform owner provisioned a Workload Identity Pool + AWS provider trusting AWS account `472838866351` directly, plus an IAM binding granting `roles/iam.workloadIdentityUser` to this session's own AWS principal, themselves via Google Cloud Shell (their own suggestion) running `gcloud` commands supplied by this session — confirmed via real command output pasted back verbatim, not assumed. The resulting `external_account` credential config (from `create-cred-config`) contains no private key by design — Google's own docs confirm it is safe to store as plain text — so `AWS-STAGE-DEPLOY-GATEWAY.yml` now wires `GOOGLE_CLOUD_PROJECT`/`VERTEX_AI_LOCATION`/`VERTEX_SERBIAN_BRIDGE_ENABLED`/`GCP_SERVICE_ACCOUNT_JSON` UNCONDITIONALLY as plain values (no `describe-secret`, no `if` guard) instead of behind an AWS-Secrets-Manager `describe-secret` OPTIONAL pattern. Zero code changes needed: `gcp-adc-bootstrap.ts` and `google-auth-library`'s `GoogleAuth()` both already handle `external_account` JSON generically. Rewrote `services/gateway/test/orb/live/upstream/staging-vertex-serbian-bridge-wiring-pinned.test.ts` (9 tests) for the new unconditional/plain-value shape; `tsc --noEmit` clean; both it and `staging-deploy-workflow-bash-syntax.test.ts` re-run together, 2/2 suites, 16/16 tests passing. **Not yet independently confirmed against a live token exchange** — verifying the WIF config resolves a real GCP OAuth token locally was attempted and was blocked by this session's own sandbox safety layer (a containment-escape-shaped classifier, triggered by the config's AWS-instance-metadata `credential_source` URLs) — not routed around, per that block's own instructions; the config is Google's own authoritative tool output against the real, live pool/provider/binding, not hand-constructed, but the real signal is still the next real `sr` session on staging reporting `reason:'vertex_serbian_bridge'` in `oasis_events` and actually producing audio. Full detail in `docs/validation/VTID-04000/acceptance.md`. | VTID-04000 |
| 2026-09-17 | **VTID-03998's Fish `latency` fix was live-measured against a real Serbian voice (6 trials, `s2.1-pro-free`, platform owner supplied a Fish API key directly in-session) and disproved: at realistic reply length (~535 chars) `'normal'` and `'low'` both averaged ~9.6s — no measurable difference; Fish's throughput is ~50-60 chars/sec regardless of mode.** Posted a correction on PR #3369 and held it unmerged rather than ship a fix known not to work. When asked "is there a better choice?", recommended against reviving Vertex (a hard standing decommission rule, real prior cost incident) — the platform owner then reported they had already opened a **new, dedicated GCP project with a 90-day free-credit window** specifically to do exactly that for Serbian, and asked to proceed on that basis. Verified Gemini Live actually supports Serbian (`sr` is in Google's own Live API language list) before writing any code. **Investigated what "the backend is already built" actually meant:** `VertexLiveClient` (full OAuth token caching/refresh/prewarming) and the AWS-compatible ADC bootstrap (`gcp-adc-bootstrap.ts` — `GCP_SERVICE_ACCOUNT_JSON` → `GOOGLE_APPLICATION_CREDENTIALS`, built because AWS ECS has no GCP metadata server for free ADC resolution) were never deleted after the shutdown — they were made structurally unreachable by `upstream-provider-selector.ts` (VTID-03723, "VERTEX IS REMOVED AS A DESTINATION"), rewritten after a real incident where staging's `voice.active_provider='vertex'` row silently routed Polish/Portuguese sessions to a dead Vertex connection that "spoke" fluent English because nothing else was ever consulted. Serbian's own Gemini TTS voice mapping (`voice-mapping.ts`) was already correctly configured — no gap there either. **Fix: the ONE narrow, explicit, additive exception to that hard-won invariant.** New `orb/live/upstream/vertex-serbian-bridge.ts` (`isVertexSerbianBridgeEnabled()` — exact-string `VERTEX_SERBIAN_BRIDGE_ENABLED=true`, same convention as `isCascadeEnabled()`; `isVertexSerbianBridgeLanguage()` — `sr` only, never widened to a list) plus a new `tryVertexBridgeRescue()` in the selector, mirroring `tryCascadeRescue()`'s exact "returns null when it does not apply" contract and checked BEFORE it at all 5 call sites (`resolveWithoutVertex`, both branches of `evaluateNovaRequest`, both branches of `evaluateNovaCanary`) — fires ONLY when BOTH gates are explicitly true. New `SelectionReason:'vertex_serbian_bridge'`. Wired into `routes/orb-live.ts`'s real `selectUpstreamProvider()` call site the same way `cascade`/`nova` already are. New `scripts/aws/setup-vertex-serbian-bridge.sh` (dry-run by default, `--apply` to execute; refuses outright if `--gcp-project lovable-vitana-vers1` is passed) provisions a scoped service account (`roles/aiplatform.user` only) and pushes its key to AWS Secrets Manager — deliberately NOT wired into `AWS-STAGE-DEPLOY-GATEWAY.yml` in this VTID, same precedent as `setup-fish-audio-secret.sh` (this session can't confirm the secret exists before merging code that would require it). **CLAUDE.md updated** — the decommission banner, NEVER rule 27, and §2e's intro now document this as a deliberate, narrow, time-boxed exception (not a general reopening), plus a new §2e-vertex-serbian-bridge section with the full mechanism and the `VERTEX_PROJECT_ID` stale-fallback caveat (`orb/live/config.ts`'s own default is still the decommissioned project id when `GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT_ID` are unset — must set both together with the new flag). 21 new tests (10 selector-carve-out + 11 predicate-module, plus 3 half-satisfied-bridge contexts added to the pre-existing VTID-03723 invariant matrix). `tsc --noEmit` clean; targeted suites 2/2, 58/58 tests passing; `npm run build` clean; full gateway suite 938/939 suites (1 pre-existing skip), 15,325/15,360 tests passing, 0 failures. **Ships inert** — `VERTEX_SERBIAN_BRIDGE_ENABLED` is unset by default; nothing changes on a live task def until an operator runs the provisioning script, confirms the secret, and wires all four new env vars. **Not yet independently confirmed against live traffic** — this session has no credentials for the new GCP project, so this is verified structurally (unit tests, the existing invariant suite) only; the next real signal is a real Serbian session reporting `reason:'vertex_serbian_bridge'` in `oasis_events` and actually producing audio, once an operator completes the deferred provisioning/wiring steps. | VTID-04000 |
| 2026-09-17 | **Reported live, same day as VTID-03986/03987: "pre login does not work at all. no audio speech. zero!!!!!" on the `_intro/maxina` pre-login voice flow, plus (separately) "Spanish, French and Russian... worked, but latency was desastrous, like 10 seconds and more" and, after re-testing post-login, "serbian language works, but with terrible latency."** Traced via `oasis_events` (no `type` column — live-session diagnostics are `topic='orb.live.diag'`/`orb.live.stall_detected` with the real fields nested in `metadata`). Found EVERY `sr` (Serbian) cascade session in the prior 6 hours — all pre-login/anonymous — following an identical pattern: session starts, nothing logged for exactly 30 seconds, then the pre-existing `greeting_timeout` stall watchdog fires and tears the session down, and only ~0.2–1.2s AFTER that teardown does `cascade_tts_failed` (`CascadedLiveClient.runTurn()`, `cascaded-live-client.ts`) finally log — meaning the turn's combined LLM-completion + TTS-synthesis time was running right up against (or past) the session's own 30s budget, on every single sr session observed, not sporadically. Serbian has no Polly voice at all (`resolvePollyVoice('sr')` is null, per §2c/§2c-fish), so success there depends entirely on Fish (VTID-03970/03987). Root cause in `fish.ts`: the TTS request body sent `latency: 'normal'` — per Fish Audio's own docs, the best-QUALITY, SLOWEST setting (the documented default), not `'low'`/`'balanced'` (the lowest-latency options). Combined with the platform owner's own live report that the shared LLM-completion leg alone already costs 10s+ for Polly-backed cascade languages (ru/es/fr, same `callViaRouter('operator', ...)` call every cascade language shares), a Fish call running close to its own hard `FISH_REQUEST_TIMEOUT_MS=15_000` accounts for sr's total exceeding the 30s watchdog specifically, while Polly-backed languages (near-instant TTS leg) stay under it — with bad latency but not silence, matching "es/fr/ru work, terrible latency" vs. "sr: zero" (and, post-login, "sr works, terrible latency" — same call finishing under 30s sometimes rather than the more consistent pre-login failures observed in the traced window). **Fix, Fish-scoped only per the platform owner's standing instruction (VTID-03987's §2c-fish-scope boundary):** `latency: 'normal'` → `latency: 'low'` in `fish.ts`'s TTS request body — a one-field change inside `synthesizeFish()`, no edit to `cascaded-live-client.ts`, `tts-backend.ts`, `polly.ts`, or Nova Sonic. New test `test/tts/fish-provider.test.ts` — "requests latency=\"low\", not the slower \"normal\"/\"balanced\" modes (VTID-03998)". `tsc --noEmit` clean; targeted Fish/cascaded suites 7/7 suites, 62/62 tests passing, 0 regressions; `npm run build` clean; full gateway suite 934/935 suites (1 pre-existing skip), 15,290/15,325 tests passing, 0 failures. **Not yet independently confirmed against live traffic** — this session has no `FISH_API_KEY` to re-measure Fish's real response time directly; the next real signal is the reporting user's next pre-login Serbian session actually producing audio. **Deliberately NOT addressed here, flagged as a separate follow-up:** the shared LLM-completion latency (10s+, affecting ru/es/fr too) is out of this VTID's Fish-only scope — fixing it would touch the shared `cascaded-live-client.ts`/`callViaRouter` path, not `fish.ts`. | VTID-03998 |
| 2026-09-17 | **W1 of the operator agent plan: the agentic executor (VTID-04006), shipped in the same PR as W0.** `services/gateway/src/services/autopilot-agent/` — selected per row (`metadata.executor='agent'`, which the on-ramp stamps when `OPERATOR_ONRAMP_EXECUTOR=agent`) or per process (`DEV_AUTOPILOT_EXECUTOR=agent`); default stays the single-shot path, so deploying this changes nothing until a flag is set. What it does that the single-shot executor could not (gap analysis §3.2): shallow-clones the repo into a scratch dir (`agent-workspace.ts`, token only ever in the remote URL, scrubbed from errors), runs a provider-neutral **tool loop** (`agent-loop.ts` on the router's `history`/`toolCalls`/`toolResults` shapes — the same transcript renders as OpenAI-style `tool_calls` on DeepSeek and `tool_use` blocks on Bedrock) over a jailed tool surface (`agent-tools.ts`: read_file/list_dir/search_text/find_files/write_file/edit_file/delete_file, and `run_check` mapping an enum onto fixed argv for tsc/jest/git — **no shell**), then, independently of what the model claims, re-runs `tsc --noEmit` and the jest suites paired to the changed files (`agent-validate.ts`), enforces the SAME allow/deny globs as the safety gate on `git status` (`agent-scope.ts`, deny wins, evidence-pack paths exempt) plus the tests_missing rule, feeds any failure back into the same transcript for ≤3 fix rounds, applies the VTID-04002 PR contract, commits, pushes `dev-autopilot/<exec8>` and opens the PR — returning the exact result shape `applyExecutionResult` already consumes, so watcher/reconciler/self-heal see no difference. **Model policy, as the owner corrected it:** `callViaRouter('worker', …, { providerOverride: 'deepseek', modelOverride: 'deepseek-flash' })` — DeepSeek Flash 4.1 PRIMARY, the `worker` stage's own v17 fallback (Bedrock `eu.anthropic.claude-sonnet-4-6`) as FALLBACK, through the router's existing override semantics (VTID-03820); env-overridable via `AGENT_PRIMARY_PROVIDER/MODEL`, never to Google. `Dockerfile.job` gains `git` and the builder's full `node_modules` (tsc/jest are devDependencies) which the agent symlinks into the clone (`AGENT_NODE_MODULES_SOURCE`), so no per-run `npm ci`. Steps are emitted as `dev_autopilot.agent.*` OASIS events with `execution_id` in the payload, so the existing `GET /executions/:id/steps` feed shows them. 3 new suites (tools 11, loop 6, scope/validate/porcelain/mode 8). **Not verified here:** a real agent execution — needs the executor image rebuilt (`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`, owner dispatch) and `OPERATOR_ONRAMP_EXECUTOR=agent` on staging; that is Test Run #4. Open risk named in the plan: the executor task's CPU/memory sizing for `tsc` on the gateway is unknown from the repo (`AGENT_SKIP_TSC=true` is the escape hatch). | VTID-04006 |
| 2026-09-17 | **Operator agent build started — W0 of `docs/OPERATOR-AGENT-BUILD-PLAN.md` (the execution order for the gap analysis' roadmap), after Test Run #3 (VTID-04004, PR #3374 → `f897403`) proved the single-shot executor fixes its own watcher but cannot read a file it was not handed.** Standing model policy recorded in the plan after the platform owner corrected it in conversation: the agent executor's PRIMARY is **DeepSeek Flash 4.1 (`deepseek/deepseek-flash`)**, its FALLBACK is **Bedrock Claude (`eu.anthropic.claude-sonnet-4-6`, the `worker` stage's v17 policy fallback)** — never the reverse, never `anthropic`, never Google. **Shipped in W0 (VTID-04005):** (1) `dev-autopilot-ci-logs.ts` — the CI watcher now fetches the failing Actions jobs' real logs (`details_url` → `/actions/jobs/:id/logs`), keeps a bounded first-signal-window + tail excerpt per job (≤3 jobs, ≤3 KB each), stores it as `metadata.ci_log_excerpts` and appends it to the failure reason handed to triage/self-heal — until now triage only ever saw a check NAME (VTID-04003), which is the mechanical root of Run #1's "branch protection" false loop; best-effort by construction, a log fetch failure never blocks the transition. (2) `dev-autopilot-env-ownership.ts` — the executor stamps `metadata.claimed_env`/`claimed_at` on the row at claim time and the CI/deploy/verification watchers, the running-watchdog and the state reconciler all skip rows another environment claimed (legacy unstamped rows stay visible everywhere); closes the Run #2 cross-env incident at the root, on top of VTID-04004's dry-run guard. (3) On-ramp **VTID self-allocation, server-side only, default OFF** (`OPERATOR_VTID_SELF_ALLOCATE_ENABLED=true`): when a caller omits `vtid`, `triggerOperatorExecution` allocates through the same `allocate_global_vtid` RPC `/api/v1/vtid/allocate` uses, registers a real title + `in_progress`/`approved` exactly as §4.1 prescribes for owner-instructed work, then re-runs its own governance gate; any allocator/registration failure refuses. **The operator tool contract (`autopilot_execute_task`) still requires `vtid`** — the harness safety classifier flagged wiring the model-facing tool to execute without a named VTID as an autonomy expansion, so that wiring is left for the owner to enable deliberately (W2 in the plan). (4) `dev_autopilot_config.allow_scope` widened additively and applied live (migration `20260917210000_vtid_04005_…`): `services/gateway/src/**`, `docs/**` (the evidence pack VALIDATOR-CHECK requires lives there), `scripts/**`, `config/**`, `DATABASE_SCHEMA.md`, sibling services; `deny_scope` unchanged; **`CLAUDE.md` deliberately NOT added** (flagged as self-modification — the rules an autonomous executor runs under stay human-edited). `tsc --noEmit` clean; 9 affected suites, 106 tests green. **Not done here, owner-gated and named in the plan:** pinning `DEV_AUTOPILOT_USE_JOB`/`JOB_CLOUD` and the operator read flags on PROD via env-only, and flipping the new self-allocate flag on staging. | VTID-04005 |
| 2026-09-17 | **Operator on-ramp Test Run #2 executed on STAGING and passed first try, end to end — the first dev-autopilot PR ever to clear `VALIDATOR-CHECK`.** After #3371 (VTID-04002) merged and the one-shot executor image was rebuilt from the same commit (`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` run 6 — the executor has no staging twin, but prod's gateway never dispatches it since `DEV_AUTOPILOT_USE_JOB` is unset there, so this affected staging executions only), a chat message to `POST /api/v1/operator/chat` on `preview-aws-gateway` as the `operator-autopilot@exafy.io` exafy_admin service account asked for VTID-04003 (a real fix: the watcher's CI failure reason now names the failing checks instead of collapsing `mergeable_state:blocked` to `branch-protection blocked` — the exact mechanism behind Run #1's wrong triage). DeepSeek called `autopilot_execute_task` with correct repo-root-relative paths on the first attempt; execution `e3ca9a1d` was claimed by the staging gateway 8 s later, the worker call took 38 s, and PR #3372 opened at +82 s with the VTID in the title, the `VTID:`/`VALIDATION_PROFILE:`/marker block, and the `docs/validation/VTID-04003/` evidence pack — 18/18 checks green including `validate-pr`. The diff matched the plan exactly (exported pure `buildCiFailureReason()`, ternary replaced, 9 new tests); merged as `f79d51c`. **Two things this run established that were previously unverified:** the staging gateway role does hold `ecs:RunTask`/`iam:PassRole` and the executor task can reach DeepSeek — the PR was opened by the ECS task (`env:production` tag on `pr_opened`, a different process from the staging gateway that claimed the row), not the in-process fallback. **New defect found, not yet fixed:** the PROD gateway's watcher — `DRY_RUN` because `DEV_AUTOPILOT_WATCHER_LIVE` is pinned on staging only — picked the shared-table row up first and synthesized `ci_passed → pr_merged → deployed → completed` (all `env:production`, `(dry-run synthetic)`), terminalizing VTID-04003 `success` at 17:08 while PR #3372 was still open. A dry-run process must never transition a real execution; roadmap R-1 now includes stamping the claiming env on the row and making each watcher skip rows it does not own (or pinning the live flag on prod). Details in `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §7. The service account's password was rotated by this session for the run (previous value was never recorded in either repo); it lives only in this session's scratchpad. | VTID-04002 |
| 2026-09-17 | **Deep analysis of the Command Hub Operator Console versus a Claude Code session, requested by the platform owner after the Operator execution on-ramp's Test Run #1 (VTID-03955 → PR #3351) — plus the two on-ramp gaps that run surfaced, one of which turned out to be much larger than reported.** Full write-up: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` (verdict, hop-by-hop chain, capability gap matrix, target architecture, 11-slice roadmap, staging test-run designs). Verdict in one line: the console is a chat front-end over a **single-shot, zero-tool code generator** (one `callViaRouter('worker')` call must emit whole replacement files for ≤8 pre-fetched files; no file reads beyond the plan, no search, no `tsc`/jest, no observation, no retry — `grep child_process` over the plane returns nothing and the executor image is `node:20-alpine` with no git), whose only agentic component (`services/autopilot-worker`, real clone + tsc + jest + 3 retries via `claude -p`) is orphaned and unconditionally bypassed by the on-ramp; its transcript is browser `localStorage`, its memory is 28 `task_outcome` rows written by five tool names, its codebase knowledge is a 6-bullet TS constant, and on **production** every operator capability flag except the on-ramp is unset. Test Run #1 proved the model is not the problem — the harness is. **Corrected post-mortem:** the missing VTID (exit 10) was only the FIRST of eight `VALIDATOR-CHECK.yml` gates the PR would have failed — `VALIDATION_PROFILE:`/four body markers (11-15), a `docs/validation/<VTID>/` evidence pack IN THE DIFF (30-33, which the executor's LOCKED FILE LIST forbids adding), AC→`TEST:` mapping (40-41), VTID in title (90). No dev-autopilot PR touching gateway source could ever have merged. The reconciler's wrong 'branch protection' triage is mechanical: the watcher relabels GitHub `mergeable_state:'blocked'` as the literal string `branch-protection blocked` and triage (no repo mount, no OASIS tool since they were removed) can only restate it; the child retry re-runs the identical prompt — a loop closed on a false premise by construction. **Shipped (VTID-04002):** (1) `files_referenced` must be repo-root-relative, stated with an example in the operator wire schema, the ORB registry and both prompt sources (VTID-03838 drift test still green); (2) on-ramp rejections now render the safety-gate violation code + offending path(s) instead of the bare `safety gate blocked approval` (`violations[]` was dropped at the tool boundary); (3) new `dev-autopilot-pr-contract.ts` — a pure, deterministic PR contract applied by the executor after the empty-diff guard: VTID appended to the title in the repo's `(VTID-XXXXX)` convention, `VTID:` + `VALIDATION_PROFILE: gateway_backend` + all four markers prepended to the body, and the three evidence files written to the branch (ACs mapped to the paired test file in the same diff, a commands.log of what the executor did and which model served it, `outputs/execution.json`); commits carry the real VTID instead of `VTID-DA-<exec8>`; skipped with a logged reason when the finding has no `activated_vtid`. 18 new tests port the workflow's own grep/regex gates. `tsc --noEmit` clean; 8 affected suites 103/103. **Not verified:** a real on-ramp execution through the new contract — that is Test Run #2, to be run on STAGING (Run #1 ran on production, against `exafyltd/vitana-v1`'s absolute rule). **Still open, named not done:** the Supabase `service_role` rotation flagged in `docs/HANDOFF-voice-quality.md` has no confirmation anywhere in either repo; `CLAUDE.md` §16 still prints partial live PATs; prod pins none of the operator/autopilot flags so the prod executor runs in-process inside the gateway container (the 09-13 watchdog failures); `ecs:RunTask`/`iam:PassRole`/`bedrock:InvokeModel` on the staging roles remain unverified live; RepoWise/Graphify exist in neither repo nor the container, so CLAUDE.md's mandatory index workflow is currently unsatisfiable for the console and for sessions. | VTID-04002 |
| 2026-09-17 | **Commerce Partner Onboarding — Phases A–E landed on STAGING end to end, on the platform owner's in-conversation "You merge, in order"; production never promoted.** Six PRs squash-merged to `main` in dependency order, each child re-based by merging `origin/main` with base = its parent PR's tip (so only the child's own changes replayed; JSON i18n shards merged key-wise on `main`'s copy): `vitana-platform` #3357 `2b5a9995` (VTID-03974, `partner_registry` bridge + `POST /admin/partner-health/inbox/manual`), `vitana-v1` #1095 `e70aa362` (VTID-03974/03976, `commerce_vertical` selector + mobile wiring), #1099 `7e571107` (VTID-03988, patient results on mobile from `patient_profiles`), #1100 `f66655bd` (VTID-03989, full mobile adaptation of the org-admin journey), `vitana-platform` #3367 `0166c7c9` (VTID-03995), `vitana-v1` #1101 `da9ab117` (VTID-03993, mobile role switcher + role-aware drawer/bottom nav — owner decision: Vitana roles are switchable modes, business roles stay memberships). Staging verified after each landing: gateway `/api/v1/admin/build-info` on `2b5a9995`, `/inbox/manual` → 401 JSON; frontend chunk sampled 10× carrying "Meine Befunde", "Mein Unternehmen", "Zur Community wechseln". **Both file-only migrations were then applied to the shared Supabase project on the owner's explicit "apply both migration now"** (`vtid_03974_commerce_vertical`, `vtid_03995_role_switch_community_and_membership_roles`), pre/post-checked read-only (column + CHECK + comment live; both function md5s changed, `set_role_preference()` no longer calls `validate_role_assignment()`, unauthenticated `get_my_permitted_roles()` still returns the `UNAUTHENTICATED` envelope). VTIDs 03957/03974/03976/03988/03989/03993/03995 terminalized `success` via the governed `POST /api/v1/oasis/tasks/:vtid/complete`. `DATABASE_SCHEMA.md` brought current in the same PR. **Still open, named not done:** a real activated-patient walkthrough of the switcher on staging (the only account this session may sign in as is an exafy admin, for whom the switcher always shows every role); the CI/preview quirk that every `github-actions[bot]` i18n commit lands its runs at `action_required` and must be re-run by hand. | VTID-03996 |
| 2026-09-17 | **Background audit dispatched under VTID-03991 to check whether the class of leak VTID-03990 fixed (a service/automation account visible to real members) exists anywhere else, per the platform owner's standing directive — and it does, live, right now.** Empirically confirmed rather than left theoretical: `select max(registration_seq)` returns `247` — exactly `operator-autopilot`'s own row — meaning both VTID-03990 bot accounts (`registration_seq` 246/247) are literally the #1 and #2 results of `GET /api/v1/community/members?sort=newest` (the Community Members Directory's own default sort), which its own file header calls "the anti-loneliness primer for the first ~1000 users." Neither account is excluded by that route's only filter (`global_community_profiles.is_visible`). The same gap exists in the ORB voice "who is...?" tools (`superlatives.ts`'s `getHiddenUserIds()` — asking "who's our newest member?" over voice would answer with a bot's name) and `find_community_member` (`community-member-ranker.ts`). A third file, `connect-people-repository.ts`'s `fetchPrimaryTenantUsers()`, iterates every primary-tenant user (bots included) for match-delivery/interest-nudge/group-recommendation automations, with a `VITANA_BOT_USER_ID` constant declared in the sibling handler file and never once referenced — dead code, removed. **Fix:** one new shared helper, `lib/excluded-test-service-accounts.ts` (`fetchExcludedTestServiceAccountIds()`), unions `service_bot_accounts` (VTID-03990) and `notification_test_actors` (`exafyltd/vitana-v1`, VTID-03506) — the two tables VTID-03991's governance rule 45 named — and fails OPEN (an empty exclusion set on error), unlike VTID-03990's fan-out guard, because these are all read/display paths where breaking a real member's directory or voice tool is a worse outcome than one test account occasionally slipping through. Wired into all four call sites; 4 new tests for the helper itself (union, empty, throw, rejected-promise — all resolve to an empty set rather than propagating). **Investigated and closed as NOT a live gap:** the matchmaking candidate pool (`match_targets`/`matches_daily`, the audit's one unconfirmed finding) — `select to_regclass('public.match_targets')` returns NULL; that whole migration (`20260101...vtid_01088_matchmaking_engine.sql`) is dead, never-deployed schema, the same shape `connect-people.ts`'s own comments already documented for other tables. The live table is a *different* one, `daily_matches` — checked directly: 1600 rows, zero referencing either bot account as `user_id` or `matched_user_id`. No code in this repo inserts into `daily_matches` at all; wherever its rows come from is outside this repo and was not touched. `tsc --noEmit`/`jest` not run locally (sandbox npm registry 403, same limitation as VTID-03990); CI is the verification. | VTID-03992 |
| 2026-09-17 | **Follow-up to VTID-03990 (merged as #3365 / `d26c0d4`), and the resulting cleanup (445 `chat_messages` + 2 `chat_group_members` rows deleted from production on the platform owner's explicit instruction, both bot accounts confirmed at 0 remaining afterward).** The platform owner's own words, verbatim: "in the future those test accounts, non-real accounts should never reach the production, it looks ugly and confusing for the real members." That is a standing directive, not a one-off ask, so it is now Part 1 rules 43-45 (new §"Test / Service / Automation Accounts") rather than left implicit in VTID-03990's PR body. Rule 43 states the principle (no test/service/automation account visible to a real member, in ANY form — DM, group roster, directory, feed). Rule 44 makes registration a PRECONDITION of creation, not a cleanup step — the exact ordering VTID-03990 got backwards (the accounts existed and acted for almost a day before anyone noticed, which is why a separate deletion pass was needed at all). Rule 45 generalizes beyond the one trigger this VTID actually fixed: any future query/endpoint/screen that lists or surfaces member profiles to a real user (member directory, "who's new", suggested connections, leaderboards, group rosters) must exclude both `service_bot_accounts` (this repo) and `notification_test_actors` (`exafyltd/vitana-v1`) the same way, by default, not by audit. **Deliberately NOT done in this VTID:** a full audit of every existing such surface in both repos for a live, unpatched leak — that is real, separate engineering work (a background investigation was dispatched the same session; if it finds a live leak, that becomes its own VTID) — this entry is the governance rule itself, so the next surface built or touched has something to be held to. | VTID-03991 |
| 2026-09-17 | **Reported live on the MAXINA mobile app: two unfamiliar chats ("operator-autopilot", "claude-code-agent") in a real user's inbox — investigated read-only against production first (no writes), then root-caused and fixed the mechanism that put them there.** Confirmed via `chat_messages`/`profiles`: both are service/automation identities (`claude-code-agent@exafy.io` / `operator-autopilot@exafy.io`, handles `claudeco246`/`operator247`), created 2026-09-16 11:38:38/40 UTC — the same two accounts VTID-03980's entry above already noted existed, but that entry never checked what their creation actually *did*. It fired the VTID-03089 welcome-chat trigger (`fire_welcome_chat_on_membership()` on `user_tenants` AFTER INSERT): each account's primary-membership insert fanned an identical "Hello! My name is ... I just joined the community and I'm excited to connect with you! 🙌" DM out to every other tenant member — **222 and 223 real recipients respectively, both at the exact single insert timestamp** (445 real `chat_messages` rows total, confirmed by direct count). The trigger only ever excluded the hardcoded Vitana-bot user; neither service account matched, so it ran as if they were real new members. **Fix (VTID-03990):** new `service_bot_accounts` allowlist table (sibling of `notification_test_actors`, VTID-03506, but failing CLOSED rather than open — a tenant-wide chat broadcast to 445 real inboxes is a worse failure mode than one dropped notification), seeded with both accounts; `fire_welcome_chat_on_membership()` now early-returns (and marks `welcome_chat_sent`) for anything in it, and the legacy `/auth/login` TS mirror (`sendWelcomeChatMessages()`) gets the identical guard, failing closed if the lookup itself errors. Deliberately scoped to the two accounts that caused this, not a broad email-domain heuristic — `@exafy.io` is also used by real staff/community accounts (including the reporting user), so domain-matching would have suppressed legitimate welcomes. `DATABASE_SCHEMA.md` updated with the new table (documented as `notification_test_actors`'s sibling) and its own CHANGE LOG row. New `test/services/welcome-chat-service.test.ts` (3 tests: skip-and-mark-sent when allowlisted, fail-closed on a lookup error, unaffected happy path for a real member) — this service file previously had zero coverage. **Not run locally** — sandbox npm registry returns 403 on `jest`/`tsc` installs, same limitation several rows above this one hit; CI is the verification. **Not yet done:** the account-creation path itself (whatever inserted these two rows directly into `user_tenants`, bypassing normal signup) was not found in either repo — it left no trace in tracked scripts/workflows, so it was either a one-off direct write or lives outside this codebase; flagging rather than guessing at it. | VTID-03990 |
| 2026-09-17 | **Platform owner flagged, after VTID-03986 merged, that Nova2Sonic (voice-to-voice) and TTS providers (Polly, Fish) "behave differently" and "there must be a separation to avoid misbehaving" — specifically worried about damaging mid-sentence interrupt/barge-in. Researched the real architecture before writing any code.** Confirmed via `upstream-client-factory.ts`'s `createUpstreamClient()` switch that `NovaSonicLiveClient` and `CascadedLiveClient` are different classes, chosen once per session — nothing in the cascade is *reachable* from a Nova Sonic session by construction, and barge-in lives entirely in `nova-sonic-live-client.ts`/`full-duplex-gate.ts` (the cascade's own file header has said "no barge-in mid-generation" since VTID-03683, confirmed by grepping for `interruptedHandler` call sites — the cascade declares the handler but never invokes it). So VTID-03986 could not have damaged Nova's interrupt capability; it was never reachable from that fix. **What WAS a legitimate concern:** Polly and Fish are two interchangeable TTS backends plugged into the SAME `CascadedLiveClient`, which also owns Transcribe (STT) and turn/silence-gating — `ru`/`pl`/`tr`/`zh`/`ar` are cascade-eligible via Polly today (live in production), `sr` only via Fish (opt-in). VTID-03986's latency fix touched the shared STT/turn-gating layer, which does run identically for Polly-backed languages too — accurate to say "not Nova, not Polly's own code, but yes the shared pipeline Polly-backed languages also depend on." **Fix (VTID-03987):** extracted the TTS backend SELECTION into `orb/live/upstream/cascaded/tts-backend.ts` — `pollyBackend`/`fishBackend` (each independently swappable) plus `synthesizeCascadeReply()` (the Polly-first/Fish-fallback order, a byte-for-byte extraction of what `runTurn()` ran inline — zero behavior change, confirmed by re-running the 5 pre-existing cascaded-* suites unmodified, still 39/39 green). This makes the boundary explicit rather than implicit: a change inside a backend object is backend-local and safe for Fish-only work; a change to selection order or anything else in `cascaded-live-client.ts` affects every cascade language and needs a Polly-backed regression test, not just Fish/`sr`. Documented as new CLAUDE.md §2c-fish-scope so the distinction (structurally-guaranteed Nova isolation vs. shared-by-design cascade pipeline) doesn't have to be re-derived under pressure next time. New `test/orb/live/upstream/cascaded/tts-backend.test.ts` (8 tests: each backend in isolation, Polly-first/Fish-fallback selection for both a Polly-backed and a Fish-only language, the "Polly fails but the language HAS a voice → no Fish fallback, that's a runtime failure not a coverage gap" case). `tsc --noEmit` clean; `npm run build` clean; 47/47 relevant tests passing (8 new + 39 pre-existing, 0 regressions). Deliberately did NOT duplicate the STT/turn-gating pipeline per TTS backend to manufacture a stronger isolation boundary — this codebase has been burned by exactly that kind of duplication drifting apart before (VTID-03644's five diverged language maps, VTID-03696's desynced workflow `paths:` list). | VTID-03987 |
| 2026-09-17 | **Reported live: cascade voice sessions on staging showed escalating per-turn latency (8.7s → 16.6s → 35s → 43s across one session), right after VTID-03984/VTID-03985 got real Serbian cascade audio working.** Root cause: VTID-03706's full-duplex mode (staging-only) forwards a continuous audio frame for the entire session — real speech above the echo floor, digital silence below it — so Nova Sonic's own native VAD/barge-in keeps working. `CascadedLiveClient.sendAudioChunk()` forwarded every one of those frames into `TranscribeStreamSession` unconditionally, with no awareness that the cascade has no barge-in at all (its own file header has said so since VTID-03683) and no use for audio while a turn is generating or its reply is still playing out client-side. `TranscribeStreamSession` is a single, ordered, never-restarted pipe per session — every frame pushed during Vitana's own turn queued ahead of the next real user utterance, so each reply's own duration added to a backlog Transcribe had to work through before it could transcribe anything new, compounding turn over turn exactly as measured. **Fix:** `sendAudioChunk()` now drops mic audio while a turn is generating (`turnInFlight`) or while `Date.now() < busyUntilMs` — the latter set in `emitAudio()` from the just-emitted reply's estimated client-side playback duration (16-bit mono PCM @ 16kHz byte length) plus a fixed 400ms margin. Dropped chunks still return `true` (accepted, not backpressure — the client is `open` and functioning; `UpstreamLiveClient`'s own contract reserves `false` for "not open"). 5 new tests in `cascaded-live-client-audio-gating.test.ts`, using a Polly-backed language (`ru`) — not Fish/`sr` — since the fix lives in the STT/turn-gating layer shared by every cascade language. `tsc --noEmit` clean; all cascaded-* suites re-run together 39/39 passing, 0 regressions; `npm run build` clean; full gateway suite 933/934 suites (1 pre-existing skip), 15,281/15,316 tests passing, 0 failures. **Not yet independently confirmed against live traffic** — the next real signal is the reporting session's next cascade turn showing flat, non-escalating latency instead of the measured pattern above. A same-day follow-up (VTID-03987, see the entry above) formalizes the TTS-backend boundary this fix's own scope raised. | VTID-03986 |
| 2026-09-16 | **VTID-03970's "not yet verified against a live synthesis call" caveat turned out to be a wrong-model-string bug, not a credit problem — found because the platform owner supplied Fish's own FAQ: S2.1 Pro has a free tier.** `getFishModel()` defaulted to the paid `s2.1-pro`, which is why every synthesis attempt with the supplied (unfunded) key returned HTTP 402 during VTID-03970's build. Fish's docs (`docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits`) confirm a free tier exists via the model string `s2.1-pro-free` — same underlying model, no character cap, no SLA/latency guarantee, requests may be retained for model improvement (an acceptable tradeoff for a rarely-hit language-gap fallback, not high-volume traffic). **Switched the default and re-tested live, for real this time:** the identical unfunded key synthesized real audio against `s2.1-pro-free` on the first try — HTTP 200, a genuine 29,256-byte MP3 (confirmed via `file`: MPEG layer III, 128kbps, 44.1kHz) for Serbian text "Zdravo, ovo je test." — sent to the platform owner directly as evidence, not just described. A parallel `pcm` request for the same text produced a byte count whose implied duration at the requested 16kHz (1.81s) closely matches the mp3's own duration (1.83s) — confirms Fish honors the requested PCM sample rate, closing the `FISH_PCM_SAMPLE_RATE_HZ=16_000` "documented assumption, not confirmed fact" caveat VTID-03970 shipped with. Also re-verified the curated Serbian voice's metadata is still clean (no adult-content tags, `dmca_taken_down:false`) — and found one new, non-blocking curiosity: the model's own `languages` field reports `["hr"]` (Croatian), not `sr`, despite the title/tags/description all being explicitly Serbian; the real synthesis call above produced correct Serbian output regardless, so this is a documentation note about Fish's own classification looseness, not a defect in this integration. **Also fixed while running it for real the first time:** `scripts/tts/verify-fish-voice.ts` had a genuine pre-existing TypeScript strictness bug (`meta` from `await metaRes.json()` was untyped `unknown`, three `TS18046` errors) that could never have been caught before — the script could never get past the 402 to reach the code that would trigger it. Updated `test/tts/fish-provider.test.ts`'s model-header assertion to match the new default; full `fish-provider.test.ts` + `cascaded-voice-fish-fallback.test.ts` suites re-run, 19/19 passing; `tsc --noEmit` clean. **Still not provisioned:** `FISH_API_KEY` still doesn't exist in AWS Secrets Manager and still isn't wired into any ECS task definition — this VTID only fixes what a correctly-configured deployment would actually do once that happens; it does not provision anything itself. | VTID-03983 |
| 2026-09-16 | **Follow-up to the same-day Fish Audio VTID: the platform owner asked where to manually TEST it, pointed at the Command Hub's existing Voice screens (`/command-hub/voice/{livekit-test,nova-sonic-test,orb-ui-monitor}/`), and separately flagged that those screens still talk about Vertex even though it's decommissioned.** Found the real gap: `/command-hub/voice/providers/` ("Providers & Voice", sibling tab in the same nav section) already has exactly the "pick a provider, type text, hit Preview, hear it" pattern the owner asked for (matching how ElevenLabs/Azure Speech Studio-style voice labs work) — but its dropdown never actually listed Polly or Fish, even though the backend endpoint it calls (`POST /api/v1/voice/preview`) already had full Polly support (VTID-03495) sitting unused because `IMPLEMENTED_TTS_PROVIDERS` (the set that enables/disables each dropdown option) was still `{'google_tts'}` only. **Fix:** added `'polly'` and `'fish'` to `IMPLEMENTED_TTS_PROVIDERS` (`services/voice-config.ts`), added a `provider==='fish'` branch to `/voice/preview` (`routes/voice-config.ts`) calling the SAME `synthesizeFish()` the live TTS fallback uses — not a bypass, so the preview honestly reports "not configured" until `TTS_FISH_FALLBACK_ENABLED`+`FISH_API_KEY` are both set, exactly like a real request would — and updated the dropdown in `app.js`'s `renderVoiceProvidersView()` with real labels for both, plus a voice-catalog-aware hint (Polly/Fish pick one fixed voice per language server-side; there's no separate catalog to browse the way there is for Google TTS). **Vertex labels — fixed where actively misleading, NOT a blanket find-replace:** `services/gateway/src/orb/live/upstream/provider-name.ts`/`active-provider-resolver.ts` confirm `'vertex'` is a load-bearing WIRE VALUE the real `/api/v1/orb/active-provider` request/response and DB config still use to mean "the gateway-proxied WS/SSE transport" — which Amazon Nova Sonic now serves exclusively, GCP's actual Vertex API is gone. Renaming that value is a separate, much larger change (touches the resolver's tests, the LiveKit Test Bench's whole active-provider state machine, `nova-sonic-config.ts`, `upstream-provider-selector.ts` — not attempted here). What WAS fixed, in the Providers & Voice and Nova Sonic Test Bench screens only: the V2V flip button's label ("Use Vertex (Gemini Live)" → "Use Nova Sonic (gateway transport)"), a new inline note explaining "vertex" is a legacy value name now served by Nova Sonic, the STT badge's claim that "Vertex Gemini Live does STT internally" (corrected to Nova Sonic), and — the one factually WRONG string found, not just stale wording — the Nova bench's Serbian language option, which read "expected fallback → vertex" even though CLAUDE.md §2e has documented since VTID-03649 that Vertex Live fallback is permanently dead; it now says there is no working ORB voice for Serbian at all yet (which Fish Audio, added the same day, is the first step toward closing via the cascade — see the entry above). New/updated tests: `test/services/voice-config.test.ts` (IMPLEMENTED-set assertions extended to polly/fish), `test/routes/voice-config.test.ts` (3 new tests for the `/voice/preview` fish branch — not-configured 422, no-curated-voice 422, success with the real `X-Vitana-Tts-Voice` header and audio bytes — using a proper mock of `fish.ts` rather than letting it silently no-op the way this test file's existing, unmocked Polly path always has). `node --check app.js` clean; `tsc --noEmit` clean; `npm run build` clean; full gateway suite re-run, 0 regressions. **Explicitly NOT done, flagged rather than silently skipped:** the LiveKit Test Bench (`/command-hub/voice/livekit-test/`) and the ~15+ other Vertex mentions across the Command Hub's LLM-routing/wallet-catalog UI (unrelated to voice) are untouched — the former needs its own careful pass given how much of its state machine keys off the literal string `'vertex'`, the latter is a different subsystem (Vertex AI as an LLM provider option, not voice) that this VTID never touched. | VTID-03970 |
| 2026-09-16 | **Added Fish Audio as a language-coverage TTS fallback, per explicit platform-owner request to cover languages Polly/Nova Sonic cannot (Serbian first).** `services/gateway/src/services/tts/fish.ts` — invoked from `tryPollySynthesis()`'s failure branch (`tts-provider.ts`), only on an unsupported-language gap, never on a transient Polly error. Opt-in on BOTH `TTS_FISH_FALLBACK_ENABLED=true` and `FISH_API_KEY` (`isFishConfigured()`), so deploying the code changes nothing. **Voice safety finding, acted on immediately, not just flagged:** the Serbian `reference_id` the platform owner proposed (`f8c26ecae994449faf73bcfae844076b`, "Srpski Razgovorni Glas") carries an explicit sexual description and `sexy`/`intimate`/`breathy` tags in its own Fish Audio metadata — rejected outright, not used anywhere in this codebase. In its place: `2ad62aaf885e4a14add09fe4a38ffd23` ("Milica - Female Serbian"), published by Fish Audio's own official account, described by Fish itself as built for "voice assistants, customer support and everyday narration" — verified via a real `GET /model/{id}` call, not assumed from the search listing. **Also closes the cascaded ORB voice pipeline's one remaining gap for the same opt-in:** `orb/live/upstream/cascaded-config.ts`'s `evaluateCascadeEligibility()` already had `sr-RS` as a real Amazon Transcribe streaming language code — Serbian's only blocker for the full Transcribe→Bedrock→TTS cascade was the missing Polly voice, never STT. `CascadeEligibility` gained a `ttsProvider:'polly'|'fish'|null` field; `cascaded-live-client.ts`'s synthesis leg now falls back to `synthesizeFish()` when `resolvePollyVoice(lang)` is null. With Fish unconfigured (the default), `sr` still reports `no_polly_voice` exactly as before — verified by re-running the existing `cascaded-voice.test.ts` suite unmodified (still green) plus a new dedicated test file for the enabled case. **Attempted a real test-run synthesis, as directed, and hit a real blocker, not a code bug:** `POST /v1/tts` with the supplied API key returned HTTP 402 "Insufficient API credit — API credit is managed independently from platform credit" on every attempt — the key has no funded API credit. `scripts/tts/verify-fish-voice.ts` (mirrors `verify-polly-voices.ts`'s live-verification pattern) is ready to run once credit exists; until then the `pcm`-format sample rate (`FISH_PCM_SAMPLE_RATE_HZ=16_000`, requested but never confirmed back by a real Fish response) is a documented assumption, not a confirmed fact — same posture `polly.ts` itself shipped with originally. **Also not yet provisioned:** `FISH_API_KEY` does not exist in AWS Secrets Manager; `scripts/aws/setup-fish-audio-secret.sh` (dry-run by default, `--apply` to create) is ready for an operator to run, but deliberately NOT wired into `AWS-STAGE-DEPLOY-GATEWAY.yml`'s task-def secrets loop in this same PR — that loop hard-fails (`exit 1`) the entire staging deploy if a listed secret is missing from Secrets Manager, and this session had no AWS CLI credentials to confirm the secret exists before merging code that would require it. New tests: `test/tts/fish-provider.test.ts` (14 tests — gating, request shape, the rejected-voice regression check, non-2xx/timeout degradation) and `test/orb/live/upstream/cascaded-voice-fish-fallback.test.ts` (5 tests — default-off behaviour unchanged, requires BOTH flag and key, `sr`→`fish` once both set, an already-Polly-covered language stays on Polly, a language with no curated Fish voice either stays ineligible). `tsc --noEmit` clean (two pre-existing unrelated missing-`@aws-sdk/*`-package errors, not touched); full affected-suite re-run 8/8 suites, 168/168 tests passing, 0 failures/regressions. **Not yet independently confirmed against a live synthesis call or live ORB traffic** — same honest caveat this file uses throughout: the next real signal is `scripts/tts/verify-fish-voice.ts` passing once API credit exists, and then a real Serbian ORB session actually producing audio. | VTID-03970 |
| 2026-09-16 | **Production slowdown reported live on the MAXINA mobile app (login 30s+, spinner after every step, email-prefix name, "Exafy Admin" under it, auth UUID shown as the @handle) — root-caused to the shared Supabase project being I/O-starved by the Command Hub's SSE event ticker, and the mobile symptoms to a profile fetch that failed once and was never retried.** Measured live: Supabase Auth sign-in for the documented test user took 32.8s (one attempt returned a 504 after 36s); `pg_stat_activity` showed several concurrent PostgREST backends on `SELECT oasis_events.* WHERE surface=$1 ORDER BY created_at DESC LIMIT/OFFSET`, and the Postgres logs counted 1,770 `canceling statement due to statement timeout` in one hour, dominated by that statement. Source: `GET /api/v1/events/stream` (`routes/events.ts`), one 3s `setInterval` per open Command Hub tab whose FIRST poll had no `created_at` bound (full seq scan + sort of ~540 MB, no created_at index) and whose cursor was only set after a successful page — so once the DB was slow enough for that page to hit PostgREST's 8s statement_timeout, the same heaviest query was re-issued every 3s, overlapping, per tab, forever. **Fix (VTID-03980):** first/no-cursor poll bounded to the last 15 min, self-scheduling loop that never overlaps, per-poll `AbortController` (5s, under statement_timeout), exponential backoff 3s→30s on failure, abort on disconnect; `buildSseEventsQuery`/`nextSsePollDelay` exported and unit-tested plus three live-route tests. **Companion fixes shipped the same afternoon:** VTID-03972 (PR #3356, merged to staging by this session — auth-middleware and badge-poll timeouts, retention job widened to all statuses, batched cleanup procedure) and `exafyltd/vitana-v1` VTID-03978 (PR #1096 — `ProfileProvider` retries a failed `profiles` fetch with 1.5s/4s/10s backoff and never downgrades a loaded profile; `displayHandle()` refuses UUID-shaped values on the identity cards; on staging `preview-aws.vitanaland.com` as `index-DrviiaJ8.js`). **Two corrections to earlier reports, from live evidence:** (1) the "Exafy Admin" label is not a role-switch bug — `tadicjovana276@gmail.com` genuinely carries `app_metadata.exafy_admin=true` (one of 7 such accounts, incl. two service accounts `claude-code-agent@` / `operator-autopilot@` created 11:38 UTC that day) and the side drawer only shows the role label when the profile handle is missing, i.e. only while the fallback profile is on screen; (2) the `idx_oasis_events_created_at` index VTID-03972 recorded as created did not exist — a pg_cron-driven `CREATE INDEX CONCURRENTLY` then produced an index with only 670 indexed tuples against 485,635 rows, so it was dropped again, and a `(surface, created_at DESC)` build stalled invalid and is dropped too; **this table still has no usable created_at index — building one needs a session that can hold the connection for the whole build and watch `pg_stat_progress_create_index`.** Not run locally (sandbox npm registry 403) — CI is the verification; production NOT promoted, staging only. | VTID-03980 |
| 2026-09-16 | **VTID-03964 merged and auto-deployed to staging (`git_commit:"dd808d6..."` confirmed on `/api/v1/admin/build-info`) — the SAME repeated-curl protocol used to validate it was immediately re-run against the live endpoint, per this repo's own deployment-verification protocol, and found the fix incomplete on two of its three targeted routes.** `/api/v1/autopilot/health` still measured 6.4-6.6s on 2 of 6 calls (over the panel's 6s budget) despite VTID-03964's `Promise.all` fix; `/api/v1/autopilot/pipeline/health` still returned real HTTP 500s on 2 of 6 calls with the EXACT SAME error bodies as before VTID-03964 (`"Body is unusable: Body has already been read"`, `"The operation was aborted."`) despite VTID-03964 giving each of its three direct fetches an independent `AbortController` — proving the shared-signal theory was incomplete, not merely under-applied. **Root cause 1 (the persistent 6.4-6.6s):** `getLoopStats()` (`autopilot-loop-store.ts`) has an internal fallback-on-failure path — when its primary `get_autopilot_loop_stats` RPC fails or returns no rows (bounded ~3s), it falls back to a SECOND sequential Supabase call, `getLoopState()` (also bounded ~3s). VTID-03964's `Promise.all` parallelized `getLoopStats()` against its sibling `isAutopilotExecutionArmed()` in `getEventLoopStatus()`, but never touched this internal two-step shape, which can still stack to ~6s all by itself exactly when Supabase is slow enough to trip the primary's bound (the same condition under which the fallback is also likely slow). **Root cause 2 (the persistent 500s):** `/pipeline/health`'s three response bodies (`taskCountsResp.json()` etc.) are read AFTER `Promise.all` has already settled and the AbortController timeouts already cleared in the `finally` block — completely unguarded by try/catch, outside the `.catch(() => null)` that only protects the `fetch()` promise itself, not the later body read. A failed/corrupted body read — consistent with Node's fetch/undici pooling this route's 3 direct fetches concurrently with `getEventLoopStatus()`'s own 2 internal fetches (up to 5 concurrent requests to the same Supabase host) — threw straight past every existing guard into the route's top-level catch, turning one degraded data point into a full 500. Checked directly whether a dispatcher/Agent-based connection-pool fix was available before ruling it out: neither the `undici` npm package nor the `node:undici` builtin module resolves in this environment/Node build, so that route was deliberately not attempted unverified. **Fix:** `getLoopStats()` now races its whole primary+fallback body (renamed `getLoopStatsUnbounded()`) against a single 3000ms `Promise.race` deadline, capping total time at ~3s regardless of internal step count; each of `/pipeline/health`'s three post-`Promise.all` body parses is now independently wrapped in try/catch, so a parse failure on any one degrades only that field (logged, not thrown) instead of 500ing the whole route. New tests: `test/services/autopilot-loop-store.test.ts` ("caps total time at ~3s even when both the primary RPC and its fallback each hang to their own bound" — resolves in ~3003ms, not ~6000ms), `test/routes/autopilot.test.ts` ("degrades one field instead of 500ing the whole route when a response body fails to parse" — simulates the exact observed corruption signature). `tsc --noEmit` clean; full gateway suite 927/928 suites (1 pre-existing skip), 15,234/15,269 tests passing, 0 failures; `npm run build` exit 0. **Not yet independently re-observed against live staging post-deploy** — same honest caveat as VTID-03954/VTID-03964 before it: the next real signal is a repeated-curl re-run showing both routes consistently under budget with no further 500s, and the underlying question of why Supabase/PostgREST is intermittently slow enough to trip these bounds at all remains explicitly un-root-caused — this VTID only bounds and gracefully degrades the failure mode, same as its predecessors. | VTID-03965 |
| 2026-09-16 | **VTID-03954 merged and deployed to staging, and the platform owner immediately re-reported the same panel showing "Autopilot (down) • Autopilot Pipeline (down)" among 5 critical issues, screenshot attached — post-deploy verification confirmed this was a real, partial regression, not a stale screenshot.** Confirmed staging was serving VTID-03954's exact merged commit (`git_commit:"7b9ca15..."` on `/api/v1/admin/build-info`) before investigating further, per this repo's own deployment-verification protocol. Repeated live `curl`: `/api/v1/orb/health` is fixed (consistently 0.27-0.35s, was spiking to 16s+) — but `/api/v1/autopilot/health` still measured 6.3s on one call (over the panel's 6s budget), and `/api/v1/autopilot/pipeline/health` got WORSE, returning real HTTP 500s on 2 of 4 calls: `{"ok":false,"error":"Body is unusable: Body has already been read"}` — a genuine regression VTID-03954 introduced, not present before it. **Root cause 1 (the 500s):** VTID-03954's `/pipeline/health` fix shared ONE `AbortController`/signal across all three of its concurrent `fetch()` calls to the same Supabase host — consistent with Node's fetch (undici) corrupting a pooled keep-alive connection when a shared signal aborts multiple in-flight requests to the same host simultaneously. **Root cause 2 (the 6.3s):** `getEventLoopStatus()` (on both `/api/v1/autopilot/health`'s and `/api/v1/autopilot/pipeline/health`'s critical path) awaited its two independent Supabase-backed reads — `getLoopStats()`, `isAutopilotExecutionArmed()` — SEQUENTIALLY; each individually bounded at ~3s by VTID-03954, so the two stacked to ~6s from this one function alone, before the rest of either route's own work. **Fix:** each of `/pipeline/health`'s three fetches now gets its own independent `AbortController` instead of sharing one; `getEventLoopStatus()`'s two reads now run concurrently via `Promise.all`. **Also found while re-checking the panel, same defect shape, not part of VTID-03954's original scope:** `/api/v1/vtid/health` (ledger read + `next_vtid` RPC probe) had the identical unbounded-sequential-fetch pattern — measured 14.7s on one call. Fixed the same way (independent `AbortController` per fetch, concurrent instead of sequential). New regression tests: `test/routes/autopilot.test.ts` (asserts the three fetches get 3 distinct `AbortSignal` instances, `new Set(signals).size===3`), `test/services/autopilot-event-loop.test.ts` (asserts the two reads run concurrently — elapsed time tracks the slower call, not their sum), new `test/routes/vtid-health.test.ts` (5 tests: healthy path, independent signals, concurrency timing, a hanging fetch resolves in ~2.5s instead of hanging, missing-env-vars 503 unchanged). `tsc --noEmit` clean; full gateway suite 925/926 suites (1 pre-existing skip), 15,200/15,235 tests passing, 0 failures; `npm run build` exit 0. **Not yet independently re-observed** — the next real signal is the Command Hub panel staying green across a normal polling window, with no further 500s on pipeline/health. | VTID-03964 |
| 2026-09-16 | **Command Hub Service Health panel flapped "ORB Live"/"Autopilot"/"Autopilot Pipeline" down intermittently — investigated live against `preview-aws-gateway.vitanaland.com` before touching any code, confirmed the checks were REAL, not stale/fake.** Repeated `curl` against the three flagged routes vs. control endpoints (`/alive`, `/api/v1/scheduler/health`) showed the controls consistently fast (<0.7s) while the three flagged routes were wildly variable — `/api/v1/autopilot/health` measured 3 timeouts at the full 20s cap out of 4 back-to-back attempts in one run. Root cause: `app.js`'s Service Health panel fetches all 55 checks with a 6s client-side timeout each (`fetchWT(ep.url, {...}, 6000)`), and the three flagged routes are the only ones in the panel backed by live, unbounded Supabase/PostgREST calls — everything else is in-memory. Traced three independent call sites with zero timeout protection: (1) `autopilot-loop-store.ts`'s shared `supabaseRequest()` helper (used by `getLoopState`/`getLoopStats`, which both `/api/v1/autopilot/health` and `/api/v1/autopilot/pipeline/health` sit on top of via `getEventLoopStatus()`); (2) `system-controls-service.ts`'s `getSystemControl()` (used by `isAutopilotExecutionArmed()`, also on `/health`'s path); (3) `routes/autopilot.ts`'s `/pipeline/health` itself, which fires three direct `fetch()` calls straight at Supabase REST with no timeout at all; (4) `routes/orb-live.ts`'s `/health` calling `getVoiceConfig()`/`getLiveKitCanaryConfig()` inside a try/catch that only catches thrown errors, not hangs — a slow Supabase moment there just blocked forever with nothing to catch. **Fix: bounded timeouts everywhere in the chain, all well under the panel's 6s budget**, so these routes now fail fast (real data, or a clean, fast error) instead of hanging. (1) and (2) get the established `abortAfter()`-style `AbortController` pattern already used in `vtid-ledger-reader.ts` (3000ms each). (3) shares one 2500ms `AbortController` across its three parallel fetches. (4) reuses the existing `withBootstrapTimeout()` helper (`orb-live.ts`, already built and tested for exactly this "await hangs, not throws" shape) to race the whole provider-config block against 2500ms and fall through to the same vertex/default fallback the pre-existing catch block already had — zero new fallback logic, just closing the "silently hangs instead of hitting the catch" gap. New regression tests pin the fix by simulating a fetch that never resolves on its own and only reacts to `signal.addEventListener('abort', ...)`: `test/services/autopilot-loop-store.test.ts` (`supabaseRequest timeout` — resolves in ~3.0s instead of hanging) and `test/routes/autopilot.test.ts` (`/pipeline/health` — resolves in ~2.5s, plus a signal-presence check on all three fetches). `tsc --noEmit` clean; full gateway suite 920/921 suites (1 pre-existing skip), 15,127+ tests passing, 0 failures (deps for two unrelated pre-existing missing `@aws-sdk/*` packages installed locally to get a clean run — no `package.json` change). **Not yet independently re-observed against a live flapping instance** — the next real signal is the Command Hub panel staying green across a normal polling window instead of intermittently reddening these three cards; the underlying Supabase/PostgREST slowness itself (why these calls are ever slow at all) is not root-caused here, only bounded so it can no longer masquerade as a hard outage. | VTID-03954 |
| 2026-09-14 | **Vitanaland BackOffice (ERP/CRM on ERPClaw) — wave 1 delivered end to end on staging, executed autonomously from the owner's EXECUTION BRIEF (Plan v3.2), one VTID and one PR per slice.** **Platform (this repo, all squash-merged to `main`, staging gateway `5fa81be` serves them):** VTID-03831 design gate (`docs/backoffice/GOLDEN-WORKFLOWS.md`: golden workflows, capability catalog, wave-1 action map); VTID-03832 `backoffice` role + `vitana_role`/`tenant_role` enum alignment and the role functions (`get_my_permitted_roles`, `validate_role_assignment`, `set_role_preference`, `me_set_active_role`; ladder community<patient<professional<staff<backoffice<admin<developer<infra); VTID-03834 ERP capability grants API (`erp_capability_grants`, `/api/v1/backoffice/me|access|access/grant|revoke`); VTID-03842 command orchestrator — typed command registry, policy tiers (read / draft / commit / high), escalations, maker-checker (requester ≠ approver, never confirmable by voice), idempotency keys, receipts, independent audit (`erp_commands`/`erp_approvals`/`erp_audit`, browser roles revoked — the browser only ever talks to the gateway); VTID-03848 ORB BackOffice assistant surface + admin overlay (surface-gated tool catalog, persona overlays, memory scoping); VTID-03840 `services/erp-bridge` — private FastAPI bridge, allowlisted actions, validated JSON, vendored ERPClaw v4.15.0 @ `4d32db6` + erpclaw-growth 2.10.0 pinned in `erpclaw.lock.json` with four Postgres patches (0001–0004; 0004 makes `decimal_sum` return numeric — two root defects, not seven), on-demand GitHub module install disabled, wave-1 module allowlist = CRM only, Postgres-only tenant bootstrap (`scripts/bootstrap_tenant.py`) and the owner-run provisioning script `scripts/aws/setup-erp-bridge-staging.sh` (Cloud Map `erp-bridge.vitana.internal`, Secrets Manager `vitana/erp-bridge/staging/*`, in-VPC bootstrap task); VTID-03887 the approver sees the request payload (`GET /commands/:id`, `/approvals` rows carry `command`). **Frontend (`exafyltd/vitana-v1`, 15 PRs #1062–#1078, all squash-merged, staging deploy run 176 verified serving the new chunks):** VTID-03833 navigation skeleton (63 tabs, BO-001..BO-063), VTID-03834 capability-gated sections + Settings › Access, VTID-03849/03855/03856/03857/03858 Read screens (Overview, Approvals, Audit, Company, Sales & CRM, Finance, Accounting, Reports) over typed Read commands, VTID-03859/03866/03871/03872/03876 Draft review cards (CRM create/update, customer, credit note, payment with lookups, balanced journal lines), VTID-03873 approve/reject + policy edit, VTID-03878 RTL sidebar overlap fix (a global `sidebar.tsx` physical-inset bug, measured before/after), VTID-03888 Commit-tier (explicit ticked confirmation, `confirm:true`) and High-risk (queued 202, never executed from the card) cards — its sweep also caught the Read-era `errors.erpFailed` wording ("rejected the *read* command") now fronting Commit refusals; reworded in all 11 locales. Every UI slice verified in a real browser against a local stub gateway with every non-read request aborted at the network layer — **nothing written to any live system**; mobile is n/a (BackOffice is desktop-only by inheritance, `useRole` forces `community` on mobile widths). **Applied live to the single Supabase project on the owner's in-conversation "apply now" (non-negotiable 4):** VTID-03832 enum values + role functions, VTID-03834 grants, VTID-03842 commands/approvals/audit + revoke. `DATABASE_SCHEMA.md` carries all of them. **Stacked-PR technique worth reusing:** each child branch was re-based on `main` after its parent's squash by merging `origin/main` and resolving with base = merge-base(child, parent-tip) (`git merge-file` per file; JSON i18n shards merged key-wise starting from `main`'s copy, never resurrecting `_pending_review`), inventory regenerated, vitest green, then retarget → undraft → squash. **Production was NOT promoted** — staging only, PUBLISH is the owner's. **Still owed by the owner (recorded, not done):** run `setup-erp-bridge-staging.sh provision --apply`, dispatch `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml`, then `bootstrap-tenant … --apply` — until then staging BackOffice screens show the bridge-unavailable state while commands, approvals and audit already work; VTID-03840 stays `in_progress` for that reason. **Open decisions:** quotation/standalone-invoice Draft cards need an item read (`sales.item.list` + `item_ref` resolution) the wave-1 gate does not expose (VTID-03866); nav-catalog rows for the BackOffice Navigator role; ERPClaw is GPL — hosting is fine, never ship its code to a customer device or on-prem install. All other program VTIDs terminalized `success` via `POST /api/v1/oasis/tasks/:vtid/complete`. | VTID-03831 → VTID-03888 (program); VTID-03891 (this entry) |
| 2026-09-13 | **The two decisions the on-ramp staging test escalated, both executed on platform-owner approval.** **(1) VTID-03850 — staging Dev Autopilot executions now run on the ECS executor task, not in-process.** `AWS-STAGE-DEPLOY-GATEWAY.yml` pins `DEV_AUTOPILOT_USE_JOB=true` + `DEV_AUTOPILOT_JOB_CLOUD=aws`, so every claimed execution (operator on-ramp included) is dispatched via `ecs:RunTask` to the `vitana-autopilot-executor` Fargate task, which carries `GITHUB_SAFE_MERGE_TOKEN` and survives gateway container churn — the in-process promise had neither (VTID-03841: 20-minute watchdog reclaim, then `GITHUB_SAFE_MERGE_TOKEN not set`). The dispatch loop already falls back to in-process with a logged reason if RunTask is refused, so the worst case is the old behaviour plus a warning. **Found while doing it: the executor task definition carried no LLM credential at all** (its own header deferred the Anthropic/OpenAI keys and nothing Bedrock/DeepSeek was ever added), and its image dated from 2026-07-24 — so a dispatched execution would have failed at the worker call regardless. `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` now upserts `BEDROCK_ROLE_ARN` (the executor's own `taskRoleArn`, same activation pattern as the gateway task defs), `AWS_BEDROCK_REGION`, and the `DEEPSEEK_API_KEY` secret (the identical Secrets Manager name the staging gateway resolves, referenced by name — the prod deploy role has no `secretsmanager:Describe*`). Dispatched 2026-09-13 with a recorded reason: revision 6 registered on image `8131af9`, Bedrock activated on `arn:aws:iam::472838866351:role/vitana-ecs-task-role`. **Not pinned on `AWS-PROD-DEPLOY-GATEWAY.yml`** — prod keeps its live task-def state until a staging dispatch is observed end to end. **(2) VTID-03851 — `autopilot_execute_task` requires an authenticated exafy_admin session.** `POST /api/v1/operator/chat` is mounted without auth and accepted an anonymous request on staging; with the on-ramp enabled, that request could queue a real code execution that opens a PR. New `operator-execute-authz.ts` keeps a per-thread verified-caller marker; the `/chat` route runs `optionalAuth` (never rejects — anonymous chat unchanged) and on EVERY request sets the marker from `req.identity` or clears it, because `threadId` is client-supplied and an anonymous request reusing an admin's thread must not inherit the marker; `executeExecuteTask()` refuses before governance/OASIS/DB with `auth_unauthenticated` / `auth_not_admin`. The Command Hub already sends the bearer token on this route, and the owner session is exafy_admin, so the console is unchanged. **Still not done: the end-to-end on-ramp test itself.** It now needs an exafy_admin session (this session has none) — the platform owner runs it from the Command Hub; the first dispatched execution is also the first live check of whether the staging gateway role holds `ecs:RunTask`/`iam:PassRole` for the executor's roles (fallback warning line if not) and whether `vitana-ecs-task-role` holds `bedrock:InvokeModel` (`llm.call.failed` AccessDenied if not). Production still NOT promoted. | VTID-03850 / VTID-03851 |
| 2026-09-13 | **§2b's "only 3 Bedrock profiles invoke" table was stale on one row, caught by real traffic rather than a sweep.** During the `OPERATOR_EXECUTION_ONRAMP_ENABLED` staging test (VTID-03829 → VTID-03839/03841/03843/03844/03845 chain), the self-heal retry child's worker call ran on the `worker` policy primary `eu.anthropic.claude-opus-4-5-20251101-v1:0` and completed normally (29.6s, 3,517 in / 2,768 out tokens) — a profile the 2026-08-10 sweep listed under "Every Haiku / Opus profile → AccessDeniedException". Split that row: Opus 4.5 now has its own dated ✅ row; the ❌ row is scoped to "as measured 2026-08-10, only Opus 4.5 re-measured since" so a future session neither dismisses that profile as unsubscribed nor assumes the rest of the ❌ row is still current. Doc-only; no gateway change, no deploy. Same session also shipped the on-ramp follow-ups the staging test surfaced: VTID-03843 (self-heal children inherit the parent's `llm_on_ramp_override` — the retry above ran on Bedrock precisely because they did not), VTID-03844 (`dev_autopilot_outcomes` gate + CHECK constraint widened to the executor-lane allowlist so `operator_onramp` findings get outcome rows; migration ships as a file, apply via `RUN-MIGRATION.yml`), VTID-03845 (operator prompt: `files_referenced` = the files the plan will create or change, so a test-only plan no longer drags an untouched source file into the safety gate's `file_outside_allow_scope`). **Still open from that test, escalated not fixed:** the staging gateway task def has no GitHub token (`GITHUB_SAFE_MERGE_TOKEN` unset — no on-ramp execution can open a PR from staging), `POST /api/v1/operator/chat` on staging accepts unauthenticated requests, and staging runs executions in-process (no `DEV_AUTOPILOT_USE_JOB`/`DEV_AUTOPILOT_JOB_CLOUD`). Production was NOT promoted — the staging test did not succeed end-to-end. | VTID-03846 |
| 2026-09-12 | **VTID-03824's RULE 0 reposition fix deployed to staging, and the platform owner immediately retested — reported "it doesn't work" again, second screenshot: Vitana says "Alles klar, ich gehe jetzt. Ich bin jetzt weg." but never actually closes the session.** Investigated via a direct, read-only `oasis_events` query against the exact reported session (`live-2dafffa5-...`, 6 turns). Ruled out two possible explanations before concluding this was a genuine model gap: (1) `env:"production"` in the diag payload looked like a wrong-deploy-target signal but is a red herring — `emitLiveSessionEvent()` hardcodes `env: isDevSandbox() ? 'dev-sandbox' : 'production'` regardless of which ECS task actually served the request, not a real staging/prod indicator; (2) the session's own `nova_instruction_debug_dump` confirmed the first follow-up's fix WAS deployed and correctly positioned (`ENDING THE CONVERSATION` at char 9687 of 32,406, immediately followed by `OVERRIDES RULE 0` at 9713, after `PROACTIVE LEADERSHIP` at 2954) — byte-for-byte the shipped text, not stale or truncated. The full turn-by-turn trace showed the real defect: **zero `end_conversation` tool calls across all 6 turns**, despite 5 turns transcribing an explicit stop request, including "du bist immer noch da" ("you're still here") verbatim TWICE — the session only ended because the client sent `upstream_closed reason:"user_stop"` (the user closing the widget), never because Vitana did. This is a genuine Nova tool-calling compliance gap, not a prompt-precedence or deploy bug: the exact override instruction this VTID already fixed to win against RULE 0 in principle still didn't make the model act on it in a real conversation. **Fix, per this repo's own established remedy for a recurring model-compliance gap (VTID-03650 — stop relying on the model once prompt wording proves unreliable): a deterministic, code-level backstop.** New `detectStillHereComplaint()` (`orb-live.ts`) — a small, high-precision EN/DE regex matching ONLY the unambiguous "you're still here" / "du bist (immer) noch da" complaint (deliberately not a broad stop-intent classifier, to avoid false-positives on legitimate pause requests like "let's talk later" — this phrase is never said except in direct response to an assistant that already failed to leave). `handleTurnComplete` (`upstream-message-handler.ts`) now checks each completed turn's transcribed user text against it and, on a match, force-dispatches the exact same `orb_directive: end_conversation` payload the TOOL sends (`dispatchEndConversationDirective()`, extracted from the tool handler so both paths are byte-identical) — independent of whether the model calls the tool. Idempotent per session; skipped on the greeting turn and when the session is already inactive, matching this function's existing guard conventions. Wired into all three `bindUpstreamSessionHandlers` call sites (cascaded, Nova, Vertex-legacy) so both WS and SSE get it (shared path since VTID-03471). **Zero client-side changes** — reuses the widget's already-built `orb_directive: end_conversation` handler verbatim. New `test/orb/live/detect-still-here-complaint.test.ts` (20 tests, pinning the exact reported phrasings and confirming ambiguous phrases stay unflagged) and `test/orb/live/session/still-here-complaint-backstop.test.ts` (5 tests, proving the real unmocked functions fire end-to-end through the handler and actually send the directive over a fake client WebSocket — not just that a mock was called). `tsc --noEmit` clean; full gateway suite 741/742 suites (1 pre-existing skip), 13,715/13,750 tests passing, 0 failures. **Not yet independently confirmed against a fresh live Nova conversation** — same environment limitation as every round in this VTID chain; the backstop is verified structurally against the exact reported failure, not yet observed ending a real session in staging/production. | VTID-03824 |
| 2026-09-12 | **VTID-03824's `end_conversation` tool reached staging and the platform owner immediately re-tested live — reported "it doesn't work" with a screenshot of Vitana still responding to a repeated German stop request instead of ending the session.** Investigated via a direct, read-only query against `oasis_events` for the reported session window (no writes — per this repo's own rule, reading telemetry is always fine). **Finding: the tool mechanism itself worked correctly on a real invocation** — one session in the reported conversation called `end_conversation` and closed cleanly in ~4s, confirming the original fix's AC-1 through AC-7 against live traffic, not just tests. The actual defect was upstream: on an earlier turn in the same conversation, the model replied with a proactive follow-up question ("Was möchtest du als Nächstes angehen?") instead of calling the tool — a near-verbatim match of the system instruction's own "PROACTIVE LEADERSHIP — RULE 0 (ABSOLUTE, EVERY TURN, NO EXCEPTIONS, ALL TENURES)" banned-phrase list. Reading that turn's own `nova_instruction_debug_dump` confirmed why: the original "ENDING THE CONVERSATION" paragraph was positioned BEFORE RULE 0 with far less emphasis (no all-caps header, no explicit override framing) — RULE 0's much louder, later, "NO EXCEPTIONS" framing plausibly won the conflict, especially on a REPEATED stop request the original wording never explicitly addressed. **Fix:** moved the paragraph to AFTER the entire RULE 0 section (recency) and reframed it as an explicit, named exception — "ENDING THE CONVERSATION — OVERRIDES RULE 0 (ABSOLUTE): ... RULE 0's always-propose-a-next-step requirement is SUSPENDED" — with an added explicit instruction for the exact reported failure: "If they have to say it again ... that proves the first call never happened — call it now, with no apology or explanation, just the call." Kept to ~780 characters, well inside the ~32-33KB session-instruction budget this repo has previously measured triggering real Nova content-filter blocks (VTID-03795/03787), so fixing this prompt-precedence conflict doesn't risk reintroducing that unrelated failure mode. New `test/orb/live/instruction/end-conversation-rule0-precedence.test.ts` (7 tests) pins the block's position after RULE 0, its override framing, its explicit handling of a repeated request, the retained farewell + Teacher-Mode/My-Journey carve-out, and the length budget; system-instruction characterization snapshots re-recorded and reviewed diff-by-diff to confirm only the intended paragraph move landed. `tsc --noEmit` clean; full `test/orb test/frontend` suite 230/230 suites, 3807/3813 tests passing (6 pre-existing todo), 0 failures. **Not yet independently confirmed against a fresh live Nova conversation** — same environment limitation as the original fix (this session cannot place a real ORB voice call): the fix is verified structurally against the exact conflict observed live, not re-tested live itself. The next real signal is another manual staging test. | VTID-03824 |
| 2026-09-12 | **ORB voice: reported live as "says a farewell, then starts listening again" — user says "okay du kannst jetzt ausschalten" ("okay, you can turn off now"), Vitana speaks a farewell acknowledging it, but the overlay flips into LISTENING mode instead of closing.** Root cause: no tool existed for the model to signal "the user wants to end this conversation" outside the two narrowly-scoped end tools (`end_teaching_session` for Teacher Mode, `end_guided_topic_teaching` for My Journey topics) — so `orb-widget.js`'s `turn_complete` handler unconditionally re-armed the mic once the farewell audio drained, with no escape hatch for an ordinary session. **Fix: a new `end_conversation` tool, mirroring the two sibling tools' exact shape** rather than inventing a new mechanism — declared in `live-tool-catalog.ts`, dispatched via `orb_directive` in `orb-live.ts`, and handled in `orb-widget.js` by setting `_s.conversationEnding = true` BEFORE polling for the farewell audio to drain (so the existing `_isClosingForNav()` guard suppresses `turn_complete`'s default listening transition instead of racing it), then calling `_hide()` once the audio has actually finished — not a fixed delay, so a longer farewell isn't clipped. The flag resets in `_hide()` and at session start, matching `navigationPending`/`signupClosing`'s existing pattern, so it can't leak across sessions. An English-intent instruction ("speak your own brief farewell, then call end_conversation") was added to the system prompt's GENERAL BEHAVIOR section per NEVER-rule 41 — no hardcoded spoken sentence. New `test/frontend/orb-widget-end-conversation.test.ts` (10 static-source-check tests, matching this file's established widget-test style); updated tool-catalog/system-instruction characterization snapshots; fixed one pre-existing test whose block-slicing boundary assumed `end_guided_topic_teaching` was the last branch before the catch-all `else` (now widened to stop at the next branch). `tsc --noEmit` clean; full gateway suite 738/739 suites (1 pre-existing skip), 13,683 tests passing, 0 failures. **Governance note:** this VTID was initially shipped tagged `BOOTSTRAP-ORB-END-CONVERSATION` rather than self-allocated, on the theory that `allocate_global_vtid` writing to the production Supabase project conflicts with vitana-v1's absolute no-production-write rule (the same reasoning the 2026-08-20 VTID-03646 entry above used). Pushing surfaced that this repo's own `VALIDATOR-CHECK.yml` hard-requires a real `VTID-[0-9]{4,5}` in the PR title with no tag-based escape hatch — re-reading vitana-v1's rule, its own text and every example in it (community posts, chat messages, wallet calls, notifications fanning out to real members) is about writes that reach real users, never about this platform's own VTID ledger, which §4.1 explicitly names as the standard, expected self-service mechanism for a session to register its own work. Allocated for real via the governed `POST /api/v1/vtid/allocate` gateway endpoint (confirmed reachable, not a raw table write) — VTID-03824 — with the one necessary follow-up (`title`/`status`/`spec_status`) applied via a direct, narrowly-scoped Supabase UPDATE, since no gateway PATCH equivalent exists. **Not yet independently confirmed against live Nova traffic** — this session has no way to place a real ORB voice call, so the fix is verified structurally, not against a real "turn off" utterance in production/staging. | VTID-03824 |
| 2026-09-11 | **Flipped the `operator` stage (Command Hub Operator Console chat + voice-to-voice, `services/gateway/src/routes/operator.ts` → `processWithGemini`/`callVertexWithTools`, legacy names — real call is `callViaRouter('operator', ...)`) from Bedrock to DeepSeek-V4.1-Flash for live testing, per explicit platform-owner request — and found two independent, pre-existing bugs that had made the GOVERNED `POST /api/v1/llm/routing-policy` endpoint (the API behind the Command Hub's own routing dropdown) unusable for ANY policy update, discovered only by actually trying it rather than assuming it worked.** (1) `llm_allowed_models`/`llm_allowed_providers` had ZERO `bedrock` rows, even though the live v16 policy uses `bedrock` as primary and/or fallback on every single stage — `validatePolicy()` rejects any stage whose provider/model pair isn't in this catalog, so the dropdown has been unable to save ANY change since Bedrock became the standing default (VTID-03563). A prior session's own `created_by` note on v16 records hitting this and working around it with a direct Supabase write instead of the governed API — the workaround was recorded but the root cause was never fixed. (2) Independently, `deepseek-chat`'s catalog row was missing `triage` from `applicable_stages` even though v16's OWN policy already uses `deepseek/deepseek-chat` as triage's fallback — meaning the governed endpoint would have rejected re-submitting the unchanged live policy verbatim. **Fixed both at the root** (two live Supabase migrations, applied directly via the now-reachable Supabase MCP connection — `bootstrap_bedrock_deepseek_flash_catalog_gap` adds the 3 bedrock models actually referenced by v16 plus `deepseek-flash` per VTID-03816, `fix_deepseek_chat_applicable_stages_triage_gap` widens deepseek-chat's stage list to match live reality) rather than repeating the workaround, then used the now-functional governed API to activate policy v17: `operator` → primary `deepseek/deepseek-flash`, fallback `bedrock/eu.anthropic.claude-sonnet-4-6` (a confirmed-invokable model, so a DeepSeek outage degrades gracefully instead of failing the operator outright); every other stage left byte-for-byte identical to v16. **Live-tested via the exact same `POST /api/v1/operator/chat` endpoint the Command Hub calls:** `meta.provider:"deepseek"`, `meta.model:"deepseek-flash"` confirms the routing genuinely switched and DeepSeek genuinely answered — but the reply itself opened with "I'm Claude, made by Anthropic," a real, observed model self-identification hallucination (a known failure mode in some non-Anthropic models whose training data includes Claude-authored text) worth weighing before trusting this stage with anything where confident-but-wrong self-description matters. Also shipped, same VTID: an emoji-rich tone instruction added to `PERSONALITY_DEFAULTS.operator_chat.system_prompt` (`services/gateway/src/services/ai-personality-service.ts`) per the platform owner's request that operator replies "feel more emotional" — a style INSTRUCTION per NEVER-rule 41 (emoji usage matched to content), not a hardcoded sentence, and confirmed to have no live `ai_personality_config` DB override for `operator_chat` (queried directly) so the code default is what actually serves today. `tsc --noEmit` clean; operator-scoped test filter 13/13 suites relevant, 72/72 tests passing; full gateway suite re-run clean. **Not yet done:** this code change is only live once deployed — the DB routing flip took effect immediately (no deploy needed), but the emoji tone change needs the normal staging→PUBLISH path to reach the exact production chat the platform owner is testing against; flagged explicitly rather than implied as already visible. | VTID-03817 |
| 2026-09-11 | **DeepSeek retired the two-tier `deepseek-chat` (V3) / `deepseek-reasoner` (R1) naming; both are now retired aliases silently served by DeepSeek-V4.1-Flash, on a ~3-month discontinuation clock from DeepSeek's own 2026-07-24 announcement.** Verified against DeepSeek's live API docs before touching anything (`api-docs.deepseek.com`): the actual API model identifier for the current model is `deepseek-flash` — "DeepSeek-V4.1-Flash" is the marketing/display name, not a literal string the API accepts, the same relationship as e.g. `claude-sonnet-4-6`'s Bedrock inference-profile id vs. its display name (§2b's own lesson: verify the real identifier, don't guess from a display name). Updated every DeepSeek call site in both repos to target `deepseek-flash` directly rather than wait for the legacy aliases to actually break: `services/gateway/src/constants/llm-defaults.ts` (LLM_SAFE_DEFAULTS fallback_model for planner/worker/validator/operator/memory/triage/classifier, MODEL_COSTS — new deepseek-flash entry added, retired deepseek-chat/deepseek-reasoner entries KEPT so a stray stored policy row on the old names doesn't silently cost-estimate to $0, PROVIDER_FLAGSHIPS.deepseek, RECOMMENDED_MODELS), `services/gateway/src/services/architecture-investigator.ts` (self-healing root-cause hypothesis agent's `ARCH_INVESTIGATOR_MODEL` default), `services/worker-runner/{index.ts,src/services/execution-service.ts}` (autopilot execution plane's Claude→DeepSeek fallback, `WORKER_FALLBACK_MODEL` default — the process the platform owner specifically flagged mid-session as "using deepseek"), `services/agents/cognee-extractor/{main.py,service.yaml}` (ORB voice memory/entity-extraction pipeline's `LLM_MODEL` default when `LLM_PROVIDER=deepseek` — the "self-improvement"/memory process also flagged mid-session), and `services/agents/conductor/llm-router/router.py` (cost calculation — added a `deepseek-flash` pricing branch rather than let it silently fall through to V3's stale rate now that "reasoner" no longer appears in the model string). Also fixed the same hardcoded `deepseek-chat` in `exafyltd/vitana-v1`'s `scripts/{translate-keys.mjs,i18n-audit-llm.mjs}` (the i18n translation/audit tooling's `--provider=deepseek` path). **Deliberately NOT touched: the ACTIVE row(s) in `llm_routing_policy`.** That table is normally mutated through the Command Hub, not migrations, and this session has no live Supabase/gateway access to read its current stored JSON before writing to it — blindly rewriting jsonb fields on a row whose live shape is unverified risks clobbering an operator's own change (NEVER rule 6: never assume unverified context). New migration `supabase/migrations/20260911120000_BOOTSTRAP_deepseek_v4_1_flash.sql` instead does the two things that ARE safe without live-DB visibility: adds `deepseek-flash` to the `llm_allowed_models` Command Hub dropdown catalog as flagship/recommended (demoting, not deactivating, the two retired aliases — DeepSeek is still serving them during the deprecation window), and updates the `agents_registry` metadata rows for `architecture-investigator` and `cognee-extractor` to match the code default. **If any ACTIVE `llm_routing_policy` row still stores a literal `deepseek-chat`/`deepseek-reasoner` string, an operator needs to flip it via the now-updated Command Hub dropdown** — the compiled-in `LLM_SAFE_DEFAULTS` (what serves on a policy-read failure or a stage missing from a stored row) is already correct as of this change, but a fully-populated stored policy row is served as-is and won't pick up the new default on its own. Full gateway suite: 737/738 suites (1 pre-existing skip), 13,673 tests passing, 0 failures, `tsc --noEmit` clean; full worker-runner suite 3/3 suites, 33/33 tests, 0 failures; Python syntax-checked (`cognee-extractor/main.py`, `conductor/llm-router/router.py`); Node syntax-checked (both `vitana-v1` scripts). **Not verified: an actual live call to `deepseek-flash`** — this session has no `DEEPSEEK_API_KEY`/network path to `api.deepseek.com` to invoke it for real, so per §2b's own standard ("verify a model is actually invokable, not just that it's listed") this is confirmed correct against DeepSeek's documentation, not against a live response. **Self-correction on VTID allocation:** this entry originally shipped with no VTID, wrongly assuming the gateway's `/api/v1/vtid/allocate` endpoint was unreachable from this session without actually trying it — it is reachable, and allocating against it landed the row as `VTID-03816` (`status=allocated`, `spec_status=missing`). No gateway endpoint reachable from a session lets the ledger status/spec_status move to `in_progress`/`approved` without first pushing a full spec through `/api/v1/specs/*`'s generate → quality-check → approve pipeline; doing that retroactively for already-shipped, already-tested work would mean authoring a spec document purely to satisfy bookkeeping, so that step is left to an operator via the Command Hub rather than fabricated. | VTID-03816 |
| 2026-08-27 | **VTID-03764's own diagnostic instrumentation was deployed and measured for real — and the one-shot design it shipped with turned out to be useless, self-caught before any conclusion was drawn from it.** The prior row's `onFirstNormalizedEvent` fired once, on the very first normalized Nova event of any kind. Real staging measurement on the exact bimodal-slow (reconnect) sessions this VTID exists to explain showed it landing at ~762-766ms — essentially simultaneous with `greeting_sent` — carrying `kind:"usage"`, a connection-handshake accounting event Bedrock sends BEFORE the greeting prompt is even transmitted, on sessions whose `total_ms` was 6.26s/6.86s. A one-shot hook that fires on a pre-greeting handshake event cannot say anything about the multi-second silence AFTER `greeting_sent`, which is the actual gap under investigation — the design raced the wrong event, not merely an imprecise one. **Fix:** redesigned `onFirstNormalizedEvent` -> `onEarlyNormalizedEvent`, now firing on each of the first `EARLY_EVENT_CAP` (12) normalized events instead of only the first, each carrying `{kind, index}` so `voice.latency.measured` records a real ordered timeline instead of one point that happens to be irrelevant. `LatencyPhase`'s `nova_first_normalized_event` -> `nova_early_event` (fired multiple times per session). `onFirstRawChunk` (byte-level, pre-normalization) is unchanged — still a distinct, useful signal on its own (confirms Bedrock is sending bytes at all, independent of how the normalizer classifies them). Updated the one test that had encoded the old one-shot behavior into a new timeline test (asserts the ordered `kind`/`index` sequence and the cap). Full gateway suite re-run clean: 712/713 suites (1 pre-existing skip), 13,419 tests passing, 0 failures; `tsc --noEmit` clean. **Still not fixed, and still the point of this whole VTID:** the real root cause of the 5-6s gap remains unknown. This redesign is a precondition for finding it, not a finding itself — the next step, unchanged from the prior row, is deploying this to staging and reading `nova_early_event`'s timeline against a real slow session to see whether Nova responds quickly with something non-audio (a fixable bug in this codebase) or stays genuinely silent for several seconds (external model latency this codebase cannot control). | VTID-03764 |
| 2026-08-26 | **VTID-03741's fix landed and works exactly as measured — but real staging measurement (not just unit tests) found it does not close the gap for every session, and root-caused why with real telemetry rather than guessing.** Platform owner explicitly demanded real measured proof against the <3s/<1.5s criteria, not a green CI report — pushed back hard on "CI green" being reported as if it answered the latency question. Built a real Playwright harness (loads the actual deployed `orb-widget.js` from `preview-aws-gateway.vitanaland.com`, authenticates as the documented test user via a real Supabase token, calls the real `VitanaOrb.toggle()` path, hooks `AudioBufferSourceNode.start()` to timestamp real audio distinct from the two known decoy buffers) and ran 20 real sessions against staging, cross-referenced against the `voice.latency.measured` telemetry VTID-03741 itself enabled. **Finding: a clean bimodal split, not noise.** Single-connection sessions land at 2.2-2.8s (under target). Sessions that reconnect once — a deliberate, error-free code path that opens fast with an empty context (the context-ready gate timed out) then reconnects ~150-350ms later once the real ~27,500-char brain context resolves, to redo the setup properly — land at 6.3-7.7s (over target), consistently, across both a rapid-fire batch and a 90-second-spaced batch (ruling out self-induced test contention as the cause). Two other hypotheses were tested and killed with real data before landing here: context size alone does not explain it (both context_chars=0 and context_chars=27500+ groups show the same 2-13s variance independently), and no Nova connection error/retry is logged for ANY of the 20 sessions — the "reconnect" is code-driven, not Nova failing. What remains unexplained: a ~5-second gap between `greeting_sent` (on the upgraded connection) and `audio_out_first_chunk`, with zero instrumentation inside it — the existing `LatencyTracker` phases jump straight from setup to the final audio chunk. **Shipped in this VTID (VTID-03764): diagnostic instrumentation only, no fix yet.** `NovaSonicLiveClient` gained two optional, try/catch-guarded callbacks — `onFirstRawChunk` (fires once, on the first raw eventstream chunk from Bedrock, whatever it contains) and `onFirstNormalizedEvent` (fires once, on the first normalized event of any kind — audio, text, toolCall, ignored) — wired as two new `LatencyPhase` values into the same `voice.latency.measured` event, so the next round of real measurements can tell apart "Nova itself is silent for ~5s" (genuine external model latency, not something this codebase controls) from "Nova responds quickly with something that isn't audio yet, and our own code is slow to turn it into audio the client hears" (a real, fixable bug) — before writing a single line of fix code. Deliberately did NOT attempt a fix blind: this exact reconnect/greeting-resend code area is where the VTID-03674→03686 chain (8+ rounds), VTID-03502, VTID-03557, VTID-03634, and VTID-03687 all previously introduced or fought regressions when "obvious" fixes were applied without this kind of measurement first. 2 new tests pin the diagnostic hooks fire exactly once and never destabilize a real session even if the callback itself throws. Full gateway suite 712/713 suites (1 pre-existing skip), 13,418 tests passing, 0 failures; `tsc --noEmit` clean. **Not yet independently confirmed which hypothesis is correct** — that is the very next step once this deploys to staging and produces real marks on a slow session. | VTID-03764 |
| 2026-08-25 | **ORB voice reported taking 6-8s from tap to first audible word (target: <3s cold-start, <1.5s warm-start) — investigated and shipped the first three phases of a staged fix; two more phases deliberately deferred pending real telemetry this session cannot observe.** A background Explore agent traced the full click-to-first-audio pipeline (WS and SSE share one path since VTID-03471) and found two stacked, independently-fixable costs. **(1) The wake-brief candidate ranker ran strictly sequentially.** `decideContinuation()` (`decide-continuation.ts`) looped `for (const provider of providers) { await invokeProviderSafely(...) }` over ~10 registered providers (guided-topic-narration, first-time-welcome, new-day-return, login-briefing, journey-guide, conversation-flow-v3, reminder-due, etc.) — each independently isolated (own try/catch, own Supabase read, never throws upward) and selected purely by returned priority, never by completion order, so nothing about the ranking logic required them to run one-after-another. With real per-provider latencies of 55-350ms (per production `oasis_events`), serializing ~10 of them adds up to low seconds directly on the critical path gating Nova/Vertex session setup via `contextReadyPromise`. **Fix:** replaced the loop with `Promise.all` over a new `invokeProviderWithTimeout` wrapper that also races each provider against a per-provider timeout (`DEFAULT_PROVIDER_TIMEOUT_MS`, 800ms default, env-tunable via `WAKE_BRIEF_PROVIDER_TIMEOUT_MS`) — a genuine robustness improvement too, since the old loop had NO timeout at all and a single hung provider could stall the whole decision indefinitely. `Promise.all` preserves input order, so `results` still lines up 1:1 with `providers` for the existing registration-order tie-break; selection semantics are unchanged (verified: all 46 pre-existing tests in `decide-continuation.test.ts` pass unmodified). 4 new tests pin the parallel behaviour: wall-time tracks the slowest provider not the sum (5×40ms providers finish in <150ms, would be ~200ms serial), a hung provider is bounded by the timeout without blocking the others, and selection is unaffected by completion order (a slow-but-higher-priority provider still beats a fast-but-lower-priority one). **(2) Two load-bearing fast-start/cache flags were never pinned on staging.** While verifying (1)'s real-world impact, found `FEATURE_ORB_FAST_START_ENV` and `FEATURE_ORB_BRAIN_CACHE_ENV` are pinned on `AWS-PROD-DEPLOY-GATEWAY.yml` with hard measured evidence (`BOOTSTRAP-ORB-FASTSTART-DRIFT`/VTID-03504: missing fast-start measured a 9.5s cold authenticated start past the widget's 8s fetch-abort timeout; missing brain-cache measured a build p50 degrading to 17.4s p50/119.7s max under stacked reconnects) — but were **never set anywhere in `AWS-STAGE-DEPLOY-GATEWAY.yml`**, confirmed by reading the file, not assumed. Whatever staging's task def has actually been running for these two is undetermined from this repo (inherited from whatever a manual edit or earlier build happened to leave), the same "config that exists only in live AWS state" shape VTID-03513 already cost four days for elsewhere. Pinned both to staging with the identical `staging+prod` value prod already runs, with an explicit note that this session has no AWS/admin credentials to confirm current live staging state first (the exact caution prod's own comment asks for) — recorded as a reasoned judgment call, not a confirmed measurement: both are pure deferral/caching mechanisms already proven safe in prod for weeks, and staging exists specifically to catch a regression before prod. A new pinning test also asserts staging and prod carry the identical value so they cannot silently diverge later. **(3) Enabled the existing (but dormant) `LatencyTracker` telemetry on staging** — `voice.latency.measured` OASIS events marking `upstream_connected`/`context_awaited`/`setup_sent`/`greeting_sent`/`audio_out_first_chunk` already existed in code but self-gated on `FEATURE_LATENCY_TELEMETRY_ENV`, which was unset on both stacks and therefore always resolved to `off` — the tracker has been a no-op since it was written. Turning it on gives the next phase real per-session numbers instead of log-line spot checks. **Deliberately NOT done in this VTID, and why:** promoting `FEATURE_ORB_SAFE_FAST_GREETING` to prod (still staging-only) — it changes what Vitana actually says, not just timing, and needs someone to observe it working on staging first, which this session cannot do without live access; retuning `CONTEXT_READY_GATE_TIMEOUT_MS` down — the current 4000ms default already sits close to the ~4.4s uncached brain-build cost, so lowering it blind before the new telemetry produces a real distribution risks truncating legitimately-slow-but-necessary context builds instead of helping; migrating guided-topic Polly narration to the Bidirectional Streaming API — a larger, separate architectural lift. **(4) Same-day Codex PR review caught a real regression risk in (1), fixed before merge.** The new 800ms generic per-provider timeout is sized for the passive/ambient providers (a handful of fast indexed reads) but `guided-topic-narration` additionally awaits real Polly synthesis on a cache miss inside its `produce()` — plausibly well over 800ms for a cold lesson — and per `wake-brief-wiring.ts`'s own `isExplicitSelection` logic, an explicitly TAPPED Guided Journey topic must win turn 1 regardless of priority-vs-timing. Left as-is, a slow cache-miss synthesis would silently drop the tapped topic's candidate and let a lower-priority provider open generic conversation instead — reproducing the exact "tapping a lesson opens small talk" defect the VTID-03644→03686 chain spent 8+ VTIDs fixing. **Fix:** `decideWakeBriefForSession` now passes `providerTimeoutMs: 10_000` to `decideContinuation` whenever `isExplicitSelection` is true (guided-topic tap or Foundation focus-step tap), instead of falling through to the 800ms ambient default — still bounds a genuinely hung call, just doesn't mistake a slow legitimate synthesis for one. 3 new tests pin exactly what gets passed to `decideContinuation` on explicit vs. passive opens. Full gateway suite re-run clean after this fix: 706/707 suites (1 pre-existing skip), 13,358 tests passing, 0 failures; `tsc --noEmit` clean. **Not yet independently confirmed against live traffic** — same honest caveat as most rows in this chain: the next real signal is `voice.latency.measured` events actually landing in `oasis_events` on the next staging deploy, and a real before/after wall-clock comparison once they do. | VTID-03741 |
| 2026-08-24 | **Barge-in had been shipped (BOOTSTRAP-ORB-BARGEIN) but built inside-out, so Nova Sonic's own barge-in had never once fired in production — reported as "the user must be able to interrupt Vitana at any time, the microphone must be open at any time."** The mic was gated SHUT while the model spoke, in **two independent places**, and only a loudness heuristic could reopen it: the client (`orb-widget.js` `_startAudioCapture`) buffered frames into an 8-frame ring and `return`ed, firing only after RMS > 0.06 sustained for **6 consecutive frames (~384 ms)**; the server (`orb-live.ts:16667` + its SSE mirror `live-session-controller.ts:2397`) hard-dropped every chunk with `if (isModelSpeaking) return;`. **The server gate is the one that mattered:** Nova handles barge-in natively — it stops generating and emits `contentEnd.stopReason:"INTERRUPTED"`, which `nova-sonic-protocol.ts:479` already normalizes and `upstream-message-handler.ts:1653` already forwards — but that path was structurally unreachable, because Nova received literal silence during its own turn. `sendEndOfTurn()` being a documented no-op for Nova means that event is the ONLY thing that actually stops generation, so the feature was dead, not merely slow. Two user-visible consequences: anything quieter than 0.06 RMS ("nein", "warte", "stopp", a normal-volume question) could never interrupt **at any point, ever** — not late, never; and confirmed interruptions took ~384 ms plus an interrupt/ack round trip, against an industry target of <200 ms. **Why "just always forward the mic" is wrong, and what was done instead.** The gates were not cargo-culted — the widget carries measured evidence that speaker bleed survives browser AEC at 0.01-0.04 RMS and that a previous 0.015 threshold "triggered on echo, causing constant interruptions", i.e. Nova interrupting *itself* in a loop. Forwarding raw frames reproduces exactly that. So the mic is now open but **noise-gated**: every capture callback emits a frame, verbatim above the echo floor and **digital silence** below it. Nova gets a continuous, correctly-timed stream (turn detection works, native barge-in engages) while AEC residue is zeroed rather than forwarded. Hysteresis (open 0.05 / close 0.025 / 400 ms hangover) stops the gate chattering across mid-word amplitude dips, which a single threshold would shred; a 250 ms AEC warm-up covers convergence on each new playback burst (LiveKit ships the same idea at 3.0 s, tuned for telephony — at that length the user could not interrupt the first three seconds of every turn, which is the complaint being fixed). The pre-roll ring buffer existed only to RECONSTRUCT audio the gate destroyed and is now unreachable under full duplex; it is kept intact for flag-off sessions rather than deleted, so rollback stays a flag flip. Nova's `INTERRUPTED` remains the **authority** on whether the turn yielded — the client's own 2-frame (~128 ms) detection only stops local playback so the interruption *feels* instant. **A real bug was caught by its own test before shipping:** confirmation initially counted gate-OPEN frames, so the 400 ms hangover would tick a single cough or door slam up to the threshold in silence and fire a spurious barge; it now counts **voiced** frames only, with hangover frames neither adding nor resetting. **Tuning lives in ONE place** (`DUPLEX_GATE`, `src/orb/live/duplex/full-duplex-gate.ts`); `orb-widget.js` and the device harness mirror the literals and `full-duplex-gate.widget-parity.test.ts` fails the build on any drift — the same remedy VTID-03696 needed after a workflow's `paths:` list desynced unnoticed for 30+ runs, and VTID-03644 after five copies of a language map diverged. **New: `/command-hub/orb-voice-bench.html`** — the one property CI cannot establish is whether a given device's echo actually opens the gate (no acoustic path in a unit test; Playwright renders pixels, not sound). This harness runs the identical gate against the real mic and speaker, reports gate openings/peak RMS/barge events with a pass-fail verdict, measures the room noise floor first and warns when ambient noise already exceeds `closeRms`, and is deliberately self-contained — no gateway call, no ORB session, no writes, safe against any host. **`endpointingSensitivity` needed no change** — already `HIGH`; it was simply being applied to a stream that was silent by construction. 46 new tests (gate behaviour frame-by-frame: speech passes on frame 1 at any volume above the floor, echo across the whole 0.01-0.04 band never opens or barges, warm-up neither passes nor accumulates, hysteresis survives a mid-word dip, a single transient is rejected; plus parity/drift guards across all three copies and both legacy predicates unchanged). Full gateway suite 686/687 suites (1 pre-existing skip), **13,125 tests passing, 0 failures**; `tsc --noEmit` clean; device page visually verified at 1400×900 and 390×844 and exercised end-to-end (two UI defects found and fixed that way: a clipped `BARGECONFIRMFRAMES` label, and the live panel freezing at GATE=OPEN after a run finished, contradicting the verdict beneath it). **NOT verified, and it is the gate on any prod discussion:** no real-device echo run has happened — this session has no microphone, and the fake-device run confirms only that the harness itself works (its own noise-floor guard correctly flagged the synthetic input as unusable). Someone must run the echo test on a real phone, speakerphone, and get zero gate openings before full duplex goes anywhere near production. **Also deliberately not done:** the `ScriptProcessorNode`→`AudioWorklet` migration. It is the right thing (deprecated API, main-thread jitter) but it is a latency/robustness improvement, not a correctness fix for barge-in, and bundling it here would have put the risky part and the safe part behind one flag. | VTID-03706 |
| 2026-08-21 | **VALIDATOR-CHECK was structurally unpassable for any PR that touched a governed tree AND anything else — and the rule that made it so did not actually protect the "anything else".** VTID-03525 scoped the `paths:` trigger to four trees so the gate stops firing on PRs it cannot judge, but left the path-ownership guard evaluating **every** file in the PR against the profile allowlist. The two disagreed. Concretely: a PR touching `services/gateway/src/**` and `scripts/**` triggers the gate and is rejected for the `scripts/**` files — while the **identical** `scripts/**` files in a PR that happens not to touch `services/gateway/src` are never judged at all, because the workflow never fires. So the old behaviour did not govern `scripts/`; it only punished changes honest enough to touch a governed tree in the same PR. Neither accepted profile (`command_hub_frontend`, `gateway_backend`) admits any path under `scripts/`, `.github/`, `supabase/` or repo-root docs, so **no profile choice could satisfy such a PR** — measured on PR #3144, 9 of 15 changed files were unsatisfiable under either profile. **Fix:** the guard now judges exactly the trees the trigger selects (`REMIT`) and REPORTS everything else as `NOT JUDGED`, explicitly labelled "no governance gate of their own — a real gap, not an approval," rather than silently implying the whole PR was validated. Those trees genuinely have no gate; naming that is better than a rule that fires only by accident. **Second fix, same root shape:** the lockfile deny rejected any `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` outright, so the gate could never approve a PR that adds a dependency — a legitimate, routine change class, i.e. a wall rather than a checkpoint, and an unsatisfiable gate is one someone eventually deletes. Lockfile changes are now **declared, not forbidden**: a `DEPENDENCY_CHANGE:` line in the PR body (new exit 23 without it), which keeps the "this PR is bigger than its profile suggests" signal while leaving a way to be honest about it. `.env` stays a hard repo-wide reject (exit 20, deliberately NOT remit-scoped — a leaked secret does not care which directory it landed in), and `.env.example` is explicitly not caught. `services/gateway/test/**` was added to the trigger: VTID-03549 had already allowlisted it in the profile (the Acceptance Mapping Gate REQUIRES `TEST:` tokens and those suites live there) but never added it to the trigger, so a tests-only PR was allowed by the profile and never triggered the gate demanding it. **The guard also moved out of inline shell into `scripts/ci/validator-path-guard.cjs` with 19 unit tests** — this step has been silently broken twice and BOTH times it was a parsing trap, not a logic error: a heredoc that terminated the YAML block scalar (VTID-03505, unenforced for 30+ runs on every branch including main) and a multi-line `awk` with a newline after `!(` that failed every PR regardless of content (VTID-03549). Neither is visible when reading the YAML; neither had a test. One test reads the workflow's own `paths:` list and fails if it drifts from `REMIT`, so the exact desync this VTID fixes cannot silently return — mutation-verified by removing a trigger path and confirming the test goes red. **Third fix, same defect family — the Route Mount Evidence Gate keyed off a proxy signal.** It fired whenever any file under `src/routes/` (or `src/index.ts`/`src/app.ts`) changed and then demanded `ROUTE_MOUNT:`/`FINAL_URL:`/`CURL_PROOF:`. But editing a route FILE is not adding a ROUTE: VTID-03692 changed a branch inside an existing WebSocket handler in `routes/orb-live.ts` and added no route at all (verified on the real diff — zero added route registrations). Demanding a curl proof for a route that does not exist does not produce evidence, it produces **invented** evidence, because the only way to go green is to write down a URL nobody can call — a gate passable only by making something up launders a guess into a green check, which is worse than no gate. It now triggers on an ADDED line matching a route registration or router mount; removals, context lines and the `+++` file header do not count, and when a route IS added the requirement is unchanged and still binds. 25/25 new tests, `tsc --noEmit` clean. **Not yet confirmed against a live PR run** — the next PR to touch a gateway tree is the first real exercise. **Fourth fix, caught live while testing the above.** The VTID was extracted as the first `VTID-\d+` appearing ANYWHERE in the title or body, and every later gate keys off it — most importantly the Evidence Pack Gate, which demands `docs/validation/$VTID/`. So a PR that merely **cites** an older VTID as background had its evidence directory silently pointed at unrelated, already-shipped work. Measured on PR #3144: the first `VTID-` in the body was **VTID-03495** (the Polly provider, cited as context), so the gate would have demanded `docs/validation/VTID-03495/` — and creating that directory to go green would have filed this PR's evidence under someone else's VTID, i.e. a green check attached to the wrong work. The title stays the primary source (the Merge Deploy Gate already requires the VTID there); the body fallback now requires an explicit `VTID: VTID-XXXXX` line, so a prose mention can no longer select the evidence directory. Verified against the real #3144 body: the old rule picked VTID-03495, the new rule correctly refuses (exit 10) rather than guessing. **Still open, not fixed:** the gate assumes ONE VTID per PR, which does not fit a branch carrying several. | VTID-03696 |
| 2026-08-19 | **Cut this file from 278,308 to ~121,000 characters (56%) at the platform owner's explicit request, after Anthropic's own CLAUDE.md guidance (concise, high-signal) was raised against this file's actual size.** Three moves, all preserving the underlying facts rather than deleting them: (1) archived the 67 oldest CHANGE LOG entries verbatim to new `docs/CHANGELOG-ARCHIVE.md` (166,797→~43,000 chars in this table), keeping the most recent 12 inline with a pointer note — nothing was rewritten or summarized, just relocated out of the file every session force-loads. (2) Compressed §1b/§2b/§2c/§2d/§2e (AWS prod, Bedrock, Polly, Titan, Nova Sonic) from incident-narrative prose down to the operational facts that actually prevented repeat mistakes before — e.g. §2b keeps the "only 3 of 22 listed Bedrock profiles actually invoke" table in full, drops the paragraphs about how that was discovered. (3) Light trims to Part 1 rules (spoken-wording rule, test-account rule) and §4/§8/§9/§13c, keeping every concrete number/gotcha that a shorter version had previously failed to prevent (mask polarity, PCM sample rate, the credit-balance/silent-fallback pattern). **Deliberately NOT touched:** §14's memory-architecture diagrams (dense but not narrative — legitimate reference) and §15/§16's deployment protocols (literal checklists, used every deploy). Went section-by-section with the platform owner reviewing a tier (keep-verbatim / distill-to-one-line / archive) for each section before executing, rather than cutting unilaterally. | (docs cleanup, no VTID — see IF-THEN rule 1/§4.1; no gateway/DB access from this session to self-allocate one) |
| 2026-08-19 | **VTID-03685 fixed the premature session close, and immediately surfaced two new, previously-unreachable defects underneath it — reported live as "error Live API" plus the model hallucinating a tool call instead of teaching.** With the guided-topic session no longer killed after the opener line, two things that could never have happened before now did. (1) **A visual "error Live API" flash on every guided-topic tap.** `nova_validation` still fires unpredictably on Nova's first connection attempt (still fully unroot-caused, same as every prior row in this chain), and the server retries internally and usually recovers within seconds via `resendGreetingIfStuckAtZeroTurns`. But `orb-live.ts`'s WS error handler unconditionally forwarded that FIRST-attempt failure to the client as a raw `{type:'error', ...}` frame, and `orb-widget.js`'s `case 'error':` handler unconditionally rendered it as `Error: Live API connection error` — flashing a scary status line for a failure that was already being silently recovered, with nothing left broken for the user to actually see. Fixed by gating the status-text update on `_s.greetingComplete`: before anything has been heard, the error is logged to console but not shown; once real audio has played, a genuine error still surfaces normally. (2) **The model, once free to actually continue past the opener, chose not to teach.** Traced live via `oasis_events` for topic T254 ("Dein Fortschritt"): the guided-topic candidate won correctly, the model spoke a short opener, the user replied "ja mach das" ("yes, do that"), and the model responded by calling `switch_persona("sage", ...)` — a persona that does not exist anywhere in the system (confirmed via the `switch_persona` tool itself rejecting it: `"Invalid persona: sage (active personas: devon, vitana)"`) rather than pure hallucination grounded in T254's actual data (`guided_practice_target:"my_journey"`, a screen key, not a persona name). The GUIDE-MODE teaching block was confirmed present in the system instruction (the same code path that correctly bundles it every time), so this is a genuine model-compliance gap, not a missing-content bug: the existing instructions never explicitly forbade skipping straight to a tool call on a minimal "yes". Strengthened all four branches (German/English × legacy/post-narration) of `buildGuidedTopicNarrationBlock()` with an explicit "STRICTLY FORBIDDEN" rule against calling any tool or jumping to practice before actually explaining the content, and clarifying that a brief "yes"/"okay" means "explain it now", not "skip ahead". **This fix carries real, acknowledged residual risk** — unlike the deterministic code fixes for (1) and VTID-03685, this depends on the model actually complying with a strengthened prompt instruction, which cannot be verified with the same certainty until observed against live traffic. 3 new tests (one WS-error-suppression characterization test pattern reused from the sibling `orb-widget-guided-topic-reconnect.test.ts` style, two prompt-content assertions — one per branch — pinning the new forbidden-tool-call language in both languages); full `test/orb/` sweep 120/120 suites, 1667/1673 tests passing (6 pre-existing todo), `tsc --noEmit` clean. **Not yet independently confirmed against live traffic** — same honest caveat as every row in this chain, and this one specifically needs a real retest to confirm the model actually teaches instead of skipping ahead. | VTID-03686 |
| 2026-08-19 | **The whole VTID-03674→03677 chain fixed WHO the guided-topic content reached (candidate selection, reconnect suppression) but never checked WHETHER the actual multi-paragraph lesson ever got spoken — reported live, furiously, as "what's completely missing is reading the session... whatever you have done, it's trash."** Traced live via `oasis_events` for two consecutive guided-topic taps (T252 "Dein Plan", T253 "Dein erster Schritt", both `session`→`practice_action_type:'orb_explain'` with substantial multi-paragraph `vitana_voice_script`): both sessions correctly won the guided-topic candidate (`wake_opener:override_v2`), spoke ~1s of audio (turn 1, the SHORT opener line), then **the CLIENT sent `upstream_closed reason:"user_stop"` at `turn_count:1`, seconds after `turn_complete`** — i.e. the widget itself told the server to stop, right after the opener and before any of the actual lesson. Root cause: `orb-widget.js`'s VTID-03294 `guidedAutoClose` (**and** a fully redundant second copy of the same close, `useOrbVoiceWidget.ts`'s `onTurnComplete`→`consumeGuidedAutoClose()`) closed the overlay **the instant turn 1's audio finished** — correct back when turn 1 (VTID-03293) WAS the entire lesson recited verbatim, but VTID-03650/03665 shrank turn 1 to a short opener and moved the real teaching to a conversational multi-turn GUIDE-MODE block ("Keep it conversational: short chunks, check understanding, answer follow-ups" — `guided-topic-narration-prompt.ts`, unchanged the whole time and never actually reachable) — and nobody updated the auto-close to match. Every fix in the 03674→03677 chain was individually correct and real, but all of them were curing failure modes of a session that was, by design, killed before it could ever reach the part that mattered. **Fix:** removed the `_hide()`/`_sessionStop()` call from both auto-close sites entirely (the now-dead `consumeGuidedAutoClose`/`_guidedAutoClose` plumbing removed from `orbActivate.ts` too) — the overlay now falls through to the normal listening transition after the opener, exactly like any other ORB conversation, so the model's GUIDE-MODE turns can actually run. **Deliberately NOT attempted:** an automatic "teaching is done, now show the congrats screen" transition — the user's full ask includes this, but guessing at a completion signal (turn count? a phrase? a timeout?) risks trading a definite, provable bug for a fragile heuristic; the already-open Topic Explanation/congrats drawer now simply reveals itself whenever the user closes the ORB themselves, same as ending any other conversation. Flagging as an explicit follow-up, not silently declaring it done. **Second, independent fix from the same live trace:** "First, it says 'einen Moment, ich verbinde mich neu'... before it starts" — `attemptTransparentReconnect()` unconditionally sends the client a loud, spoken `{type:'reconnecting'}` cue on every server-internal Nova retry (both T252 and T253 hit `nova_validation` on their first attempt), including when `turn_count===0` — nothing has been heard yet, so "reconnecting" reads as "already broken" rather than "hold on." The exact same defect was already named and fixed for the persona-swap case ("just makes the widget speak 'Einen Moment...' on top of her") — extended the same suppression to `hasHeardNothingYet = (session.turn_count||0)===0`; `resendGreetingIfStuckAtZeroTurns`'s actual recovery is untouched. 4 new characterization tests (source-check pattern, matching `zero-turn-greeting-recovery-not-silenced`) + 3 new widget tests + 1 existing widget test updated (`_hide()` must NOT appear in the guided-close block anymore). Full suite 672/673 suites (1 pre-existing skip), 12913/12948 tests passing, `tsc --noEmit` clean; companion `vitana-v1` change (`useOrbVoiceWidget.ts`/`orbActivate.ts`) verified with `tsc --noEmit` + full `vitest run` (20/20 suites, 110/110 tests). **Not yet independently confirmed against live traffic** — same honest caveat as every row in this chain, plus the still-fully-open, still-unroot-caused `nova_validation` flakiness that makes a retry necessary on nearly every guided-topic tap in the first place. | VTID-03685 |
| 2026-08-19 | **VTID-03666's `ci_vital_systems_health()` RPC was live in production for under 10 minutes before manual invocation caught it flagging German as an "incomplete" GA locale on the My Journey coverage check — a false positive that would have fired on every single morning run, forever.** Verified live immediately after applying the migration: `journey_checklist_incomplete_ga_locales` reported `{"locale":"de","complete_rows":0,"expected":254}`. Root cause: `journey_checklist_translations` and `nav_catalog_i18n` do not treat German the same way, and the original query assumed they did. Confirmed by direct query: `nav_catalog_i18n` has `lang='de'` → 291/291 rows, full parity like every other populated locale; `journey_checklist_translations` has `locale='de'` → only 4 rows, not 254. German is the checklist's SOURCE language — the base topic content is authored directly in German outside this overlay table (`applyTranslations()` in `services/gateway/src/services/guided-journey/checklist-service.ts` only consults the overlay for other locales), and the 4 `de` rows that exist are legitimate explicit overrides permitted by migration `20260613114737_allow_de_locale_in_journey_checklist_translations.sql` — not a partial translation set. The original check excluded only `en` (the canonical reference) from the completeness comparison, so `de` — `status='ga'` like every shipped locale — was compared against the full 254-row `en` count and would have reported critically incomplete every morning regardless of real translation state, which is exactly the kind of false alarm this whole rebuild (VTID-03666) was meant to eliminate, not add. **Fix:** `journey_checklist_incomplete_ga_locales` now excludes `de` alongside `en` (`sl.code NOT IN ('en', 'de')`), with the reasoning recorded inline so a future reader doesn't "fix" it back. `nav_catalog_incomplete_ga_locales` is deliberately left untouched — German is genuinely a normal, fully-populated locale there. Caught and fixed within the same session that shipped VTID-03666, before the corrected RPC was ever exercised by a real scheduled run — the manual `SELECT ci_vital_systems_health();` smoke check that caught this is now the standing verification step for any future edit to this function. | VTID-03679 |
| 2026-08-18 | **Rebuilt MORNING-SYSTEM-HEALTH-CHECK.yml for the AWS/Aurora era and extended it from 15 to 21 checks — the two check-13/15 failures reported this morning were both real, and both were signals the check itself was stale, not that anything vital was actually down.** Check 13 ("Maxina STAGING reachability") pointed at `preview.vitanaland.com`, which has returned a permanent HTTP 500 since GCP billing was deliberately disabled (VTID-03508) — that Cloud Run host is dead by design, not broken; the live AWS staging frontend has been `preview-aws.vitanaland.com` since VTID-03409/AWS-STAGE-DEPLOY-FRONTEND.yml, and this check had been reporting a fake outage of a decommissioned host every morning since. Check 15 (self-audit) was simply reporting check 13's failure honestly. **Fix for both: pointed the URL at the real AWS staging host.** Separately audited the whole file against what has actually changed since it was written the week gateway/community-app were still on Cloud Run: it had no check for the VTID-03563 standing rule ("Claude always via Bedrock, never the direct Anthropic API" — that account has no credit balance and every call to it silently falls back to Google, which is exactly how 268 such failures went unnoticed for 14 days last time), no check for the 8-language DB-content release that went live this same day (VTID-03515/03580 — `supported_locales` can say a language is `status='ga'` while its `journey_checklist_translations`/`nav_catalog_i18n` rows are partial or zero, which renders German inside an otherwise translated UI with no error anywhere; this already happened once silently to es/sr/fr per VTID-03519), no check for Nova Sonic (ORB voice, promoted to 100% of sessions under VTID-03560, own public health endpoint already existed and nothing was polling it on a schedule), and no regression guard for either of the two VTID-03480/VTID-03516 incidents that were each silently broken for days-to-months before anyone happened to look — both already have their own daily ALERT-*.yml workflow and RPC, now reused here rather than duplicated (ALWAYS 9). New migration `20260818090000_vtid_03666_ci_vital_systems_health.sql` adds one more `service_role`-only PostgREST RPC, `ci_vital_systems_health()`, following the exact transport pattern VTID-03492 established (GitHub runner IPs cannot reach the Supabase DB pooler directly, only PostgREST): it reports any `llm_routing_policy` stage still pointed at `primary_provider`/`fallback_provider = 'anthropic'` (checked across every active policy row, not a guessed `environment` string — `LLM_ROUTING_ENV` is not pinned in any tracked deploy workflow) plus 24h `oasis_events` counts for anthropic credit-balance failures and bedrock/vertex completions; per-locale row counts for `journey_checklist_translations`/`nav_catalog_i18n` against every `status='ga'` locale's canonical `'en'` count; and whether the VTID-03506 notification test-actor guard (`_notif_is_test_actor()` + `trg_suppress_test_actor_notifications`) is still installed and enabled. The workflow now also directly reuses `ci_orb_session_state_health()` and `ci_ledger_integrity_check()` (the RPCs behind ALERT-ORB-SESSION-STATE-HEALTH.yml and ALERT-OASIS-LEDGER-INTEGRITY.yml) and curls `/api/v1/orb/nova-sonic/health` (public, secret-free by construction). The scheduled-workflow self-audit's watchlist grew from 6 to 9 entries — the three newer ALERT-*.yml workflows had never been added, which defeated the point of a check whose entire purpose is catching crons that fail silently. Total checks 15 → 21; the report table, self-audit denominator, and the final pass/fail summary all read from a single `TOTAL_CHECKS` env var instead of hardcoded numbers, closing the exact class of drift (a stale hardcoded count) that made this rebuild necessary in the first place. Verified the new SQL for balanced parens/dollar-quoting and every workflow `run:` block for `bash -n` syntax validity; could not execute the RPC against live Supabase or dispatch the workflow from this session (no `SUPABASE_SERVICE_ROLE`/repo-dispatch credentials available here) — next scheduled run (or a manual `workflow_dispatch`) is the first live confirmation. | VTID-03666 |
| 2026-08-18 | **Swept this file to remove GCP as a direction for new work, following the real GCP shutdown that VTID-03599/VTID-03649 (row below, 2026-08-16) had already executed but this file had never been updated to reflect.** Requested directly by the platform owner: "not a single process is running there [GCP]... no oasis, no autopilot, no agent, nothing." Rewrote Part 1's Infrastructure/Deployment ALWAYS/NEVER/IF-THEN rules from `gcloud`/Cloud Run/Artifact Registry/GCP-project to their AWS ECS/ECR/ALB equivalents; retired the "sanctioned Google dependency for ORB voice" exception (rule 27) now that Vertex Live is permanently dead; rewrote §1 (GCP INFRASTRUCTURE) into a decommission notice and §1b (AWS "DR") into "AWS PRODUCTION — canonical, not DR"; updated §2b/2c/2d/2e to flag that GCP's shutdown is now real, not planned. **Checked the live code while doing this rather than trusting the prose (2026-08-18):** `TTS_PROVIDER`'s and `IMAGE_PROVIDER`'s own internal fallback constants are still `'google'`/`'vertex'` when the env var is unset — now a hard failure risk rather than a safe default, since GCP is off; flagged in §2c/§2d as an open follow-up (flip the code default, or confirm the AWS task defs already set these explicitly — this pass could not verify live AWS env state). Also surfaced two **live gaps this pass did not fix**: (1) `vitana-v1`'s `useTextToSpeech.ts`/`VoiceSettingsPanel.tsx` still call Google edge functions (`google-gemini-tts`, `google-cloud-tts`) directly, bypassing the gateway's Polly seam entirely — with GCP off this is a live outage for any user with a stored Google voice preference, and the sole path Serbian TTS ever had; (2) Nova Sonic's premature-close mitigation (VTID-03502, §2e) reconnected to Vertex Live, which VTID-03649 already patched behind a `VERTEX_LIVE_UNAVAILABLE` flag — but that flag only takes effect once set on the live task definition, unverified from this repo. **Deliberately left alone:** the CHANGE LOG below this entry is a historical record and was not rewritten — GCP is named throughout it because that is what was true at the time each row was written; only the file's forward-looking rules and reference sections were brought current. Full report of every section touched given to the user in-conversation, not duplicated here. | (docs cleanup, no VTID — see IF-THEN rule 1/§4.1; no gateway/DB access from this session to self-allocate one) |
| 2026-08-18 | **VTID-03675 shipped and correctly resent `guided_topic_id` on a client-side retry — but the retry ALSO legitimately set `reconnect_stage`, which fed a second, independent suppression the provider had had since VTID-03290: reported live as "now it talks generally about the My Journey screen, not the selected session, and completes the entire session, not just that step."** Traced live via `oasis_events` (topic T003, right after VTID-03675 went to prod): the first client session (`live-513be0bc...`) won the guided-topic candidate correctly (`wake_opener:override_v2`, `prompt_len:227`) and was `nova_validation`-rejected twice — identical shape to the T017/T015 incidents, still unroot-caused. A THIRD client session (`live-008e054c...`, ~3s later) then actually delivered audio and completed a turn — but its `greeting_sent` carried **no `wake_opener` at all** (not `override_v2`), and a `tool_call` fired mid-turn — consistent with a generic, route-aware ("what screen are you on") provider winning instead of the guided-topic one. Root cause: `guided-topic-narration.ts`'s `produce()` unconditionally suppressed (`forced_skip_reconnect`) whenever `isReconnect` was true, on the theory "the previous turn is still alive — don't re-open." `isReconnect` here is `orb-live.ts`'s `isReconnectStart`, computed in `live-session-controller.ts` as `reconnectTranscriptHistory.length>0 || reconnectStage!=='idle'` — set whenever the WIDGET sends `reconnect_stage`/`transcript_history` on its start payload, which it does for ANY reconnect after a detected disconnect, for entirely separate reasons (conversation continuity across a transport hiccup). VTID-03675's fix meant this retry now correctly carried `guided_topic_id` for the first time in this failure's history — and immediately walked into this second, previously-unreachable suppression, since prior to VTID-03675 a reconnect could never have carried `topicId` at all (nulled before any retry could see it), so this branch had never actually fired outside its own unit test. **Fix:** removed the `isReconnect` suppression from `guided-topic-narration.ts` entirely. The wake-brief pipeline that invokes this provider runs exactly once per `session_id` (at session start, never re-run for same-session server-internal Nova retries), and the widget only ever sends `guided_topic_id` while the topic genuinely has not been delivered yet (cleared on delivery or on close, per VTID-03675) — so by the time this provider ever sees a `topicId` on a reconnect-flavored request, "isReconnect" can only mean "retrying a topic that was never taught," never "resuming a lesson already in progress." There is no live case left for the old branch to protect. `isReconnect` stays on the type (still forwarded, still computed) but is no longer read by `produce()`. Updated the one test that had encoded the old (now-proven-wrong) suppression as expected behavior — it now asserts the candidate still LEADS turn-1 with `isReconnect: true`. Full suite 670/671 suites (1 pre-existing skip), 12906/12941 tests passing, `tsc --noEmit` clean. **Not yet independently confirmed against live traffic** — same honest caveat as every row in this chain, plus the still-unresolved, still-separate `nova_validation` flakiness that makes a retry necessary in the first place. | VTID-03677 |
| 2026-08-18 | **GCP project `lovable-vitana-vers1` has NO LINKED BILLING ACCOUNT — confirmed live via the GCP Console ("This project has no billing account") — which is why the VTID-03656 fix could not actually be completed: `gcloud scheduler jobs create` for `gateway-push-dispatch` requires active billing and fails on this project today.** This contradicts a great deal of this file's own documented state: §1b and the AWS-DR table describe GCP as "canonical production for every service except gateway and community-app," several ALWAYS/NEVER/IF-THEN rules in Part 1 instruct "Always use GCP project `lovable-vitana-vers1`," and multiple 2026-08 changelog rows above this one report live `gcloud`/Cloud Run verification against this same project. **None of that is re-verified here** — this entry only confirms the billing account is unlinked as of 2026-08-18; whether existing GCP resources (Cloud Run services, existing Cloud Scheduler jobs, `oasis-projector`/`worker-runner`/`verification-engine`/`orb-agent`, all still documented as GCP-canonical) are still actually running, or have been suspended/degraded by the missing billing account, is **unverified and unknown** — this session has no `gcloud` access to check. Explicit direction from the platform owner: move to AWS instead of restoring GCP billing. **Scoped fix landed here (VTID-03676):** `scripts/aws/setup-eventbridge-push-dispatch.sh` — an AWS-native replacement for just the `gateway-push-dispatch` job, using EventBridge Scheduler + an EventBridge API destination (no compute) to POST to `gateway.vitanaland.com/api/v1/scheduled-notifications/push-dispatch` every minute, mirroring what the GCP job did as closely as AWS's primitives allow. **Not yet run or verified against a live AWS account** — this session has no AWS CLI credentials; the script is a best-effort draft against documented AWS CLI syntax, flagged for whoever runs it to report back any command errors. **Explicitly NOT in scope here:** the other ~25 GCP Cloud Scheduler jobs in `scripts/setup-cloud-scheduler.sh` (the AP-XXXX automation registry jobs, the memory-intelligence jobs, the tenant-scoped daily jobs) hit the exact same missing-billing blocker and are equally unable to be created/updated on GCP right now — they are NOT migrated by this VTID and should be assumed broken until someone confirms otherwise; a full GCP→AWS scheduler migration is a separate, larger follow-up. **Follow-up same VTID, verified live 2026-08-18:** EventBridge Scheduler does NOT support invoking an EventBridge API destination directly via `Target.Arn` — confirmed via a real `ValidationException` ("Provided Arn is not in correct format") against a syntactically-correct, freshly-minted api-destination ARN, on a live run in `eu-central-1`. That capability belongs to EventBridge Rules/Pipes, not Scheduler; the API destination + connection approach was abandoned. Rebuilt on Lambda-as-target instead (a first-class, unambiguous Scheduler integration): a small Node.js function does the actual HTTPS POST, invoked by the schedule every minute. Confirmed firing via CloudWatch logs (`/aws/lambda/vitana-push-dispatch`) and the real backlog draining 1020 → 0 *reachable* rows within the 48h window. **New finding, also resolved:** the ~3 real days between outage discovery and the fix actually landing (GCP billing dead-end → AWS pivot → script debugging) pushed the *oldest* ~16h of the original backlog (2026-08-15 18:52 → ~16:00 next day) past the 48h lookback cutoff by the time the scheduler started running — 394 rows landed permanently unreachable by the current window, confirmed via `unsent_AGED_OUT_of_window`. Platform owner decision: leave them unsent rather than widen the window further — a push for a 3-day-stale "new post" event reads as noise, and those rows remain visible in-app regardless (`push_sent_at` only gates the push alert, not in-app delivery). VTID-03676 terminalized `success`. | VTID-03676 |
| 2026-08-18 | **VTID-03674's plain trigger still got `nova_validation`-blocked sometimes, and when it did, the widget's own reconnect silently threw away the guided topic — a third, independent defect in the client, not the prompt.** Reported live again by the user after VTID-03674 shipped: "not fixed, it just says: Let's continue from where we left off... after it said: Let's continue..." with a screenshot of the "Well done! You just completed this session" drawer for a topic Vitana never actually taught. Traced live via `oasis_events`: topic T017 ("Profil-Grundlagen" / Profile Basics) produced **three distinct `session_id`s within 5 seconds**. Session 1 (`live-92addc94...`) correctly won the guided-topic candidate (`wake_opener:override_v2`, `prompt_len:225` — the VTID-03674 plain-trigger shape, confirming that fix is live and working as designed) and was rejected by Nova's `nova_validation` content filter TWICE in a row on the byte-identical prompt (same `decision_id`, same `prompt_len` both times) — the server's own internal retry (`resendGreetingIfStuckAtZeroTurns`/VTID-03557-retry) correctly resent the SAME guided-topic line both times, so the plain-trigger fix was never the gap; Nova's block on this exact benign 225-char prompt is evidence the content-filter behavior is at least partly non-deterministic, independent of trigger wording — an open question this VTID does not resolve. What actually broke the user's session: once the server gave up retrying and the WS died, the **widget's own client-side `_attemptReconnect()`** (a different mechanism from the server-internal retry — it tears the connection down and calls `_sessionStart()` fresh) started two more brand-new sessions, and NEITHER carried `guided_topic_id` — confirmed by `orb.livekit.next_action.*` telemetry showing exactly one `guided_topic:T017` candidate/suggested pair in the whole window, tied only to session 1. Root cause in `orb-widget.js`: `focusGuidedTopic(topicId)` arms `_s.guidedTopic` as a one-shot value, and `_sessionStart()` read-then-immediately-nulled it the instant it built the FIRST payload — before knowing whether that attempt would even succeed. The server-internal retry (same session object, `session.guided_topic_id` already stored server-side) was never affected by this; only the CLIENT's own `_attemptReconnect()`, which calls `_sessionStart()` as a fresh top-level call, was — and by then `_s.guidedTopic` was already gone. Session 3 (`live-e0ae5329...`) therefore ran the normal (non-guided) ladder, landed on a much longer, generic prompt (`prompt_len:655`, no `wake_opener` tag at all — a different rung entirely) that produced "let's continue" wording, and succeeded (`model_start_speaking`/`turn_complete`) — but `_s.guidedAutoClose`, armed together with the now-lost `_s.guidedTopic` back in `focusGuidedTopic`, fires unconditionally on ANY first turn completing, so the overlay auto-closed and revealed the My Journey "session completed" drawer as if the (never-delivered) lesson had happened. **Fix:** `_sessionStart()` no longer nulls `_s.guidedTopic` after reading it — it now lives until the guided turn actually completes (cleared alongside `_s.guidedAutoClose` at the SAME existing turn-complete auto-close point, so the two flags can no longer drift apart the way they did here) or the overlay is closed via `_hide()` (also cleared there, so a never-delivered topic can't leak into a later, unrelated session). A client-side `_attemptReconnect()` retry now naturally resends the still-armed `guided_topic_id`, matching the server-internal retry's existing behavior. 5 new static-source-check tests (`orb-widget-guided-topic-reconnect.test.ts`, same pattern as the sibling `orb-widget-failed-start-recovery.test.ts` suite — the widget is a plain IIFE with no export surface) pin: the payload block no longer nulls the field, `_attemptReconnect` doesn't clear it either, both flags clear together at turn-complete (in the right order, before `_hide()` runs), `_hide()` clears both, and `focusGuidedTopic` still arms both together. Full suite 670/671 suites (1 pre-existing skip), 12906/12941 tests passing, `tsc --noEmit` clean. **Not yet independently confirmed against live traffic** — same honest caveat as every row in this chain, plus a residual open question this does NOT resolve: Nova rejected an identical, already-fixed 225-char prompt twice with no content-based explanation, so the underlying `nova_validation` flakiness itself is still unroot-caused and this fix only stops that flakiness from silently losing the topic instead of retrying it correctly. | VTID-03675 |
| 2026-08-18 | **VTID-03665's fix landed correctly but a real production session STILL showed the same "regular conversation, no lesson" symptom — root-caused to a second, independent defect: a special guided-topic trigger wrapper that Nova's content filter rejects regardless of length or content.** Reported live by the user tapping a My Journey session on the mobile app. Traced via `oasis_events`: THREE `vtid.live.session.start` events fired for the same user within 90 seconds — the middle one (topic T015, "Datenschutz-Kontrolle") shows the guided-topic candidate winning the ranker correctly (priority 96) with `user_facing_line_chars:103` — proof VTID-03665's short-opener fallback fired exactly as designed — and STILL hit `code:nova_validation, diagnostic:"This request has been blocked by our content filters."` on a mere **370-character** prompt. That length (down from the ~1600-1900 chars the original bug reproduced at) is decisive: the block was never about lesson length or curriculum subject matter (T015's script is an innocuous privacy-settings blurb; T251's, checked in parallel, is a benign community-welcome message — neither remotely "unsafe"). What both the short opener AND the old full lesson shared is `compute-greeting-decision.ts`'s `guidedTeachTrigger` — a SEPARATE, more forceful wrapper template used only for guided-topic candidates ("Say the following lesson to the user in fluent English. The text may be in another language — translate it faithfully and completely into English and speak ONLY that translation, then stop and listen. Do NOT summarize, shorten, add a greeting, or ask a question: ...") instead of the plain trigger every other provider (Teacher, Journey Guide, login-briefing) uses successfully ("Say exactly: ... — ONE short utterance only. Do NOT add a greeting before..."). That special wrapper was built when `safe` was the entire raw lesson and needed a forceful verbatim-recitation instruction to hold up under native-audio's preference for short direct turns (VTID-03293) — but VTID-03650/03665 already made `safe` a short, PRE-TRANSLATED line (`buildGuidedTopicPostNarrationLine`/`buildGuidedTopicNarrationOpenerLine` both localize to the session's own `lang` internally), so telling the model "this text may be in another language, translate it faithfully" about text that is ALREADY in the target language reads as a confusing or adversarial instruction pattern — plausibly why Nova's guardrails treat it differently from the plain "say exactly this" template every other rung uses without incident. **Fix:** deleted `isGuidedTeach`/`guidedTeachTrigger` entirely; guided-topic candidates now render through the exact same `wakeTriggerByLang[ctx.lang]` template as every other override_v2 candidate — no special-casing left to diverge, and the `LOCALE_ENGLISH_NAME`/`resolveLocaleStrict` imports it alone needed are removed. Updated the golden snapshot test (`compute-greeting-decision.golden.test.ts`) to assert the new plain-trigger shape instead of the old "fluent English"/"translate" wording. Full suite 669/670 suites (1 pre-existing skip), 12901/12936 tests passing, `tsc --noEmit` clean. **Not yet independently confirmed against live traffic post-deploy** — same honest caveat as every row in this chain: watch for the next real guided-topic tap to actually get taught the topic rather than opening generic conversation, and watch whether `nova_validation` content-filter blocks on guided-topic sessions drop to zero. | VTID-03674 |
| 2026-08-17 | **Reported "no one is getting push notifications for posts" — `/push-dispatch`, the only delivery path for DB-trigger notifications (new post/video, like, comment, follow, mention), silently stopped succeeding 2026-08-15 ~18:52 UTC and never resumed.** Verified live via read-only query against production: `community_post_published` push delivery ran fine for 7000+ rows, then `push_sent_at` stopped advancing entirely — 782 unsent as of 2026-08-17, plus a smaller backlog of `post_like`/`post_comment`/`message_reaction`. Everything dispatched *synchronously* by other scheduled-notifications.ts handlers (`feature_announcement`, `new_chat_message`, `morning_briefing_ready`, `daily_pace_check`, etc.) kept delivering fine through 08-16/17 — that isolates the fault to this one cron/scheduler path, ruling out a global FCM/Appilix credential or preference-default problem. **Two compounding defects, both fixed here:** (1) the route's query only ever looked at notifications created in the last 5 minutes, so once the scheduler missed an invocation, everything older was orphaned PERMANENTLY — even after the scheduler resumed, those rows could never be picked up again. Widened to a 48h lookback (still capped, still ordered oldest-first, still 100/call) so a multi-day outage is recoverable instead of silently unrecoverable, plus a `console.warn` when the oldest picked-up row is older than the old 5min window, so a future stall is loud in logs immediately rather than needing someone to notice missing pushes. (2) `push-dispatch` was **never registered in `scripts/setup-cloud-scheduler.sh`** — whatever Cloud Scheduler job was calling it before this VTID lived only in live GCP state, invisible to this repo, the identical "wiring existed only in live state" trap VTID-03513/VTID-03551 already hit for other systems. Added it to `DIRECT_JOBS` at `* * * * *` (also corrected the route's stale "every 30 seconds" comment — GCP Cloud Scheduler's standard cron format cannot go below 1-minute granularity, so that claim was never actually achievable via this script). Added `ALERT-PUSH-DISPATCH-HEALTH.yml` (20-min PostgREST poll of `user_notifications` for growing unsent-push backlog / stale oldest-row age) so a recurrence surfaces within an hour, not 40+. **Not yet resolved: the actual live Cloud Scheduler job.** This session had no `gcloud`/AWS CLI credentials to inspect or restore whatever was (or wasn't) invoking `/push-dispatch` before — that is the one remaining action needed to resume real delivery, and it's an infra action outside this session's reach; someone with GCP access needs to run the updated `setup-cloud-scheduler.sh` (or otherwise confirm/recreate the `gateway-push-dispatch` job) before the code fix above can take effect on the 782+ row backlog. **Follow-up same VTID:** `setup-cloud-scheduler.sh`'s `GATEWAY_URL` default still pointed at the retired GCP Cloud Run gateway (`gateway-q74ibpv6ia-uc.a.run.app`) — a rollback target no user reaches since the VTID-03419 AWS cutover, not `gateway.vitanaland.com` — so running the script with defaults, including for the `push-dispatch` job just added, would have created a Cloud Scheduler job POSTing to the wrong host and doing nothing for real production traffic. Default corrected to the AWS gateway; the old Cloud Run URL is still reachable via `--gateway`/`GATEWAY_URL` for anyone deliberately targeting the rollback instance. Cloud Scheduler itself still has to run on GCP regardless — there is still no AWS equivalent (open gap noted in the 2026-07-31 draft cutover spec) — this only fixes which host it calls. | VTID-03656 |
| 2026-08-16 | **VTID-03650's Polly fallback was itself the still-open defect: live production evidence showed Polly never once succeeded, so every guided-topic session kept hitting the exact "say this whole lesson word-for-word" trigger VTID-03647/03648 had already proven Nova and Vertex both reject — reported again as "clicking a session doesn't activate it, regular Orb communication starts."** Traced live via `oasis_events`: a guided-topic candidate won the turn-1 ranker correctly (`orb.livekit.next_action.candidate`, `winner:true`, priority 96, `dedupe_key:"guided_topic:T253"` — that topic prefix is a legacy naming artifact of the shared telemetry allowlist, not evidence of the LiveKit transport) with `user_facing_line_chars:1625` — the FULL raw `voice_script`, not the short post-narration line — and **zero** `guided_topic_audio_bridge_sent` events anywhere in the prior 2 days. Every layer between the frontend tap (`orbActivate.ts` → `VitanaOrb.focusGuidedTopic` → `orb-widget.js`'s WS `start` frame → `ws-start-adapter.ts` → `live-session-controller.ts` → `wake-brief-wiring.ts`) was independently verified correct — `guided_topic_id` reaches the backend and the provider wins the ranker every time. The break was `guided-topic-narration.ts`'s OWN Polly-failure branch: VTID-03650 correctly stopped feeding the raw script to the model on the Polly-SUCCESS path, but its Polly-FAILURE fallback was `buildGuidedTopicSpokenLesson()` — the unmodified VTID-03293 mechanism, i.e. exactly the payload already proven unreliable. A working Polly call was never a safe precondition for correctness; it was only ever meant to be a nicer delivery mechanism for the same lesson, and this session's environment apparently can't reach Polly (unverified IAM/`polly:SynthesizeSpeech` permission per VTID-03495's own build-time caveat, or another config gap — no AWS CLI access from this session to confirm directly). **Fix:** the Polly-failure fallback now uses the SHORT, DIRECT opener line (`buildGuidedTopicNarrationOpenerLine` — "Let's talk about '<topic>' — I'll walk you through what it is and how it helps you", already proven reliable since every other continuation provider speaks a short line this exact same way) instead of the raw script, and lets the pre-existing GUIDE-MODE (TEACH) system-instruction block (`buildGuidedTopicNarrationBlock`'s legacy branch, unchanged) do the actual teaching in the model's own words from the material as reference — the SAME teaching mechanism the Polly-success path already uses via its post-narration follow-up, just without pre-recorded audio. This finally removes the "say a large literal block verbatim" pattern entirely, regardless of whether Polly works — Polly succeeding now only changes WHICH short line opens the turn and whether pre-recorded audio plays underneath it, never whether the model is asked to recite curriculum text. `orb-livekit.ts` reads the identical `picked.userFacingLine` from the same shared candidate, so its `session.say()` opener is fixed by the same change with no separate edit needed. 4 tests updated (the "byte-for-byte VTID-03293" assertions replaced with assertions that the short opener is used and the raw script text is absent from `userFacingLine`); full suite 669/670 suites (1 pre-existing skip), 12901/12936 tests passing, `tsc --noEmit` clean. **Still not independently confirmed against live traffic** — same honest gap as every prior row in this chain: the next real signal is either `orb.guided_topic.audio_bridge_sent` finally firing (if the Polly permission gap gets fixed separately) or, regardless of Polly, the reporting user's next tap actually being taught the topic instead of opening generic conversation. | VTID-03665 |
| 2026-08-16 | **Root-cause fix for the VTID-03644/03647/03648 chain: stopped asking a conversational model to read curriculum text at all.** Explicit user directive after VTID-03648's kill-switch: "fix it... only nova and polly by aws" — no Vertex, and the lesson content itself must actually work. Both prior attempts treated this as a ROUTING problem (which provider should read the lesson); the real defect is that ANY conversational model asked to read a specific pre-authored text has its own judgment about whether to comply — Nova refused via its content-safety filter (34 blocks/3 days), and the identical text, rerouted to Vertex, was ALSO rejected (`upstream_ws_close` 1007). **Fix: stop routing curriculum content through a conversational model at all.** New `services/gateway/src/services/tts/guided-topic-narration-audio.ts` synthesizes the guided-topic `voice_script` via Amazon Polly directly (`synthesizePolly`, bypassing the `TTS_PROVIDER` gate deliberately — this call site is Polly-only, unconditionally, because falling back to a second judgment-bearing pipeline would reproduce the exact defect this exists to eliminate) — chunks text over Polly's 3000-char synchronous limit on sentence boundaries and concatenates the headerless PCM buffers, since a script over ~2000 chars was already observed live. `guided-topic-narration.ts` (the continuation provider) now attempts this synthesis BEFORE deciding the turn-1 spoken line: on success, the model's turn-1 line shrinks from the full lesson text (`buildGuidedTopicSpokenLesson`, the VTID-03293 mechanism that fed Nova/Vertex the risky payload as a literal "say exactly this" turn) to a short, safe post-narration follow-up (`buildGuidedTopicPostNarrationLine`, "any questions, or ready to practice?"), and the turns-2+ system-instruction block (`buildGuidedTopicNarrationBlock`) drops the raw `voice_script`/explanation material entirely, replaced with a short "you already narrated this via audio, don't repeat it" instruction — the raw curriculum text now NEVER re-enters the conversational model's prompt on the success path. On Polly failure (unsupported language, API error) `content.narrationAudio` stays null and every downstream branch is BYTE-FOR-BYTE the pre-existing VTID-03293 behavior — no regression for the case this can't cover yet. The actual audio dispatch (`sendGuidedTopicNarrationAudioBridge` in `routes/orb-live.ts`) plays it to the client directly — mirroring the existing `sendGreetingAudioBridge` SSE pattern but extended to the WS transport too (which never had ANY pre-greeting audio bridge before this), wired at both WS `audio_ready` call sites (the primary ack and the 1s-timeout fallback) plus the SSE session-start path, always before the live model's own first turn, one-shot per session (a reconnect never replays it). **Nova only, as directed — the VTID-03647/03648 Vertex-fallback machinery is untouched but now far less likely to ever fire for guided-topic sessions**, since the payload that was tripping it is gone from the prompt on the Polly-success path; VTID-03648's kill switch (`ORB_GUIDED_TOPIC_VERTEX_FALLBACK_ENABLED`, default off) stays exactly as it was. 37 new tests across three files (`guided-topic-narration-audio.test.ts` — text assembly, chunking, Polly-only routing, whole-narration-fails-on-any-chunk-failure; `guided-topic-narration-prompt.test.ts` — the post-narration line + block branch, asserting the raw script text is verifiably ABSENT once narrated; a characterization test for the orb-live.ts wiring, matching this file's established pattern for testing that massive/stateful module) plus updates to the existing provider test asserting the Polly-success and Polly-failure branches both behave as specified. Full suite: 662/663 suites (1 pre-existing skip), 12781/12816 tests passing, `tsc --noEmit` clean. **Not yet independently confirmed against live traffic** — same honest caveat as VTID-03647: the next step is watching `orb.guided_topic.audio_bridge_sent` in `oasis_events` and, ideally, a real user confirming the lesson audio is now what they actually hear. | VTID-03650 |
| 2026-08-15 | **The proactive conversation flow was gone because the rich briefing could not fire on ANY production session, and the one opener left standing was instructed to dead-end.** Reported as: Vitana opens voice with "ich zeige dir die neuesten Nachrichten" and then drops into listening mode — no content, no proposal, no confirmation. Three independent defects stacked, and fixing any two still leaves the report true. **(1) The briefing guard required a first name production never has.** `shouldAttemptNewdayOverview()` demanded a non-empty `ctx.firstName`. That name comes from the greeting-facts prefetch, which `live-session-controller.ts` (L1101) gates on `isFeatureLive('ORB_SAFE_FAST_GREETING')` — and that flag is **`staging-only`** (`STAGE-DEPLOY.yml` L189), so in prod the prefetch never runs and `session.greetingFirstName` is permanently null. Measured: **every** `newday_briefing_eval` on 2026-08-15, across all users/languages/timezones, reports `outcome:guard_rejected` with `briefing_due:true`, `not_first_time:true`, `not_onboarding:true`, `has_first_name:false`, `facts_ready_awaited:false`, `last_full_briefing_date:null`. One conjunct rejected 100% of briefings. **The name was never load-bearing for the CONTENT** — `buildNewDayOverviewBlock` takes `firstName: string | null` and has always had an explicit unknown-name branch ("do not invent one; address user warmly without name"). Guard now drops it; the `(ctx.firstName as string).trim()` cast that was only safe *because* the guard rejected null goes with it. Every other guard (already-briefed-today, onboarding, first-time, user/supabase) is unchanged and pinned. **(2) The rung was ALSO kill-switched off, on a theory its own follow-up disproved.** VTID-03628 disabled `newday_overview` believing its content tripped Bedrock's filter; VTID-03629 then recorded that the rung "was already being rejected by its own guard (missing first name) before it could even fire" — i.e. a rung that was not running was blamed and disabled. Prod agrees: **zero `newday_overview` events have ever been recorded**, before or after. And the blocks did not stop — `stage=upstream_error` still carries "blocked by our content filters" on 08-14 (x2) and 08-15 (x1), days after both rungs went dark. **VTID-03647, landed on main the same day, independently confirms this from the other end**: it traced 34 content-filter blocks over 3 days to the *guided-topic narration* system instruction and routes that case to Vertex — a different code path entirely, which is why disabling the greeting rungs never moved the number. `ORB_NEWDAY_OVERVIEW_RUNG_ENABLED` therefore defaults **on** again (`!== 'false'` — the lever is kept, only its default flips). **`day_close` deliberately stays default-OFF**: it is the rung actually observed firing and being blocked (14 events on 08-13, prompt_len 4202), it only fires at local_hour 0-4, and it is not implicated in this report. **(3) `override_v2` — the ONLY opener any session now reaches (24 of 24 `wake_opener` events in 4 days) — was instructed to dead-end.** Its per-language trigger said: *"Say exactly: <line> — ONE short utterance only. No greeting before. **NO QUESTION AFTER.** Do not paraphrase."* That is the reported behaviour verbatim, and it is not the model disobeying — it is the directive. The provider line is a LEAD, not the turn. Replaced with a three-beat contract: **SUBSTANCE** (say what is going on, never announce an intention you do not carry out in the same turn) → **NEXT STEP** (propose one concrete move yourself; never ask what the user wants, never offer a menu) → **CONFIRMATION** (close so they can just say yes). Concrete facts from the lead — numbers, names, dates — stay pinned, nothing invented. Written as one **English INTENT** per NEVER-rule 41 / §13b, which also retires a 10-entry per-language wrapper map that had already shipped missing pt/pl once (VTID-03644). **Guided-teach candidates deliberately do NOT get the three-beat contract** — a tapped Journey topic is an authored lesson, and the teaching happens on turns 2+ from the GUIDE-MODE block, so turn 1 only opens. **Corrected when this branch was merged with main:** this row originally said the guided branch was *untouched*, which stopped being true — **VTID-03674** deleted the guided-only "translate it faithfully and completely" wrapper on live evidence (Nova's content filter blocked a 370-char prompt built from it around an already-short, already-localized opener line), falling guided candidates back to the plain per-language trigger this VTID then replaced. Guided candidates now get a plain short-utterance opener instead: telling the model to propose a next step and ask for confirmation before it has taught anything is precisely the skip-ahead **VTID-03686** had to forbid in that block one day earlier. The deleted wrapper is not reintroduced by any route, and the tests assert its absence rather than merely its replacement. **Worth keeping:** the golden snapshot suite pinned the dead-end directive as correct behaviour, and the characterization test pinned the two verbatim wrappers *by their literal text* — both were re-recorded deliberately rather than worked around, and the characterization test now pins the invariant it exists for (the rung lives in the brain, not the transport) instead of the implementation string. 12 new regression tests, **mutation-verified**: restoring the firstName guard fails 3, restoring the verbatim directive fails 3. Full suite 659/659 suites, 12,743 passing, 0 failures; `tsc --noEmit` clean. **NOT fixed here, and it is the next thing to look at:** `FEATURE_ORB_SAFE_FAST_GREETING` being `staging-only` means the prefetch — first name, last-session info, `lastFullBriefingDate`, `lastDayCloseDate`, `recentNbaKeys`, the proactive line — is dead in production entirely. This VTID makes the briefing survive that; it does not restore the facts themselves, and `last_full_briefing_date:null` on every session means the once-per-day cap is currently anchored on nothing. | VTID-03646 |

| 2026-08-20 | **VTID-03646's own "not fixed here" list, closed out two of three, in the same PR: the staging-only prefetch flag turned out to be a bigger gap than documented, and `day_close` finally got the Nova-aware retry VTID-03629 left as a TODO.** **(1) `ORB_SAFE_FAST_GREETING` was never actually "staging-only" on AWS — checked live in this repo rather than trusting the prior write-up: `FEATURE_ORB_SAFE_FAST_GREETING_ENV` is set on NEITHER `AWS-STAGE-DEPLOY-GATEWAY.yml` nor `AWS-PROD-DEPLOY-GATEWAY.yml`; the only place it is ever set is the dead GCP `STAGE-DEPLOY.yml`.** Since it is absent from `feature-flags.ts`'s `DEFAULT_SETTINGS` map, `isFeatureLive()` resolves the code default, `'off'` — meaning the whole greeting-facts prefetch (first name, last-session info, `lastFullBriefingDate`, `lastDayCloseDate`, `recentNbaKeys`, the proactive line) has been dead on AWS staging **and** prod both, not staging-only as this VTID's own PR body assumed. **Fix, staging only, per explicit platform-owner instruction this round ("everything you do here you are doing it to staging"):** upserted `FEATURE_ORB_SAFE_FAST_GREETING_ENV=staging-only` into `AWS-STAGE-DEPLOY-GATEWAY.yml`'s task-def jq block, same pattern `FEATURE_ORB_GREETING_TTS_BRIDGE_ENV` already uses. `AWS-PROD-DEPLOY-GATEWAY.yml` was deliberately NOT touched — promoting this to prod is a separate, later, human decision (PUBLISH / manual dispatch), not a side effect of this PR. **(2) `day_close` — the Nova-aware retry.** Its own kill-switch comment has said since VTID-03629 that the rung "keeps its unchanged opt-in until a Nova-aware retry (rebuild the opener from reduced content instead of resending identical content) ships for it." Read `buildDayCloseBlock`: ~4200 chars, carrying TWO fully worked quoted-dialogue exemplars (a ❌ and a ✅ for both night phases) — the same shape `nova-instruction-sanitizer.ts` already had to rewrite out of the IDENTITY LOCK block because Nova's filter reacts to persona-voiced quoted speech, and the same shape VTID-03674 proved trips the filter independent of length once it carries that kind of exemplar framing. New `buildDayCloseOpenerLine()` (`day-close-prompt.ts`) states the same intent — warm close, one forward thought or warmth-on-a-hard-day, carry-don't-complete, no recap — in plain English/German with **no quoted exemplar dialogue at all**, at roughly a sixth the length. New `dayCloseReduced?: boolean` on `GreetingDecisionContext` switches `tryDayCloseRung` to the reduced builder; new `shouldRetryDayCloseReduced()` (`orb-live.ts`, same exported-pure-predicate pattern as its `shouldFallbackToVertexOnGuidedTopicContentFilterBlock`/`shouldRetryNovaOnPrematureClose` siblings) arms a one-shot session flag when a `day_close` open gets `nova_validation`-closed specifically — not gated on `!hasProducedAudio` generally, because a `day_close` open that dies for an unrelated transport reason should get the SAME directive back, not a shrunk one that misattributes the failure to content it never had anything to do with. Deliberately does **not** decide whether a retry happens at all — that is still entirely the pre-existing `shouldRetryNova`, unchanged; this only decides what the resend rebuilds. If the reduced retry ALSO gets blocked, the existing `alreadyRetried` gate stops a second attempt and control falls through to the pre-existing VTID-03502 Vertex-fallback path, which (with `VERTEX_LIVE_UNAVAILABLE=true`) reports the honest `connection_issue` signal rather than looping — no new failure mode added. `_dayCloseRungEnabled`'s default was deliberately left OFF — shipping the mechanism is not the same claim as "it works," and flipping the default is a separate decision for once this is observed against real Nova traffic. 12 new predicate tests (mutation-style — every guarding condition negated individually) + 14 new day-close-prompt/decision tests (reduced-vs-full length and content, name/no-name, hard-day, locale, and that the once-per-night/window/kill-switch guards still hold under the reduced path). Full suite 678/679 suites (1 pre-existing skip), 12,991 tests passing, `tsc --noEmit` clean. **(3) The My Journey teaching flow — explicitly NOT touched.** Read through the whole VTID-03644→03686 chain and this repo's own Nova-vs-Vertex divergence map before concluding this: every deterministic code defect found in that chain is already merged into this branch via `main`; the one thing VTID-03686 (the latest link) still needs is independent confirmation against live Nova traffic that the model actually teaches instead of skipping ahead, which depends on model compliance with a strengthened instruction, not on code this session can write. Manufacturing a further code change here without a new, real defect to point at would be exactly the pattern this whole chain has already been burned by more than once. **Governance note:** did not self-allocate a fresh VTID for this — `vitana-v1`'s CLAUDE.md absolute rule forbids any write to the production Supabase project (`inmkhvwdcuyhnxkgfvsb`, confirmed live to be the only project this session's Supabase access resolves to) with no exception, which is the same project `allocate_global_vtid` would have to write to; per IF-THEN rule 9 ("rules conflict → prefer stricter rule") and the platform owner's own explicit instruction this round, continuing under VTID-03646's existing identity instead, the same way prior sessions with no live DB access have. Nothing in this round deploys anywhere — code changes only, on the `claude/` branch, merge-to-staging-only per §16. | VTID-03646 |

> **Older entries (67, back to project inception) live in `docs/CHANGELOG-ARCHIVE.md`** — full text, unedited, just moved out of the file every session force-loads. This table keeps roughly the last two weeks; anything older is one file open away, not gone.

---

## Mandatory Codebase Intelligence Workflow

Before planning, modifying, debugging, reviewing, or generating code, always query both RepoWise and Graphify. Do not begin implementation from assumptions or broad grep searches.

### 1. Verify index freshness

1. Determine the current repository and Git `HEAD`.
2. Select the correct RepoWise MCP server. Never use an index belonging to another repository or an older checkout.
3. Confirm RepoWise's indexed commit matches `HEAD`.
4. Check for `graphify-out/graph.json`.
5. If either index is missing or stale, update it before implementation:
   - `repowise update`
   - `graphify --update`

Report any indexing failure clearly. Do not silently continue with stale information.

### 2. Read the codebase before execution

Use RepoWise for precise code and health information:

1. Call `get_overview` once to understand architecture, layers, entry points, and key modules.
2. Use `search_codebase` to locate relevant concepts, symbols, and paths.
3. Use `get_context` for compact file and module context.
4. Use `get_symbol` only when full implementation bodies are required.
5. Use `get_why` when architectural decisions or historical rationale matter.
6. Call `get_risk` before changing shared, central, or high-risk files.

Use Graphify for relationships and system-wide reasoning:

1. Run `graphify query "<task-specific question>" --budget 1500`.
2. Use `graphify path "<source>" "<target>"` to trace dependencies or data flow.
3. Use `graphify explain "<component>"` for unfamiliar systems.
4. Pay particular attention to god nodes, community boundaries, dependency paths, and surprising cross-module connections.

### 3. Produce a pre-execution code map

Before editing, establish:

- Relevant entry points and execution flow.
- Files, symbols, modules, and tests involved.
- Upstream and downstream dependencies.
- Existing patterns that should be followed.
- Architectural constraints and recorded decisions.
- Health hotspots, complexity, missing tests, and change risk.
- The smallest safe implementation scope.

Do not start execution until this map is sufficient to explain what will change, why, and what may be affected.

### 4. Minimize token and search waste

- Treat RepoWise and Graphify as the primary navigation layer.
- Do not recursively read directories or perform broad grep searches when an indexed query can answer the question.
- Retrieve compact context first and expand only the exact files or symbols required.
- Do not repeatedly call `get_overview` during the same task unless the index changes.
- Reuse already retrieved results instead of requesting identical context again.
- Raw file reads are allowed only for targeted implementation details, verification, or when an index result is missing, stale, ambiguous, or approximate.
- Source code and tests remain the final authority; never invent a relationship that the indexes or source do not support.

### 5. Validate after implementation

After changing code:

1. Run the relevant tests, linting, type checks, and build.
2. Re-query change risk for the affected files when appropriate.
3. Update both indexes:
   - `repowise update`
   - `graphify --update`
4. Confirm the indexes now match the final Git state.
5. Summarize changed behavior, affected dependencies, risks, and verification evidence.

A task is not complete until the implementation is verified and both indexes are current.

For Graphify's built-in Claude integration, also run once per repository:

```
graphify claude install
```

This workflow improves Claude's navigation speed, token efficiency, and change accuracy. It does not automatically improve application runtime performance—that requires acting on the health and performance findings uncovered by the indexes.
