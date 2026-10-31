# Sparring round 2 — in_progress

Session: `52ba3de1-35fb-4b65-877b-c9ab716852ff` · plan hash `f75828609a7d20e377acf65009377460c6501d55351777e7cb093ec66618f481`

## Summary

All six R1 findings were accepted by the planner and appear genuinely addressed in the revised plan. The revision introduces three new gaps, two of them major: (1) the new git pre-commit/pre-push hooks—which are the sole remaining race-protection mechanism once the PreToolUse typecheck and mark-dirty hook are removed—are never added to `statusReport`, so `status --check` exits 0 even when the hooks are absent; (2) the per-step done-stamp mechanism described in §3.2.1 is underspecified against the existing single-stamp code; (3) a minor stale string in the hook status message.

## Findings

### R2-F1 [major]

After the plan's changes, `status --check` does not verify that the git pre-commit/pre-push hooks are installed. The plan removes the PreToolUse `checkCommit` call and the `vitana-web-dirty.json` PostToolUse hook and states that the git hooks replace them. But `statusReport` at lines 202-243 has no check for git hooks at all. Its `rep.ok` (line 243) is built solely from the existing `add(...)` items, none of which covers `<git-common-dir>/hooks/pre-commit` or `pre-push`. If setup cannot install the git hooks (e.g. an unmarked file is already there), `status --check` exits 0, the agent proceeds, and the race protection introduced by this plan is entirely absent.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:202` — export function statusReport(...) { ... add('workspace-steering',...); add('hooks',...); add('reviewer-agent',...); add('gateway-deps',...); ... add('installs', !!setupDone, false, ...); return { ok: items.every((i) => i.ok || !i.required), items }; }
- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:516` — if (cmd === 'status') { const rep = statusReport({ workspace }); process.stdout.write(...); return argv.includes('--check') && !rep.ok ? 1 : 0; }

Suggestion: Add a required `add('git-hooks', ...)` call in `statusReport` that, for each checkout found by `findRepos`, checks that `<git-common-dir>/hooks/pre-commit` and `pre-push` exist and contain the marker line. Flag as `required: true` so `status --check` exits 1 when either hook is missing. The plan should specify the marker-detection logic for shell scripts (analogous to `isMarked` for JSON hooks at line 103-105).

### R2-F2 [major]

The plan states (§3.2.1) 'status reports `ready` only after the steps that ran finished (each writes its own done stamp; a stamp older than the step's start is ignored)'. The current `installScript` writes exactly ONE stamp at the very end (`setup.done`, line 197) and `statusReport` checks only that stamp (lines 240-242, `required: false`). The plan's per-step stamp system—which is needed to show progress during an 8-minute foreground run and to detect stale stamps from a prior interrupted run—is not described anywhere: the stamp names, how many there are, where the setup start time is recorded for the staleness check, and what changes to `installScript` and `statusReport` are required are all unspecified.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:195` — if (repos.length) lines.push(`s=$(date +%s); bash ${q(setupSh)} --foreground ...`); lines.push(`date -u +%FT%TZ > ${q(path.join(cacheDir, 'setup.done'))}`, 'echo "setup done $(date -u +%FT%TZ)"'); return lines.join('\n');
- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:240` — let setupDone = null; try { setupDone = readFileSync(path.join(cacheDir, 'setup.done'), 'utf8').trim(); } catch { /* not yet */ } add('installs', !!setupDone, false, setupDone ? `finished ${setupDone}` : `not finished ...`); return { ok: items.every((i) => i.ok || !i.required), items };

Suggestion: Enumerate the per-step stamps explicitly in the plan (e.g. `steering.done`, `deps-<keyOf>.done`, `codeintel.done`) and specify that `setup` writes a `setup.start` timestamp before invoking any step. `statusReport` checks each step's stamp against `setup.start` to detect staleness. Add a test for intermediate status (one stamp present, others absent).

### R2-F3 [minor]

The `statusReport` success message for the hooks item is hardcoded as 'guard + mark-dirty in ${hookDir}' (line 219). Once the plan removes `vitana-web-dirty.json` from `hookDefs()`, that string becomes stale — setup would correctly delete the old file via `writeHooks`, but a passing `status` output would still reference a hook that no longer exists.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:215` — const missing = hookDefs({ platformRoot }).filter((d) => { const p = path.join(hookDir, d.file); return !existsSync(p) || readFileSync(p, 'utf8') !== `${JSON.stringify(d.json, null, 2)}\n`; }).map((d) => d.file); add('hooks', missing.length === 0, true, missing.length ? `missing or stale: ${missing.join(', ')} (run setup)` : `guard + mark-dirty in ${hookDir}`);

Suggestion: Derive the success message from `hookDefs()` dynamically (e.g. `defs.map(d=>d.file.replace('.json','')).join(' + ') + ' in ' + hookDir`) so it stays accurate when the set of hooks changes.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — §3.2.2 explicitly states the PreToolUse guard does not call the push check for a push that follows a commit in the same command, and §3.2.7 adds a test verifying checkPush is not invoked. The revised plan fully addresses the original gap.
- R1-F2: acknowledged — §3.2.2 adds the `pr-body` subcommand, PR_BODY_FILE env-var flow, and a blocking error when VALIDATOR-CHECK applies but neither a PR body nor PR_BODY_FILE is available. §3.2.7 adds tests for both paths. Addressed.
- R1-F3: acknowledged — §3.1.2 adds a platform-side not-covered entry naming the Build Gate (including the command_hub_frontend src+dist sub-check) whenever the check applies; the :202-203 entry is documented as v1-only. The README states a command_hub_frontend PR can pass preflight and still fail CI. Addressed.
- R1-F4: acknowledged — The planner's rationale that scope-check judges each PR's changed files against that PR's own lane only is sound. The shared glob is the standard allowlist form used by parallel plans in this repo. The §3 note clarifies each lane writes only its own VTID subfolder.
- R1-F5: acknowledged — §3.2.1 changes setup to run all steps in the foreground by default (~8 min cold); --no-codeintel skips only the venv/index build. No detached child is started. Addresses the de-facto removal concern.
- R1-F6: acknowledged — §3.2.2 documents the conservative behavior (unstaged type errors also block) and specifies the error message names the unstaged files. §3.2.7 adds the corresponding test. Addressed.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
