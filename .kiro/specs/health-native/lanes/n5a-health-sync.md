---
lane: n5a-health-sync
state: executing
next_actor: kiro
vtid: VTID-05184
depends_on: [phase1-data-core]
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
paths:
  - "apps/mobile/**"
  - "packages/core/**"
  - "packages/tokens/**"
  - "docs/validation/**"
updated: 2026-10-15T18:59Z
---
# N5a — Health Sync module, Apple Health + Health Connect (vitana-v1 #1398)

Tasks: `tasks.md` section "n5a-health-sync".

vitana-v1 #1398 (branch `claude/health-data-integration-plan-dbxyld-n5a`), green, main merged in 2026-10-14
(8fea5e652). Remaining work for Kiro once C1 (#4107) is merged:
1. Re-vendor the Health Sync contract types/schema/fixtures from C1's **merge commit** (not the branch) and record the
   commit in the vendored header; the contract test must pass byte-for-byte.
2. Replace N5a's own N3 auth stub and N4 feature-flag stub with the real modules now on main
   (`apps/mobile` shell auth from N3, remote config from N4-APP); remove the stubs.
3. Keep it switched off (ingest flag) — it only turns on with the C1 preconditions.
Checks: `npx tsc --noEmit -p apps/mobile`, apps/mobile jest, `node --test scripts/native/__tests__/*.test.mjs`,
core-closure/parity-ledger/check-shell-pins/gen-tokens/gen-core-extract `--check`, `npx eslint apps/mobile packages`.
Health permission strings: HealthKit + microphone texts share the per-language `.lproj` files (see the N5a merge note).

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → executing
Handed over to Kiro with the health-native spec. next_actor: kiro.
