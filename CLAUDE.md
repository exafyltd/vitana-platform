# CLAUDE.md - Vitana Platform Development Guide
**CANONICAL REFERENCE - Last Updated: 2026-08-19**

This file contains critical information for AI assistants working on the Vitana platform.
**READ THIS BEFORE MAKING ANY CHANGES.**

> **GCP IS FULLY DECOMMISSIONED.** GCP project `lovable-vitana-vers1` billing
> was disabled 2026-08-16 and the GCP `gateway` Cloud Run service was deleted
> the same night (VTID-03599/VTID-03649 emergency response). **Zero Vitana
> processes run on GCP any more — no OASIS, no autopilot, no agents, no
> Cloud Run, no Cloud Scheduler, nothing.** AWS is now the sole cloud for
> every service. This file has been swept to remove GCP as a direction for
> new work; every `gcloud`/Cloud Run/Artifact Registry/GCP-project reference
> below is either replaced with its AWS equivalent or marked historical. See
> the CHANGE LOG entry for this pass for what was touched and what is still
> an open follow-up (a few code-level defaults still fall back toward Google
> when their controlling env var is unset — see §2c/§2d/§2e).

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
27. **IF** you are about to point any stage at `vertex`, Gemini, or any other
    Google Cloud API → **THEN STOP.** There is no sanctioned Google
    dependency left at all. ORB voice used to fall back to Vertex Live —
    that fallback is now permanently dead (GCP billing disabled 2026-08-16
    killed Vertex Live outright, VTID-03649) and voice runs on Amazon Nova
    Sonic exclusively (§2e). Do not reintroduce a Google call anywhere.
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
- **IF** adding a host-header listener rule to `vitana-alb-prod` →
  **THEN** give it priority < 10 — the existing path-based rules (`/api/*`,
  `/ws/*` at priority 10) match before higher-numbered host-header rules
  regardless of `Host`, and will silently route to staging otherwise.
- **Never** assume a service not in the §1b table has AWS infrastructure,
  or that a live AWS resource is governed just because it exists —
  `orb-agent`'s ECS service/task-def predated its own deploy pipeline
  (2026-07-09 bulk-provisioning event, ~17-22 still-unexplained "mystery
  services" from the same event — see `docs/AWS-PRODUCTION-BUILD-LOG.md`).
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
| Every Haiku / Opus profile, `claude-sonnet-5`, `fable-5` | ❌ `AccessDeniedException` (account not subscribed via `aws-marketplace`, not an IAM problem) |
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

**Voice runs on Amazon Nova Sonic exclusively — no working Google speech
fallback exists (see rule 27).** GCP's 2026-08-16 shutdown killed Vertex
Live outright. `VERTEX_LIVE_UNAVAILABLE=true` (`orb-live.ts`) forces Nova
through its own runtime/language gates instead of degrading to Vertex, and
gates the premature-close reconnect (below) onto the honest
`connection_issue` signal instead of a doomed round trip to a dead
endpoint. **This is zero-behavior-change until the flag is actually set on
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
| `personalization_audit` | Cross-domain personalization audit |
| `services_catalog` | Service catalog |
| `products_catalog` | Product catalog |
| `d44_predictive_signals` | Proactive intervention signals |
| `contextual_opportunities` | D48 opportunity surfacing |
| `risk_mitigations` | D49 risk mitigation |

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
IMAGE_PROVIDER=bedrock
BEDROCK_ROLE_ARN=xxx
VERTEX_LIVE_UNAVAILABLE=true
OPENAI_API_KEY=xxx
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

### GitHub PATs for API Access

- **Vitana Platform**: `github_pat_11BI6FN3I0...` (use for PR creation, merging, workflow dispatch)
- **Lovable (Vitana v1)**: `ghp_vCNFyyrr...` (use for Lovable repo access)

Use these PATs with the GitHub REST API (`api.github.com`) for all PR and deployment operations.

---

## CHANGE LOG

| Date | Change | VTID |
|------|--------|------|
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
