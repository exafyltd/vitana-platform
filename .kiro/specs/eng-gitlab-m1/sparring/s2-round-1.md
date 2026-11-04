# Sparring round 1 — in_progress

Session: `a47c00c6-4665-455a-94f4-eea7dcce4585` · plan hash `35a985bef58dcad960531444ad115c97d5aad7e2f2e47eb8a14962b8d196b79b`

## Summary

Verified 9 premises (P1–P9) against the pinned code. Most hold. P8 is false: the programme registry does not mention `eng-gitlab-m1`. One additional major finding relates to the gateway typecheck dependency chain being underspecified relative to what the existing CICDL-GATEWAY-CI workflow documents as required.

## Findings

### R1-F1 [major]

P8 is false — the programme registry does not register eng-gitlab-m1. The plan cites `docs/programs/engineering-platform/program.md:9` and `:23`, but line 9 lists only `eng-platform-p01`, and line 23 does not exist (the file has 22 lines). There is no mention of `eng-gitlab-m1` anywhere in program.md. If spec registration in the programme is a governance prerequisite for implementation, this plan cannot proceed until it is registered.

- `exafyltd/vitana-platform:docs/programs/engineering-platform/program.md:7` — specs:
  - vitana-platform:eng-platform-p01

Suggestion: Add `- vitana-platform:eng-gitlab-m1` to the `specs:` list in `program.md` as part of this lane, and correct the premise to reference the actual line numbers.

### R1-F2 [major]

The plan's description of the `typecheck` job in `platform.gitlab-ci.yml` omits two prerequisite steps that the existing CICDL-GATEWAY-CI.yml documents as essential: (1) a gateway-specific `npm ci` in `services/gateway` (lines 86–92 explain that the root pnpm install does NOT install the gateway's own dependencies, causing `tsc` to resolve to a different TypeScript and fail with TS5108), and (2) Prisma client generation (`pnpm exec prisma generate`, line 78) — `@prisma/client` is a root dependency (root `package.json` line 20) and its generated types are needed by imports. The plan says only 'pnpm run typecheck' for the typecheck job. While §6 says a failing pipeline will be fixed, the dependency chain is documented in existing code and should be captured in the plan to avoid a guaranteed first failure.

- `exafyltd/vitana-platform:.github/workflows/CICDL-GATEWAY-CI.yml:86` — # VTID-04950: the root pnpm install never installs services/gateway's own
# dependencies, so `tsc` resolved to a different TypeScript and failed on
# tsconfig (TS5108). `|| echo` hid that for as long as the step existed.
# Install the gateway's locked deps, the same way TEST-SUITE does.
- name: Install gateway dependencies
  working-directory: services/gateway
  run: npm ci --no-audit --no-fund
- `exafyltd/vitana-platform:.github/workflows/CICDL-GATEWAY-CI.yml:77` — - name: Prisma Generate
  run: pnpm exec prisma generate
- `exafyltd/vitana-platform:package.json:16` — "devDependencies": {
    "prisma": "^6.18.0"
  },
  "dependencies": {
    "@prisma/client": "6.18.0"
  }

Suggestion: Specify in §3 that the `typecheck` job must: (a) install gateway-specific dependencies (`npm ci` in `services/gateway`, or `pnpm install` with the working directory set to `services/gateway` as TEST-SUITE does), and (b) ensure Prisma client types are generated (either via `pnpm exec prisma generate` or by relying on `@prisma/client`'s postinstall hook if the root install runs first). Document the same dependency chain that CICDL-GATEWAY-CI.yml records at lines 86–92.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
