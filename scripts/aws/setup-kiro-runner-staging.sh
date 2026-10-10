#!/usr/bin/env bash
# VTID-04999 staging shortcut, kept for the commands already in docs and chat:
# same subcommands, flags and exit codes as `setup-kiro-runner.sh --env staging`.
exec "$(dirname "$0")/setup-kiro-runner.sh" --env staging "$@"
