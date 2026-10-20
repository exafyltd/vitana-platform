# Plan — kiro-primary-executor

Rule-only change: Kiro becomes the primary executor and carries routine work end to end — plan → PLAN-SPAR → VTID →
build → review/fix-forward → merge → owner-approved migrations → staging deploy and verification → dependent lanes →
done — and stops for the owner only at a defined list of major decisions. No product code.

<!-- plan:begin -->
## Goal (owner, 2026-10-20, Kiro session kiro-jtadic-202610201358-fc62)
"I want Kiro to become the primary executor for this project and carry work through end-to-end. Do not hand routine
work back to me or Claude Code merely because another procedural step is reached." The owner lists the major
decisions that still stop the work (§D below), and says routine CI failures, test fixes, plan corrections,
documentation, lane transitions, review findings, non-destructive staging work, merge sequencing and implementation
details are never reasons to ask. "First, create a rule-only plan to update the collaboration/role rules so this
operating model is actually permitted. Do not change product code."

Change class: **governance** (rule text and the seat automations only). Pinned: `exafyltd/vitana-platform@3063c9543`,
`exafyltd/vitana-v1@996bfaf1d`.

## Today (verified in the text)
1. **Merging needs a per-PR owner instruction.** `.claude/rules/collaboration.md` §7a forbids merging, dispatching a
   workflow and deploying; §7b allows a merge only "when the owner has explicitly instructed this specific merge in the
   conversation (a standing 'merge my lanes' does not count)", and never in an unattended run. The Project Manager that
   should merge by rule is not live (`PM_MODE` dry_run; lane `pm-agent/p4-act` not built).
2. **Steps that fall outside §7b go back to Claude Code or the owner:**
   - `.kiro/steering/vitana-kiro-notes.md` sends a blocked lane to `next_actor: claude`;
   - `.kiro/automations/*.md` step 6 stops on "a VTID, a plan change, a migration apply, a governance path, a live
     write" with `next_actor: claude`;
   - Reviewer step B leaves `verified` and the merge to "Claude Code (later the Project Manager)";
   - the closing line "The Project Manager (or, until it runs, Claude Code) merges verified lanes, watches staging and
     sends the owner Gate 2".
   A plan that escalated in PLAN-SPAR (partner unavailable) also waits for `claude`: 13 such `_plan` rows in today's
   queue (both repos).
3. **Migrations have no Kiro path.** Every agent text says "a database change is a migration file in the PR"; nothing
   says who applies it. The appliers are (s2 R1-F1), all `workflow_dispatch` only:
   - vitana-platform `RUN-MIGRATION.yml` (target input; honours `MIGRATION_FREEZE`);
   - the 21 per-file vitana-v1 `apply-*.yml` workflows.

   `APPLY-FB061-DEBOUNCER-FIX.yml` is not one of them (s2 R2-F1): it is a one-shot, self-deleting code-patch workflow
   that pushes to a feature branch and touches no database. Like any other non-staging workflow, Kiro never dispatches
   it under §7d. Each posts one hardcoded SQL file to the production Supabase
     ref (`inmkhvwdcuyhnxkgfvsb`) and has no target input, hash check or freeze guard.
   Merging a migration file applies nothing: the push-triggered `SQL-*` workflows run against a CI Postgres service
   container and reference no live database secret. Staging shares the production Supabase project, so **every applied
   migration is a production database write**.
4. **The stop list is narrower than the owner's.** `CLAUDE.md` Autonomy contract "Stop and ask mid-flight only for"
   (a)–(d): out-of-plan work that does not converge, a production write not covered by the gates, security or
   data-loss risk, the same failure surviving 3 fix-forward attempts. Nothing names legal, financial, scope or
   unrelated-release decisions, and there is no required format for the stop message.
5. **In flight, same files:** plan `retire-claude-code` (approved; VTID-05255..05259). Its lane `scope-rules`
   (#4210, open) makes `governance: true` Kiro lanes valid in `queue.mjs`. Its lanes `rules-platform` / `rules-v1`
   (ready) rewrite the role text without Claude Code and add §7c (production after Gate 2: PUBLISH by the owner, or a
   Kiro dispatch on an explicit "yes, deploy"). It keeps §7b's per-PR merge instruction. This plan builds on it.

## Change — new §7d "Kiro is the primary executor" (both repos), and the texts that point at it

### A. Standing authority
**Activation (R1-F1).** §7d is not activated by this plan's policy approval. It takes effect only when the owner
answers this plan's Gate 1 with an explicit "yes", including the B.4 scope choice. The answer is recorded verbatim
with the date in `handoff.md` and `docs/validation/<VTID>/plan-sparring.md`, and each lane then needs the owner's
per-PR merge instruction (governance). Until both lanes are merged, §7b applies unchanged.

**Owner's Gate 1 (2026-10-20): "Gate 1 approved — interactive only."**
- §7d applies only to **interactive Kiro sessions started by the owner**.
- Automation runs may plan, build, review and reach `verified`. They may not merge until the follow-up
  `merge-deploy-guard` is implemented and tested, and even then only after a separate owner decision. This plan
  does not enable automation merge authority.

Once active: the owner's instruction to start a workstream, a plan's policy approval `converged-auto-v1`, or a Gate 1
"yes" is the standing instruction for every routine step of that workstream's lanes. A Kiro session carries them without
asking, in this order:
plan → PLAN-SPAR → VTID → build → reviewer-seat review → fix-forward → `verified` → merge → owner-approved migrations
→ staging deploy + STAGING-VERIFY → the next dependent lane → `done` → Gate 2.

It **never** hands a lane to Claude Code or the owner because a procedural step was reached. `next_actor: claude` is
no longer written by Kiro, except for the legacy `executor: claude` lanes until `retire-claude-code` retires them.

### B. Steps Kiro now takes itself
1. **Sparring.**
   - Kiro answers each round.
   - A plan that escalated on infrastructure (partner unavailable, `partner_output_invalid`, dead session) is
     re-triggered by a push. That retry is mechanised by `plan-spar-stale-session` (VTID-05254, merged) and
     `plan-spar-retry-invalid` (VTID-05262).
   - If it is still escalated after those retries, the plan stays `drafted` on the board, the session reports it and
     moves to other work. This is never an owner question.
2. **VTID (R1-F5).** PLAN-SPAR allocates on convergence, as today. A lane executor never allocates. When a plan is
   converged and policy-approved, or owner-approved at Gate 1, and a lane still has no VTID, the **coordinator** fixes
   it: the session holding that plan's `_plan` claim, which must be a session of the plan's `author_seat`. It
   allocates through the gateway (`POST /api/v1/vtid/allocate`) citing the sparring record and plan hash, and writes
   the VTID in a `_plan` commit. The `vtid_ledger` trigger still refuses any VTID without a converged, approved record
   with a matching hash. No VTID ever comes from `execute_sql`.
3. **Verified.** The session holding the lane claim sets `verified` from an `approve` entry by the lane's
   `reviewer_seat` on the PR's current head. Self-review stays forbidden. The reviewer seat's automation picks up the
   review, so waiting for it is not a hand-back: the session works other lanes meanwhile.
4. **Merge (replaces §7b's per-PR instruction for non-governance lanes).** An interactive Kiro session started by
   the owner (never an automation run) merges a lane PR when all of these hold. This is the Project Manager rule, applied by Kiro until the PM runs `live`:
   - the lane is `verified`;
   - every check on the head is green, incl. Lane scope and Collab handoff;
   - no merge conflict;
   - every `depends_on` lane is `done`;
   - the PR targets `main` of `exafyltd/vitana-platform` or `exafyltd/vitana-v1`;
   - the lane is not `governance: true`, and the diff touches no governance path;
   - the staging-only check below passes.

   **Staging-only check (R1-F2), mechanical, before every merge.**
   1. The session lists every workflow on the target repo's `main` that runs on `push` to `main` and whose `paths`
      filter (or no filter) matches the PR's changed files.
   2. Each listed workflow must be one of:
      - (a) staging or verification: `AWS-STAGE-*`, `STAGING-VERIFY*`, preview, test, lint or CI workflows that
        deploy nothing;
      - (b) a production workflow whose push path is frozen by its `cutover_gate`: platform `AUTO-DEPLOY.yml`;
        vitana-v1 `DEPLOY.yml` and `supabase-functions-deploy.yml`. Freezing is time-based since 2026-06-08; the
        session reads the gate's logic on `main` and confirms it still freezes the push path.
   3. Any other deploying workflow is not staging-only, and the merge is a §D.1 stop. An example is
      `DEPLOY-CLOUDFLARE-WORKERS.yml`, which deploys live Workers on a push touching `cloudflare/**` with no freeze.
      So is a production workflow whose freeze is gone.
   4. The list is recorded as a `deploys:` line in the lane log before the merge.
   5. **Enumeration is mechanical (R2-F3).** The list comes from reading the workflow files on `main`; it is never
      written from memory.
      - Interactive sessions use the read-only listing recorded in §7d, a `git show origin/main:.github/workflows/…`
        loop over every file's `on.push` block.
      - Automation runs have no merge authority (owner Gate 1, interactive only). A follow-up plan,
        `merge-deploy-guard`, adds the listing as a tested `queue.mjs` command. Any automation merge authority after
        that is a separate owner decision.

   On merge the session appends `merge: <sha>` and `authority: §7d standing` to the lane log.

   A red check inherited from `main` is not overridden: the fix on `main` is its own routine lane, which Kiro plans
   and carries first. §7b's `--admin` override stays limited to governance-artifact false positives, with every real
   test green.
5. **Staging.**
   - Kiro may dispatch or re-run staging and verification workflows only: `AWS-STAGE-*`, `STAGING-VERIFY*`, preview
     and PR CI re-runs.
   - Never dispatched by Kiro outside Gate 2: `AUTO-DEPLOY.yml`, vitana-v1 `DEPLOY.yml`,
     `supabase-functions-deploy.yml`, `DEPLOY-CLOUDFLARE-WORKERS.yml`, `AWS-PROD-*` and PUBLISH. A manual dispatch of
     these deploys production.
   - It watches the deploy and STAGING-VERIFY for its merge commit and fixes forward.
   - Then it writes the Gate 2 message to the plan's handoff log (`gate2: ready`) and gives it to the owner — in the
     same reply if interactive, otherwise in the next interactive session's first reply.
6. **Migrations, owner-approved only (R1-F3, s2 R1-F1).**
   - **Applier list.** B.6 covers every migration applier: `RUN-MIGRATION.yml` and every vitana-v1 `apply-*.yml`.
     - For a per-file applier, the owner's approval names the workflow file and the SQL path it applies. The target
       is always the production Supabase project, which the session confirms from the workflow's `PROJECT_REF`.
     - The `migration-approval:` line records the workflow, the SQL path with its sha256, and `target:supabase`.
     - The session confirms the workflow on `main` still applies exactly that SQL path.
     - Freeze (s2 R2-F2): `MIGRATION_FREEZE` is a vitana-platform variable that only `RUN-MIGRATION.yml` enforces.
       The vitana-v1 per-file appliers have no freeze mechanism, and repo variables are not readable from a Kiro
       session (HTTP 403). So, for those appliers:
       - the session does not dispatch during an Aurora cutover freeze window recorded in the cutover runbook or the
         `aurora-cutover` programme;
       - the owner's approval must be given in the same conversation as the dispatch.

       Adding a freeze guard to those workflows is a separate, non-rule change.
   - **Every `RUN-MIGRATION.yml` apply is a production database write.** Its targets are the production Supabase
     project (default, `MIGRATION_TARGET` unset) or Aurora, and staging shares that project. So approving a migration
     is the §D.2 owner decision itself: the approval is the owner's "yes" to that production write. No other
     production approval is implied or needed for it, and no other production write is covered by it.
   - Kiro dispatches `RUN-MIGRATION.yml` for a migration file only when the owner has explicitly approved that file
     **and its target database** in an owner conversation. That means either an in-conversation instruction naming
     both, or the owner's own Gate 1 "yes" to a message that lists both by path and target (R2-F1).
   - A plan's policy approval (`converged-auto-v1`) never authorises a migration apply.
   - The session records `migration-approval: "<owner's words>" (<date>) <path> sha256:<hash> target:<supabase|aurora>`
     in the lane log before the dispatch.
   - Required:
     - the target resolved at dispatch, read from the `target` input or the repo variable `MIGRATION_TARGET`, equals
       the approved target, and the dispatch passes `target` explicitly (never `default`);
     - the file's hash at dispatch equals the recorded hash;
     - `allow_non_transactional` is `false` unless the owner's approval names a non-transactional apply. Such an
       apply cannot be rolled back atomically, so it is also a §D.3 irreversible-action decision. The
       `migration-approval:` line records `non_transactional:true|false` (R2-F2);
     - the lane's `docs/validation/<VTID>/` has the rollback file and the read-only pre/post checks;
     - `MIGRATION_FREEZE` is not set;
     - the order in any migration queue the plan names (e.g. `docs/multitenancy/MIGRATION-QUEUE.md`) is respected.
   - Interactive sessions only — an automation run never applies a migration.
   - A changed file, or a migration that is not approved, is a stop (§D).
7. **Dependent lanes.** When a lane is `done`, the session continues with the next unblocked lane of the same plan
   that it may build. Lanes of another seat are left to that seat. Then it continues the workstream until the plan
   is `done`.
8. **Fix-forward.** CI failures, test fixes, review findings (`review: changes` → back to `executing` by the builder
   seat) and plan corrections inside the approved plan (a new sparring round on the plan PR) are routine. The fourth
   attempt at the same failure is a stop (§D, "unresolved failure").

### C. What does not change
- **Production:** `AWS-PROD-*`, PUBLISH, `publish-to-prod.sh` and production cutovers happen only after Gate 2, on
  the owner's answer (§7c from `retire-claude-code`).
- **No direct writes to a live system from a session tool:**
  - no `execute_sql` INSERT/UPDATE/DELETE/DDL;
  - no `apply_migration` or `deploy_edge_function`;
  - no Supabase branch, project or secret tools;
  - no mutating AWS CLI or API call.

  Live changes go only through the governed workflows in B.5/B.6. Reading for diagnosis stays allowed.
- **Never test against production;** staging suites stay read-only.
- **Every change is sparred** before it gets a VTID.
- **Governance lanes** (`governance: true`) still merge only on the owner's explicit per-PR instruction, with an
  approving review from a different seat (§7b / `retire-claude-code`). Changing Kiro's own guard rails is a material
  access change (§D).
- **Automation runs:**
  - they still do at most one item per run;
  - they never build, approve or merge a governance lane;
  - they never apply a migration;
  - they never take a §D decision.

### D. Major decisions — the only stops
Kiro stops at the exact point and asks the owner only for:
1. production deployment or cutover;
2. a new production database migration the owner has not already approved (B.6);
3. a destructive or irreversible action;
4. a legal or compliance decision;
5. a financial, commission, payment or payout decision;
6. a material security or access change (incl. any governance lane);
7. a meaningful change to approved product scope or business logic;
8. a production release containing unrelated material changes the owner has not approved;
9. a genuine product decision with materially different options;
10. the same failure surviving 3 fix-forward attempts, or a security or data-loss risk found mid-flight (from today's
    Autonomy contract).

The stop message has exactly five parts:
1. what Kiro wants to do;
2. why it is needed;
3. impact and risk;
4. the recommendation;
5. the exact yes/no decision needed.

The lane is parked (`parked_from` set, `next_actor: owner`) with the same five parts in its log. The session continues
other unblocked work.

Never asked: CI failures, test fixes, plan corrections, documentation, lane transitions, review findings,
non-destructive staging work, merge sequencing, implementation details, VTIDs, branch names, PR titles, re-runs.

### Files (lane `rules-platform-autonomy`, vitana-platform)
1. `.claude/rules/collaboration.md` (R1-F4), relative to the text `retire-claude-code` leaves on `main`:
   - new §7d (A–D above), inserted directly after §7c;
   - §7c is kept byte for byte;
   - §7 and §7b keep their text, and each only gains one pointer sentence to §7d (§7b stays the rule for governance
     lanes and the record format);
   - §7a's prohibition sentence itself is amended (R3-F1). Its exception clause "— except under the owner-directed
     exception in §7b below" becomes "— except under §7b (owner-directed, governance lanes) or §7d (standing
     authority) below", and its live-write bullet names the B.5/B.6 workflows as the only §7d exceptions. No flat
     "never dispatch/deploy" remains that §7d contradicts;
   - §7's "the Project Manager (until it runs, Claude Code) sets `verified` … and merges" and "Until it runs `live`,
     Claude Code merges a `verified` lane on the same rule" are rewritten (s2 R1-F2). In interactive owner-started
     sessions, Kiro sets `verified` and merges under §7d B.3/B.4. Automations stop at `verified`. The Project
     Manager takes over when it runs `live`;
   - §8 gains one sentence: automations never merge (owner Gate 1, interactive only), until a separate owner
     decision after `merge-deploy-guard`.
2. `CLAUDE.md`:
   - the Autonomy contract's "Stop and ask mid-flight only for" becomes the §D list plus the five-part format;
   - the collaboration roles paragraph's flat sentence "Kiro never merges, deploys or writes to a live system" is
     replaced (s2 R1-F2) by: "Kiro merges and dispatches staging/migration workflows only under §7d (interactive
     owner-started sessions); production stays behind Gate 2; no session-tool live writes."
3. `.kiro/steering/vitana-load-project-rules.md` and `.kiro/steering/vitana-kiro-notes.md`: the role text says
   "primary executor, §7d". The "never" list keeps only the items in §C. `next_actor: claude` on a block is replaced
   by §D or fix-forward.
4. `.kiro/automations/{exafy,exafyltd,jtadic}.md`:
   - step 1's "never" list follows §C;
   - step 6 stops only for §D items, a governance path or a migration apply;
   - Reviewer B no longer leaves `verified` to Claude Code;
   - the closing line "The Project Manager (or, until it runs, Claude Code) merges verified lanes, watches staging and
     sends the owner Gate 2." is replaced by "Kiro merges verified lanes under §7d B.4, watches staging and prepares
     Gate 2 (§7d B.5)" (R3-F2);
   - new item **D. Mark a reviewed lane verified:** a lane of the run's seat in `in-review` with a reviewer-seat
     `approve` on the current head. The run sets `verified` and stops. It never merges; the next interactive
     owner-started session merges under B.4. Order: A, B, D, C;
   - in the closing line above, "Kiro merges" reads "an interactive owner-started Kiro session merges".
5. `docs/validation/<VTID>/`: plan-sparring copy, `scope.json`, `acceptance.md`.

### Files (lane `rules-v1-autonomy`, vitana-v1)
Same `collaboration.md` (byte-identical, sha256 in the PR), `CLAUDE.md` roles paragraph, the same two steering
files, `docs/validation/<VTID>/`. vitana-v1 has no `.kiro/automations/`.

### Order and bootstrap
- Both lanes are `governance: true`. They need `retire-claude-code/scope-rules` (#4210) on `main`; until then
  `queue.mjs` refuses Kiro governance lanes.
- Hard prerequisite (R1-F4): `retire-claude-code/rules-platform` and `rules-v1` are `done` (merged) and their merge
  commits' checks are green before either lane here is claimed. The builder branches from that `main`, so the two
  plans never edit the same text at once.
- This ordering is stated here because `depends_on` is per spec.
- This plan PR flags both lanes in Collab handoff on today's `main` for the same reason. That is the known bootstrap
  false positive described in `retire-claude-code` plan "Bootstrap". It is not a required check (`main` requires only
  `validate`).
- Each lane PR merges on the owner's explicit per-PR instruction (governance), recorded as `owner-instruction:` and
  `merge:` lines. `rules-v1-autonomy` follows `rules-platform-autonomy`.
- Account-level Kiro steering is outside git: the global "vitana-load-project-rules" user rule in each Kiro account.
  The PR body carries its new text, and the owner pastes it into each account. Until then the repo text, which loads
  after it, governs where they differ. This is stated in the steering file itself.

## Out of scope
- Any product code.
- `queue.mjs` or other `scripts/collab/**` changes; the B.4 conditions are those the PM agent already encodes.
- Production deploy rules.
- Gate 2 content.
- The Project Manager's own switch-on (`pm-agent/p7-switch-on`).
- Enforcing B.4/B.6 in code: a follow-up plan may add checks for the `authority:` and `migration-approval:` lines.

## Tests
- `queue.mjs validate` green on both lane PRs (after #4210).
- `node scripts/ci/kiro-steering/guard.cjs` green.
- `collaboration.md` sha256 identical across the repos.
- **Structure check (R1-F4):**
  - `collaboration.md` contains the headings §7, §7a, §7b, §7c and §7d, in that order;
  - §7a's exception clause names both §7b and §7d (R3-F1);
  - `git diff <base> -- .claude/rules/collaboration.md` shows no removed line inside §7c;
  - the diff only adds §7d and the pointer sentences.
- **Scoped grep (R1-F6),** over the files the lanes change:
  - none of these patterns remains:
    - `stop and go to step 9 with \`next_actor: claude\``;
    - `(or, until it runs, Claude Code) merges`;
    - `Claude Code (later the Project Manager) sets \`verified\``;
    - `Blocked → a log entry and \`next_actor: claude\``;
  - every remaining `next_actor: claude` occurrence is in a sentence about legacy `executor: claude` lanes;
  - no added line permits dispatching the B.5 production workflows, or a session-tool live write;
  - the sentence "Kiro never merges, deploys or writes to a live system" no longer appears in `CLAUDE.md`
    (s2 R1-F2);
  - no automation file grants a merge.
- **Workflow inventory (s2 R1-F3):** every vitana-v1 `apply-*.yml` (and the platform code-patch `APPLY-*.yml`) is
  `workflow_dispatch`-only (no `push`), checked by reading each file's `on:` block. The result goes in the PR's
  acceptance.
- Change suites: `existing` entries for these checks. No staging surface changes, so no browser suite.

## Lanes
- `rules-platform-autonomy` (vitana-platform): executor kiro, `governance: true`, seat `jtadic`, reviewer `exafyltd`.
- `rules-v1-autonomy` (vitana-v1 PR, lane file here): executor kiro, `governance: true`, seat `jtadic`, reviewer
  `exafyltd`; depends on `rules-platform-autonomy`.

## Risks
- **Merges without a per-PR instruction.** Only interactive owner-started sessions (owner Gate 1). Bounded by:
  - the reviewer-seat approve on the current head;
  - all checks green;
  - staging-only deploy;
  - no governance lanes;
  - production still behind Gate 2;
  - automatic rollback on production post-deploy checks is unchanged.

  All seats share one GitHub identity, so "another seat" is self-declared (as stated in `retire-claude-code`).
  Automations do not merge.
- **A merge that deploys production by path** (e.g. `cloudflare/**`) is caught by the B.4 staging-only check and
  becomes a §D.1 stop.
- **Migrations are production writes.** Bounded by the per-file owner approval with a hash, interactive sessions only,
  rollback + checks in the evidence pack, and `MIGRATION_FREEZE`.
- **More merges, faster.** STAGING-VERIFY stays the gate to Gate 2. A red STAGING-VERIFY blocks the next merge on the
  same service until it is fixed forward.
<!-- plan:end -->
