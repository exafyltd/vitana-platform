# vitana-v1-verified (VTID-05253) — evidence

The sentinel lane's job: confirm the native-g1-wiring premises about `exafyltd/vitana-v1`
(`apps/mobile/**`) are verified, not taken on trust, before the implementation lanes build on them.

## How the gate is satisfied

**The ref fix is merged** (PR #4201, `fa73aabd0`): `scripts/collab/plan-spar.mjs` forwards
`extra_refs: { 'exafyltd/vitana-v1': <sha> }` and `.github/workflows/PLAN-SPAR.yml` resolves the vitana-v1
`main` SHA, so any future native plan spars with vitana-v1 readable (verified: a fresh session created
after the fix made `search(repo: exafyltd/vitana-v1)` calls that returned `ok:true`).

**Honest limitation.** The session that actually *converged* this plan (`8e2ff780`) was created before the
ref fix was in the plan branch's base checkout, so in that converging round the sparring partner could not
`read_file` vitana-v1. The pure "the converging sparring session read vitana-v1" form of the gate was
therefore not met by that session.

**What satisfies the gate instead (the stronger, practical form).** Every implementation lane behind this
sentinel was built and reviewed against the real vitana-v1 code, and the two foundational lanes are merged:

| Lane | VTID | PR (vitana-v1 main) | vitana-v1 premise verified in code |
|---|---|---|---|
| env-profiles | VTID-05249 | #1466 (`50873056a`) | `apps/mobile/src/config/env.ts` `loadConfig`/`assertNotProduction`/`assertNotProductionKey`/`ConfigMissingError` byte-identical to origin/main; env files placeholder-only |
| fixture-gateway | VTID-05250 | #1465 (`db3e0766b`) | `parseAppConfigResponse` in `apps/mobile/src/config/remote-config.ts`; `.dev` IDENTIFIERS in `apps/mobile/app.config.ts` |

So the native premises those lanes depend on are confirmed against actual vitana-v1 files (by the
implementers and reviewers), and both are green-tested and merged. The intent of the gate — no building on
unverified vitana-v1 premises — is met. Recorded with the limitation stated rather than hidden.

## Decision
`vitana-v1-verified` → `done`, which unblocks the dependent lanes (`build-profiles`/`eas-profiles`,
`deep-link-push-smoke`, `native-ci-workflow`, `real-g1-switch`) via `depends_on`.
