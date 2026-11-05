# Sparring round 1 — in_progress

Session: `52ba3de1-35fb-4b65-877b-c9ab716852ff` · plan hash `4e179dc8c550e854134d2c3b5ee2e46a73ae15e1a48f3f7d69c291ffc0204a30`

## Summary

The plan is well-researched and its premises largely check out against the pinned code. The race-free git-hook direction (§3.2.2) is sound — a git pre-commit/pre-push hook does run at the point it judges the actual committed/pushed content, fixing the PreToolUse TOCTOU the plan documents. However, the plan has several real gaps and one under-specified code change that could leave the existing `commit && push` block in place.

## Findings

### R1-F1 [major]

The plan removes the PreToolUse `commit && push` block and "defers to pre-push", but never specifies that the PreToolUse guard must SKIP the deferred push's checkPush. The current guard loop (kiro-web-session.mjs:452-455) calls checkPush for every parsed push action; removing only the early block (lines 446-450) still runs checkPush at PreToolUse time for the push in `commit && push`, which (a) preflights the stale pre-commit HEAD and writes a pass-cache entry for the wrong sha, and (b) can still block on `no open PR` (line 418) before the commit+push ever executes — defeating the stated fix.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:446` — const ci = acts.findIndex((a) => a.op === 'commit'); const pi = acts.findIndex((a) => a.op === 'push' ...); if (ci >= 0 && pi > ci) { return block(...separate commands...); } const notes = []; for (const a of acts) { const r = a.op === 'commit' ? checkCommit(...) : checkPush(...); if (r.code !== 0) return r; }
- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:417` — if (!title) { return block(`kiro-web-session guard: no open PR for ${branch}, so the preflight has no PR title ...`); }

Suggestion: Specify that when a commit precedes a push in the same command, the PreToolUse guard must skip checkPush for that push action entirely (no preflight, no title/PR lookup, no pass-cache write) and rely solely on the pre-push hook. Add a test asserting checkPush is not invoked for the deferred push.

### R1-F2 [major]

First-push body gap: pre-push runs VALIDATOR-CHECK, which reads the PR body declarations via --body-file (new). But on a lane's FIRST push there is no open PR (the existing checkPush already blocks on that for the title, line 417-420) and PR_BODY_FILE is only "parsed like PR_TITLE" from the bash command. The plan describes no recovery path for how an agent supplies the full PR body (with VALIDATION_PROFILE, SCOPE_ALLOWLIST, ACCEPTANCE, MERGE_PAYLOAD_PREVIEW, OASIS_IMPACT) at first-push time, so the first push would fail 'no --body-file'.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:411` — const args = [ ... 'preflight.mjs', '--repo', top, '--base', 'origin/main', '--head', sha, '--branch', branch ]; let title = a.title; if (!title && slug) { ... gh api ... } if (!title) { return block('no open PR for ...'); }
- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:66` — run: | node scripts/ci/validator-path-guard.cjs --pr-body-check /tmp/pr_body.txt

Suggestion: Specify a first-push body mechanism: require the agent to set PR_BODY_FILE (e.g. a temp file with the full PR body template) in the same bash command, or fall back to a documented body template when no open PR exists, and add a test for the first-push body path.

### R1-F3 [major]

The plan states (§3.1.1) the Build Gate is "reported under :203 'Not run by preflight'", but line 203 is guarded by `if (!isPlatform)` — it is the vitana-v1-only 'not-covered' block. For vitana-platform PRs (where VALIDATOR-CHECK actually runs), there is no existing 'Not run by preflight' reporting for the excluded Build Gate, so the plan conflates a v1-only block with a new platform responsibility that does not exist yet. Separately, the excluded Build Gate performs a `src+dist both updated` mirroring check for command_hub_frontend (lines 282-289) plus `npm run build` that the pre-commit tsc does NOT cover, so preflight can pass while CI VALIDATOR-CHECK fails.

- `exafyltd/vitana-platform:scripts/collab/preflight.mjs:202` — if (!isPlatform) { add('not-covered', 'Not run by preflight', 'report-only in CI', 'skip', 'vitana-v1 PR-GATE also runs migrations, typecheck / ESLint ...'); }
- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:282` — if [ "$PROFILE" = "command_hub_frontend" ]; then SRC_CHANGED=...; DIST_CHANGED=...; if [ "$SRC_CHANGED" -eq 0 ] || [ "$DIST_CHANGED" -eq 0 ]; then echo "REJECTED: command_hub_frontend requires src+dist both updated"; exit 60; fi; fi

Suggestion: Add an explicit platform-side 'Not run by preflight' entry naming the Build Gate (and the src+dist mirroring sub-check) whenever VALIDATOR-CHECK applies but the build is excluded; do not rely on the v1-only :203 block. Document that a command_hub_frontend PR can pass preflight yet fail CI.

### R1-F4 [major]

Both lanes declare `docs/validation/VTID-*/**` in their `paths` (§3.1 and §3.2), contradicting the §3 header 'no shared file' and §8a.1 'No two lanes edit the same file'. The plan's own §6 risk says shared/hot-file lanes are 'never dispatched together', but it never resolves this overlap or states how Lane scope (queue.mjs scope-check runs against the declared paths) treats the identical glob on two parallel lanes.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:333` — 8a. Parallel execution 1. Lanes run in parallel by default; the plan declares the real `depends_on` ... No two lanes edit the same file.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:60` — paths: # the only files the lane may change (Lane scope); required from executing on

Suggestion: Narrow each lane's `docs/validation/` scope to its own VTID folder (the plan already implies distinct VTIDs per lane), or document explicitly how the overlapping glob passes Lane scope and the shared-file rule. Confirm queue.mjs scope-check accepts two lanes with the same `docs/validation/VTID-*/**` glob.

### R1-F5 [minor]

§3.2.1 makes codeintel (venv + index, ~453s cold per §2.15) opt-in via `--codeintel`, and the AGENTS.md change instructs a bare `setup`, so codeintel silently stops running in normal sessions. Today installScript always schedules codeintel (lines 188-196), even though the detached install never completed in Kiro Web (§2.14). This is a de facto removal of code intelligence from default sessions rather than a fix of the incomplete-detached-install problem.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:188` — const venv = path.join(codeintelDir, 'venv'); lines.push(`export UV_CACHE_DIR=...` ... if (repos.length) lines.push(... bash ${q(setupSh)} --foreground ...);
- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:543` — const child = spawn('bash', ['-c', `{ ${script}\n} >> '${log}' 2>&1`], { detached: true, stdio: 'ignore' }); child.unref();

Suggestion: State whether codeintel is required by any downstream consumer (driver/reviewer/status `--check` treats it as non-required, line 235) and whether defaulting it to off is acceptable; otherwise run codeintel in the foreground by default and gate only the optional parts.

### R1-F6 [minor]

The new `git-pre-commit` detects gateway changes via `git diff --cached --name-only` but then runs `tsc --noEmit`, which reads the WORKING TREE files on disk, not the staged index snapshot. An unrelated unstaged edit with a type error under services/gateway/src (e.g. in-progress work) will cause tsc to fail and false-block a commit whose staged content is clean; and the plan's race test only covers a writer that lands 'before git add', not one landing between `git add` and the hook's tsc run.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:364` — // ...the diff covers edits the marker cannot see (bash/sed) ... const d = run('git', ['-C', top, 'diff', '--name-only', 'HEAD', '--', 'services/gateway/src']);
- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:375` — const t = run('npx', ['tsc', '--noEmit', '--incremental', ...], { cwd: gw, timeoutMs: 540000 });

Suggestion: Specify a tsBuildInfoFile-scoped incremental tsc like the existing checkCommit (line 375) to avoid cross-checkout contamination, and add a test that a dirty unstaged gateway file does not block a clean staged commit (or document the intended conservative behavior).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
