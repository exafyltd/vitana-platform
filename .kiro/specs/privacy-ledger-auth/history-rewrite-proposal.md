# Proposal: remove the account addresses from every file and every commit (not run)

Owner, 2026-11-11: *"Prepare a history-rewrite proposal that removes the account emails from every file and commit. Do
NOT run it. A rewrite of a shared branch needs the owner's explicit go, and it is a separate step after the plan."*

Status: proposal only. Nothing below has been run. Step 1 rewrites shared history and runs only on the owner's explicit
go, with a date. This file contains no address: the list is read from the repository at run time into a private file
outside every checkout.

## 1. What is affected (measured 2026-11-11, read-only)
Addresses: the four `account:` values of `docs/programs/areas.yaml` at vitana-platform `6dc6e1ba0c`. The owner may add
other account addresses to the private list by hand (step 1.1); they are not counted here.

| Measure | vitana-platform (`6dc6e1ba0c`) | vitana-v1 (`e31bf4627`) |
|---|---|---|
| Files on `main` that contain at least one address | 69 | 45 |
| Commits on `main` | 6,202 | 8,423 |
| Commits on `main` whose diff adds or removes one | 62 | 42 |
| Commit messages on `main` that contain one | 77 | 19 |
| Commits on `main` with one as author or committer address | 3,802 | 1,567 |
| Open PRs / branches / tags on GitHub | 151 / 1,047 / 2 | 53 / 389 / 0 |

The files are mostly records: `.kiro/automations/{exafy,exafyltd,jtadic}.md`, handoffs and lane logs under
`.kiro/specs/**`, runbooks under `docs/**`, and evidence under `docs/validation/**` (sparring records, `commands.log`,
saved test output). The author and committer fields are the largest part: they come from commits made under personal
accounts.

The counts come from this command, run from the workspace root. It prints counts and file paths, never an address:

```bash
T=$(mktemp -d)
node -e 'const fs=require("fs");const t=fs.readFileSync("vitana-platform/docs/programs/areas.yaml","utf8");
const em=[...new Set(t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)||[])];
fs.writeFileSync(process.argv[1]+"/e.txt",em.join("\n")+"\n");
fs.writeFileSync(process.argv[1]+"/re.txt",em.map(e=>e.replace(/[.+]/g,"\\$&")).join("|"));' "$T"
RE=$(cat "$T/re.txt")
for r in vitana-platform vitana-v1; do
  git -C $r grep -l -F -f "$T/e.txt" origin/main -- . | wc -l                       # files on main
  git -C $r log origin/main --format=%H -G "$RE" | wc -l                             # diffs
  git -C $r log origin/main --format=%H -E --grep="$RE" | wc -l                      # messages
  git -C $r log origin/main --format='%H %ae %ce' | grep -F -f "$T/e.txt" | wc -l    # author/committer
done
rm -rf "$T"
```

## 2. Step 0 — clean the current files (no rewrite, normal lanes)
- `docs/programs/areas.yaml`: lane `areas-emails` of this plan.
- The 68 other platform files and the 45 v1 files: follow-up lanes (one per repository, through the normal plan gate),
  each replacing an address by the seat name, plus a test like `areas-no-email.test.mjs` that keeps the seat and
  automation files clean. Evidence files are redacted in place; the redaction is recorded in the lane log.
- After step 0 the addresses are only in history. Step 0 is worth doing even if step 1 never runs.

## 3. Step 1 — rewrite history (only on the owner's explicit go)
### 3.1 Preconditions
1. The owner's go, with a date, naming this proposal.
2. A quiet queue: no lane in review, no plan driver running, merges paused (merge bot or PM off, PLAN-SPAR and
   DRIVER-WAKE disabled for the window, seat automations off).
3. Recommended timing: the GitLab cutover window of `agentic-delivery` (§8 of that plan). The cut already pauses
   landing, re-homes `main` and re-mirrors, so the commit ids change once instead of twice.
4. A production PUBLISH just before the window, so production and `main` are on the same tree (see 3.4, PUBLISH gate).

### 3.2 Backup
```bash
for r in vitana-platform vitana-v1; do
  git clone --mirror "https://github.com/exafyltd/$r.git" "$r-backup.git"
  git -C "$r-backup.git" bundle create "../$r-$(date +%F).bundle" --all
done
# Store both bundles in the engineering account (S3, KMS-encrypted). They are the rollback.
```

### 3.3 Rewrite (on fresh mirror clones, with `git filter-repo`)
```bash
mkdir -p ~/private && chmod 700 ~/private                       # outside every repository; never committed
git -C vitana-platform show 6dc6e1ba0c:docs/programs/areas.yaml \
  | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | sort -u > ~/private/accounts.txt
# The owner adds any other account address by hand, one per line.
sed 's/$/==><redacted>/' ~/private/accounts.txt > ~/private/replace.txt
# ~/private/mailmap.txt: one line per address, "Seat <noreply address chosen by the owner> <old address>"
for r in vitana-platform vitana-v1; do
  git clone --mirror "https://github.com/exafyltd/$r.git" "$r-rewrite.git"
  git -C "$r-rewrite.git" filter-repo --replace-text ~/private/replace.txt \
      --replace-message ~/private/replace.txt --mailmap ~/private/mailmap.txt
done
```
`filter-repo` also rewrites abbreviated commit ids inside commit messages, and writes `filter-repo/commit-map` (old id →
new id) for each repository. Keep both maps with the backups.

### 3.4 Verify before pushing
- Every ref of both rewritten mirrors: `git grep -c -F -f ~/private/accounts.txt $(git for-each-ref --format='%(refname)')`
  returns nothing; `git log --all --format='%ae %ce' | grep -c -F -f ~/private/accounts.txt` is 0.
- Trees: for each branch, the rewritten tree differs from the original only on the redacted lines
  (`git diff --stat <old> <new>` through the commit map).
- Build and the full test suites on the rewritten `main` of both repositories (CI on a scratch remote, never on the
  real projects).

### 3.5 Push and clean the hosts
1. Owner: allow force pushes to `main` on both GitHub repositories for the window (branch protection).
2. `git push --force --all` and `git push --force --tags` from each rewritten mirror. GitHub refuses writes to
   `refs/pull/*`, so open PRs keep pointing at the old commits.
3. Owner: a GitHub Support request to remove cached views and the old PR references (GitHub's procedure for removing
   sensitive data); without it the old commits stay reachable through the PR pages.
4. GitLab: push the rewritten history to `vitana/vitana-platform` and `vitana/vitana-v1` (or re-run the mirror), then
   Settings → Repository → Repository cleanup with each `commit-map`, so GitLab drops the old objects.
5. Owner: restore branch protection (force push off).

### 3.6 What breaks, and the repair
| Stored commit ids | Effect after the rewrite | Repair |
|---|---|---|
| PUBLISH gate and STAGING-VERIFY rows (keyed by commit) | the commit production reports through build-info no longer exists in history; STAGING-VERIFY fails closed on an unknown production baseline | PUBLISH the rewritten `main` (same tree as production, precondition 4), or give `run.mjs` a one-time lookup through the commit map |
| Reviews bound to a head (`Collab-Reviewed-Head`), lane logs, `spar_refs`, `timings.json`, OASIS rows, ledger links | point at old ids | the map translates them; in-flight lanes get a new review on their rewritten head |
| 151 + 53 open PRs | their branches are rewritten; reviews lapse | re-review; small queue (precondition 2) |
| Every clone (seat sandboxes, CI caches, the bridge, the mirror) | holds the old history | re-clone; Kiro Web sessions clone fresh anyway |

### 3.7 Rollback
Push the bundles of 3.2 back (`git push --force --all`, `--tags`) and repeat 3.5 step 4 on GitLab.

## 4. Alternatives
| Option | What it removes | Cost |
|---|---|---|
| A. Step 0 only | the addresses in current files | none beyond the lanes; history keeps them (two private repositories) |
| B. Step 0, then step 1 at the GitLab cutover (recommended) | files and history on both hosts | one coordinated window, the PUBLISH before it, a GitHub Support request |
| C. Step 1 now | same as B | a second break of all commit ids at the cut, and a full queue to re-review |

## 5. What the owner decides
1. Go or no-go for step 1, and the date (recommended: inside the cutover window).
2. The no-reply address per seat for the mailmap.
3. Any further account address for the private list.
