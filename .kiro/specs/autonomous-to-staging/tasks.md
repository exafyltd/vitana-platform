# Tasks — autonomous-to-staging
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/autonomous-to-staging/<lane>`; title
`VTID-xxxxx (autonomous-to-staging/<lane>): …`; trailers `Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`;
evidence in `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`, `scope.json`).

Common acceptance:
- Only the lane `paths` change; each new behaviour has a test recorded red on base.
- No production write, no suite against production, no secret in git.

<!-- lane: rules-platform -->
## Lane `rules-platform` (vitana-platform)
- [ ] T1 Rewrite the Autonomy Contract: Gate 1 removed (all plans spar through PLAN-SPAR); stop cases (a),(c),(d) become machine quarantine; production remains the only human decision.
- [ ] T2 §3a/§7/§7a/§7b: protected gate files merge on two reviewer-agent accepts from two different chain models; owner instruction no longer required.
- [ ] T3 §7d: migrations apply automatically to the isolated staging database only (STAGING-MIGRATE); `blocked: isolated-staging-db` until it exists; production migrations stay part of PUBLISH.
- [ ] T4 NEVER 34 narrowed to production autonomy settings; owner stop table replaced by production publish + quarantine rules; CLAUDE.md rules 51/51a for Pipeline B everywhere and CI VTID allocation.
- [ ] T5 Regenerate Kiro steering (`scripts/collab/kiro-web-steering.mjs`) and keep the Kiro steering check green.

**Acceptance**
- Change types: Tooling/docs.
- No sentence anywhere in the lane paths requires an owner action before STAGING-VERIFY (grep evidence in `commands.log` for `owner` / `approval` / `instruction`).
- Production rules unchanged: rules 49–50a, §7c, read-only staging suites, no suite against production.
- Each new rule names the mechanism and lane that enforces it.

<!-- lane: rules-v1 -->
## Lane `rules-v1` (vitana-v1)
- [ ] T1 Mirror the platform Autonomy Contract and stop table.
- [ ] T2 Commerce friction and Spotlight contract changes: machine checks (UX acceptance section, design ratchet) instead of owner approval.
- [ ] T3 'Why no host is exempt' updated to point at the isolated staging plane once `staging-frontend-isolation` is done; until then the read-only rule stays.

**Acceptance**
- Change types: Tooling/docs.
- Byte-identical `vitana-owner-autonomy.md` with the platform copy.
- The absolute rule against testing on production is unchanged.

<!-- lane: machine-gate-protected -->
## Lane `machine-gate-protected` (vitana-platform)
- [ ] T1 land-guard `mergeDecision`: a protected file merges only with two accept entries for the current head from two different `REVIEWER_AGENT_MODELS`.
- [ ] T2 queue.mjs scope-check: a Kiro lane with `protected_gate: two-model` from a trusted source may change a protected file.
- [ ] T3 governance.ts mirrors T1 for the PM.
- [ ] T4 `gate-invariants.mjs` (expectations read from the merge-base; bootstrap pass when none) as a required step in Collab tests.
- [ ] T5 Tests red on base, green after.

**Acceptance**
- Change types: Tooling/docs, Infrastructure/CI.
- One accept → refused; two accepts same model → refused; two different models → allowed.
- No other gate loosened (diff limited to the protected branch).

<!-- lane: quarantine -->
## Lane `quarantine` (vitana-platform)
- [ ] T1 plan-spar: non-convergence and infra escalation → `state: quarantined`, `next_actor: kiro` (exceptions seat), no owner.
- [ ] T2 plan-driver `next`: quarantined lane → re-plan action; independent lanes continue; 3 failed repairs → quarantine.
- [ ] T3 plan-sparring-service: an escalated session is re-planned automatically (new session), no `exafy_admin` acknowledgement for staging work.
- [ ] T4 OASIS events `collab.lane.quarantined` / `collab.lane.unquarantined` on every transition.
- [ ] T5 Tests.

**Acceptance**
- Change types: Tooling/docs, Backend.
- A quarantined item is never reported `done` or staging verified.
- The `vtid_ledger` gate still requires a converged session for every VTID.

<!-- lane: pipeline-b-v1 -->
## Lane `pipeline-b-v1` (vitana-v1)
- [ ] T1 Allow `apps/mobile/src/**`; deny native navigation, `apps/mobile/parity/**`, `app.json`, `eas.json`, generated.
- [ ] T2 Fixtures for each surface.

**Acceptance**
- Change types: Tooling/docs.
- NATIVE-CI and parity checks stay required for native changes.

<!-- lane: pipeline-b-platform -->
## Lane `pipeline-b-platform` (vitana-platform)
- [ ] T1 frontend-simple for `services/gateway/src/frontend/command-hub/**` (allow css, index.html cache-bust, view modules; deny routing/auth).
- [ ] T2 VTID-ALLOCATE `pull_request` trigger: qualifying `frontend-simple` diff → one allocation, commit as `ci-vtid-allocate`.
- [ ] T3 PR-GATE: frontend-simple skips the sparring requirement, keeps build and staging suite.

**Acceptance**
- Change types: Infrastructure/CI.
- Allocation is idempotent per PR and refuses a non-qualifying diff.
- No manual VTID path is added.

<!-- lane: staging-db-isolation -->
## Lane `staging-db-isolation` (vitana-platform)
- [ ] T1 Provision `vitana-aurora-staging` (serverless v2, min 0.5 ACU) from migrations plus synthetic seed; never from production data.
- [ ] T2 Staging PostgREST proxy and gateway staging point at it; staging secrets only.
- [ ] T3 Guard script in every staging workflow refusing production refs and ARNs.
- [ ] T4 STAGING.md rewritten for AWS.

**Acceptance**
- Change types: Infrastructure/CI, Database.
- Guard fails on each production identifier fixture.
- STAGING-VERIFY passes against the isolated plane; evidence of cluster id and schema hash.

<!-- lane: staging-frontend-isolation -->
## Lane `staging-frontend-isolation` (vitana-v1)
- [ ] T1 Staging frontend build uses staging data endpoints and keys, never `inmkhvwdcuyhnxkgfvsb`.
- [ ] T2 Guard in the workflow.

**Acceptance**
- Change types: Infrastructure/CI.
- Built staging bundle contains no production project ref (grep evidence).

<!-- lane: staging-migrations-auto -->
## Lane `staging-migrations-auto` (vitana-platform)
- [ ] T1 Target `staging` resolves only to the isolated cluster.
- [ ] T2 STAGING-MIGRATE on merge: lint, snapshot, apply in timestamp order, drift check, compatibility suite, restore snapshot on failure, quarantine.
- [ ] T3 Evidence written per VTID.

**Acceptance**
- Change types: Infrastructure/CI, Database.
- `staging` can never resolve to a production target (test).
- Rollback proven with a failing fixture migration on local Postgres.

<!-- lane: kiro-aws-access -->
## Lane `kiro-aws-access` (vitana-platform)
- [ ] T0 Read-only inventory of 841276716213 recorded in `docs/KIRO-AWS-ACCESS.md`.
- [ ] T1 `kiro-engineering-admin` in 841276716213 (GitLab delete denies); `kiro-staging-operator` in 472838866351 as an allow-list of staging ARNs, exact-ARN production denies, a permissions boundary, and a required + daily drift check; GitLab credential secrets denied in the admin role.
- [ ] T2 Apply workflow on the existing OIDC role; credential delivered to the Kiro environment secret store, never to chat or git.
- [ ] T3 CloudTrail and OASIS evidence per session.

**Acceptance**
- Change types: Infrastructure/CI.
- Policy test: every production resource pattern denied in `kiro-staging-operator`.
- No static key in git.

<!-- lane: gate-invariants-ci -->
## Lane `gate-invariants-ci` (vitana-platform)
- [ ] T1 `.github/workflows/GATE-INVARIANTS.yml`: runs `node scripts/collab/gate-invariants.mjs --against main` on every push to `main` and daily (cron).
- [ ] T2 `scripts/ci/workflow-trigger-check.test.mjs` asserts the push and schedule triggers.

**Acceptance**
- Change types: Infrastructure/CI.
- The first run on `main` after merge is green and its run URL is in `commands.log`.
