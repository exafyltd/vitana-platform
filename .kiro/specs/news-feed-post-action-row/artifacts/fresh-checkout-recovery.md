# Recover the card-actions lane from this PR alone (verified 2026-11-19 ~13:55Z, fresh clone, no original worktree)

| Item | Value |
|---|---|
| Base | vitana-v1 `bbe90b71373e76b18e3a93e22db17b6953c0a183` (= `origin/main` at the time of the check) |
| Patch | `card-actions.patch` at plan head `0f20f71c15a3816b859038e7b40d644291bde1d1`, sha256 `8b5a3464a32c030983ea602f76982bdbd4f96ed92c2f050af9acc9819235d3ec` |
| `git am` | exit 0, one commit, 2 files (+65 / -41) |
| Result | tree `ec6878721d210b62695a1405f3ad3b7e04e9ea01`, identical to the original lane commit; with the committer env below the commit SHA is identical too: `cad441c1747cd1c6208045ef226b396fa976a30b` |

## Commands
```bash
git clone https://github.com/exafyltd/vitana-v1.git && cd vitana-v1
git checkout -b kiro/news-feed-post-action-row/card-actions bbe90b71373e76b18e3a93e22db17b6953c0a183
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/exafyltd/vitana-platform/contents/.kiro/specs/news-feed-post-action-row/artifacts/card-actions.patch?ref=0f20f71c15a3816b859038e7b40d644291bde1d1" > card-actions.patch
sha256sum card-actions.patch   # 8b5a3464…35d3ec
GIT_COMMITTER_NAME='kiro-agent[bot]' GIT_COMMITTER_EMAIL='245459735+kiro-agent[bot]@users.noreply.github.com' \
  GIT_COMMITTER_DATE='<committer date of cad441c, only needed for an identical SHA>' git am card-actions.patch
npm ci --no-audit --no-fund --ignore-scripts
npx vitest run src/components/home/CommunityPostCard.test.tsx
npx vitest run src/components/home
npx eslint src/components/home/CommunityPostCard.tsx src/components/home/CommunityPostCard.test.tsx
npm run build
```
On a later `main`, rebase or `git am -3`; the tree check above then no longer applies.

## Results in the fresh clone
| Command | Result |
|---|---|
| `npm ci` | exit 0 |
| CommunityPostCard.test.tsx | 22 / 22 passed |
| `src/components/home` | 5 files, 42 / 42 passed |
| new layout case with base `CommunityPostCard.tsx` | fails: `Unable to find an element by: [data-testid="post-author-row"]` (red on base) |
| ESLint (both files) | 1 error, `no-explicit-any` at test line 19 `let mockComments: any[] = [];`, present on base; nothing new |
| `npm run build` | exit 0 |
| `git status --short` after | clean |

Still to do when the lane is published: add `docs/validation/<VTID>/` (scope.json `frontend-simple`, acceptance.md,
commands.log, outputs/, staging-tests.json) and move `staging-spec.draft.ts.txt` to
`tests/e2e/staging/vtid-<VTID>-news-feed-post-action-row.staging.spec.ts`.
