# Sparring round 1 — in_progress

Session: `fcd0bf3d-b5bc-4be0-8588-46df4430292d` · plan hash `ff9b2f2c772261175ac065cbd9a919554c94558e77151b813eddb8bde6da188e`

## Summary

Verified 8 premises (P1–P8) against the pinned code in `exafyltd/vitana-platform`. All hold. Found three findings: one major risk around adding `send_message` to review steps, one major concern about loss of platform-enforced tool restrictions, and one minor omission in the file-edit scope for `lane-review.md`.

## Findings

### R1-F1 [major]

The plan adds `send_message severity 'success'` to every review step, but the current review steps deliberately omit it while all other step types include it. The land step parses the verdict JSON and review entry from `{{review-N.output}}`. If `{{step.output}}` is scoped to the `send_message` payload (which is how `stopWhen` on land-N and spar steps appears to work — the prompt says 'end your final message with VITANA_SLOT_DONE' and stopWhen checks `{{land-N.output}} contains VITANA_SLOT_DONE`), then adding `send_message` to review steps would replace the parseable verdict blocks in `{{review-N.output}}` with a success message. The land step at lane-land.md:8-10 expects the verdict JSON with `model: claude-sonnet-5.5` and `agent: vitana-lane-reviewer`; it would reject the output, logging a blocker on every review. The current omission of `send_message` from review steps looks deliberate, not accidental.

- `exafyltd/vitana-platform:.kiro/workflows/vitana-pipeline.workflow.json:94` — review-1 prompt has no send_message instruction; land-1 prompt says 'When this step's work is done, always call send_message with severity success' and parses {{review-1.output}} for the verdict
- `exafyltd/vitana-platform:.kiro/pipeline/lane-land.md:8` — **New verdict** (status `in_review` and the review step's output for `head_sha` is a verdict): write the three `RUN/reviews/<LANE>-<head7>.*` files (`lane-review.md`). The JSON must say `model: claude-sonnet-5.5` and `agent: vitana-lane-reviewer` (else: blocker, ignore it, go to 4).

Suggestion: Do not add `send_message` to review steps. The current pattern — review steps return raw output that the land step parses — works precisely because `send_message` is absent. If Kiro workflow semantics make `{{step.output}}` the send_message payload, adding it would break every review. Confirm the Kiro workflow output semantics before any change, and if `send_message` is added, ensure the verdict blocks are the payload.

### R1-F2 [major]

Switching from workspace agent `vitana-lane-reviewer` (with Kiro-enforced deny of fs_write, web_fetch, web_search, MCP and all shell commands except 9 specific patterns) to the bundled `wf-code-reviewer` (full write tool set) removes all platform-enforced restrictions on the review step. The guard tests at guard.test.cjs:91-98 still validate the workspace agent file's tool restrictions, but these become decorative — they test a file that is loaded as checklist text, not as the executing agent. After the change, there is no CI-enforceable check that the review step cannot write files, run arbitrary shell commands, or access the network. The reviewer is the last independent check before merge (lane-review.md:5); prompt-only enforcement is a weaker guarantee than the current platform-enforced restrictions.

- `exafyltd/vitana-platform:.kiro/agents/vitana-lane-reviewer.md:16` — permissions: rules: - capability: fs_write effect: deny - capability: web_fetch effect: deny - capability: web_search effect: deny - capability: mcp effect: deny - capability: shell match: [...9 patterns...] exclude: [...chaining...] effect: allow - capability: shell exclude: [...] effect: deny
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:149` — Guard validates workspace agent tools, excludedTools, includeMcpJson, includePowers, and REQUIRED_BODY — all on the workspace agent file, not on the executing bundled agent
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.test.cjs:91` — Tests verify workspace agent excludes write tools (fs_write, str_replace, delete_file) — but these restrictions don't apply to the bundled wf-code-reviewer

Suggestion: Either (a) keep the review step dispatched to the workspace agent `vitana-lane-reviewer` and fix only the self-check and the allowlist (the actual root causes of the observed failures), or (b) if switching to `wf-code-reviewer` is necessary, add an explicit guard check that the review step prompt contains the read-only prohibition AND add a new guard test proving the workspace agent's permission block is still semantically enforced (e.g. a check that the prompt carries 'never edit, write, delete, commit, push, merge, approve or comment'). Document in the plan why platform enforcement cannot be kept.

### R1-F3 [minor]

The plan says lane-review.md edits are at `:3` and `:34`, but line 1 (the heading) also names the old agent: `# Lane review: the reviewer agent \`vitana-lane-reviewer\` on \`claude-sonnet-5.5\``. If the heading is left unchanged while the body describes `wf-code-reviewer`, the file is self-contradictory.

- `exafyltd/vitana-platform:.kiro/pipeline/lane-review.md:1` — # Lane review: the reviewer agent `vitana-lane-reviewer` on `claude-sonnet-5.5`

Binding: `common-rules.md`. The review step runs the workspace agent `.kiro/agents/vitana-lane-reviewer.md` with
`modelId: claude-sonnet-5.5`.

Suggestion: Add line 1 to the edit list: update the heading to reflect `wf-code-reviewer` + checklist.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
