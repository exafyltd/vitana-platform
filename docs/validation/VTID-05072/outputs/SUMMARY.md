# VTID-05072 Phase 0 — local check results

Environment: Windows, Node v24.11.1 (local). CI pins NODE_VERSION '20.x'.
git core.autocrlf set to `input` (owner-authorized) and the worktree renormalized to LF
before testing — this fixed the earlier CRLF-induced string-pin failures (blocker 2).

| Check | Command (from services/gateway unless noted) | Result | Log |
|---|---|---|---|
| TypeScript | `npx tsc --noEmit` | PASS (exit 0) | tsc.log |
| Command Hub jest | `npx jest test/command-hub` | PASS — 43 suites, 636 tests | jest-command-hub.log |
| VTID-05072 guard suite | `npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts` | PASS — 16 tests | jest-vtid05072-only.log |
| Operator pipeline | `npm run test:operator` | 63 passed, 1 failed* | test-operator.log |
| Role separation | `npm run test:roles` | PASS — 105 tests | test-roles.log |
| Support pipeline | `npm run test:support` | PASS — 4 suites, 87 tests | test-support.log |
| Symbol index sync | `node scripts/generate-command-hub-symbol-index.mjs --check` | PASS — in sync, 1106 functions / 15 files | symbol-index-check.log |
| Build (tsc) | `npx tsc` | PASS (exit 0) | build-tsc.log |
| Golden fingerprint | (root) `node scripts/ci/command-hub-golden-fingerprint.js` | PASS — 8 bundle files, all 6 markers found | golden-fingerprint.log |
| Ownership guard | (root) `node scripts/ci/command-hub-ownership-guard.js` | PASS — VTID-05072 allowlisted | ownership-guard.log |

\* The single `test:operator` failure ("the runner jest targets include every suite that
names app.js") is a pre-existing Windows-only path-separator artifact: the runner builds a
glob target with OS-native separators, so on Windows it emits `test\command-hub\cache-bust-pin.test.ts`
while the assertion expects `test/command-hub/...`. Verified pre-existing by stashing ALL
VTID-05072 changes and re-running on the clean base commit — identical failure (63 passed,
1 failed), same backslash string. It is independent of this change and does not reproduce on
CI (Linux, Node 20). Captured in test-operator-base.log equivalent during verification.

## Notes
- Node 20 was not available locally (no nvm/fnm/nvs and no Node 20 install); checks ran on
  v24.11.1. CI runs the gates on Node 20.x.
- `npm run build` (full) uses POSIX `rm`/`mkdir -p`/`cp -r` and cannot run under Windows cmd;
  the build was done as `tsc` + a Windows robocopy of src/frontend/command-hub into
  dist/frontend/command-hub so the golden fingerprint ran against real built output. `dist/`
  is gitignored and not committed.
- app.js was NOT modified. All pre-existing string-pin suites pass once the worktree is LF.
