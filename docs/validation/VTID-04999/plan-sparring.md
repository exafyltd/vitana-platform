# VTID-04999 — plan sparring record

- Plan Sparring Gate: VTID-04868. Partner: plan-sparring-partner (independent, read-only).
- Change class: standard. Rounds: 2. **Verdict: CONVERGED** (no open or disputed blocker/major).
- Final plan hash (sha256 of the text between the plan markers): `fb0531147b62925ad7e0784f859ace9576931dc5af6137b1cceaa5fd09542128`
- **Owner approval:** 2026-10-08, Gate 1 "Yes" in the Claude Code session (https://claude.ai/code/session_015p5xCULCm9qpV7cEwboKEr). Recorded in the vtid_ledger row metadata (`plan_hash`, `owner_approval`). The approval also records owner decisions P-1 (a backend may run kiro-cli for each seat holder with that holder's own key) and P-2 (the owner runs the provisioning script).

## Round 1 findings (partner, summarised verbatim in substance)
- F1 [major] Unpinned `curl | bash` install of kiro-cli — supply-chain and reproducibility risk. Suggestion: pin a version, verify SHA256.
- F2 [major] Relay failure modes under-specified: (a) Secrets Manager transient vs not-found, (b) no runner-side session timeout, (c) no frame-size/backpressure cap.
- F3 [minor] The generic `openSession` catch in `runKiroTurn` would swallow a typed KiroKeyMissingError.
- F4 [minor] Hardcoded English reply string vs server i18n rule 13b.
- F5 [minor] STAGING-VERIFY only checks unauthenticated 401s.
- F6 [minor] `config/service-path-map.json` change not described.
- Questions: Q1 kiro-cli runtime libraries on -slim; Q2 Secrets Manager secret count; Q3 prod gateway reaching the staging runner.

## Round 2 findings
- F1–F4, F6 closed; F5 acknowledged (rejection accepted).
- F7 [minor] the prod guard test should name the future production-runner VTID.
- F8 [minor] state that `KIRO_RUNNER_MAX_SESSION_MS` is an env var.

---
## Planner responses — round 1
- F1 [major] ACCEPTED — installer replaced by a pinned versioned artifact with SHA256 verification; no `curl | bash` (Design §1).
- F2 [major] ACCEPTED — (a) not-found → 4401, other SM errors → 1011 transient; (b) runner idle (15 min) + absolute (4 h) timeouts and 30 s ping; (c) 1 MiB maxPayload / line cap and 8 MiB bufferedAmount cap → kill + 1009 (Design §1).
- F3 [minor] ACCEPTED — the `openSession` catch in `runKiroTurn` is split explicitly, `instanceof KiroKeyMissingError` first (Design §2).
- F4 [minor] ACCEPTED (comment route) — admin-only Operator Console text, English by design under 13b's admin/dev exclusion, stated in a code comment; same as the existing Phase 1 Kiro replies, which are not in the catalog either.
- F5 [minor] REJECTED — STAGING-VERIFY signs in only as the shared test user (`TEST_USER_EMAIL`, STAGING-VERIFY.yml:164), which is not exafy_admin, and every `/kiro/*` route is `requireAdminAuth`; an authenticated admin probe would need a new admin credential in CI, which is out of scope and a security widening. Runner reachability is proven by CI (remote backend end-to-end against a real ws server), by the runner deploy's ECS health check on `/alive`, and by the owner's first linked turn on staging, reported in Gate 2.
- F6 [minor] ACCEPTED — `kiro-runner` entry described (Design §4).
- Q1 — not yet; handled by F1's build-time verification: the PR builds the image in CI and the build fails on a missing library or a failing `kiro-cli --version`.
- Q2 — one secret per Kiro Power seat holder, admin-only; seat counts are in the tens. No concern at that scale; revisit only if Kiro opens to members.
- Q3 — covered under F6/§4: prod workflow untouched + test asserting no `KIRO_RUNNER` in it, staging-only token, staging-SG ingress.

## Planner responses — round 2
- F7 [minor] ACCEPTED — the guard test's comment points the future production-runner VTID at it.
- F8 [minor] ACCEPTED — `KIRO_RUNNER_MAX_SESSION_MS` is an env var, default 14400000.

## Verdict: CONVERGED (2 rounds; no open or disputed blocker/major).

---

## Final plan

## Goal
Make the Command Hub Operator's Kiro engine (VTID-04975/04984, live in prod but inert) actually run
`kiro-cli` on **staging**, with each Kiro Power seat holder using **their own** Kiro API key, and link
the owner's key to Command Hub account `dstevanovic@hotmail.com` (user id
`0adc6ff6-acb0-4dca-99d0-295211a40e3e`, exafy_admin).

Change class: **standard** (new service, routes, deploy workflow, IAM, secrets, migration apply).
Production for the runner is **out of scope** — a separate later VTID once staging works.

## Owner preconditions (Gate 1)
- P-1 The original Phase 1 plan gated Phase 2 on confirmation that a backend may run `kiro-cli` on a
  seat holder's behalf with that seat holder's own key. The owner said "let's set it up now
  together" and confirmed admins enabled API-key generation per seat; Gate 1 asks the owner to
  confirm this explicitly as their decision.
- P-2 The owner runs one provisioning script (sessions have no AWS admin rights — same as erp-bridge).

## Design
### 1. `services/kiro-runner/` (new, Node 20 + TS, port 8080, `/alive`)
- Image: `node:20-bookworm-slim` (glibc 2.36 ≥ Kiro's 2.34 minimum). `kiro-cli` is **pinned**: the
  Dockerfile downloads one versioned Linux release artifact (`ARG KIRO_CLI_VERSION`, `ARG
  KIRO_CLI_SHA256`), verifies `sha256sum -c` and fails the build on mismatch; no `curl | bash`. The exact
  artifact URL, version and checksum are taken from Kiro's published release at implementation time and
  recorded in a Dockerfile comment; bumping is a deliberate edit. Missing shared libraries for `-slim`
  are found by building the image in CI (the runner workflow's build job and a PR-time `docker build`)
  and added via apt; the build also fails unless `kiro-cli --version` succeeds. The version is exposed
  on `/alive`.
- Private only: reached from the gateway at `http://kiro-runner.vitana.internal:8080` via Cloud Map
  (no ALB rule, same as erp-bridge). Every route except `/alive` requires
  `Authorization: Bearer <KIRO_RUNNER_TOKEN>` (constant-time compare).
- **Key store** (Secrets Manager, prefix `vitana/kiro/staging/users/<user_id>`, user_id must be a UUID):
  - `PUT /keys/:userId {key}` → create-or-put-secret-value. Basic shape check only (non-empty, ≤ 4 KB,
    no whitespace). Response never echoes the key.
  - `GET /keys/:userId` → `{linked, updated_at}` from DescribeSecret — never GetSecretValue.
  - `DELETE /keys/:userId` → DeleteSecret `ForceDeleteWithoutRecovery` (revoke is immediate and the
    name is reusable for re-link); also kills that user's running sessions.
  - Keys are never logged; the request-logger skips bodies on `/keys/*`.
- **Session relay**: WebSocket `GET /sessions?user_id=&thread_id=` (bearer token).
  - Reads the user's key (GetSecretValue). `ResourceNotFoundException` → close 4401 `kiro_key_missing`;
    any other Secrets Manager error (throttle, network) → close 1011 `kiro_key_unavailable` (transient,
    the gateway reports "Kiro could not start" and the next turn retries).
  - Spawns `kiro-cli acp` with `KIRO_API_KEY` in **that child's env only** (env is built from an
    allowlist: PATH, HOME=<workspace>, LANG; never the runner's own env/AWS creds).
  - cwd = fresh empty dir `/work/<random uuid>`, deleted on close. The relay rewrites `cwd` in
    `session/new`/`session/load` params to that dir (gateway cannot pick paths).
  - Relays stdout lines → WS text frames and WS frames → stdin lines; nothing else. WS close → kill
    child; child exit → WS close 1011.
  - Bounds of its own, independent of the gateway: idle timeout `KIRO_RUNNER_IDLE_MS` (default 15 min,
    no frame either way → kill + close 4408) and absolute lifetime `KIRO_RUNNER_MAX_SESSION_MS`
    (env var, default 14400000 = 4 h); WS ping every 30 s, a dead peer is killed. Max frame size 1 MiB (ws `maxPayload`);
    a stdout line over 1 MiB, or `ws.bufferedAmount` over 8 MiB (slow gateway), kills the child and
    closes 1009 — the relay never buffers without limit.
  - Caps (defense in depth on top of the gateway's 3/user, 10 global): runner `KIRO_RUNNER_MAX_SESSIONS`
    default 10 → close 4429.
- Task role `vitana-kiro-runner-task-role` (new, separate from the gateway's) with
  Create/Put/Get/Describe/DeleteSecret on `arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/kiro/staging/users/*`
  only. The gateway task role gets **no** access to user keys.

### 2. Gateway
- `services/kiro/remote-backend.ts`: `KiroBackend` whose `spawn()` opens the runner WS and returns an
  `AcpChild` adapter (stdin.write → ws.send, ws messages → stdout 'data' with newline, ws close →
  'exit', 4401 → a typed `KiroKeyMissingError`). `AcpClient`/`kiro-turn` are reused; only one change in
  `kiro-turn.ts`: the `openSession` catch in `runKiroTurn` (today one generic `result('error', 'Kiro
  could not start.')`) is split so `err instanceof KiroKeyMissingError` returns first with
  `kiro_status:'not_connected'`, `error:'kiro_key_missing'` and reply "Link your Kiro API key in the
  Kiro workspace panel."; every other error keeps the generic branch. The string is admin-only
  Operator Console text, English by design (13b's admin/dev exclusion), and says so in a code comment
  like the existing Kiro replies.
- Registered at startup (`index.ts` or the operator module) only when `KIRO_ENGINE_ENABLED==='true'`
  AND `KIRO_RUNNER_URL` AND `KIRO_RUNNER_TOKEN` are set; otherwise unchanged inert behaviour.
- Key routes on `routes/operator.ts`, all `requireAdminAuth`, user id **only** from `req.identity`
  (never from the body/URL): `GET /kiro/key`, `PUT /kiro/key {key}`, `DELETE /kiro/key` → forward to the
  runner. OASIS `operator.kiro.key_linked` / `operator.kiro.key_revoked` via `emitOasisEvent`, payload
  without the key; types added to the `CicdEventType` union. Body logging excluded for `/kiro/key`.
- `GET /kiro/status` additionally reports `runner_configured: boolean`.

### 3. Command Hub "Kiro workspace" card (`app.js`, `styles.css`, `index.html ?v=` bump)
- Replaces "Your Kiro API key: not linked" with: not linked → password input (`autocomplete=off`) +
  "Link" button; linked → "Linked · <date>" + "Replace" (shows the input again) + "Revoke" (confirm).
  Input cleared from the DOM and state right after submit; key never stored in `state`/localStorage.
- No inline styles; literal class names (dead-CSS test); ownership-guard allowlist entry; symbol index
  regenerated; staging probes repointed to the new `?v=`.

### 4. Infra (owner-run) + CI
- `scripts/aws/setup-kiro-runner-staging.sh` (dry run default, `--apply`; pinned staging names; never
  prod): ECR `vitana-kiro-runner`, log group, runner token secret `vitana/kiro-runner/staging/runner-token`
  (generated once, never overwritten), task role + key-prefix policy, SG ingress gateway SG → runner :8080,
  Cloud Map service `kiro-runner` in existing `vitana.internal`, placeholder task def, ECS service
  desiredCount 0. Subcommand `link-user --email <email>`: resolves the user id read-only, reads the key
  with `read -rs` (never argv/history), puts it in `vitana/kiro/staging/users/<id>`. `status` prints what
  exists.
- `.github/workflows/AWS-STAGE-DEPLOY-KIRO-RUNNER.yml`: on push to main under `services/kiro-runner/**`
  + dispatch; preflight refuses until ECR/service/secret exist; build → ECR → task def (1 vCPU/2 GB,
  `/alive` health check) → service desiredCount 1 → wait stable.
- `AWS-STAGE-DEPLOY-GATEWAY.yml`: when the runner token secret exists, upsert `KIRO_RUNNER_URL`,
  `KIRO_RUNNER_TOKEN` (secret ref) and `KIRO_ENGINE_ENABLED=true` on the staging gateway task def;
  absent → leave them unset (log line), exactly the erp-bridge pattern. `AWS-PROD-*` untouched; a test
  asserts `AWS-PROD-DEPLOY-GATEWAY.yml` contains no `KIRO_RUNNER` reference (its comment names the future production-runner VTID that must update it), so prod can never be
  pointed at the staging runner by this change. The runner token is a staging-only secret and the SG
  ingress rule names the staging gateway service's SG (read live by the script); if that SG is shared
  with prod, the token stays the barrier.
- `config/service-path-map.json`: new `kiro-runner` entry (`paths: ["services/kiro-runner/"]`,
  `deployable: true`), same shape as the existing entries.
- Migration `20261008120000_vtid_04975_operator_thread_engine.sql` (additive, already merged, not yet
  applied) is applied via `RUN-MIGRATION.yml` as part of this release so Kiro threads keep their engine.

### 5. Linking `dstevanovic@hotmail.com`
After the runner is up on staging, the owner either pastes the key into the Connect Kiro field on the
staging Command Hub (their own action) or runs `setup-kiro-runner-staging.sh link-user --email
dstevanovic@hotmail.com --apply`. The session never sees the key.

## Known limitations (accepted for Phase 2)
- L-1 Kiro sessions live in one gateway task's memory; if staging runs >1 gateway task, a turn routed to
  another task opens a fresh Kiro session (Phase 1 behaviour). Reattach via `session/load` is a follow-up.
- L-2 The workspace is an empty per-session directory; a repo checkout for Kiro is a follow-up.
- L-3 No production runner yet.

## Scope (files)
services/kiro-runner/** (new); services/gateway/src/services/kiro/remote-backend.ts (new),
kiro-turn.ts, routes/operator.ts, types/cicd.ts, index.ts (backend registration);
services/gateway/src/frontend/command-hub/{app.js,styles.css,index.html,command-hub-symbol-index.json};
scripts/ci/command-hub-ownership-guard.js; scripts/aws/setup-kiro-runner-staging.sh (new);
.github/workflows/AWS-STAGE-DEPLOY-KIRO-RUNNER.yml (new), AWS-STAGE-DEPLOY-GATEWAY.yml;
config/service-path-map.json; staging probe files pinning `?v=`; tests; docs/validation/<VTID>/**.

## Test plan
- Runner unit tests: auth (401 without/with wrong token, `/alive` open); key store with a mocked SM
  client (PUT never echoes, GET never calls GetSecretValue, DELETE force-deletes and kills sessions, bad
  user id 400); relay against a fake `kiro-cli` script (lines both ways, cwd rewrite, child env contains
  KIRO_API_KEY and none of the runner's AWS vars, kill on WS close, 4401 on missing key, 4429 on cap).
- Gateway: remote backend against a local `ws` server that relays to the scripted fake ACP agent,
  driving the real `runKiroTurn`/`listKiroModels`/`setKiroModel` end to end; key-missing → not_connected
  reply; key routes forward with the identity's user id and ignore a body/URL user id; OASIS events
  carry no key; registration only when all three env vars set.
- UI: link/replace/revoke states, key cleared after submit, auth headers, no key in state.
- Existing suites green: vtid-04975/04984, `npm run test:operator`, CSP/dead-CSS/ownership/source-pin.
- STAGING-VERIFY (read-only): `/alive` cannot be probed from outside (private), so: gateway
  `/api/v1/operator/kiro/key` and `/kiro/status` unauthenticated → 401 JSON; Command Hub serves the new
  `?v=` with the key field; runner deploy workflow's own post-deploy check of service stability and
  `/alive` via ECS health status.
