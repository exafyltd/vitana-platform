# Sparring round 1 — in_progress

Session: `abb7d483-a2f1-4fc4-baa7-5437c6d51426` · plan hash `97b6ce2556db1214d3a6c96c9aacbdaa5c22034ad9d5469b576c0fc59f660fd6`

## Summary

The plan is well-researched, with thorough sandbox probes and correct premises about the existing codebase. Most stated premises verify cleanly. The scope is well-bounded (two new files plus docs, no deployed code changes), the governance model is correctly navigated (executor: kiro + reviewer agent for governance-path files that are not protected gate files), and the fail-open guard design is sound. I found one concrete typo that would cause a runtime failure and a couple of minor gaps.

## Findings

### R1-F1 [major]

Plan §3.A.1.c specifies `uv pip install repowise graphifyy[bedrock]` with a double 'y' in the package name. The actual tool is named `graphify` (see session-setup.sh line 85: `for t in repowise graphify`). If the implementer follows the plan text literally, the pip install will fail with a 'package not found' error, breaking the code-intelligence venv creation.

- `exafyltd/vitana-platform:scripts/codeintel/session-setup.sh:82` — link_onto_default_path() {  # MCP servers and git hooks may not see ~/.local/bin
    local t dir=/usr/local/bin
    [ -w "$dir" ] || return 0
    for t in repowise graphify; do

Suggestion: Fix the typo: `graphify[bedrock]` (single y), not `graphifyy[bedrock]`.

### R1-F2 [minor]

The plan's guard on `git push` requires a PR title via either a `gh api` lookup of the open PR or a `PR_TITLE='…'` environment-variable prefix on the push command. Parsing `PR_TITLE='…'` out of the raw `tool_input.command` shell string is fragile: the agent could use double quotes (`PR_TITLE="…"`), export syntax (`export PR_TITLE=… && git push`), or set it in a prior command. The test plan §4.4 covers 'every push form above' but does not explicitly list the PR_TITLE extraction variants. If parsing fails, the guard blocks a legitimate first push, requiring the agent to create the PR first (which needs a push). This creates a chicken-and-egg problem for the very first push of a lane branch.

- `exafyltd/vitana-platform:scripts/collab/preflight.mjs:117` — if (wt !== head) add('worktree', 'Working tree at --head', 'required', 'fail', `the checked-out HEAD (${(wt || 'none').slice(0, 12)}) is not --head (${head.slice(0, 12)}); Collab tests, PR-GATE and Kiro steering judge the checked-out tree, as CI checks out the PR head`);
      if (opts.title === undefined) add('title', 'PR title', 'required', 'fail', 'no --title: PR-GATE scope / sparring / red-green read the VTIDs from the PR title (CI uses the live title); pass --title "<PR title>"');

Suggestion: Specify the exact `PR_TITLE` extraction logic (e.g., only the `VAR='value' command` POSIX form, single-quoted). Add an explicit test case for the PR_TITLE parsing. Consider documenting that the first push of a lane can alternatively use `gh pr create` first (which doesn't go through `git push`) and then the second push finds the PR via `gh api`.

### R1-F3 [minor]

The plan says the `status` subcommand 'prints the morning pack' when DEV_MEMORY_PACK_TOKEN is present, reusing `.claude/hooks/session-start-dev-memory-pack.sh`. That script makes an HTTPS request to `preview-aws-gateway.vitanaland.com` (line 17), which is a network call. The plan's test §4 says tests use 'no network', so either the status tests skip the morning-pack path entirely or they need to mock the network call. But the test plan §4.7 only checks 'missing hooks → exit 1' for status, and doesn't mention the morning-pack integration. If the morning-pack call fails or times out in a test/sandbox context, it could cause flaky status results.

- `exafyltd/vitana-platform:.claude/hooks/session-start-dev-memory-pack.sh:16` — TOKEN="${DEV_MEMORY_PACK_TOKEN:-}"
BASE="${DEV_MEMORY_PACK_URL:-https://preview-aws-gateway.vitanaland.com}"
REPO_NAME="${DEV_MEMORY_PACK_REPO:-vitana-platform}"

if [ -z "$TOKEN" ]; then
  echo "dev-memory-pack: DEV_MEMORY_PACK_TOKEN not set — skipping the morning pack" >&2
  exit 0
fi

Suggestion: Add a test case for `status` with and without the token set. The no-token path (line 20-22) exits cleanly, but the with-token path makes a network call. Clarify that tests always run without the token, or mock the script.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
