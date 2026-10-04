#!/usr/bin/env bash
# VTID-04868 — Plan Sparring Gate, session layer (UX only, never blocks).
#
# Every new plan is sparred BEFORE a VTID is allocated (CLAUDE.md "Plan
# Sparring Gate"). When a tool call looks like a VTID allocation without a
# sparring id, inject a reminder into the model's context. The real gate is
# the vtid_ledger trigger (log mode now, enforce later); this hook only makes
# the rule visible at the moment it matters.
input="$(cat)"
payload="$(printf '%s' "$input" | jq -r '(.tool_input.command // "") + " " + (.tool_input.query // "")' 2>/dev/null)"
[ -z "$payload" ] && exit 0

if printf '%s' "$payload" | grep -qiE 'allocate_global_vtid|/vtid/allocate|insert[[:space:]]+into[[:space:]]+(public\.)?vtid_ledger'; then
  if ! printf '%s' "$payload" | grep -qiE 'sparring_id'; then
    jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "PLAN SPARRING GATE (VTID-04868): this call allocates a VTID without a sparring_id. Standing rule: every new plan is sparred by the independent partner (skill: plan-sparring) and approved by the owner BEFORE its VTID is allocated. If this plan was sparred, pass p_sparring_id / metadata.sparring_id. If not, stop and run the plan-sparring skill first. The vtid_ledger trigger records every allocation without a valid sparring record."}}'
  fi
fi
exit 0
