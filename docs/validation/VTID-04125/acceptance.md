# VTID-04125 — Acceptance Criteria

Wire RepoWise's LLM synthesis to DeepSeek (RepoWise has no Bedrock
provider), and fix a real, previously-undiscovered CLI bug in
`runRepowise()` found while verifying that live.

AC-1: RepoWise resolves DEEPSEEK_API_KEY via REPOWISE_PROVIDER=deepseek.

`.claude/hooks/session-start-codeintel-setup.sh` sets
`REPOWISE_PROVIDER=deepseek` when `DEEPSEEK_API_KEY` is present in the
session environment and `REPOWISE_PROVIDER` is not already set; it must
never override an operator-set provider and must never write a
fabricated key to a tracked file.

TEST: `bash -n .claude/hooks/session-start-codeintel-setup.sh` (syntax) +
live verification recorded in `commands.log` — with `DEEPSEEK_API_KEY`
set (an intentionally invalid value, since this session has no funded
key) and `REPOWISE_PROVIDER` unset, `repowise ask "..."` resolved the
provider to `deepseek` and made a real outbound call to
`api.deepseek.com`, returning a genuine `401` rather than any local
fallback/mock behavior.

AC-2: runRepowise() no longer sends the non-existent --no-prose flag.

`runRepowise()` (`services/gateway/src/services/codeintel-readonly.ts`)
no longer appends `--no-prose` to the argv of any of the 7 allowlisted
subcommands (`ask`/`search`/`context`/`risk`/`health`/`why`/`status`) —
that flag does not exist on any of them (confirmed against
`repowise <cmd> --help` for each, recorded in `commands.log`) and was
making every real `dev_repowise` Operator Console call fail outright
with a CLI usage error, independent of provider configuration.

TEST: services/gateway/test/vtid-04116-operator-codeintel.test.ts ::
"passes the free-text argument through to an allowlisted repowise
subcommand, bounded" — asserts the exact argv passed to execFile no
longer contains --no-prose.

AC-3: the rest of dev_repowise/dev_graphify wiring is unchanged.

The rest of the `dev_repowise` / `dev_graphify` Operator Console tool
wiring (kill switch, command allowlist, repo allowlist, ENOENT ->
`not_configured`, end-to-end CLI result passthrough) is unchanged by
this fix.

TEST: services/gateway/test/vtid-04116-operator-codeintel.test.ts (all
12 tests in the suite), plus `npx tsc --noEmit` on services/gateway
clean — both recorded in commands.log.
