# Sparring round 1 — in_progress

Session: `a8274a3c-ae8f-4d4b-bd18-5ed3596a0246` · plan hash `3da8aa4e2b14aafcdf378144d6967c531954b69133e45af65d7643011ba680bd`

## Summary

Three lanes of documentation, tooling, and template improvements. All central premises about file locations and CI wiring hold. Two real gaps found: (1) the integration mechanism between `quality-checks.md` and the automated review prompt is unspecified—the plan says "one sentence" to `lane-review.md` but provides no way for the review step to determine a lane's change types; (2) the BOM fix in `run.mjs` is incomplete because a second JSON parse of `commit-coverage.json` at line 379 is not updated. One minor precision issue: the platform PR template the plan says to "add a section to" does not exist and must be created.

## Findings

### R1-F1 [major]

The central integration point—`lane-review.md` passing quality-checks rows as checklist item 10—has no specified mechanism for determining a lane's change types, making the sentence addition unimplementable as written.

- `exafyltd/vitana-platform:.kiro/agents/vitana-lane-reviewer.md:101` — 10. Any lane-specific check the caller's prompt adds.
- `exafyltd/vitana-platform:.kiro/pipeline/lane-review.md:45` — ## What the review step's prompt gives the agent
Lane key `<slug>/<LANE>`, PR URL(s) and number(s), the head SHA per repo, the repo checkout paths, the spec paths on
`origin/main`, `RUN/lanes/<LANE>/impl-notes.md`, and any lane-specific check.
- `exafyltd/vitana-platform:.kiro/pipeline/lane-code.md:10` — `RUN/lanes/<LANE>/state.json`: `{"status":"pending|in_review|changes_requested|accepted|ci_failed|needs_update|landed|parked|skipped",
"done":false,"vtid","title","seat","reviewer":"agent:vitana-lane-reviewer","executor","depends_on","paths","repos",
"branch","worktree","pr_urls","head_sha","v1_head_sha","review_rounds","ci_fix_attempts","merge_conflicts",
"last_verdict","merge_shas","merged_by","notes"}`

Suggestion: The plan must specify WHERE change types are declared. The two realistic options are: (a) add an optional `change_types: [ui, backend, ...]` field to the lane file schema (shown in `lane-code.md`'s state schema section and the lane file template in `planning.md:35`), with the coder populating it and the review step reading it; or (b) have the coder include a `Change-types:` line in `impl-notes.md` and have the review prompt template in `lane-review.md` extract it. Without this, the `lane-review.md` sentence is aspirational text, not an executable instruction, and the `quality-checks.test.mjs` structural check (which only verifies that `lane-review.md` contains a reference to `quality-checks.md`) will not catch the omission.

### R1-F2 [minor]

`run.mjs` has a second bare `JSON.parse(readFileSync(..., 'utf8'))` call for `commit-coverage.json` at line 379 that the BOM fix does not reach, leaving the same failure mode open for that file.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:202` — function loadManifest(repoRoot, vtid) {
  const p = join(repoRoot, 'docs', 'validation', vtid, 'staging-tests.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { __parseError: e.message };
  }
}
- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:377` — const coveragePath = join(repoRoot, 'docs', 'validation', 'commit-coverage.json');
    let coverageJson = null;
    try { coverageJson = existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, 'utf8')) : null; } catch (e) { log(`commit-coverage.json unreadable: ${e.message} — ignored`); }
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:775` — MAX_HTTP_BODY_CHARS,
  clipBody,
  evaluateHttp,
  httpRequestInit,
  describeBaseline,
  deployCutoff,
  attributeResults,
  DEPLOY_COMPLETED_MARGIN_MS,
  DEPLOY_LOOKBACK_MS,
  decideOutcome,
  summarizeByVtid,
  buildReadyMessage,
  isAutopilotCommit,
};

Suggestion: The `staging-manifest-bom` lane should also update the `commit-coverage.json` parse at `run.mjs:379` to use `parseJsonText`. A corresponding test case ('a BOM commit-coverage.json parses to the same object as the BOM-free one') should be added to `lib.test.cjs`. The plan already cites PowerShell BOM writes as the root cause; `commit-coverage.json` is written by the same tooling environment.

### R1-F3 [minor]

The platform `.github/PULL_REQUEST_TEMPLATE.md` does not exist; the plan's wording 'gets a ## Verification section' implies modification of an existing file, but the lane must create the file from scratch.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:1` — # PR-GATE — mechanical damage protection before merge (VTID-04950, plan E2;
# vitana-platform twin of vitana-v1's VTID-04948 gate).

Suggestion: Acknowledge in §3 that `.github/PULL_REQUEST_TEMPLATE.md` is a new file on vitana-platform (not an edit). The `quality-checks.test.mjs` test checks `the platform PR template has a ## Verification section`; update the red-on-base description to note both `quality-checks.md` and the PR template are absent on base. The lane's `paths` declaration must include `.github/PULL_REQUEST_TEMPLATE.md` as a new file so Lane scope does not flag it as out-of-paths.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
