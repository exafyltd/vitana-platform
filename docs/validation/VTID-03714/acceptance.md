# VTID-03714 — CSP Governance Gate scans the diff, not the whole file

Evidence pack for a governance-gate bug discovered live while trying to
merge VTID-03711 (PR #3167, an emergency production hotfix): the CSP
Governance Gate in `.github/workflows/VALIDATOR-CHECK.yml` rejected that PR
with exit 50, even though the PR's own diff contains zero CSP-pattern
matches.

**Root cause:** the step read each CSP-surface file's FULL content
(`open(f).read()`) and pattern-matched against that, rather than against
what the PR actually changed. `orb-widget.js` is a ~3,400-line, years-old
file that legitimately contains `.style.cssText` DOM manipulation and a
doc-comment `<script src=...>` usage example — none of it new. Any PR
touching that file, regardless of content, would fail this gate. This is
the same defect shape already fixed once for the Route Mount Evidence Gate
(VTID-03696): a gate that judges the whole file instead of the diff
produces false rejections, and an unsatisfiable gate eventually gets muted
or bypassed by someone under deadline pressure — which is exactly the
situation this was caught in (a live "Mickey Mouse voice" production bug
blocked on an unrelated CI false positive).

---

AC-1 — `cspViolationsInAddedLines` flags a CSP pattern in an ADDED line

TEST: `services/gateway/test/scripts/validator-path-guard.test.ts`
— "flags a pattern that appears in an ADDED line"
Output: `outputs/targeted-tests.txt`

AC-2 — `cspViolationsInAddedLines` does NOT flag the identical pattern in
a context (unchanged) line

The core fix: pre-existing content that a diff merely shows as context
(unified diff lines with no `+`/`-` prefix) must not be judged, because the
PR did not touch it.

TEST: same file — "does NOT flag the identical pattern in a context
(unchanged) line"
Output: `outputs/targeted-tests.txt`

AC-3 — `cspViolationsInAddedLines` does NOT flag a pattern in a REMOVED
line, and ignores the `+++` file header

Mirrors the exact guarantees `routeEvidenceRequired()` already gives for
the Route Mount Evidence Gate.

TEST: same file — "does NOT flag a pattern in a REMOVED line"
TEST: same file — "ignores the +++ file header, which is not an added line"
Output: `outputs/targeted-tests.txt`

AC-4 — The exact PR #3167 false positive is reproduced and confirmed fixed

A unit test constructs the real shape: pre-existing `orb-widget.js` context
lines (the doc-comment `<script src=...>` example, three `.style.cssText`
lines) alongside the actual VTID-03711 added lines
(`_pcmRateFromMime`/`createBuffer` call). Asserts zero violations.

TEST: same file — "reproduces the exact PR #3167 false positive and
confirms it is now clean"
Output: `outputs/targeted-tests.txt`

**Also verified end-to-end against the real PR, not just a unit test
fixture:**

TEST: `node scripts/ci/validator-path-guard.cjs --csp-added-lines` run
against the actual `git diff origin/main...origin/claude/orb-widget-pcm-rate-vtid-03711
-- services/gateway/src/frontend/ services/gateway/dist/frontend/` (35
lines) — exits 0, "No CSP pattern hits in added lines." The same file's
full content independently greps 27 pre-existing CSP-pattern hits, none of
which are in that diff.
Output: `outputs/end-to-end-pr3167-simulation.txt`,
`outputs/pr-3167-real-diff.txt`

AC-5 — A genuinely NEW CSP violation added by a diff is still caught

The fix narrows judgment to added lines — it must not also become a rubber
stamp. A newly-added `<script>` injection alongside pre-existing, untouched
`.style` context still triggers a violation.

TEST: same file — "still catches a genuinely NEW CSP violation added by a
diff"
Output: `outputs/targeted-tests.txt`

AC-6 — No regression to the guard's existing behaviour

TEST: `npx jest test/scripts/validator-path-guard.test.ts` — 37/37 tests
passing (31 pre-existing + 6 new), 0 failures. Includes the untouched
`the remit is exactly the workflow trigger` test, confirming this change
did not touch `REMIT`/the workflow's `paths:` trigger.
Output: `outputs/targeted-tests.txt`

AC-7 — Type-checks and syntax-checks clean

TEST: `node -c scripts/ci/validator-path-guard.cjs` — syntax OK.
TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## Verification summary

| Check | Result |
|---|---|
| Targeted guard tests | 37/37 passing (6 new for this fix) |
| End-to-end against the real PR #3167 diff | exits 0 — false positive gone |
| `node -c` syntax check | clean |
| `tsc --noEmit` | clean |
| Workflow YAML re-parses | confirmed via `python3 -c "import yaml; yaml.safe_load(...)"` |
| Live confirmation (staging) | N/A — this is a CI-governance-only change with no runtime deploy surface |

## Known limitation carried forward

This fix corrects the CSP gate's scope. It does not add any new CSP
protection beyond what already existed — a genuinely risky pattern
introduced by a future diff is still caught (AC-5), just no longer punished
retroactively for content nobody touched.
