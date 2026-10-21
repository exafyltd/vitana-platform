#!/usr/bin/env bash
# VTID-04868 — Plan Sparring Gate, session layer.
#
# Every new plan is sparred BEFORE a VTID is allocated (CLAUDE.md "Plan
# Sparring Gate"). A tool call that allocates a VTID without referencing a
# sparring record is DENIED before it runs. A PreToolUse additionalContext
# reminder arrives only with the tool result, i.e. after the VTID already
# exists, so a reminder cannot enforce the ordering; a deny can.
#
# The call passes when it references the sparring record in any of these
# forms (the model re-issues the call after sparring):
#   - p_sparring_id / metadata.sparring_id   (gateway tier, once live)
#   - a `sparring_record` reference, e.g. an SQL comment
#     `-- sparring_record: docs/validation/<VTID>/plan-sparring.md`
#   - sparring_exempt_reason                 (break-glass, owner only)
# The real gate is the vtid_ledger trigger; this hook stops the session early.
input="$(cat)"
# Flatten newlines so a multi-line statement (INSERT\nINTO ...) still matches.
payload="$(printf '%s' "$input" | jq -r '(.tool_input.command // "") + " " + (.tool_input.query // "")' 2>/dev/null | tr '\n\r\t' '   ')"
[ -z "$payload" ] && exit 0

if printf '%s' "$payload" | grep -qiE 'allocate_global_vtid|/vtid/allocate|insert[[:space:]]+into[[:space:]]+("?public"?\.)?"?vtid_ledger"?'; then
  if ! printf '%s' "$payload" | grep -qiE 'sparring_id|sparring_record|sparring_exempt_reason'; then
    jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "PLAN SPARRING GATE (VTID-04868): this call allocates a VTID without referencing a sparring record. Every new plan is sparred by the independent partner (skill: plan-sparring) and approved by the owner BEFORE its VTID is allocated. If it was sparred, re-issue the call with p_sparring_id / metadata.sparring_id, or reference the record (e.g. SQL comment: -- sparring_record: docs/validation/<VTID>/plan-sparring.md). If not, run the plan-sparring skill first."}}'
  fi
fi
exit 0
