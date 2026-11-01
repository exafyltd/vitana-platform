# Tasks — kiro-lane-admin

Plan: `.kiro/specs/kiro-lane-admin/plan.md` (plan block authoritative). Design: `design.md`.

<!-- lane: enforcement -->
## Lane `enforcement`
- [ ] E0 `scripts/collab/queue.mjs`: add a module-level `const toBool = (v) => v === true || v === 'true';` next to
      `asList` and use it EVERYWHERE `lane_admin` is tested (R2-F1) — `parseFrontMatter` parses scalars as strings, so
      `lane_admin: true` is `'true'` and `=== true` is dead on arrival. Never boolean strict equality. (design §0)
- [ ] E1 `scripts/collab/queue.mjs` `validateLane`: recognise `lane_admin` (string marker via `toBool`); a lane with
      `toBool(fm.lane_admin)` must be `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`, and declare a
      lane-file path (`.kiro/specs/*/lanes/*.md`); clear error otherwise. (design §0, §1)
- [ ] E1a `scripts/collab/queue.mjs` `validateRange` (:528): (R2-F2) add `fetchPlanLane = null` to the options and
      thread it from the `validate` CLI command exactly as `scope-check` does (:989-997); then (R1-F1) add the
      cross-lane-file exemption — a changed lane file whose key differs from the commit's `Collab-Lane` passes the
      Collab handoff check (near :584, before the :591 error) when the committing admin lane's TRUSTED front matter has
      `toBool(lane_admin)` + `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer` and the target lane file
      matches that trusted admin lane's `paths` (shared helper `laneAdminCovers(..., fetchPlanLane)`, resolving the
      merge-base / qualifying plan( PR / other-repo main chain SYMMETRICALLY with `scopeCheck`, never the head).
      (design §0, §1a)
- [ ] E2 `scripts/collab/queue.mjs` `scopeCheck` (:664-686): add the TARGET-ONLY PERM carve-out (R1-F2) — the
      lane-admin allowance applies only when the lane under check is a target lane file an in-PR trusted `lane_admin`
      lane administers, NEVER to the admin lane's own PERM fields; compute `selfTrustedLaneAdmin` (with
      `toBool(trustedFm.lane_admin)`, R2-F1) from the trusted revision; pin
      `['executor','seat','reviewer_seat','paths','lane_admin']` back to trusted when not allowed (so the admin lane can
      never self-widen and `lane_admin` can never be self-granted); reword the PERM and governance-path refusals to name
      the Kiro lane-admin / reviewer-agent route; leave the protected-gate refusal (:699) and the seat-ownership check
      (:714-715) intact. (design §0, §2, §3, §4)
- [ ] E3 `scripts/collab/protected-gate-files.json` `description` + `PROTECTED_GATE_BUILTIN` comment: replace "legacy
      claude review" with the owner-instruction + reviewer-agent-accept wording; globs unchanged; keep JSON ↔ builtin
      byte-identical content. (design §4)
- [ ] E4 `services/gateway/src/services/project-manager/governance.ts` (:184): `governanceMergeAllowed` ALWAYS returns
      `{ok:false, reason:'protected_gate_file'}` for a protected gate file PR — the legacy-claude programmatic unlock
      is RETIRED, not transferred to an agent accept (R1-F3); the owner instruction is the out-of-band authority in the
      lane log. Remove the dead legacy-claude protected-gate branch (delete `isLegacyClaudeReview` only if it has no
      other caller); update header prose; keep every other verdict unchanged. Both independent layers (queue.mjs +
      governance.ts) keep refusing protected gate files — defense-in-depth preserved. (design §5)
- [ ] E5 `scripts/collab/queue.test.mjs`: add T-A..T-K (design §7), each proven red on origin/main first — incl. T-G
      (validateRange exemption passes for a trusted admin lane), T-H (ordinary cross-lane-file edit still refused),
      T-I (the admin lane cannot self-widen its own PERM / `lane_admin`), T-J (a string-`'true'` `lane_admin` lane is
      recognised and unlocks the carve-outs, and reverting any comparison to `=== true` fails — R2-F1), and T-K (the
      `validateRange` exemption resolves a trusted admin lane via `fetchPlanLane` from a qualifying plan( PR — R2-F2);
      all 53 existing cases stay green; JSON↔builtin parity stays green.
- [ ] E6 Gateway Jest: update `governance.ts` tests for the new protected-gate unlock; suite green.

**Acceptance:**
- Change types: Tooling/docs, Backend.
- Outcome — an authorized Kiro session (reviewer-agent-gated, trusted-source lane with `lane_admin: true`) can reassign
  a lane's `seat` and narrow its `paths`; an ordinary or self-granting lane still cannot; a protected gate file still
  cannot merge on a reviewer-agent accept alone. CI (Collab handoff / Lane scope) enforces this.
- States — n/a (pure enforcement logic + tests; no UI).
- Surfaces — callers of `queue.mjs scope-check`/`validate` (PR-GATE Collab handoff + Lane scope) and the PM
  `governance.ts` merge guard.
- Locales — n/a (developer-facing tooling, English by design).
- Accessibility — n/a (no UI).
- Contract — `scopeCheck`/`validateLane` return shapes unchanged; new refusal strings documented in design §4.
  `governanceMergeAllowed` still returns `{ok:true}` / `{ok:false, reason}` with the same union.
- Staging proof — not verified on staging: developer tooling, no deployed surface. Proven by `node --test
  scripts/collab/queue.test.mjs` (new cases red-on-base captured in the PR body) and the gateway Jest suite.
- Reviewer — the trusted-source read (never head) in both `validateRange` (§1a) and `scopeCheck` (§2); that
  `lane_admin` is compared via `toBool`, never `=== true` (R2-F1, T-J); that `fetchPlanLane` is threaded into
  `validateRange` so the trusted chain is symmetric with `scopeCheck` (R2-F2, T-K); that the PERM carve-out is
  TARGET-only so the admin lane can never self-widen (T-I); that `lane_admin` is pinned to trusted (T-D); that the
  `validateRange` exemption is narrow (T-G passes, T-H still refused); that protected-gate and seat-ownership refusals
  are unchanged (T-E, T-F); that `governanceMergeAllowed` ALWAYS refuses protected gate files (R1-F3, defense-in-depth
  preserved); and that every existing test still passes.

<!-- lane: rules -->
## Lane `rules`
- [ ] R1 `.claude/rules/collaboration.md` §3a + §7b: protected-gate authority → "the owner's instruction naming the
      plan plus a reviewer-agent accept on the current head"; §7/§7a: one sentence on the authorized `lane_admin`
      reviewer-agent lane-administration path (seat reassignment + path narrowing, preserving seat ownership, scope,
      independent review). (design §6)
- [ ] R2 `CLAUDE.md` (platform) protected-gate sentence → Claude-free wording.
- [ ] R3 `vitana-v1/CLAUDE.md` — byte-identical mirror of R2 (carried in a sibling vitana-v1 PR of this lane;
      sha256 in PR body).
- [ ] R4 `.kiro/pipeline/common-rules.md` rule 4 + `.kiro/steering/vitana-owner-autonomy.md` stop #3 → Claude-free
      wording.
- [ ] R5 Confirm `scripts/ci/kiro-steering/guard.cjs` green and `node scripts/collab/queue.mjs validate` green;
      `vitana-collaboration.md` stays a `#[[file:]]` link (no body edit).

**Acceptance:**
- Change types: Tooling/docs.
- Outcome — every rule, steering and doc file states the Claude-free protected-gate authority and the new lane-admin
  path consistently with the enforcement; no file still says "legacy claude review" is an option.
- States — n/a.
- Surfaces — the loaded rule files a session reads (`collaboration.md`, both `CLAUDE.md`, `common-rules.md`,
  `vitana-owner-autonomy.md`).
- Locales — n/a (developer-facing rules, English by design).
- Accessibility — n/a.
- Contract — text only; `collaboration.md` identical across both repos; the two `CLAUDE.md` protected-gate sentences
  byte-identical (sha256 in PR body).
- Staging proof — not verified on staging: documentation. Proven by the steering guard + `queue.mjs validate` green
  and the byte-identical sha256 check.
- Reviewer — wording matches the enforcement lane exactly; no behavioural claim the code does not make; the
  `#[[file:]]` twin untouched.
