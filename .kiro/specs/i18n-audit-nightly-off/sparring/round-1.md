# Sparring round 1 — in_progress

Session: `2a3612e6-6b35-4c39-8000-93238a2bd18b` · plan hash `cb5527970f6121bf081c03266822d049ba57a3662f1a598b5e5c60a9c40ca5cf`

## Summary

The plan's core mechanism — deleting the `schedule:` trigger and `audit-nightly` job, flipping the dispatch default to `deepseek`, and updating one CLAUDE.md line — is correct and the major premises check out. Three issues remain: one governance-sequence violation that needs clarification, and two minor hygiene gaps that the plan should address while it has the file open.

## Findings

### R1-F1 [major]

Implementation code is prepared in draft PR exafyltd/vitana-v1#1463 during Round 1 sparring, which inverts the governance-mandated sequence: Plan → sparring → approval → VTID → code.

- `exafyltd/vitana-v1:CLAUDE.md:182` — 1. **Plan → sparring → owner approval → VTID → code.** Every new plan is sparred by the independent `plan-sparring-partner` agent (read-only, Claude Opus 4.6) before its VTID is allocated. No VTID for the sparring itself.
- `exafyltd/vitana-platform:CLAUDE.md:482` — 51. **Plan → sparring → owner approval (or, for a CI-sparred plan that converged, policy approval `converged-auto-v1`, VTID-05214) → VTID → code.** No VTID is allocated for a plan that has not been sparred, and no VTID is ever allocated for the sparring itself.

Suggestion: The plan must clarify one of two things: (a) the draft PR is a placeholder branch with zero implementation commits — the actual edits will be made after sparring converges and the VTID is allocated; or (b) if the CI-sparring pipeline generates code in parallel with the plan as a known workflow design, that exception should be cited explicitly (pointing at a policy record) so the executor and reviewer can confirm it is accepted. As written, the plan states 'The implementation is prepared as draft PR #1463' with no VTID anywhere in the document, which is an undefended sequence inversion relative to rules that explicitly govern CI-sparred plans. No VTID number appearing in the plan is correct (allocation happens post-convergence); the code-before-sparring is the concern that needs clarification.

### R1-F2 [minor]

`scripts/i18n-audit-llm.mjs` hard-codes `'gemini'` as the fallback default on line 67. The plan changes the workflow input default to `deepseek` but leaves the script's own default untouched, so a developer running the script directly (without `--provider`) silently falls back to the exhausted Gemini quota.

- `exafyltd/vitana-v1:scripts/i18n-audit-llm.mjs:67` — const PROVIDER = args.provider || 'gemini';

Suggestion: Change line 67 to `const PROVIDER = args.provider || 'deepseek';` in the same PR, consistent with the plan's stated rationale (Gemini quota exhausted, DeepSeek is the only responding provider today). The usage comment on line 34 (`default gemini`) and the `--provider=gemini` example on line 34 should also be updated to reflect the new default.

### R1-F3 [minor]

After removing `audit-nightly`, the workflow-level `pull-requests: write` permission is entirely dead. Neither the surviving `audit-single` job (which only git-pushes to the dispatching branch) nor any other remaining step in the file uses the PR API. The plan modifies this file but leaves an unnecessary permission in place.

- `exafyltd/vitana-v1:.github/workflows/i18n-audit-llm.yml:59` — permissions:
  contents: write
  pull-requests: write
- `exafyltd/vitana-v1:.github/workflows/i18n-audit-llm.yml:105` —     - name: Commit audit results
      run: |
        git config user.name "github-actions[bot]"
        ...
        git push origin HEAD:${{ github.ref_name }}

Suggestion: Remove `pull-requests: write` from the workflow-level `permissions` block in the same PR. The `audit-single` job only needs `contents: write` to commit and push audit results back to the dispatching branch. Leaving a write permission that no remaining job exercises violates least-privilege and would be flagged by any future permissions audit.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
