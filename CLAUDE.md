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

**Restructured 2026-09-22** — the detailed reference sections below moved
to path-scoped files under `.claude/rules/`, loaded automatically only
when a session touches a matching path, so the large amount of
provider/services/deployment reference material stops being force-loaded
into every session regardless of what it's actually working on. This is a
pure move — no section was rewritten or summarized, only relocated.

- **§1, §1b, §8, §9, §11, §12, §15, §16** (GCP decommission history, AWS
  production topology, environment variables, CI/CD workflows, quick
  reference, document references, deployment verification, staging-first
  pipeline) → `.claude/rules/infrastructure.md`
- **§2, §2b–§2e, §3, §6, §7, §10, §13, §13b, §13c, §14** (services
  architecture, LLM routing/Bedrock, TTS/image/voice providers, database,
  OASIS events, worker orchestrator API, coding conventions, server-side
  i18n, commerce vision, memory & intelligence architecture) →
  `.claude/rules/backend.md`

**§4 (VTID System) and §5 (Governance) stay here, unscoped** — VTID
self-allocation and the governance kill switches must apply regardless of
what files a session happens to open in a given turn; gating them behind
a `paths:` glob risks a session that never opens a matching file never
seeing them at all.

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

## CHANGE LOG

**Moved to `docs/CHANGELOG.md`** (recent entries) and
`docs/CHANGELOG-ARCHIVE.md` (older, pre-2026-08-19) — 2026-09-22. This is
an audit trail, not a rule: read it on demand via `get_why`, git
archaeology, or when investigating a past incident, never force-loaded
into every session. Nothing was rewritten or summarized, this is a
straight relocation of the table that used to sit inline here.

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

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
