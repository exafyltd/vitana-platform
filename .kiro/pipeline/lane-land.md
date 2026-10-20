# Lane land (last step of each lane slot loop; the only writer of `done`)

Binding: `common-rules.md`. Paths as in `lane-code.md`. Always write `RUN/lanes/<LANE>/state.json` back; set `done:
true` exactly when the status becomes `landed`, `parked` or `skipped`.

1. Slot empty or state missing → write `{"status":"skipped","done":true,"notes":["no lane state"]}` when a lane id
   exists, then go to 4.
2. **New verdict** (status `in_review` and the review step's output for `head_sha` is a verdict): write the three
   `RUN/reviews/<LANE>-<head7>.*` files (`lane-review.md`). The JSON must say `model: claude-sonnet-5.5` and `agent:
   vitana-lane-reviewer` (else: blocker, ignore it, go to 4). `model_unavailable` → blocker, status stays
   `in_review`, go to 4. Append the entry to the lane file log on BRANCH in WT (front matter unchanged), commit with
   the entry's trailer lines and the bot identity, push (protocol); log in `decisions.md` that the land step committed
   it on the agent's behalf. `last_verdict` = `{"verdict","file","reviewed_head"}`; `head_sha` = the entry commit
   (an entry-only commit after the reviewed head keeps the review on the current head). `changes` →
   `changes_requested` (`parked` + `done` if `review_rounds` is already 3). `accept` → `accepted`; timing
   `lane_accepted`.
3. **`accepted` → land:**
   a. Order: a lane whose plan names a "lands first" lane waits until that lane is `landed` or `parked` (poll 2-3 min,
      max 90 min; else stay `accepted`, go to 4).
   b. Merge lock (one merge at a time): create `RUN/merge.lock` exclusively (`New-Item` fails when it exists) with the
      lane and the time; held → poll 2-3 min; a lock older than 90 min is stale (remove it, log it). Release it at the
      end of this step whatever happens.
   c. `gh pr ready` if draft. Already merged by the PM → `merged_by: PM`, go to f.
   d. Up to date with latest `main`: if behind, `gh pr update-branch <n>` (no force); clean → keep the accept (log:
      only `main`'s commits added); conflict → `merge_conflicts`+1, status `needs_update`, release the lock, go to 4.
      Wait (poll 2-3 min, max 60 min) for every required check green on that exact head, then merge at once under
      the §7b rule (common rule 4) with the method recent merged PRs use; `--admin` only for the governance-artifact
      false positive (log why); never over a real red. A lane spanning both repos merges both PRs.
      Infra or flake (runner lost, network, a known flake on `main`) → `gh run rerun <id> --failed` once per check per
      head; the rerun allowlist is PR checks, PLAN-SPAR, PR-GATE and STAGING-VERIFY only, never `AWS-PROD-*`. Real
      failure → `RUN/lanes/<LANE>/ci-failure.md` (check, run URL, failures) and status `ci_failed` (`parked` + `done`
      if `ci_fix_attempts` is already 3). Still running at the bound → stay `accepted`, go to 4.
   e. A proof lane the plan says the PM must merge: never self-merge first; meet its preconditions (deploy of the
      lanes it proves, the mode the plan names), release the lock, poll up to 60 min for the PM merge; none → read-only
      evidence, log the proof incomplete in `blockers.md`, re-take the lock and merge under common rule 4.
   f. Record the merge SHA (`gh pr view <n> --json mergeCommit,mergedBy,mergedAt`), who merged (PM or §7b rule),
      `--admin` and why → `merges.md`, lane log and state; a PR comment on PRs this step merged:
      `Merged under collaboration.md §7b (PM merge rule): merge commit <sha>`; status `landed`, `done: true`; timing
      `lane_merged` (`mergedAt`). Release the claim (`queue.mjs release <slug>/<LANE> --session <id>`).
   g. A rule-text lane (steering / collaboration.md) right after landing: for both repos, fetch; if the main
      checkout is on `main` with a clean `git status --porcelain` → `git merge --ff-only origin/main`, else skip and
      log, so the next steps load the new rules.
4. **Slot hand-over.** When this slot's lane is `done` and `RUN/slots.json` `queue` is not empty, move the first queued
   lane whose `depends_on` are all landed or parked into this slot (`slots.N`), and do not end the loop. When the
   slot's lane is `done` and the queue is empty, the final message ends with the line `VITANA_SLOT_DONE` (the slot
   loop's stop token); never write that token in any other case.

Final message: lane, status, action, PR URL(s), merge SHA(s) and who merged, `done`, and the stop token when it applies.
