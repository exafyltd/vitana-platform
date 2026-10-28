# Sparring round 2 — in_progress

Session: `f98b0fe9-6651-4cac-a46d-cba0f846121d` · plan hash `048e713d5d276e146afd1f2eac5a4cff2d4e40b1408fea824974d6d35f8de72c`

## Summary

Both R1-F1 and R1-F2 are properly acknowledged. R1-F1's three-step path-resolution algorithm and paired test fixtures are now specified; R1-F2's fixture-repo remedy is sound and reduces the UNIT.yml blast radius to only the 25 long-lived paths CONTEXT-MAP.md will link, which is correct behaviour. Two new major findings arise from the revised plan: (1) the `check` command's stated path-resolution algorithm applies only to backtick-quoted rule-file tokens and does not cover the directory references, relative-parent paths, and glob-only patterns that actually appear in domain-atlas.ts `code` arrays — a silent gap in the atlas staleness detection the plan advertises; (2) `vtid --prs` makes a real `gh api search/issues` call, UNIT.yml has no gh authentication setup, and the test spec is silent on how this path is handled in CI. One minor finding: §2.5 line numbers for atlas stale pointers cite the domain-object `key:` line rather than the `code:` array line where the stale string actually appears.

## Findings

### R2-F1 [major]

The `check` command's path-resolution algorithm (§3.1) is stated as: 'a backticked token with a `/` and a file extension is a candidate path.' Atlas `code` arrays contain entries in three formats this algorithm does not handle: (a) directory references with trailing slash — `'orb/delegation/'`, `'services/jev/'`, `'services/timeline/'` (line 65), `'frontend/command-hub/'` (line 89), `'services/timeline/'` (line 113) — none have a file extension after the final `/`; (b) the relative-parent path `'../erp-bridge/'` (line 196); (c) glob-terminated patterns like `'services/governance-*.ts'` (line 77) where the `*` means the token does not end in a literal extension. The plan advertises `check` will warn about 'Atlas code/doc pointers that match nothing,' but the only specified resolution algorithm is for markdown backtick tokens. An implementer applying that algorithm to atlas entries will skip every directory reference (criterion 'has a file extension' fails) and may handle wildcards inconsistently, silently failing to report dead entries like the confirmed-stale `'services/commerce/'` (no `services/commerce/` directory exists in the tree).

- `exafyltd/vitana-platform:services/gateway/src/orb/developer/domain-atlas.ts:65` — code: ['services/gemini-operator.ts', 'services/operator-*.ts', 'orb/delegation/', 'services/dev-agent-memory.ts', 'services/llm-stage-tool-loop.ts', 'services/jev/'],
- `exafyltd/vitana-platform:services/gateway/src/orb/developer/domain-atlas.ts:77` — code: ['services/oasis-*.ts', 'services/vtid-*.ts', 'services/governance-*.ts', 'services/system-controls-service.ts', 'services/plan-sparring/'],
- `exafyltd/vitana-platform:services/gateway/src/orb/developer/domain-atlas.ts:196` — code: ['services/erp-*.ts', '../erp-bridge/'],

Suggestion: Add a second, atlas-specific resolution pass to §3.1: (1) strings ending in `/` are tested as directory-existence checks resolved against repo roots and usual bases; (2) strings containing `*` or `**` are expanded as globs (a match of zero files = dead); (3) strings starting with `../` are resolved relative to the atlas file's own directory (`services/gateway/src/orb/developer/`). Document this algorithm explicitly alongside the rule-file algorithm. Add test fixtures in `context.test.mjs` covering all three forms.

### R2-F2 [major]

`vtid <VTID> --prs` issues a real `gh api search/issues` call against GitHub. UNIT.yml (21 lines, no `env:` block, no `gh auth` step) does not set `GH_TOKEN` / `GITHUB_TOKEN` in the step environment, so `gh api` calls made during `node --test` will fail with an authentication error. §5 says `vtid` tests use 'a fixture git repo built in a temp dir' — a temp dir has no GitHub remote and no issues to search. The plan is entirely silent on how the `--prs` path is exercised or excluded in CI. If the implementer writes a test for `--prs`, UNIT.yml fails; if they skip it, the `--prs` code path ships untested.

- `exafyltd/vitana-platform:.github/workflows/UNIT.yml:1` — name: unit
on: { pull_request: {} }
jobs:
  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Script unit tests (node:test, no install)
        run: |
          FILES=$(find scripts -path '*/node_modules' -prune -o \( -name '*.test.cjs' -o -name '*.test.mjs' \) -print | sort)
          echo "$FILES"
          node --test $FILES

Suggestion: In §5, explicitly address `--prs` by one of: (a) wrapping the `gh api` call behind an injectable `fetchIssues` dependency that the test suite stubs (standard for external calls in script tests) — document the stub in §5; or (b) marking `--prs` tests as skipped in CI via a `CONTEXT_SKIP_GH_API` env guard set in UNIT.yml. Option (a) is preferable because it keeps the test suite dependency-free and gives real coverage. Either way, §5 must name the approach.

### R2-F3 [minor]

§2.5's domain-atlas.ts stale-pointer line citations are systematically wrong. They cite the domain-object `key:` open-brace line, not the `code:` array line where the stale string actually appears. The plan says `governance-*.ts` is at `:72` — confirmed actual `code:` line is 77. The plan says `cognee-extractor-client.ts` is at `:108` — confirmed actual `code:` line is 113. The domain `key: 'oasis'` is at line 72 and `key: 'memory'` is at line 108 — those are the domain-object lines, not the code-pointer lines. The same off-by-~5 pattern repeats for every entry. Implementers cross-checking the plan against the file will land on the wrong lines.

- `exafyltd/vitana-platform:services/gateway/src/orb/developer/domain-atlas.ts:72` — key: 'oasis',
      title: 'OASIS, VTIDs and governance',
      summary:
        'OASIS is the single source of truth...',
      routes: [...],
      code: ['services/oasis-*.ts', 'services/vtid-*.ts', 'services/governance-*.ts', ...],
- `exafyltd/vitana-platform:services/gateway/src/orb/developer/domain-atlas.ts:108` — key: 'memory',
      title: 'Memory and intelligence',
      summary:
        'The member brain...',
      routes: [...],
      code: ['services/cognee-extractor-client.ts', ...],

Suggestion: Correct §2.5 line references to the `code:` array line: `governance-*.ts` → `:77`, `cognee-extractor-client.ts` → `:113`, `connect-people-*.ts` → `:125`, `vitana-index*.ts` → `:149`, `services/commerce/` → `:161`, `wallet*.ts` → `:172`, `erp-*.ts` → `:196`. Documentation-only fix; no implementation impact.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — §2.5 now explicitly marks `:769` as not stale. §3.1 specifies a three-step path-resolution algorithm (repo-prefix match → repo-root/base glob → git ls-files suffix). §5 adds test fixtures for both the short-form live path and the full-path deleted file. The defect is properly addressed.
- R1-F2: acknowledged — The fixture-repo remedy is sound. Using a temp-dir fixture for all `route/domain/why/vtid` tests eliminates blast radius from renaming real route files. The remaining live-file test (CONTEXT-MAP.md link check) is bounded to ~25 long-lived structural paths where a rename genuinely requires updating the map — the same contract as the existing atlas drift test. The concern is resolved.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
