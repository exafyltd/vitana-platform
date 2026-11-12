Change types: Tooling/docs.

# Acceptance — VTID-05609 (mt-schema-queue-followup-r2 / lane `migration-queue-rows`)

Plan: `.kiro/specs/mt-schema-queue-followup-r2/plan.md` and the `migration-queue-rows` group of `tasks.md`. Sparring record:
`.kiro/specs/mt-schema-queue-followup-r2/sparring/` (round-2 finding R2-F1 is answered in AC-3).

VALIDATION_PROFILE: gateway_backend (docs only; one Markdown file).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied; no migration, code or workflow changes.

Outcome: an owner approving VTID-05582, VTID-05573 or VTID-05575 sees every file and its apply order in
`docs/multitenancy/MIGRATION-QUEUE.md`; nobody applies out of order.

AC-1 Rows 48-49 (VTID-05582, `20261102051000`, `051100`), rows 50-53 (VTID-05573, `052000`-`052300`) and rows 54-56
(VTID-05575, `053000`, `053100`, `053200`) exist in apply order; the VTID-05569 rows move from 51-52 to 57-58; rows 61-62
(VTID-05506) and rows 1-47 are unchanged. Every file named exists under `supabase/migrations/` on `main`.
TEST: `node docs/validation/VTID-05609/outputs/queue-check.mjs --repo <checkout>` -> `outputs/red-origin-main.txt` (7 fail on
base), `outputs/green.txt` (0 fail).

AC-2 No reference to the old numbers remains: the notes "Rows 48-50 are reserved for VTID-05575" and "Rows 51-52
(VTID-05569)", the row 52 dependency "#51" and the row 51 "row 52" wording, and row 46's "VTID-05582 ... rows" wording are
rewritten to the new numbers.
TEST: `outputs/queue-check.mjs` check "no stale reference" and `outputs/grep-stale.txt`.

AC-3 (R2-F1) The "Depends on" column records functional dependencies stated in each migration file header, not sort
position. Row 54 (053000) is "expand only", rows 55-56 depend on #48 (and 56 on #55), and no VTID-05575 row names row 45
(VTID-05576). The VTID-05573 rows take theirs from its file headers on `main` (052000 and 052100 "need 20261102050000 and
20261102051000", i.e. #45 and #48).
TEST: `outputs/queue-check.mjs` checks "row 54" and "rows 55-56" and `outputs/headers.txt` (the header lines quoted).

AC-4 Row 50 carries the VTID-05573 apply preconditions from its `acceptance.md`: every reader and writer of the legacy
tables is retired first (the 052000 freeze breaks their writes), and the owner approves the files only with a clean
`live-before.sql` output.
TEST: `outputs/queue-check.mjs` check "row 50 carries the 05573 apply preconditions".

AC-5 Table order equals apply order, numbers are unique and increase down the table; one Notes bullet per VTID (05582,
05573, 05575) records owner approval, 30-day `bak_*` retention (05573) and the drift baseline state.
TEST: `outputs/queue-check.mjs` checks "unique", "monotonically" and "queue order".

Staging proof: not verified on staging, docs only (`staging-tests.json`).

## Decisions taken (most conservative option inside the plan)
- PR #4850 (VTID-05579, rows 63-65) is open and not on `main`; this lane leaves rows 61-62 untouched and adds no row 63+.
  If #4850 lands first its rows stay as they are; the monotonic check still holds.
- VTID-05573's PR is merged (`2c1a3d23ad`), so rows 50-53 are written (plan task Q2).
- The drift baseline is not edited (outside the lane's paths); the Notes say which tables are or are not in it.
