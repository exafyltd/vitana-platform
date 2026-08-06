#!/usr/bin/env bash
#
# VTID-03508 — remove always-on Cloud Run standby billing in GCP.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The deploy workflows have been updated (STAGE-DEPLOY.yml, DEPLOY-ORB-AGENT.yml,
# EXEC-DEPLOY.yml via VTID-03491), but a workflow edit only takes effect on the
# NEXT deploy of that service. Until then the live services keep their current
# warm floors and keep billing. This script applies the same change directly so
# the saving starts now, without waiting for a deploy.
#
# It is idempotent, and it PRINTS BEFORE/AFTER for every service it touches.
#
# WHAT IT DOES NOT DO
# -------------------
#   * It does not delete or disable any service. Every change here is a scaling
#     floor; the services stay deployed, routable, and instantly restorable.
#   * It does not touch `worker-runner` — see the WORKER-RUNNER section below.
#   * It does not touch the Serverless VPC connector — see VPC CONNECTOR below.
#   * It does not change any AI/voice/TTS provider. Vertex Imagen and Google
#     Cloud TTS keep working exactly as before: they are per-call APIs and need
#     no Cloud Run instance of their own.
#
# USAGE
#   scripts/gcp/scale-idle-to-zero.sh              # dry run — shows the plan, changes nothing
#   scripts/gcp/scale-idle-to-zero.sh --apply      # actually apply
#   scripts/gcp/scale-idle-to-zero.sh --restore    # put the warm floors back
#
set -euo pipefail

PROJECT="lovable-vitana-vers1"
REGION="us-central1"
MODE="dryrun"

for arg in "$@"; do
  case "$arg" in
    --apply)   MODE="apply" ;;
    --restore) MODE="restore" ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v gcloud >/dev/null 2>&1 || {
  echo "ERROR: gcloud not found. This script must run somewhere authenticated to ${PROJECT}." >&2
  exit 1
}

ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [ "$ACTIVE_PROJECT" != "$PROJECT" ]; then
  echo "NOTE: active gcloud project is '${ACTIVE_PROJECT:-<unset>}'; this script pins --project=${PROJECT} explicitly."
fi

show() {
  local svc="$1"
  local min cpu
  min="$(gcloud run services describe "$svc" --region="$REGION" --project="$PROJECT" \
        --format='value(spec.template.metadata.annotations."autoscaling.knative.dev/minScale")' 2>/dev/null || echo "?")"
  cpu="$(gcloud run services describe "$svc" --region="$REGION" --project="$PROJECT" \
        --format='value(spec.template.metadata.annotations."run.googleapis.com/cpu-throttling")' 2>/dev/null || echo "?")"
  echo "    ${svc}: minScale=${min:-0} cpu-throttling=${cpu:-<default true>}"
}

run() {
  if [ "$MODE" = "dryrun" ]; then
    echo "    [dry run] $*"
  else
    "$@"
  fi
}

# Print the post-change state, but only when a change was actually made.
# (Written as a function rather than a chained [ ] || [ ] && { } test: that
# construct's precedence is subtly wrong and its exit status trips `set -e`.)
show_after() {
  if [ "$MODE" != "dryrun" ]; then
    echo "  after:"
    show "$1"
  fi
}

echo "=============================================================="
echo " VTID-03508  GCP idle standby -> zero      mode: ${MODE}"
echo "=============================================================="
echo

# --------------------------------------------------------------------------
# 1. gateway (GCP production) — ~$70-150/mo
#    Zero production traffic since the 2026-07-27 AWS cutover (VTID-03419).
#    It is the standing ROLLBACK TARGET, so it stays deployed and routable —
#    a cold start on a rollback is entirely acceptable.
# --------------------------------------------------------------------------
echo "[1/3] gateway  (GCP prod — rollback target, zero live traffic since 2026-07-27)"
echo "  before:"; show gateway
if [ "$MODE" = "restore" ]; then
  run gcloud run services update gateway --min-instances=1 --region="$REGION" --project="$PROJECT" --quiet
else
  run gcloud run services update gateway --min-instances=0 --region="$REGION" --project="$PROJECT" --quiet
fi
show_after gateway
echo

# --------------------------------------------------------------------------
# 2. gateway-staging — ~$69/mo
#    KNOWN CONSEQUENCE: a cold authenticated ORB /orb/live/session/start takes
#    ~9.4s vs the widget's 8s abort, so the FIRST ORB open after idle will go
#    silent on staging. Warm it before testing voice:
#        curl -s https://preview-gateway.vitanaland.com/alive >/dev/null
# --------------------------------------------------------------------------
echo "[2/3] gateway-staging  (preview env; first ORB open after idle will cold-start)"
echo "  before:"; show gateway-staging
if [ "$MODE" = "restore" ]; then
  run gcloud run services update gateway-staging --min-instances=1 --region="$REGION" --project="$PROJECT" --quiet
else
  run gcloud run services update gateway-staging --min-instances=0 --region="$REGION" --project="$PROJECT" --quiet
fi
show_after gateway-staging
echo

# --------------------------------------------------------------------------
# 3. vitana-orb-agent — ~$150/mo, the largest single item
#    THIS TURNS THE LIVEKIT VOICE PATH OFF, it does not merely slow it down.
#    The livekit-agents worker connects OUTBOUND to LiveKit Cloud and must stay
#    resident to receive dispatches; at min-instances=0 it deregisters.
#    Justification (measured 2026-08-06): the LiveKit canary allowlist contains
#    ONE user, and there have been ZERO room-join/agent-dispatch events in 90
#    days. All real ORB voice runs on the WS/Vertex/Nova path, which does not
#    use this service.
#    Restore with --restore here, or dispatch DEPLOY-ORB-AGENT with warm_worker=true.
# --------------------------------------------------------------------------
echo "[3/3] vitana-orb-agent  (LiveKit worker — LARGEST ITEM; this DISABLES the LiveKit voice path)"
echo "  before:"; show vitana-orb-agent
if [ "$MODE" = "restore" ]; then
  run gcloud run services update vitana-orb-agent --min-instances=1 --no-cpu-throttling --region="$REGION" --project="$PROJECT" --quiet
else
  run gcloud run services update vitana-orb-agent --min-instances=0 --cpu-throttling --region="$REGION" --project="$PROJECT" --quiet
fi
show_after vitana-orb-agent
echo

# --------------------------------------------------------------------------
cat <<'EOF'
==============================================================
 DELIBERATELY NOT TOUCHED
==============================================================

WORKER-RUNNER (~$65/mo, min-instances=1)
  Not changed, and NOT because it is cheap. `worker_registry` shows TWO
  worker-runners heartbeating within seconds of each other, but the registry
  records no cloud attribution, so it cannot be determined from the database
  alone whether the second poller is the AWS ECS `vitana-worker-runner`
  (VTID-03411) or a second GCP revision.

  That distinction decides the outcome:
    - if the other poller is AWS, scaling GCP to zero is free and safe;
    - if both are GCP, scaling to zero stops the canonical autopilot pipeline
      dead (VTID-01206 pinned min-instances=1 precisely to keep polling alive),
      and it would fail SILENTLY — the pipeline simply stops claiming work.

  Resolve it first with:
      gcloud run services describe worker-runner --region=us-central1 \
        --project=lovable-vitana-vers1 --format='value(status.traffic)'
      aws ecs describe-services --cluster Vitana-ECS-Cluster \
        --services vitana-worker-runner --region eu-central-1 \
        --query 'services[0].runningCount'
  If AWS shows runningCount>=1 and is genuinely claiming tasks, GCP's can go to
  zero. Two simultaneous pollers is itself worth a look — CLAUDE.md's "Never run
  parallel VTID executions" rule cuts against it.

SERVERLESS VPC CONNECTOR (~$15-70/mo, min-instances=2)
  Created by PROVISION-MEMORYSTORE.yml. Two instances is the platform MINIMUM
  for a connector, so it cannot be scaled down — it can only be deleted, and
  only if Memorystore/Redis is genuinely unused. Editing that workflow does
  nothing to the existing connector (it is create-if-not-exists). Check first:
      gcloud redis instances list --region=us-central1 --project=lovable-vitana-vers1

MEMORYSTORE / REDIS ITSELF
  Not assessed here. If the gateway on AWS uses ElastiCache (per CLAUDE.md §1b)
  the GCP Redis instance may be idle, but that needs confirming against live
  config before anything is removed.
EOF

echo
if [ "$MODE" = "dryrun" ]; then
  echo ">>> DRY RUN — nothing was changed. Re-run with --apply to execute."
fi
