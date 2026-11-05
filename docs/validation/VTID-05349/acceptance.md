# Acceptance — VTID-05349 (context-map/context-cli)

Developer tooling only (`scripts/dev/context.mjs`, its tests, `docs/CONTEXT-MAP.md`). Deploys nothing: no
`staging-tests.json`, no STAGING-VERIFY, no Gate 2. Plan: `.kiro/specs/context-map/plan.md` (#4405), lane tasks C1–C4.

AC-1: `route` maps every mount form in `index.ts` (destructured, aliased, ternary, inline `require`, `module.default`,
`import`) and shows the most specific handler (`POST /allocate` over `GET /:vtid`; `OPTIONS *` hidden), the atlas
domain and the tests naming the path.
TEST: node --test scripts/dev/context.test.mjs  # "parseMounts …", "parseHandlers …", "route: mount → most specific handler …"

AC-2: `domain`, `uses`, `why`, `vtid` answer with `file:line` from a fixture git repo. Rules rank before the changelog,
each hit carries its heading, and `--prs` goes through an injected runner (no GitHub call in tests).
TEST: node --test scripts/dev/context.test.mjs  # "domain, uses and why …", "vtid: commits, spec files with state …" (incl. a failing gh → one line)

AC-2b: `screen` maps a vitana-v1 path to its lazy-imported page file. It shows the nav registry, manifest and parity
lines, an exclusion prefix and a `<Navigate>` redirect, hides the catch-all `*`, and errors without a v1 checkout.
TEST: node --test scripts/dev/context.test.mjs  # "screen (vitana-v1 fixture): …"

AC-3: `check` path resolution: a short form of a live file is not dead, and a full path to a deleted file is. Atlas
directory, glob and `../` pointers resolve against src → services/gateway → root, and each finding cites the
pointer's line.
TEST: node --test scripts/dev/context.test.mjs  # "check: a short form …", "check: atlas directory, glob and ../ …", "check: stale atlas pointers …"

AC-4: `docs/CONTEXT-MAP.md` has no dead link and names only real commands. A dead link or an unknown command is an
error, and a `vitana-v1/` link without that checkout is info.
TEST: node --test scripts/dev/context.test.mjs  # "check: docs/CONTEXT-MAP.md has no dead link …", "check: a dead context-map link is an error …"

AC-4b: CLI exit codes. `check` exits 0 with warnings only, exits 1 with `--strict`, and exits 1 on a context-map
error, printing that error's line. A bad command or a missing argument exits 2.
TEST: node --test scripts/dev/context.test.mjs  # "main: usage on a bad command, exit codes, …"

AC-5: Green in a depth-1 clone without vitana-v1, as `UNIT.yml` runs it.
TEST: git clone --depth 1 … && node --test scripts/dev/context.test.mjs  # => tests 16, pass 16, fail 0 (outputs/tests-shallow.txt)

AC-6: On this repo with vitana-v1 present, `check` exits 0 with 0 errors and reports the stale pointers the plan
lists (§2.5).
TEST: node scripts/dev/context.mjs check  # => 0 error(s), 11 warning(s), 1 info; exit=0 (outputs/check.txt)

AC-7: Measured on seven representative questions: 20 → 6 commands and 82 219 → 9 442 bytes printed for T1–T6, every
answer found, plus T7 (stale pointers), which has no equivalent today.
TEST: bash docs/validation/VTID-05349/outputs/bench-context-map.sh  # outputs/benchmark.md, outputs/measurement.md

AC-8: Only the lane's paths change, the tool is read-only with zero dependencies, and no test is weakened.
TEST: node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/context-map/context-cli --title "…"  # Lane scope PASS
