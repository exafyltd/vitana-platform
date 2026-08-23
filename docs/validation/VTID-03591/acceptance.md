# VTID-03591 — merge/CI-fix increment (continued under VTID-03702)

Evidence pack for the commits pushed to this PR on 2026-08-23 that merge
`origin/main` (141 commits, including the GCP decommission and other
in-flight Aurora/DB-i18n work) into this branch and fix the resulting CI
breakage. This is a mechanical merge-hygiene pass, not new Aurora-client
functionality — the pre-existing `aurora-client.ts`/RLS-shim work in the
rest of this PR is unchanged by these commits.

Continuation tracked under **VTID-03702** (the standing "full Supabase→AWS/
Aurora migration, including Auth" effort) — evidence filed under VTID-03591
because the Evidence Pack Gate keys strictly off the PR title's VTID.

---

AC-1 — Merging 141 commits from `origin/main` does not silently drop or
corrupt this branch's own Aurora work

The merge resolved two real conflicts (`services/gateway/package.json`,
`services/gateway/package-lock.json` — both dependency-version conflicts,
additive on both sides) and nothing else; git reported no other conflicted
paths.

TEST: `git log --oneline ca00ed8..d9814f3` — every commit from both
branches is present in the merged history, none dropped.
Output: `outputs/merge-commits.txt` (145 commits)

AC-2 — `services/gateway/package.json` resolves cleanly with no leftover
conflict markers and no version regression

Both branches' additions are kept: `@aws-sdk/client-s3` and
`@aws-sdk/client-transcribe-streaming` (added by `main`), `pg@^8.23.0` and
`@types/pg@^8.21.0` (this branch's versions, newer than `main`'s
`8.22.0`/`8.20.4`).

TEST: `grep -n "^<<<<<<<\|^=======\|^>>>>>>>" services/gateway/package.json`
returns nothing.

AC-3 — `services/gateway/pnpm-lock.yaml` (the lockfile CI's
`pnpm install --frozen-lockfile` actually reads, per
`.github/workflows/TEST-SUITE.yml`'s `working-directory: services/gateway`)
matches the resolved `package.json`

The first fix attempt regenerated the wrong lockfile
(`services/gateway/package-lock.json` via `npm`, harmless but insufficient)
and CI kept failing with `ERR_PNPM_OUTDATED_LOCKFILE` against
`services/gateway/pnpm-lock.yaml`, which still carried `origin/main`'s old
`pg@8.22.0`/`@types/pg@8.20.4`. Regenerated with pnpm 9.0.0 (matching the
version this repo's `packageManager` field and CI both pin) so the lockfile
format is byte-identical to what CI produces, not just semantically
equivalent.

TEST: `cd services/gateway && pnpm install --frozen-lockfile` exits 0.
Output: `outputs/pnpm-frozen-lockfile-check.txt`

AC-4 — The Dev Autopilot Impact Scan warning (undocumented
`AURORA_DATABASE_URL`/`AURORA_SSL`/`AURORA_POOL_MAX`) is closed without
changing `aurora-client.ts`'s behavior

`getAuroraPool()` still returns `null` until `AURORA_DATABASE_URL` is set —
this is a `.env.example` documentation addition only, same deliberate-opt-in
shape as `TTS_PROVIDER`/`IMAGE_PROVIDER`/`BEDROCK_ROLE_ARN`.

TEST: `grep -A12 "Aurora application-layer client" services/gateway/.env.example`
Output: `outputs/env-example-aurora-section.txt`

---

OASIS_IMPACT: no — this increment is CI/lockfile hygiene and documentation
only; `getAuroraPool()` remains unwired and unconfigured, no runtime
behavior changes, so there is no state transition for OASIS to record.
