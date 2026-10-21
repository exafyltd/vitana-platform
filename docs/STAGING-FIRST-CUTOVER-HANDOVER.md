# Handover: Staging-First Cutover (both repos)

**Created:** 2026-06-04 · **Hard deadline:** Mon 8 Jun 2026, 10:00 CET
**Owner:** d.stevanovic@exafy.io

This is a handover brief for a **fresh Claude Code session that has BOTH repos in
scope**:
- Backend: `exafyltd/vitana-platform`
- Frontend: `exafyltd/vitana-v1` (the consumer "community-app")

A prior session did the discovery below but could only see `vitana-platform`.
Start here — do not re-discover from scratch.

---

## 1. The goal (verbatim intent from the user)

> All development across the system must stop going to the live system. Every
> development must go through the staging system. There is **one button** that
> publishes **everything** to live — that button lives in the Command Hub. We
> must **also** be able, with Claude Code manually, to publish to live as a
> documented **exceptional** rule. Every **auto** deployment goes to staging.

Decoded into hard requirements:

1. **No auto-deploy ever reaches production** — in **both** repos.
2. Every push to `main` (both repos) → deploys to **staging only**.
3. **One PUBLISH button** (Command Hub) promotes **both** backend + frontend
   staging → live, shipping the **exact tested build** (no rebuild drift).
4. **One documented manual escape hatch** so Claude Code / a human can publish
   to live deliberately — the explicit exception, never the default.

The mental model the user wants is the **Lovable preview → publish** workflow:
push freely, it lands on a preview/staging URL, you test it, then one click
ships it live.

---

## 2. Current state — what already exists (do not rebuild)

A "Phase 0" staging stack is already built. Canonical reference:
[`docs/STAGING.md`](./STAGING.md). Key URLs:

|        | Live (prod)                       | Preview (staging)                       |
|--------|-----------------------------------|-----------------------------------------|
| Frontend (community app) | `https://vitanaland.com`          | `https://preview.vitanaland.com`        |
| Backend gateway          | `https://gateway.vitanaland.com`  | `https://preview-gateway.vitanaland.com`|
| Command Hub (operator)   | `gateway.vitanaland.com/command-hub` | `preview-gateway.vitanaland.com/command-hub` |
| Supabase                 | `inmkhvwdcuyhnxkgfvsb` (prod)     | `rsdakjqpvcpgomltdmxu` (Persistent branch `Staging`) |

### Backend (`vitana-platform`) — workflows
- **`.github/workflows/STAGE-DEPLOY.yml`** — ✅ GOOD. On push to `main` under
  `services/gateway/**`, source-builds + deploys **`gateway-staging`** Cloud Run
  service. Sets `VITANA_ENV=staging`, staging Supabase secrets. Smoke-gates on
  `/api/v1/admin/health` returning `env=staging`. No VTID gate. **Keep.**
- **`.github/workflows/AUTO-DEPLOY.yml`** — ❌ THIS IS THE PROBLEM. On push to
  `main` under `services/gateway/**`, `services/worker-runner/**`,
  `.github/workflows/**`, it extracts a VTID and **dispatches `EXEC-DEPLOY.yml`
  straight to PRODUCTION** `gateway` + `worker-runner`. This is the auto-to-prod
  path that must be cut.
- **`.github/workflows/EXEC-DEPLOY.yml`** — governed prod deploy
  (`workflow_dispatch`): VTID hard-gate + governance eval, then
  `gcloud run deploy --source` to prod Cloud Run. Notes:
  - `environment` input is **metadata only**; gateway always deploys to the
    `gateway` service regardless.
  - **No `ref`/`commit_sha` input** — checkout defaults to `main` HEAD.
  - Service case statement (~lines 249–282): `gateway`, `oasis-operator`,
    `oasis-projector`, `vitana-verification-engine`, `cognee-extractor`,
    `worker-runner`. **`community-app` is NOT here.**
  - Keep available for `workflow_dispatch` (the PUBLISH button + manual escape
    hatch both drive it).

### Backend — the PUBLISH machinery (already built)
- **`services/gateway/src/routes/operator.ts`**
  - `POST /api/v1/operator/publish` (~lines 1288–1485): describes
    `gateway-staging`, reads its active revision commit SHA, **bake-time guard**
    (`STAGING_PUBLISH_BAKE_SECONDS`, default 3600s), allocates a VTID, calls
    `deployOrchestrator.executeDeploy({ service:'gateway',
    environment:'production', canary })`. Canary defaults TRUE. Records
    `software_versions` + emits OASIS events.
  - `POST /revert` (~1504), `POST /promote` (~1618), `POST /abort-canary`
    (~1727), `GET /revisions` (~1242). The `/revisions` service whitelist
    (line ~1247) already includes `gateway`, `gateway-staging`, `community-app`,
    `community-app-staging`.
- **`services/gateway/src/services/deploy-orchestrator.ts`** (~line 249):
  dispatches `EXEC-DEPLOY.yml` with **`ref: 'main'` HARDCODED** and **does NOT
  pass the staging commit SHA**. ← **DRIFT BUG** (see §4).
- **Command Hub frontend:** `services/gateway/src/frontend/command-hub/`
  - `app.js` (PUBLISH button ~line 5723), `command-hub-staging.js` (publish /
    canary / revert UI; env detection via `/api/v1/admin/health`),
    `index.html`, `styles.css`.
  - Env awareness: `/api/v1/admin/health` returns `env: 'production'|'staging'`.

### Frontend (`vitana-v1`) — current state (from docs + cross-repo evidence)
- Separate repo, React 18 + Vite 5. Cloud Run services: **`community-app`**
  (prod), **`community-app-staging`** (staging).
- Deploys via **its own `DEPLOY.yml`** on push to `main` → **community-app prod
  directly** (this is the frontend's auto-to-prod path that must be cut). On
  success it fires a `repository_dispatch` (`community-app-deployed`) into
  `vitana-platform`, which triggers `VISUAL-VERIFY-FRONTEND.yml` +
  `E2E-TEST-RUN.yml`.
- `preview.vitanaland.com` → `community-app-staging` via Cloudflare worker
  (`cloudflare/preview-router/worker.js`); `vitanaland.com` → `community-app`.
- **NOT** deployed by `EXEC-DEPLOY.yml`.
- ⚠️ The fresh session must inspect `vitana-v1` directly to confirm `DEPLOY.yml`
  exact triggers, whether a staging deploy workflow already exists, and how
  `community-app-staging` is currently built/deployed.

### Canon that currently contradicts the goal
`CLAUDE.md` **§15, §16, and IF-THEN rules 21–25** actively instruct AI/devs to
manually dispatch `EXEC-DEPLOY` to prod, bump cache-busting on prod, and verify
prod after deploy. These must be rewritten or a future AI session will deploy
straight to prod per current canon.

---

## 3. Workstreams

### A — Backend (`vitana-platform`)
1. **Cut auto-to-prod:** neuter `AUTO-DEPLOY.yml` — remove the `push: main`
   trigger (or convert to `workflow_dispatch`-only) so pushes no longer dispatch
   `EXEC-DEPLOY` to prod. `STAGE-DEPLOY.yml` continues auto-deploying staging.
2. **`worker-runner`:** also frozen from auto-to-prod. It has **no staging twin**
   today → prod updates only via the manual escape hatch until a twin exists.
   (Optional stretch: add a `worker-runner-staging`.)
3. **Manual escape hatch:** add a documented, governed script
   (e.g. `scripts/deploy/publish-to-prod.sh`) that wraps a `workflow_dispatch`
   of `EXEC-DEPLOY.yml` with an explicit `--reason`, clearly labeled as the
   exception. This satisfies "publish to live manually with Claude Code."
4. **Rewrite canon:** update `CLAUDE.md` §15/§16 + IF-THEN 21–25 to:
   "auto = staging only; live only via the PUBLISH button or the documented
   manual exception."

### B — Frontend (`vitana-v1`) — REQUIRES this repo in session scope
1. Add a `STAGE-DEPLOY`-equivalent: push to `main` → **`community-app-staging`
   only**.
2. Neuter `DEPLOY.yml`'s auto-to-prod path.
3. Add a `PROD-PROMOTE` workflow (`workflow_dispatch`) that promotes the
   **tested staging image** → `community-app` (image/digest promotion, no
   rebuild).

### C — One button promotes BOTH (in `vitana-platform` Command Hub)
- Extend `POST /api/v1/operator/publish` so one click promotes **both**:
  - **Backend:** gateway-staging tested commit → `gateway` (with the §4 fix).
  - **Frontend:** trigger `vitana-v1`'s `PROD-PROMOTE` via cross-repo
    `workflow_dispatch`, **or** directly promote the `community-app-staging`
    image to `community-app` via the Cloud Run Admin API.
- Surface both results in the UI + provide a combined revert.

### D — Cutover rehearsal (go/no-go before Mon 10:00 CET)
Push trivial changes to **both** repos → confirm they land on **staging only,
prod untouched** → test on `preview.vitanaland.com` → click **PUBLISH** once →
confirm **both** prod surfaces update → confirm **REVERT** works on both.

---

## 4. Critical correctness fix — "tested = shipped"

Today the PUBLISH path **rebuilds prod from `main` HEAD**, not the exact commit
tested in staging (`deploy-orchestrator.ts:249` hardcodes `ref:'main'`;
`EXEC-DEPLOY.yml` has no SHA input). If `main` advances between staging-deploy
and publish, **prod ships untested code** — which defeats the whole point.

**Recommended fix = image/commit promotion (preferred over rebuild):**
- **Backend:** add a `ref`/`commit_sha` input to `EXEC-DEPLOY.yml` + check out
  that ref, and thread the staging revision's SHA through
  `operator.ts` → `deploy-orchestrator.ts`. (Even cleaner: promote the
  already-built staging image by digest instead of rebuilding.)
- **Frontend:** promote the `community-app-staging` image digest to
  `community-app` — same bits that were tested.

---

## 5. Recommended choices (confirm with user, then proceed)
- **Promotion method:** image/commit promotion (ship the exact tested artifact).
- **Publish gate for Monday:** human SHA-confirm + bake-time (current behavior),
  with staging test results surfaced. Hard "tests must be green" gate = fast
  follow, not a Monday blocker.
- **Single button now, two coordinated promotes under the hood** — acceptable if
  a truly atomic both-or-neither promote is too much for Monday; the UX is still
  one click.

---

## 6. Open items / risks
- **`vitana-v1` access** is the gating dependency for workstream B + the
  frontend half of C. Confirm the repo is in this session's scope before
  starting B.
- `worker-runner` has no staging twin — decide freeze-only vs build-twin.
- Supabase staging branch has known migration drift (`docs/STAGING.md` §9b) —
  relevant if any schema change rides along with the cutover.
- Branch protection on `main` (both repos) so nothing bypasses the staging-first
  rule.

## 7. Suggested order of work for the fresh session
1. Confirm both repos in scope; read `vitana-v1`'s `DEPLOY.yml` + staging setup.
2. Workstream A (backend freeze + escape hatch + canon) — fully in-scope, ship
   as a draft PR on a fresh `claude/` branch.
3. Workstream B (frontend freeze + staging + PROD-PROMOTE) — draft PR in
   `vitana-v1`.
4. Workstream C (wire the single button to both).
5. Workstream D (rehearsal) — the Monday go/no-go.
