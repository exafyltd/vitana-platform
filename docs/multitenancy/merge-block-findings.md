# Merge block findings (read-only, step 1 of KIRO-HOTMAIL-HANDOVER-ROUND3)

Checked: 2026-11-10, via `gh api` (read-only). No merge was attempted and nothing was changed on GitHub.

## What was read

- `main` head: `6dc6e1ba0c` (merge of PR #4714, committed 2026-11-08 18:27:41Z). Last merge into main.
- Open PRs: the first page (`per_page=50`) returned 50 open PRs, and I did not paginate. The total is at least 50, not the 15 the handover lists. The list response does not fill `mergeable_state`, so each PR needs its own fetch.
- PR #4935 (seat move, plan `mt-guardrails-r2`), head `ef32c06420`:
  - `mergeable: true`, `mergeable_state: blocked`, `rebaseable: true`, `draft: false`.
  - Reviews: none. `review_decision` is empty.
  - Check runs: 11 of 11 `success`.
  - Combined commit status: `pending`, with zero status entries.
- PR #4924 (VTID-05576 audit note), head `f10adb4869`:
  - `mergeable: true`, `mergeable_state: blocked`, `rebaseable: false`.
  - Check runs: 12 `success`, 4 `cancelled` (`validate-pr`, `Lane scope`, `Collab handoff`, `pr-gate`).
  - Combined commit status: `pending`, with zero status entries.
- Branch protection on `main`: `GET /repos/.../branches/main/protection` returns HTTP 403 for this token. The rules cannot be read.
- Rulesets on `main`: none (`GET /repos/.../rules/branches/main` returns `[]`).
- Repo settings: not archived, not disabled, default branch `main`, squash and merge commits allowed, auto-merge disabled.
- CODEOWNERS: no file at `.github/CODEOWNERS` or the repo root.

## What this shows

- Every check on #4935 passes, and `mergeable` is true. The `blocked` state therefore does not come from a failing check.
- No reviews exist on either PR. A required approving review is the most likely cause. The handover notes that a reviewer-agent accept may not count as a human approval. That is an inference. It cannot be confirmed from this token.
- The four cancelled checks on #4924 are a separate issue. Those runs need a re-run decision by the owner. This step did not re-run them.

## What this does not show

- The actual protection rule. It needs an owner or admin token with access to branch protection, or the settings page for `main`.

## Question for the owner

What is blocking merges to `main`? Specifically: is a required human approving review, a required status check, a lock, or a merge queue setting in effect?

Step 2 is to report this. Steps 3 onward have not started.
