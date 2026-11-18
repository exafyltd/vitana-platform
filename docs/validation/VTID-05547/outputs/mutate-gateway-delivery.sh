#!/usr/bin/env bash
# Mutation check for services/gateway/test/delivery/** (VTID-05547). Runs mutate-gateway-delivery.mjs, which breaks one value of the
# lane's code at a time in scratch copies and requires a named case of the six Jest suites to go red.
#
# usage: mutate-gateway-delivery.sh <worktree>
# env:   WORKERS  parallel scratch copies (default 8)
#        ONLY     regex on the mutation name: run a subset
#        TMPDIR   where the scratch copies and the Jest cache go
set -eu
exec node "$(dirname "$0")/mutate-gateway-delivery.mjs" "${1:?worktree}"
