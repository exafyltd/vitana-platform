# Tasks: ci-queue-flood

<!-- lane: stop-pm-loop -->
- [ ] Set `PM_AGENT_ENABLED` to `"false"` and `PM_MODE` to `"off"` in `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (lines 1225-1226).
- [ ] After the staging deploy: `GET /api/v1/project-manager/mode` reports `enabled: false`, and no new `pm: ` commit appears on any `pm-agent/*` branch for 30 minutes.

<!-- lane: gate-hygiene -->
- [ ] Add the concurrency block (cancel superseded `pull_request` runs) and a job `timeout-minutes` to `STAGING-TESTS-REQUIRED.yml`, `PHASE-2B-NAMING-ENFORCEMENT.yml` and `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`.
- [ ] Remove `fetch-depth: 0` from `PHASE-2B-NAMING-ENFORCEMENT.yml` (line 18). Keep it in `STAGING-TESTS-REQUIRED.yml`.
- [ ] Check: the four files parse as YAML, job ids and names are unchanged, and a second push on the lane PR cancels the first run of each gate.
