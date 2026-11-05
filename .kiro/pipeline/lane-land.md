# Lane land (last step of each lane slot loop; the only writer of `done`)

Binding: `common-rules.md`. Paths as in `lane-code.md`. Always write `RUN/lanes/<LANE>/state.json` back; set `done:
true` exactly when the status becomes `landed`, `parked` or `skipped`.

1. Slot empty or state missing → write `{"status":"skipped","done":true,"notes":["no lane state"]}` when a lane id
   exists, then go to 4. An empty slot normally never reaches this step: the gate skips it (`slot-N-skip` /
   `slot-N-go`, `node scripts/collab/run-gate.cjs`, zero agent sessions); this stays the fallback when the gate
   cannot read RUN.
2. **Review outputs** (status `in_review`): this iteration's review race (`lane-review.md`: one pinned review step
   per chain model in a `joinPolicy: "any"` parallel, first finished wins) has ended; read the stored outputs
   `RUN/reviews/<LANE>-<head7>.out-<model>.md` in chain order (`claude-sonnet-5.5`, `claude-opus-5.5`,
   `claude-sonnet-4.5`). Never wait for a model and never re-run one; this step does not dispatch reviews.
   **New verdict** (the first file that is a verdict for `head_sha`): write the three `RUN/reviews/<LANE>-<head7>.*`
   files (`lane-review.md`). The JSON's `model` must equal the model in the file name (the pin of the step that
   produced it), and the `Collab-Reviewer` must be `agent:vitana-lane-reviewer (<that model>)`;
   `agent: vitana-lane-reviewer` (else: blocker, ignore that file and try the next; `unstated` or the bare identity
   never counts on a new entry).
   Append the entry to the lane file log on BRANCH in WT (front matter unchanged), commit with
   the entry's trailer lines and the bot identity, push (protocol); log in `decisions.md` that the land step committed
   it on the agent's behalf. `last_verdict` = `{"verdict","file","reviewed_head"}`; `head_sha` = the entry commit
   (an entry-only commit after the reviewed head keeps the review on the current head). `changes` →
   `changes_requested` (`parked` + `done` if `review_rounds` is already 3). `accept` → `accepted`; timing
   `lane_accepted`.
   **No valid verdict for `head_sha`** although the race completed (a branch finished without a stored verdict, for
   example the store watch could not find RUN): one blocker line in `blockers.md` naming the head and the files found, status `parked`, `done: true`, go to 4. The race already gave every chain model its
   one try on this head, so it is not repeated. A new head starts fresh. (When all three models fail, the race itself
   fails and this step does not run: `lane-review.md` "All three fail".)
3. **`accepted` → land:**
   a. Order: a lane whose plan names a "lands first" lane waits until that lane is `landed` or `parked` (poll 2-3 min,
      max 90 min; else stay `accepted`, go to 4).
   b. Merge lock (one merge at a time): create `RUN/merge.lock` exclusively (`New-Item` fails when it exists) with the
      lane and the time; held → poll 2-3 min; a lock older than 90 min is stale (remove it, log it). Release it at the
      end of this step whatever happens.
   c. `gh pr ready` if draft. Already merged by the PM → `merged_by: PM`, go to f.
   d. Up to date with latest `main`: if behind, `gh pr update-branch <n>` (no force); clean → keep the accept (log:
      only `main`'s commits added); conflict → `merge_conflicts`+1, status `needs_update`, release the lock, go to 4.
      Merge with `node <vitana-platform>/scripts/collab/land-guard.mjs merge --gh <owner/repo> --pr <n> --reviewed-head
      <Collab-Reviewed-Head> --title "<title>" --wait 3600` (common rule 13: it waits for every required check green on
      that exact head and refuses a stale review, a red check, a PR behind its base and a protected gate file), at once under
      the §7b rule (common rule 4) with **squash** (the subject keeps the PR title's VTID, which STAGING-VERIFY reads;
      a merge commit fails rule 47, `quality-checks.md` "Merge"); `--admin` only for the governance-artifact
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
      `lane_merged` (`mergedAt`). Release the claim only after the lane's closing record
      (`state: done`) is merged to `origin/main`: `land-guard.mjs release --repo <dir> --slug <slug> --lane <LANE> --session
      <id>` (it refuses, and prints the file and the state it found, otherwise; common rule 13).
   g. A rule-text lane (steering / collaboration.md) right after landing: for both repos, fetch; if the main
      checkout is on `main` with a clean `git status --porcelain` → `git merge --ff-only origin/main`, else skip and
      log, so the next steps load the new rules.
4. **Slot hand-over.** When this slot's lane is `done` and `RUN/slots.json` `queue` is not empty, move the first queued
   lane whose `depends_on` are all landed or parked into this slot (`slots.N`), and do not end the loop. When the
   slot's lane is `done` and the queue is empty, the final message ends with the line `VITANA_SLOT_DONE` (the slot
   loop's stop token); never write that token in any other case.

Final message: lane, status, action, PR URL(s), merge SHA(s) and who merged, `done`, and the stop token when it applies.
