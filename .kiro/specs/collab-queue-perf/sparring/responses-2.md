# Responses — round 2 (session 0793eaa6)
Both findings accepted; `plan.md` and `tasks.md` updated.
```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "plan.md §Changes 1 now requires maxBuffer: 256 * 1024 * 1024 on every batch-style call: the cat-file --batch reader (Buffer output, sizes in bytes) and the rev-list --parents / log --cc --name-status calls of step 3. A spawn error such as ENOBUFS is thrown, never treated as 'no data' (today's gitOk swallows errors, queue.mjs L266-268, which is exactly how this would have hidden). §Tests adds a fixture whose spec blobs total > 2 MB and asserts they read back in full. tasks.md T1 says the same."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Fixture split as suggested. The equality fixture uses the A-status variant (branch adds a lane file, main later deletes it), where old and new agree. A separate, labelled guard fixture (a stale branch that modified, status M, a lane file main has since deleted) asserts the path does NOT appear in the new collect(), and is excluded from the collectReference equality check with a comment. 'Difference from today' now names this as the guard's one visible difference with its reason (a spec main deleted must not come back via a stale branch) and lists why every other case matches today's rows; Goal 1 points to that section."
  }
]
```
