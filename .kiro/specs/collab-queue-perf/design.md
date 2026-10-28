# Design — collab-queue-perf
See `plan.md` §Changes. Process budget per repo:

| call | count |
|---|---|
| `symbolic-ref` (default branch) | 1 |
| `for-each-ref refs/remotes/origin` (branches and claims, one call) | 1 |
| `ls-tree -r --name-only <main> -- .kiro/specs` | 1 |
| `rev-list --stdin --not <main> --parents` (recent refs on stdin; full off-main graph, no pathspec) | 1 |
| `log --stdin --not <main> --format=%x00%H --name-status -- .kiro/specs` (spec files per off-main commit) | 1 |
| `cat-file --batch` (main specs, branch specs, claim commits) | 1 |

The last three are skipped when there are no recent refs. Total ≤ 6.

**Branch → changed spec files.** `rev-list --parents` gives the off-main commit graph (no pathspec, so parents
are real, not rewritten). The pathspec'd `log` gives the spec files each off-main commit touched. In JS: for each
recent ref, walk from its tip through parents that are in the off-main set, and union the touched files. That is
the file set of `main..ref`.

**Guard for the revert case.** Read `(ref, path)` only if `path` is on main, or one of the branch's own commits
added it (status `A` in the `--name-status` output). That keeps a file deleted from main from coming
back via a stale branch.

**`cat-file --batch` parsing** works on a Buffer: sizes are bytes. Reply per query is `<oid> <type> <size>\n`,
then `<size>` bytes and `\n`, or `<query> missing\n`. Decode each blob as UTF-8 after slicing. Commit objects
(claims): the message is everything after the first blank line. A path containing a newline cannot be queried and
is skipped (none exist today).
