# Evidence — ci-gate-invariants (re-plan)

Pins: `exafyltd/vitana-platform` origin/main `4c4694b7977bbbff1610f1558ac91baeaf7a472b`; `exafyltd/vitana-v1` origin/main
`447e46a82ea9e5dded5dc56b1876dfcde105e361`.

Every row below was read with `git show <sha>:<path> | sed -n 'NNp'` (or `grep -n` for a search) at the platform pin, and the
quoted text is that output. The `depends on` column names the file the premise relies on.

## File reads (vitana-platform @ 4c4694b7977bbbff1610f1558ac91baeaf7a472b)

| # | Path | Line | Quoted line | Depends on |
|---|---|---|---|---|
| 1 | services/gateway/specs/loop-catalog-v1.json | 381 | `"AWS-KIRO-ACCESS",` | services/gateway/src/services/loop-catalog.ts:93 |
| 2 | services/gateway/src/services/loop-catalog.ts | 93 | `return path.resolve(__dirname, '..', '..', 'specs', 'loop-catalog-v1.json');` | the JSON file (row 1) |
| 3 | services/gateway/test/loop-catalog.test.ts | 2 | ` * VTID-05084 — Loop Engineering catalog (specs/loop-catalog-v1.json) and the` | the JSON file (row 1) |
| 4 | services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts | 14 | `const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');` | CLAUDE.md (row 10) |
| 5 | services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts | 29 | `const md = read('CLAUDE.md');` | CLAUDE.md (row 10) |
| 6 | services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts | 45 | `expect(md).toMatch(/[Pp]lan → sparring → machine approval[\s\S]*?→ VTID → code\./);` | CLAUDE.md:336 (row 10) |
| 7 | CLAUDE.md | 19 | `## ⚙️ AUTONOMY CONTRACT — MACHINE UNTIL STAGING VERIFIED (BRIDGE PERIOD, 2026-11-12)` | none (text) |
| 8 | CLAUDE.md | 75 | `## 🤝 CLAUDE CODE ↔ KIRO COLLABORATION (STANDING RULE — VTID-05145)` | none (text) |
| 9 | CLAUDE.md | 93 | `# PART 1: CORE RULES (Always / Never / If–Then)` | none (text); the only `# PART 1` in the file (grep) |
| 10 | CLAUDE.md | 336 | `51. **Back-end and complex work: plan → sparring → machine approval on convergence (local partner or CI policy` | none (text) |
| 11 | CLAUDE.md | 513 | `# PART 2: TECHNICAL REFERENCE` | none (text) |
| 12 | services/gateway/src/services/operator-bootstrap-pack.ts | 55 | `  // VTID-05785: the bridge-period governance additions (CLAUDE.md, #5021) pushed the` | CLAUDE.md:93 |
| 13 | services/gateway/src/services/operator-bootstrap-pack.ts | 59 | `  rulesChars: 12_000,` | the budget used at :114 |
| 14 | services/gateway/src/services/operator-bootstrap-pack.ts | 73 | `  return env.OPERATOR_BOOTSTRAP_PACK_ENABLED === 'true';` | the flag (no other source) |
| 15 | services/gateway/src/services/operator-bootstrap-pack.ts | 114 | `export function extractClaudeMdPart1(text: string, maxChars = LIMITS.rulesChars): string {` | CLAUDE.md (runtime input) |
| 16 | services/gateway/src/services/operator-bootstrap-pack.ts | 115 | `  const cut = text.indexOf('# PART 2');` | CLAUDE.md:513 |
| 17 | services/gateway/src/services/operator-bootstrap-pack.ts | 116 | `  const part1 = cut > 0 ? text.slice(0, cut) : text;` | CLAUDE.md:513 |
| 18 | services/gateway/src/services/operator-bootstrap-pack.ts | 117 | `  return clip(part1.trim(), maxChars);` | LIMITS (row 13) |
| 19 | services/gateway/src/services/operator-bootstrap-pack.ts | 367 | `    section(BOOTSTRAP_RULES_SECTION_TITLE, SOURCE_TIMEOUT_MS, async () => extractClaudeMdPart1(await claudeMd)),` | row 15 (caller) |
| 20 | services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts | 21 | `const REAL_CLAUDE_MD = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');` | CLAUDE.md (row 10) |
| 21 | services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts | 41 | `    const rules = extractClaudeMdPart1(REAL_CLAUDE_MD);` | row 15, row 20 |
| 22 | services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts | 42 | `    expect(rules).toContain('# PART 1: CORE RULES');` | CLAUDE.md:93 |
| 23 | services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts | 43 | `    expect(rules).not.toContain('# PART 2');` | CLAUDE.md:513 |
| 24 | services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts | 44 | `    expect(rules).not.toContain('## CHANGE LOG');` | none (text) |
| 25 | services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts | 45 | `    expect(rules.length).toBeLessThanOrEqual(12_000 + 20); // pins LIMITS.rulesChars (VTID-05785)` | row 13 |
| 26 | services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts | 46 | `    expect(extractClaudeMdPart1('no marker here', 5)).toBe('no ma\n…[abridged]');` | row 15 |
| 27 | scripts/collab/protected-gate-files.json | 5 | `    "CLAUDE.md",` | none (list) |
| 28 | scripts/collab/protected-gate-files.json | 7 | `    "scripts/collab/queue.mjs",` | none (list) |
| 29 | scripts/collab/protected-gate-files.json | 11 | `    ".github/workflows/PLAN-SPAR.yml",` | none (list) |
| 30 | .claude/rules/collaboration.md | 53 | `vtid: VTID-xxxxx             # required from executing on` | none (rule text) |
| 31 | .claude/rules/collaboration.md | 257 | `## 7b. PM merge rule` | none (rule text) |
| 32 | .kiro/pipeline/common-rules.md | 71 | `12. **Measurement (collaboration.md §8b).** Every plan writes ...` | none (rule text) |
| 33 | scripts/collab/preflight.mjs | 1 | `#!/usr/bin/env node` | none |
| 34 | services/gateway/package.json | 13 | `    "test": "jest",` | jest devDependency (row 35) |
| 35 | services/gateway/package.json | 98 | `    "jest": "^29.7.0",` | none |
| 36 | .github/workflows/PLAN-SPAR.yml | 27 | `      - '.kiro/specs/*/plan.md'` | the PLAN-SPAR trigger for this plan (not a premise of the lanes) |

Ancestry check: `git merge-base --is-ancestor 575d70e9ae 4c4694b7977bbbff1610f1558ac91baeaf7a472b` succeeds, and
`git show -s --format=%P 575d70e9ae` has one parent.

Searches at the pin: `git grep -n VTID-05792` (platform and vitana-v1 pins) returns nothing. `git grep -n "# PART 1" CLAUDE.md`
returns only line 93. `git grep -n "AUTONOMY CONTRACT" CLAUDE.md` returns only line 19.

## Reads at the plan branch (not at the pin)

| Path | Line | Quoted line | Note |
|---|---|---|---|
| docs/programs/native-app/program.md | 8 | `  - vitana-platform:ci-gate-invariants` | plan-branch head `0380fe72da`; the program entry is the only file changed outside the spec folder |

## GitHub evidence (PR and commit state, `gh api`; not files at a pin)

| Item | Result | Premise |
|---|---|---|
| `repos/exafyltd/vitana-platform/pulls/5050` | state `closed`, head `kiro/ci-gate-invariants-loop-catalog` at `cee6b6fc18c4` | #5050 closed (corrected) |
| `pulls/5050/files` | 0 files | #5050 has nothing to change on `main` |
| commit `fa534e37` (PR #5050) | trailers `Collab-Session: kiro-exafyltd-202611072144-1c88`, `Collab-Lane: ci-gate-invariants/loop-catalog` | lane key kept |
| `pulls/5068` | state `closed`, head `d942eb5651` | #5068 closed (corrected) |
| `pulls/5068/files` (test file) | one line changed, `:45`: `machine approval` → `machine approval on convergence` | Today, #5068 |
| `pulls/5070` | state `open`, draft `false`, head ref `kiro/vtid-05792-bootstrap-pack-rules`, head `8d1faca3c1` | #5070 |
| `pulls/5070/commits` | `43ace0d895` (VTID-05792 subject), `5f5d7ec3e3`, `8d1faca3c1` | the commit the plan cites is one of three |
| commit `43ace0d8…` and head `8d1faca3c…` messages | 0 `Collab-` trailer lines each | Trailers |
| `pulls/5070/files` (operator-bootstrap-pack.ts patch) | `+ const from = Math.max(0, text.indexOf('# PART 1'));`, `- const cut …` unchanged, slice from `from` | #5070 change (Today) |
| `pulls/5069` | draft `true`, head `524430dde66c` | HELD (out of scope) |
| `524430dde66c…:supabase/migrations/20261112110000_vtid_05793_definer_revoke_sparring_gate.sql:2` | `-- VTID-05793: REVOKE on the Plan Sparring gate SECURITY DEFINER function.` | HELD migration exists on the PR head, not on `main` |
| `gh run list --workflow PLAN-SPAR.yml` | the trigger path at row 36 includes `.kiro/specs/*/plan.md` | a commit that edits `plan.md` starts a round |

## Corrections found in the re-check
- #5050 and #5068 are **closed**. The earlier plan said both "stay open".
- The PR #5070 head is `8d1faca3c`. The plan named `43ace0d8`, which is one of its three commits. Neither has trailers.
- `575d70e9ae` is a single-parent commit. The plan called it a merge commit.
- The protected-file list is the set of globs in `protected-gate-files.json:5-18`. The earlier plan listed directories.

## Removed premises (no citation possible)
- "VTID-05785 widened the same line and a lane review rejected the widening": the review outcome is not in the repo.
- "PLANWRITE-BRIEF forbids editing existing tests" and "the brief's example path": the brief is in the sandbox handover folder, not in either repo.
