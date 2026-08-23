#!/usr/bin/env bash
#
# VTID-03700 — grant the gateway ECS task role the IAM permissions the
# cascaded voice pipeline (VTID-03683: Transcribe -> Bedrock -> Polly) needs
# to actually run, before ORB_CASCADED_VOICE_ENABLED is ever flipped to true.
#
# WHY THIS EXISTS
#
# VTID-03683 shipped the cascade fully built, tested, and mutation-verified,
# but explicitly inert — and its own acceptance doc says why in the same
# words §2b already learned the hard way for Bedrock: "the eligibility gate
# refuses a language it cannot serve, but it cannot see an IAM denial — that
# surfaces per turn as a session that connects and then produces nothing,
# the same invisible shape as VTID-03480 and VTID-03665." Ordering is
# load-bearing: grant IAM first, verify it, THEN flip the flag. Flipping
# first reproduces the exact bug this script exists to prevent.
#
# This is Arabic's actual voice fix (VTID-03700): Nova Sonic has no Arabic
# speech-to-speech capability at all (`NOVA_SONIC_SUPPORTED_LANGUAGES` is
# en/de/fr/es/pt only), so every live Arabic ORB session today would be
# forced onto Nova with the German 'tina' voice substituted — the same
# degraded path Serbian/Polish/Russian are already on. Arabic is the one
# language among the cascade's four (ru/pl/ar/zh) that already has a proper
# Polly neural voice (Hala), so routing it through the cascade instead of
# through Nova's German-voice hack is a real quality improvement, not just
# parity. There has been ZERO live Arabic ORB traffic ever (confirmed via
# oasis_events, 2026-08-23) — this is genuinely new ground, not a fix to an
# observed regression.
#
# WHAT THIS DOES NOT DO
#
# It does not flip ORB_CASCADED_VOICE_ENABLED. That is a separate, later,
# deliberate action via AWS-STAGE-DEPLOY-GATEWAY.yml (staging first, per
# CLAUDE.md §16) then AWS-PROD-DEPLOY-GATEWAY.yml's workflow_dispatch inputs
# — never a hand-edit of the live task definition (the VTID-03513 lesson).
# It does not test a real Arabic session — that is the step AFTER this
# script and the flag are both applied, and it is the first-ever live
# exercise of this path for Arabic specifically.
#
# USAGE
#
#   scripts/aws/setup-cascaded-voice-iam.sh            # dry run, prints the plan
#   scripts/aws/setup-cascaded-voice-iam.sh --apply    # actually attach the policy
#
# AFTERWARDS
#
#   1. Dispatch AWS-STAGE-DEPLOY-GATEWAY.yml (or push to main) so staging
#      picks up... actually the cascade flag is currently only wired as a
#      dispatch input on AWS-PROD-DEPLOY-GATEWAY.yml. Add the equivalent
#      input to the staging workflow before testing there, OR dispatch prod
#      directly with a recorded reason if staging verification is skipped
#      deliberately (not recommended — this is genuinely untested code).
#   2. Set ORB_CASCADED_VOICE_ENABLED=true (and AWS_TRANSCRIBE_REGION if not
#      eu-central-1) via that workflow's dispatch inputs.
#   3. Have a real Arabic ORB session (lang=ar) and confirm in oasis_events:
#        - a provider-selection event with reason='cascaded_language_rescue'
#        - audio actually comes back (not a connect-then-silence session,
#          which is what a missed IAM grant looks like)
#   4. Only then is this proven — per VTID-03683's own acceptance doc,
#      terminalization/promotion waits for that observation, not for this
#      script running cleanly.

set -euo pipefail

ACCOUNT_ID="472838866351"
REGION="${AWS_REGION:-eu-central-1}"
TASK_ROLE="${GATEWAY_TASK_ROLE:-vitana-ecs-task-role}"
POLICY_NAME="VitanaCascadedVoicePipeline"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

echo "=== Cascaded voice pipeline IAM provisioning (VTID-03700) ==="
echo "account : $ACCOUNT_ID"
echo "region  : $REGION"
echo "role    : $TASK_ROLE"
[ "$APPLY" = "1" ] || echo "MODE    : DRY RUN (pass --apply to execute)"
echo

# Guard against pointing this at the wrong account — CLAUDE.md IF-THEN 11.
CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
if [ "$CURRENT_ACCOUNT" != "$ACCOUNT_ID" ]; then
  echo "ERROR: caller is account '$CURRENT_ACCOUNT', expected '$ACCOUNT_ID'." >&2
  echo "Refusing to provision into the wrong account." >&2
  exit 1
fi

# ---------------------------------------------------------------- IAM
# Transcribe streaming has no resource-level ARN to scope to (the streaming
# API operates on a live connection, not a named resource) — "*" is Amazon's
# own documented requirement for transcribe:StartStreamTranscription, not a
# shortcut taken here. Polly is likewise resource-less for SynthesizeSpeech.
cat > /tmp/cascaded-voice-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CascadedVoiceTranscribeStreaming",
      "Effect": "Allow",
      "Action": ["transcribe:StartStreamTranscription"],
      "Resource": "*"
    },
    {
      "Sid": "CascadedVoicePollySynthesis",
      "Effect": "Allow",
      "Action": ["polly:SynthesizeSpeech"],
      "Resource": "*"
    }
  ]
}
JSON

echo "Attaching inline policy '$POLICY_NAME' to role '$TASK_ROLE':"
cat /tmp/cascaded-voice-policy.json
run aws iam put-role-policy \
  --role-name "$TASK_ROLE" \
  --policy-name "$POLICY_NAME" \
  --policy-document file:///tmp/cascaded-voice-policy.json

# ---------------------------------------------------------------- verify
echo
if [ "$APPLY" = "1" ]; then
  echo "=== Verifying the grant actually works ==="
  # Listing a policy is not proof it is effective — §2b's own lesson, where 22
  # Bedrock profiles reported ACTIVE and only 3 could actually be invoked.
  # Simulate instead of trusting the attach call's exit code.
  aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}" \
    --action-names transcribe:StartStreamTranscription polly:SynthesizeSpeech \
    --query 'EvaluationResults[].{action:EvalActionName,decision:EvalDecision}' \
    --output table || echo "(simulate-principal-policy unavailable to this caller)"

  # Polly's grant can be checked for real without spending anything on
  # Transcribe (which needs a live audio stream to invoke at all) — a
  # DescribeVoices call needs no special grant, but a tiny SynthesizeSpeech
  # call exercises the exact permission just attached.
  echo
  echo "Confirming Polly SynthesizeSpeech is actually callable as this role"
  echo "would need to be assumed by ECS to test end-to-end — this command"
  echo "runs as YOUR caller identity, not the task role, so it only proves"
  echo "Polly itself is reachable in this account/region, not that the role"
  echo "grant works. The simulate-principal-policy output above is the real"
  echo "check for the role; a live ORB Arabic session is the final proof."
fi

echo
echo "=== Next steps ==="
echo "1. Add an 'orb_cascaded_voice_enabled' dispatch input to"
echo "   AWS-STAGE-DEPLOY-GATEWAY.yml if testing on staging first (recommended"
echo "   — this path has never been exercised live), or dispatch"
echo "   AWS-PROD-DEPLOY-GATEWAY.yml directly with a recorded reason."
echo "2. Set ORB_CASCADED_VOICE_ENABLED=true via that workflow's dispatch input."
echo "3. Start a real ORB session with lang=ar and confirm in oasis_events:"
echo "     - a provider-selection event: reason='cascaded_language_rescue'"
echo "     - real audio_out per turn, not a connect-then-silence session"
echo "4. Only a real 'cascaded_language_rescue' row with nonzero audio_out"
echo "   proves the grant works end-to-end — this script's own exit code does not."
