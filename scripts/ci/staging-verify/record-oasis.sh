#!/usr/bin/env bash
# VTID-05128 — STAGING-VERIFY: record the result in OASIS.
#
# Called by the "Record result in OASIS" step of .github/workflows/STAGING-VERIFY.yml.
# Env: SUPABASE_URL, SUPABASE_SVC, RESULTS (results.json path), RUN_URL, SERVICE, SHA.
#
# The event body is written to a file and sent with `curl --data-binary @file`.
# It used to be passed as one argv argument (`curl -d "$BODY"`): a full run
# (VTID-04949, ~1,060 results) exceeds Linux's 128 KiB per-argument limit, bash
# failed with "Argument list too long" and full runs never reached OASIS.
# The event content is unchanged (same jq programs as before).
#
# VTID-05144: metadata also carries superseded_by, attribution_cutoff, chain,
# and per result `attributed` (only when the run was superseded mid-run and
# its results were attributed against the deploy cutoff).
set -euo pipefail

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SVC:-}" ]; then
  echo "::error::SUPABASE_URL / SUPABASE_SERVICE_ROLE not set — the result cannot reach OASIS, so neither channel will see it."
  exit 1
fi

BODY_FILE="$(mktemp "${RUNNER_TEMP:-/tmp}/oasis-event.XXXXXX.json")"
trap 'rm -f "$BODY_FILE"' EXIT

if [ -n "${RESULTS:-}" ] && [ -f "$RESULTS" ]; then
  jq -c --arg run "${RUN_URL:-}" '{
    vtid: (.vtid // "BOOTSTRAP-STAGING-VERIFY"),
    topic: ("staging.verify." + .outcome),
    service: ("staging-verify-" + .service),
    role: "CICD",
    model: "staging-verify",
    status: (if .outcome == "passed" then "success" elif .outcome == "failed" then "error" else "info" end),
    message: .message,
    metadata: {
      env: "staging", service: .service, commit: .sha, outcome: .outcome,
      vtids: .vtids, run_url: $run, production_commit: .production_stamp,
      results: [.results[] | {suite, name, ok, problems} + (if has("attributed") then {attributed} else {} end)],
      missing_suites: .plan.missing, invalid_suites: .plan.invalid,
      shipping: .shipping, full: (.full // false), workflow: "STAGING-VERIFY.yml",
      superseded_by: (.superseded_by // null), attribution_cutoff: (.attribution_cutoff // null),
      chain: (.chain // 0)
    }
  }' "$RESULTS" > "$BODY_FILE"
else
  # The runner crashed before writing a result: that is a failed
  # verification, and it must be visible as one.
  jq -nc --arg svc "${SERVICE:-}" --arg sha "${SHA:-}" --arg run "${RUN_URL:-}" '{
    vtid: "BOOTSTRAP-STAGING-VERIFY", topic: "staging.verify.failed",
    service: ("staging-verify-" + $svc), role: "CICD", model: "staging-verify", status: "error",
    message: ("**Staging verification FAILED — the runner crashed before producing a result.** Not ready for production. Run: " + $run),
    metadata: { env: "staging", service: $svc, commit: $sha, outcome: "failed", run_url: $run, crashed: true, workflow: "STAGING-VERIFY.yml" }
  }' > "$BODY_FILE"
fi

curl -fsS -X POST "$SUPABASE_URL/rest/v1/oasis_events" \
  -H "Content-Type: application/json" -H "apikey: $SUPABASE_SVC" \
  -H "Authorization: Bearer $SUPABASE_SVC" -H "Prefer: return=minimal" \
  --data-binary @"$BODY_FILE"
SHORT_SHA="${SHA:-}"
echo "✓ recorded $(jq -r .topic "$BODY_FILE") for ${SERVICE:-} @ ${SHORT_SHA:0:12}"
