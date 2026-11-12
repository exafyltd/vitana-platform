# VTID-05764 — autonomous-to-staging, lane `kiro-aws-access`

Plan: `.kiro/specs/autonomous-to-staging/plan.md` §3.5 (#5000), amended by `autonomous-to-staging-r2` §3.2 (PR #5024):
preparation only; the owner applies the stacks (credential handoff).

## What changed
- `infra/kiro-access/staging-operator.json`: `kiro-staging-operator` (472838866351) — allow-list of staging resources by
  exact ARN, read-only elsewhere without secret values, explicit denies on every production resource in the role and in
  its permissions boundary `kiro-staging-boundary` (which also blocks IAM changes), trust only from
  `kiro-agent-source` with ExternalId and a `kiro-session` tag; read-only OIDC drift role `vitana-gha-kiro-access-drift`.
- `infra/kiro-access/engineering-admin.json`: `kiro-engineering-admin` (841276716213) — AdministratorAccess with denies
  on deleting the GitLab instances/volumes/snapshots and backup bucket, on the GitLab credential secrets, on changing
  itself, on stopping CloudTrail and on Organizations.
- `infra/kiro-access/source-principal.json`: IAM user `kiro-agent-source` (841276716213) that can only assume the two
  roles; no console, no key in the template.
- `infra/kiro-access/identifiers.json`, `lib.mjs` (IAM evaluator, static drift), `drift.mjs` (live drift),
  `policy.test.mjs`, `drift.test.mjs`.
- `.github/workflows/AWS-KIRO-ACCESS.yml`: tests + cfn-lint on PRs that change these files and on push to `main`;
  daily live drift with the read-only role once applied. Never applies, never assumes a production role.
- `docs/KIRO-AWS-ACCESS.md`: what each role can and cannot do, inventory from repo evidence, the exact owner handoff.

## Acceptance criteria → tests

AC-1 Every production resource pattern is denied in `kiro-staging-operator`, explicitly, in the role and the boundary.
TEST: infra/kiro-access/policy.test.mjs ("kiro-staging-operator: every production resource is denied (role and boundary)"; "kiro-staging-operator: production denies are explicit, not only implicit")

AC-2 Staging writes only on the pinned staging ARNs; reads allowed without secret values; deletes denied.
TEST: infra/kiro-access/policy.test.mjs ("kiro-staging-operator: staging writes are allowed only on the pinned staging ARNs"; "kiro-staging-operator: reads are allowed, secret values are not read")

AC-3 The permissions boundary blocks IAM changes, including to the role itself; trust needs ExternalId and session tag.
TEST: infra/kiro-access/policy.test.mjs ("kiro-staging-operator: the boundary blocks IAM changes, including to the role itself"; "kiro-staging-operator: trust is the engineering source principal with an external id and a session tag")

AC-4 `kiro-engineering-admin` keeps the GitLab delete denies and the GitLab credential secret denies.
TEST: infra/kiro-access/policy.test.mjs ("kiro-engineering-admin: AdministratorAccess with the GitLab deletes and credential secrets denied")

AC-5 The drift check reports unclassified resources and production resources without an explicit Deny.
TEST: infra/kiro-access/drift.test.mjs ("an unclassified service is reported"; "a production secret or cluster without an explicit Deny is reported"; "a production service without an explicit Deny is reported")
TEST: infra/kiro-access/policy.test.mjs ("static drift: no allow-list entry names a production resource")

AC-6 No static key in git.
TEST: infra/kiro-access/policy.test.mjs ("no static credential in the templates or docs"; "source principal: may only assume the two Kiro roles; no inline admin, no console")

Red on base: `outputs/red-on-base.txt` (modules absent). Green: `outputs/green.txt` (14/14). Mutation: removing
`DenyProdData` fails 2 tests (`outputs/mutation-deny-removed.txt`). `cfn-lint` exit 0 (`outputs/cfn-lint.txt`).

No migration, no production write, nothing applied; deploys nothing.

## Decisions taken
- r1 tasks.md T2 ("apply workflow on the existing OIDC role") is replaced by the owner applying the stacks (owner
  directive 2026-11-12, r2 §3.2): no CI identity gets IAM-write.
- The source principal is an IAM user in the engineering account, not in the management account, so the management
  account gets no new user; its one access key is created by the owner and is the only static credential.
- r1 T3 (OASIS `infra.kiro_access.*` per session start): CloudTrail records every assumption with the `kiro-session`
  tag; the OASIS emitter needs gateway code outside this lane's paths and is deferred to a follow-up lane.
- r1 T0 (live read-only inventory of 841276716213) needs the credential; recorded from repo evidence now, live after
  the handoff.
- The workflow has a `pull_request` trigger without a path filter (a filtered one needs a services-registry entry
  outside the lane's paths); its validate job exits early when the PR does not touch these files.
- `staging-operator.json` lists the r2 candidate services `vitana-gateway-iso` and `vitana-postgrest-aurora-staging-iso`
  ahead of their creation (r2 §3.4); they match no production pattern.
