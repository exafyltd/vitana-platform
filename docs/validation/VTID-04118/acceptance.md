# VTID-04118 — Acceptance

Follow-up to VTID-04116 (merged #3464), whose own acceptance doc flagged
that neither RepoWise nor Graphify was installed anywhere the deployed
gateway container could reach, so the Operator Console's `dev_repowise`/
`dev_graphify` tools reported `not_configured` on every real deployment.
This closes that gap for STAGING ONLY.

AC-1: The gateway's runtime Docker image installs python3/git/pip and
builds real RepoWise + Graphify indexes for both vitana-platform and
vitana-v1 at build time, from source trees staged into the build context.
TEST: manual (see commands.log) — reviewed `services/gateway/Dockerfile`'s
new RUN block: `apk add python3 py3-pip git`, `pip install --break-system-
packages repowise graphifyy`, then `graphify update . --no-cluster` +
`repowise init --no-prose -y` against `/repo-platform` and
`/repo-vitana-v1`. Not build-tested locally — this sandbox has no working
Docker daemon (`docker info` cannot reach the daemon socket) — flagged
explicitly in the PR description, not silently assumed working.

AC-2: The whole codeintel setup is best-effort and never fails the
gateway image build, matching this repo's established pattern for every
other optional provider (Fish, ERP bridge, Vertex bridge).
TEST: manual (see commands.log) — the entire `pip install`/`graphify`/
`repowise` block in the Dockerfile is wrapped in `( ... ) || echo "..."`,
and the workflow's "Checkout vitana-v1 (read-only)" step uses
`continue-on-error: true` with a placeholder-directory fallback in the
following step, so the Dockerfile's `COPY codeintel-src/vitana-v1` never
lacks a source path to copy.

AC-3: `AWS-STAGE-DEPLOY-GATEWAY.yml` wires `OPERATOR_CODEINTEL_ENABLED`,
`CODEINTEL_PLATFORM_REPO_DIR`, `CODEINTEL_V1_REPO_DIR` onto the staging
task definition only; `AWS-PROD-DEPLOY-GATEWAY.yml` is untouched.
TEST: services/gateway/test/orb/live/upstream/staging-vertex-serbian-bridge-wiring-pinned.test.ts
(pre-existing VTID-04000 suite, whose one pinned assertion this PR had to
relax after appending three new names to the same strip-list array — see
commands.log for the failing-then-passing CI evidence) + manual grep
confirms no `CODEINTEL_` string appears anywhere in
`AWS-PROD-DEPLOY-GATEWAY.yml`.

## Not done in this PR

- No staging deploy has run yet — this PR's merge to `main` triggers the
  first real one. `dev_repowise`/`dev_graphify` reporting real output
  instead of `not_configured` on staging is the follow-up signal, not
  something this PR can confirm itself.

OASIS_IMPACT: no
