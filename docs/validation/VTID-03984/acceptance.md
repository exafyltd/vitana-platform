# VTID-03984 — Wire FISH_API_KEY into AWS-STAGE-DEPLOY-GATEWAY.yml

## Report

The platform owner provisioned `vitana/gateway/staging/fish-api-key` in AWS
Secrets Manager via `scripts/aws/setup-fish-audio-secret.sh provision
--env staging --apply` (VTID-03970's own documented next step). This VTID
wires it into the staging deploy workflow so Fish Audio actually activates,
following the exact pattern `DEEPSEEK_API_KEY` already uses.

## Acceptance Criteria

AC-1 — `SEC_FISH:vitana/gateway/staging/fish-api-key` added to the
required-secrets resolution loop — the deploy now hard-fails loudly if the
secret is ever missing, same as every other required secret here, rather
than silently deploying without it.

TEST: `commands.log` — `bash -n` on the extracted deploy step, clean.

AC-2 — `FISH_API_KEY` is resolved onto the task definition's `secrets`
array via `valueFrom:$SEC_FISH`, and `TTS_FISH_FALLBACK_ENABLED=true` is
set on the `environment` array — both verified against a real jq dry-run,
not just read by eye.

TEST: `commands.log` / `outputs/jq-dry-run-result.json` — ran the extracted
jq program (via `jq -f`) against a fake task-definition JSON with dummy
`--arg` values for every variable the real workflow passes; confirmed
`FISH_API_KEY.valueFrom == "f"` (the test arg) and
`TTS_FISH_FALLBACK_ENABLED.value == "true"` in the output.

AC-3 — The workflow YAML itself is well-formed.

TEST: `outputs/yaml-parse.txt` — `python3 -c "yaml.safe_load(...)"`, clean.

## Not yet independently confirmed

This workflow only triggers on `push` to `main` (not on `pull_request`), so
merging is the actual first live exercise — verified separately once
merged: the deploy completing successfully, and a real Command Hub
click-through test (Providers & Voice → Fish Audio → Srpski → Preview)
producing real audio instead of the "not configured" 422 VTID-03970/03983
observed before this secret existed.

OASIS_PROOF: not applicable — infra/CI wiring only, no `oasis_events` path
touched.
