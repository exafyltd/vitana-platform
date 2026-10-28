# Acceptance — VTID-05300 (collab-queue-perf/queue-batch-read)

Developer tooling only (`scripts/collab/queue.mjs` and its tests). Deploys nothing: no `staging-tests.json`, no
STAGING-VERIFY, no Gate 2. Plan: `.kiro/specs/collab-queue-perf/plan.md`, tasks T1–T6.

AC-1: `collect()` returns the same files, refs and claims as the old implementation on a fixture with reverted
changes, new specs, out-of-window branches, renames, CRLF, large and binary files, a clean merge of main, a merge of
main with a conflict resolution, an edit made only in a merge commit, an added lane on a spec main deleted, and claims.
TEST: node --test scripts/collab/queue.test.mjs  # "collect: batched read equals the old implementation; 6 git spawns with origin/HEAD set"

AC-2: The guard: a stale branch that modified a lane file main has since deleted no longer brings it back.
TEST: node --test scripts/collab/queue.test.mjs  # "collect guard: a stale branch that modified a lane file main deleted does not bring it back"

AC-3: Spawn budget: `collect()` 6 with `origin/HEAD`, ≤ 8 without, 4 with no recent ref, the same for 3 and 8
branches; `listClaims()` 2; `loadPrograms()` 2.
TEST: node --test scripts/collab/queue.test.mjs  # spawn-count tests for collect, listClaims, loadPrograms

AC-4: Spec blobs over 2 MB in total read back in full (`maxBuffer` 256 MiB); `catFileBatch` is byte-accurate.
TEST: node --test scripts/collab/queue.test.mjs  # "collect: spec blobs over 2 MB in total read back in full (maxBuffer)", "catFileBatch: …"

AC-5: Every collab test passes.
TEST: node --test "scripts/collab/*.test.mjs"  # => 101 tests, 101 pass, 0 fail (outputs/tests.txt)

AC-6: A two-repo queue run is fast again on the owner's Windows machine.
TEST: Measure-Command { node scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1> }  # => 238.2 s before, 12.8 s / 6.9 s after (outputs/timings.txt)
